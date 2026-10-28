/**
 * Mídia do projeto: narrações, efeitos importados, imagens, GIFs e vídeos.
 *
 * Os arquivos ficam no IndexedDB — o localStorage não serve (≈5 MB e só
 * texto). O projeto salvo guarda apenas o id e os metadados; este módulo
 * resolve o blob, a duração e a URL para a prévia.
 */

const DB_NAME = "mapcine.media";
const DB_VERSION = 1;
const STORE = "arquivos";

let dbPromise = null;

export function isMediaSupported() {
  return typeof indexedDB !== "undefined";
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!isMediaSupported()) {
      reject(new Error("Armazenamento de mídia indisponível neste navegador."));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Falha ao abrir o banco de mídia."));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function run(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

/** Guarda um arquivo. `meta` costuma ter { name, kind }. */
export function putMedia(id, blob, meta = {}) {
  return run("readwrite", (store) => {
    store.put({ id, blob, name: meta.name || "", kind: meta.kind || "", added: Date.now() });
  });
}

export function getMedia(id) {
  return run("readonly", (store) => {
    const req = store.get(id);
    return { __req: req };
  });
}

export function deleteMedia(id) {
  return run("readwrite", (store) => {
    store.delete(id);
  });
}

export function listMedia() {
  return run("readonly", (store) => {
    const req = store.getAll();
    return { __req: req };
  });
}

/* ------------------------------------------------------------------ *
 * URLs para prévia
 * ------------------------------------------------------------------ */
const urls = new Map();

/** URL de objeto do arquivo (criada uma vez e reaproveitada). */
export async function mediaURL(id) {
  if (urls.has(id)) return urls.get(id);
  const rec = await getMedia(id);
  if (!rec || !rec.blob) return null;
  const url = URL.createObjectURL(rec.blob);
  urls.set(id, url);
  return url;
}

export function forgetURL(id) {
  const url = urls.get(id);
  if (url) URL.revokeObjectURL(url);
  urls.delete(id);
}

export function forgetAllURLs() {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
}

/* ------------------------------------------------------------------ *
 * Metadados
 * ------------------------------------------------------------------ */

/**
 * Duração de um arquivo de áudio/vídeo, em segundos.
 * Usa o elemento de mídia (aceita qualquer formato que o aparelho toque).
 */
export function probeDuration(blob, kind = "audio") {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const url = URL.createObjectURL(blob);
    const el = document.createElement(kind === "video" ? "video" : "audio");
    el.preload = "metadata";
    el.muted = true;
    el.onloadedmetadata = () => {
      const d = Number(el.duration);
      if (Number.isFinite(d) && d > 0) finish(d);
      else {
        // alguns WebM reportam Infinity: força o cálculo pulando para o fim
        el.currentTime = 1e6;
      }
    };
    el.ondurationchange = () => {
      const d = Number(el.duration);
      if (Number.isFinite(d) && d > 0) finish(d);
    };
    el.onerror = () => finish(0);
    el.src = url;
    setTimeout(() => finish(Number.isFinite(el.duration) ? Number(el.duration) || 0 : 0), 6000);
  });
}

/** Tamanho natural de uma imagem/GIF. */
export function probeImage(blob) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => finish({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => finish({ width: 0, height: 0 });
    img.src = url;
    setTimeout(() => finish({ width: 0, height: 0 }), 6000);
  });
}

/**
 * Remove do banco os arquivos que o projeto não usa mais.
 * @param {Set<string>} usedIds
 */
export async function pruneMedia(usedIds) {
  const all = await listMedia();
  let removed = 0;
  for (const rec of all || []) {
    if (usedIds.has(rec.id)) continue;
    await deleteMedia(rec.id);
    forgetURL(rec.id);
    removed++;
  }
  return removed;
}
