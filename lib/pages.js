// The app and sign-in pages, with every script and stylesheet address stamped
// with a hash of those files (?v=…). Cloudflare can tell browsers to keep
// static files for hours, so after a deploy a fresh page could run stale
// scripts (e.g. a Chat button the old code doesn't know about). New file
// contents mean new addresses, so updates load at once.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function loadPages(root) {
  const pub = join(root, "public");
  // The Photos engine (photo/develop.wasm) is fetched by a worker with the
  // same stamp, so it's part of the hash too.
  const files = ["js", "css", "photo"]
    .flatMap((dir) => readdirSync(join(pub, dir)).filter((f) => /\.(m?js|css|wasm)$/.test(f)).map((f) => `/${dir}/${f}`))
    .sort();
  const hash = createHash("sha256");
  for (const f of files) hash.update(f).update(readFileSync(join(pub, f)));
  const v = hash.digest("hex").slice(0, 10);

  // Modules import each other by plain path ("./ui.js"); the import map sends
  // those to the stamped addresses too.
  const imports = Object.fromEntries(files.filter((f) => /\.m?js$/.test(f)).map((f) => [f, `${f}?v=${v}`]));
  const importMap = `<script type="importmap">${JSON.stringify({ imports })}</script>\n  `;
  const stamp = (html) => html
    .replace(/(href|src)="(\/(?:js|css)\/[^"?]+)"/g, `$1="$2?v=${v}"`)
    .replace("<script", `${importMap}<script`);

  return {
    version: v,
    app: stamp(readFileSync(join(root, "views", "app.html"), "utf8")),
    login: stamp(readFileSync(join(pub, "login.html"), "utf8")),
  };
}
