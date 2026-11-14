// A tiny router: route("GET", "/api/portal/projects/:id", handler). Handlers get
// { request, env, params, url, client, admin, waitUntil } and return a Response or a plain object (sent as JSON).
import { json, HttpError } from "./lib/http.js";

export function makeRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    routes.push({ method, re, keys, handler });
  };
  const api = {
    get: (p, h) => add("GET", p, h),
    post: (p, h) => add("POST", p, h),
    put: (p, h) => add("PUT", p, h),
    patch: (p, h) => add("PATCH", p, h),
    delete: (p, h) => add("DELETE", p, h),
    async handle(ctx, path) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(path);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== ctx.request.method && !(r.method === "GET" && ctx.request.method === "HEAD")) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        try {
          const out = await r.handler({ ...ctx, params });
          return out instanceof Response ? out : json(out ?? { ok: true });
        } catch (e) {
          if (e instanceof HttpError || (e?.status && e.status < 500)) return json({ error: e.message }, e.status);
          console.error(e);
          return json({ error: "Something went wrong. Please try again." }, 500);
        }
      }
      return pathMatched ? json({ error: "Method not allowed" }, 405) : null;
    },
  };
  return api;
}

/** Route parameter as a positive integer id, or 404. */
export const idOf = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, "Not found");
  return n;
};
