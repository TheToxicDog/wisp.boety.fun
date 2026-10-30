// Copies the pre-built runtime bundles (Scramjet, bare-mux, epoxy WASM, and
// mediabunny for the BoetyCut video editor) into
// the static web root so Nginx/Cloudflare can serve them directly.
// `node scripts/assets.js --verify` only checks that they are present.
import { cpSync, existsSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";

// mediabunny doesn't export its package.json, so locate it beside the others.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const mediabunnyPath = join(root, "..", "node_modules", "mediabunny", "dist", "bundles");

export const bundles = [
  { from: scramjetPath, to: "scram", files: ["scramjet.all.js", "scramjet.sync.js", "scramjet.wasm.wasm"] },
  { from: baremuxPath, to: "baremux", files: ["index.js", "worker.js"] },
  { from: epoxyPath, to: "epoxy", files: ["index.mjs"] },
  { from: mediabunnyPath, to: "mediabunny", files: ["mediabunny.min.mjs"], only: true },
];

export function verifyAssets() {
  const missing = [];
  for (const b of bundles) {
    for (const f of b.files) {
      const p = join(root, b.to, f);
      if (!existsSync(p) || !statSync(p).size) missing.push(`public/${b.to}/${f}`);
    }
  }
  return missing;
}

function copy() {
  for (const b of bundles) {
    const dest = join(root, b.to);
    rmSync(dest, { recursive: true, force: true });
    if (b.only) {
      for (const f of b.files) cpSync(join(b.from, f), join(dest, f));
      continue;
    }
    cpSync(b.from, dest, { recursive: true, filter: (src) => !src.endsWith(".map") && !src.endsWith(".d.ts") });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--verify")) copy();
  const missing = verifyAssets();
  if (missing.length) {
    console.error("Missing runtime assets:\n  " + missing.join("\n  "));
    process.exit(1);
  }
  for (const b of bundles) for (const f of b.files) {
    const kb = (statSync(join(root, b.to, f)).size / 1024).toFixed(0);
    console.log(`ok  public/${b.to}/${f}  ${kb} KB`);
  }
}
