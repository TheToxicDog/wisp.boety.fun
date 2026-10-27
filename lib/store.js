// JSON-file persistence for users and sessions. Writes are atomic
// (tmp file + rename) and coalesced so bursts of changes cost one write.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";

export const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

export function loadJson(name, fallback) {
  const file = join(DATA_DIR, name);
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function saveJsonNow(name, value) {
  const file = join(DATA_DIR, name);
  writeFileSync(file + ".tmp", JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(file + ".tmp", file);
  chmodSync(file, 0o600);
}

const pending = new Map();
export function saveJson(name, getValue, delay = 250) {
  if (pending.has(name)) return;
  pending.set(name, setTimeout(() => {
    pending.delete(name);
    saveJsonNow(name, getValue());
  }, delay));
}

export function flushAll(savers) {
  for (const [name, timer] of pending) {
    clearTimeout(timer);
    pending.delete(name);
    saveJsonNow(name, savers[name]());
  }
}
