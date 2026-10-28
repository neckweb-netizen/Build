/**
 * Salvamento do vídeo exportado.
 *
 * No navegador o download é um link `blob:`. No app Android o WebView não
 * baixa esses links, então uma ponte nativa (`window.MapCineSave`) grava o
 * arquivo aos poucos em Filmes/MapCine, já visível na galeria e no CapCut.
 */

import { downloadBlob } from "./recorder.js";

const CHUNK = 512 * 1024; // pedaços de 512 kB

function toBase64(bytes) {
  const step = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function hasNativeSaver() {
  return typeof window.MapCineSave !== "undefined" && window.MapCineSave !== null;
}

/**
 * @param {Blob} blob vídeo gravado
 * @param {string} filename nome com extensão
 * @param {{onProgress?:(p:number)=>void}} [opts]
 * @returns {Promise<{saved:boolean, path:string}>} `saved` falso quando foi
 *   apenas o download do navegador
 */
export async function saveVideoFile(blob, filename, opts = {}) {
  const { onProgress } = opts;

  if (!hasNativeSaver()) {
    downloadBlob(blob, filename);
    return { saved: false, path: "" };
  }

  const bridge = window.MapCineSave;
  const mime = blob.type || "video/webm";
  const opened = bridge.start(filename, mime);
  if (opened) throw new Error(opened);

  try {
    let offset = 0;
    while (offset < blob.size) {
      const part = blob.slice(offset, offset + CHUNK);
      const buffer = await part.arrayBuffer();
      const err = bridge.write(toBase64(new Uint8Array(buffer)));
      if (err) throw new Error(err);
      offset += CHUNK;
      if (onProgress) onProgress(Math.min(1, offset / blob.size));
      // deixa a interface responder entre os pedaços
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const result = bridge.finish();
    if (/^erro|^nao foi/i.test(result || "")) throw new Error(result);
    return { saved: true, path: result || "" };
  } catch (err) {
    try {
      bridge.abort();
    } catch (ignored) {
      // nada a fazer
    }
    throw err;
  }
}
