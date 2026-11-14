// Node can't import .sql files; Wrangler bundles them as text. Do the same for the tests.
import { readFile } from "node:fs/promises";
export async function load(url, context, next) {
  if (url.endsWith(".sql")) return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(await readFile(new URL(url), "utf8"))};` };
  return next(url, context);
}
