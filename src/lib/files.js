// Private files in R2 (bucket binding FILES). Nothing in the bucket is public: every download goes
// through the Worker, which checks the person asking may see it. Keys are random, never the file name.
import { first, run, activity } from "./db.js";
import { fail } from "./http.js";

export const MAX_BYTES = 25 * 1024 * 1024;
const TYPES = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic", "image/heif": "heif", "image/avif": "avif",
  "image/svg+xml": "svg", "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv",
  "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/zip": "zip", "application/postscript": "eps", "application/illustrator": "ai", "image/vnd.adobe.photoshop": "psd",
};
export const ALLOWED_TYPES = Object.keys(TYPES);

const safeName = (n) => String(n || "file").replace(/[\\/\0\r\n"]/g, "_").slice(0, 160) || "file";

/**
 * Store an upload. body: ArrayBuffer/stream; meta: { project_id, item_id, name, type, size, kind, by, visible }.
 * The browser sends the raw file with x-file-name / content-type headers (no multipart parsing needed).
 */
export async function saveFile(env, request, meta) {
  if (!env.FILES) fail(503, "File storage isn't set up yet");
  const type = String(request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!TYPES[type]) fail(415, "That file type isn't accepted. Photos, PDFs, Office documents and common design files are fine.");
  const size = Number(request.headers.get("content-length") || 0);
  if (size > MAX_BYTES) fail(413, "Files can be up to 25 MB. For bigger files, send a share link in the notes.");
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BYTES) fail(413, "Files can be up to 25 MB.");
  if (!body.byteLength) fail(411, "Empty file");
  let name = request.headers.get("x-file-name") || "file";
  try {
    name = decodeURIComponent(name);
  } catch {}
  name = safeName(name);
  const key = `${meta.project_id ? `projects/${meta.project_id}` : "studio"}/${crypto.randomUUID()}.${TYPES[type]}`;
  await env.FILES.put(key, body, { httpMetadata: { contentType: type } });
  const row = await first(
    env,
    "INSERT INTO files (project_id, item_id, r2_key, name, content_type, size, kind, uploaded_by, visible_to_client) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    meta.project_id ?? null, meta.item_id ?? null, key, name, type, body.byteLength, meta.kind || "onboarding", meta.by, meta.visible === false ? 0 : 1
  );
  await activity(env, meta.project_id, meta.actor || meta.by, "upload", `${name} (${Math.round(body.byteLength / 1024)} KB)`);
  return row;
}

/** Send a stored file. Inline only for plain images and PDFs; everything else (and SVG) downloads. */
export async function serveFile(env, file, { download = false } = {}) {
  const obj = await env.FILES.get(file.r2_key);
  if (!obj) fail(404, "File not found");
  const inline = !download && /^(image\/(jpeg|png|webp|gif|avif)|application\/pdf)$/.test(file.content_type);
  return new Response(obj.body, {
    headers: {
      "content-type": file.content_type,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${file.name.replace(/[^\x20-\x7e]/g, "_")}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

export async function removeFile(env, file, actor) {
  await run(env, "UPDATE files SET deleted_at = datetime('now') WHERE id = ?", file.id);
  await env.FILES.delete(file.r2_key);
  await activity(env, file.project_id, actor, "file_deleted", file.name);
}
