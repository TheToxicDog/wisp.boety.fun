// Photos: the catalog, kept in this browser's IndexedDB. Originals are stored
// as Blobs; edits are non-destructive settings on each photo record.
const DB = "wisp-photo";
let dbp = null;

function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("photos", { keyPath: "id" });
      db.createObjectStore("files", { keyPath: "id" });
      db.createObjectStore("thumbs", { keyPath: "id" });
      db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function store(name, mode = "readonly") {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function allPhotos() { return done((await store("photos")).getAll()); }
export async function getPhoto(id) { return done((await store("photos")).get(id)); }
export async function putPhoto(p) { return done((await store("photos", "readwrite")).put(p)); }
export async function deletePhoto(id) { return done((await store("photos", "readwrite")).delete(id)); }

export async function putFile(id, blob) { return done((await store("files", "readwrite")).put({ id, blob })); }
export async function getFile(id) { return (await done((await store("files")).get(id)))?.blob || null; }
export async function deleteFile(id) { return done((await store("files", "readwrite")).delete(id)); }

export async function putThumb(id, blob) { return done((await store("thumbs", "readwrite")).put({ id, blob })); }
export async function getThumb(id) { return (await done((await store("thumbs")).get(id)))?.blob || null; }
export async function deleteThumb(id) { return done((await store("thumbs", "readwrite")).delete(id)); }

export async function getMeta(key, fallback) {
  const r = await done((await store("meta")).get(key));
  return r ? r.value : fallback;
}
export async function setMeta(key, value) { return done((await store("meta", "readwrite")).put({ key, value })); }

export async function usage() {
  try { return await navigator.storage?.estimate?.(); } catch { return null; }
}

export async function persist() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
