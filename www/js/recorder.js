/**
 * Exportação: compõe o canvas do mapa + overlay 2D em um canvas de saída
 * e grava com MediaRecorder (WebM/VP9). Gravação em tempo real.
 */

function pickMime(withAudio) {
  const candidates = withAudio
    ? [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
        "video/mp4",
      ]
    : [
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
        "video/mp4",
      ];
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export function isExportSupported() {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function"
  );
}

/**
 * @param {object} opts
 * @param {maplibregl.Map} opts.map
 * @param {HTMLElement} opts.mapEl
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} opts.fps
 * @param {number} opts.total segundos
 * @param {MediaStreamTrack} [opts.audioTrack] faixa de áudio para incluir no vídeo
 * @param {() => void} [opts.onStart] chamado quando a gravação começa
 * @param {(t:number)=>void} opts.applyCamera
 * @param {(ctx:CanvasRenderingContext2D, t:number)=>void} opts.drawOverlay
 * @param {(t:number)=>string|null} [opts.mapFilter] filtro CSS do tema do mapa
 * @param {(t:number)=>{color:string,alpha:number}|null} [opts.mapTint] tingimento do tema
 * @param {(p:number)=>void} [opts.onProgress]
 */
export async function renderVideo(opts) {
  const {
    map,
    mapEl,
    width,
    height,
    fps,
    total,
    audioTrack,
    onStart,
    applyCamera,
    drawOverlay,
    mapFilter,
    mapTint,
    onProgress,
  } = opts;

  if (!isExportSupported()) {
    throw new Error("Este navegador não suporta gravação de canvas (MediaRecorder).");
  }
  if (!total || total <= 0) {
    throw new Error("Adicione pelo menos dois keyframes com duração.");
  }

  const withAudio = Boolean(audioTrack);
  const mimeType = pickMime(withAudio);
  if (!mimeType) throw new Error("Nenhum formato de vídeo suportado neste dispositivo.");

  const prevStyle = mapEl.getAttribute("style") || "";
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d", { alpha: false });
  ctx.imageSmoothingQuality = "high";

  const stream = out.captureStream(fps);
  if (withAudio) stream.addTrack(audioTrack);

  const chunks = [];
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: Math.round(width * height * fps * 0.12),
    audioBitsPerSecond: withAudio ? 128000 : undefined,
  });

  const done = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = (e) => reject(e.error || new Error("Falha ao gravar vídeo."));
  });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };

  try {
    mapEl.style.inset = "0 auto auto 0";
    mapEl.style.width = `${width}px`;
    mapEl.style.height = `${height}px`;
    map.resize();
    await nextFrame();
    await nextFrame();

    recorder.start(200);
    if (onStart) {
      try { onStart(); } catch (err) { console.warn("Falha ao iniciar o áudio:", err); }
    }
    const start = performance.now();
    let lastDrawn = -1;

    // tema do mapa: filtro + tingimento, iguais aos da prévia
    const paintMap = (t) => {
      const filter = mapFilter ? mapFilter(t) : null;
      ctx.save();
      if (filter) ctx.filter = filter;
      try {
        ctx.drawImage(map.getCanvas(), 0, 0, width, height);
      } catch (err) {
        throw new Error("O canvas do mapa está protegido por CORS (tiles sem cabeçalho). " + err.message);
      }
      ctx.restore();

      const tint = mapTint ? mapTint(t) : null;
      if (tint && tint.alpha > 0) {
        ctx.save();
        ctx.globalAlpha = tint.alpha;
        ctx.globalCompositeOperation = "soft-light";
        ctx.fillStyle = tint.color;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
      }
    };

    while (true) {
      const elapsed = (performance.now() - start) / 1000;
      const t = Math.min(elapsed, total);

      applyCamera(t);
      map.triggerRepaint();
      await nextFrame();

      // desenha o quadro do mapa
      ctx.fillStyle = "#05070b";
      ctx.fillRect(0, 0, width, height);
      paintMap(t);

      drawOverlay(ctx, t);

      if (onProgress) onProgress(t / total);
      lastDrawn = t;
      if (elapsed >= total) break;
    }

    // garante um último quadro no fim exato
    applyCamera(total);
    map.triggerRepaint();
    await nextFrame();
    paintMap(total);
    drawOverlay(ctx, total);
    await new Promise((r) => setTimeout(r, 120));

    recorder.stop();
    const blob = await done;
    if (lastDrawn < 0) throw new Error("Nenhum quadro foi capturado.");
    return { blob, mimeType, width, height, fps, duration: total };
  } finally {
    if (recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* ignore */ }
    }
    stream.getTracks().forEach((tr) => tr.stop());
    mapEl.setAttribute("style", prevStyle);
    map.resize();
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
