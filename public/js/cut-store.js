// BoetyCut: projects and imported media, kept in this browser's IndexedDB.
const DB = "wisp-cut";
let dbp = null;

function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("projects", { keyPath: "id" });
      db.createObjectStore("media", { keyPath: "id" }); // { id, projectId, name, kind, duration, w, h, hasAudio, blob }
      db.createObjectStore("thumbs", { keyPath: "id" }); // project covers + media filmstrips
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
async function store(name, mode = "readonly") { return (await open()).transaction(name, mode).objectStore(name); }

export async function listProjects() {
  const all = await done((await store("projects")).getAll());
  return all.sort((a, b) => b.updated - a.updated);
}
export async function getProject(id) { return done((await store("projects")).get(id)); }
export async function putProject(p) { return done((await store("projects", "readwrite")).put(p)); }
export async function deleteProject(id) {
  await done((await store("projects", "readwrite")).delete(id));
  for (const m of await projectMedia(id)) await deleteMedia(m.id);
  await done((await store("thumbs", "readwrite")).delete("cover:" + id));
}

export async function putMedia(m) { return done((await store("media", "readwrite")).put(m)); }
export async function getMedia(id) { return done((await store("media")).get(id)); }
export async function deleteMedia(id) {
  await done((await store("media", "readwrite")).delete(id));
  await done((await store("thumbs", "readwrite")).delete("strip:" + id));
}
export async function projectMedia(projectId) {
  const all = await done((await store("media")).getAll());
  return all.filter((m) => m.projectId === projectId);
}

export async function putThumb(id, value) { return done((await store("thumbs", "readwrite")).put({ id, value })); }
export async function getThumb(id) { return (await done((await store("thumbs")).get(id)))?.value ?? null; }

export async function persist() { try { return await navigator.storage?.persist?.(); } catch { return false; } }
