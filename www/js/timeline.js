/**
 * Modelo de timeline: keyframes de câmera com duração por segmento.
 * Puro, sem dependência de DOM/mapa — fácil de testar.
 */

export const EASINGS = {
  linear: (p) => p,
  easeIn: (p) => p * p,
  easeOut: (p) => 1 - (1 - p) * (1 - p),
  easeInOut: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
};

export const EASE_OPTIONS = [
  { id: "easeInOut", label: "Suave" },
  { id: "linear", label: "Linear" },
  { id: "easeIn", label: "Acelera" },
  { id: "easeOut", label: "Desacelera" },
];

export const MOTION_OPTIONS = [
  { id: "smooth", label: "Voo suave" },
  { id: "linear", label: "Reta" },
  { id: "orbit", label: "Órbita" },
  { id: "arc", label: "Arco" },
  { id: "dwell", label: "Pausa e vai" },
  { id: "punch", label: "Impacto" },
  { id: "spin", label: "Giro 360°" },
  { id: "dive", label: "Mergulho" },
  { id: "topdown", label: "Vista de cima" },
  { id: "bounce", label: "Quique" },
  { id: "sweep", label: "Varredura" },
];

export const TRANSITION_OPTIONS = [
  { id: "none", label: "Sem transição" },
  { id: "fadeBlack", label: "Fade preto" },
  { id: "fadeWhite", label: "Fade branco" },
  { id: "flash", label: "Flash" },
  { id: "wipe", label: "Cortina diagonal" },
];

/** Menor diferença assinada entre dois ângulos, em graus. */
function shortestAngle(from, to) {
  return ((to - from + 540) % 360) - 180;
}

function lerp(a, b, p) {
  return a + (b - a) * p;
}

/** Espera antes do primeiro keyframe (a primeira cena pode ter narração). */
export function leadIn(keyframes) {
  return Math.max(0, Number(keyframes?.[0]?.hold) || 0);
}

/** Duração total da animação (espera inicial + soma dos segmentos). */
export function totalDuration(keyframes) {
  if (!keyframes.length) return 0;
  let total = leadIn(keyframes);
  for (let i = 1; i < keyframes.length; i++) {
    total += Math.max(0.1, Number(keyframes[i].duration) || 0);
  }
  return total;
}

/** Início absoluto (s) de cada keyframe. */
export function keyframeTimes(keyframes) {
  const times = [leadIn(keyframes)];
  for (let i = 1; i < keyframes.length; i++) {
    times.push(times[i - 1] + Math.max(0.1, Number(keyframes[i].duration) || 0));
  }
  return times;
}

/** Início do trecho que chega no keyframe `i` (onde a narração dele começa). */
export function segmentStart(keyframes, i) {
  if (i <= 0) return 0;
  const times = keyframeTimes(keyframes);
  return times[i - 1] || 0;
}

/** Duração do trecho do keyframe `i`. */
export function segmentLength(keyframes, i) {
  if (i <= 0) return leadIn(keyframes);
  return Math.max(0.1, Number(keyframes[i]?.duration) || 0);
}

/**
 * Amostra a câmera em um instante t (segundos).
 * Retorna { center, zoom, pitch, bearing }, ou null se não há keyframes.
 *
 * Cada keyframe que chega define o "movimento" do trecho (motion) e a
 * "suavidade" (ease) usada na interpolação.
 */
export function sampleAt(keyframes, t) {
  if (!keyframes.length) return null;
  if (keyframes.length === 1) return { ...keyframes[0].camera };

  const times = keyframeTimes(keyframes);
  const total = times[times.length - 1];
  const time = Math.min(Math.max(t, 0), total);

  // localiza o segmento
  let i = 1;
  while (i < times.length - 1 && time > times[i]) i++;

  const a = keyframes[i - 1];
  const b = keyframes[i];
  const span = times[i] - times[i - 1] || 1;
  const raw = Math.min(Math.max((time - times[i - 1]) / span, 0), 1);
  const ease = EASINGS[b.ease] || EASINGS.easeInOut;
  const motion = b.motion || "smooth";
  let p = ease(raw);

  // movimentos que alteram o andamento do trecho
  if (motion === "dwell") {
    // fica parado no início e corre no fim
    p = p <= 0.55 ? 0 : EASINGS.easeInOut((p - 0.55) / 0.45);
  }

  const dLng = shortestAngle(a.camera.center[0], b.camera.center[0]);
  const dLat = b.camera.center[1] - a.camera.center[1];
  let lng = a.camera.center[0] + dLng * p;
  let lat = a.camera.center[1] + dLat * p;

  // zoom: suave usa escala logarítmica (mais natural), linear usa reta
  let zoom = lerp(a.camera.zoom, b.camera.zoom, p);
  const logZoom =
    motion === "smooth" || motion === "arc" || motion === "orbit" ||
    motion === "spin" || motion === "dive" || motion === "topdown" ||
    motion === "bounce" || motion === "sweep";
  if (logZoom) {
    zoom = Math.exp(lerp(Math.log(Math.max(0.2, a.camera.zoom)), Math.log(Math.max(0.2, b.camera.zoom)), p));
  }

  let bearing = a.camera.bearing + shortestAngle(a.camera.bearing || 0, b.camera.bearing || 0) * p;
  let pitch = lerp(a.camera.pitch || 0, b.camera.pitch || 0, p);

  if (motion === "orbit") {
    // meia volta extra durante o voo
    bearing += 180 * Math.sin(Math.PI * p);
  } else if (motion === "spin") {
    // uma volta completa, terminando na rotação do keyframe
    bearing += 360 * p;
  } else if (motion === "dive") {
    // mergulho: segura longe e aproxima rápido no fim
    const dive = Math.pow(p, 2.2);
    zoom = Math.exp(
      lerp(
        Math.log(Math.max(0.2, a.camera.zoom)),
        Math.log(Math.max(0.2, b.camera.zoom)),
        dive,
      ),
    );
  } else if (motion === "arc") {
    // curva: desloca o caminho na perpendicular
    const len = Math.hypot(dLng, dLat) || 1;
    const off = 0.2 * len * Math.sin(Math.PI * p);
    lng += (-dLat / len) * off;
    lat += (dLng / len) * off;
  } else if (motion === "punch") {
    // "soco": passa do zoom e volta
    const overshoot = 1 + 0.22 * Math.sin(Math.PI * Math.min(1, p * 1.15));
    zoom = lerp(a.camera.zoom, b.camera.zoom, p) * overshoot;
  } else if (motion === "topdown") {
    // chega "de cima": a inclinação zera no destino e o zoom desacelera
    pitch = lerp(a.camera.pitch || 0, 0, EASINGS.easeOut(p));
    const out = Math.exp(
      lerp(
        Math.log(Math.max(0.2, a.camera.zoom)),
        Math.log(Math.max(0.2, b.camera.zoom)),
        EASINGS.easeOut(p),
      ),
    );
    zoom = out;
  } else if (motion === "bounce") {
    // quique: dois saltos de zoom que morrem no destino
    const damp = (1 - p) * (1 - p);
    const hop = Math.sin(p * Math.PI * 2) * damp * 0.28;
    zoom *= 1 + hop;
    const len = Math.hypot(dLng, dLat) || 1;
    lat += (dLat / len) * hop * 0.12;
  } else if (motion === "sweep") {
    // varredura lateral, como um travelling de cinema
    const len = Math.hypot(dLng, dLat) || 1;
    const off = 0.55 * len * Math.sin(Math.PI * p);
    lng += (-dLat / len) * off;
    lat += (dLng / len) * off;
    bearing += 18 * Math.sin(Math.PI * p);
  }

  return {
    center: [((lng + 540) % 360) - 180, lat],
    zoom,
    pitch,
    bearing,
  };
}

/** Opacidade do texto: entra no começo, sai no fim. */
export function textOpacityAt(t, total, fade = 0.6) {
  if (total <= 0) return 1;
  if (t < fade) return t / fade;
  if (t > total - fade) return Math.max(0, (total - t) / fade);
  return 1;
}

/**
 * Transição no instante t: retorna { color, alpha } ou null.
 * A transição de um keyframe acontece em volta do instante em que ele chega.
 */
export function transitionAt(keyframes, t) {
  if (keyframes.length < 2) return null;
  const times = keyframeTimes(keyframes);

  for (let i = 1; i < keyframes.length; i++) {
    const kind = keyframes[i].transition || "none";
    if (kind === "none") continue;

    const half = kind === "flash" ? 0.22 : kind === "wipe" ? 0.55 : 0.42;
    const dist = Math.abs(t - times[i]);
    if (dist >= half) continue;

    const alpha = 1 - dist / half;
    return {
      kind,
      color: kind === "fadeBlack" ? "#05070b" : kind === "wipe" ? "#0b0d12" : "#ffffff",
      alpha: kind === "flash" ? alpha * 0.85 : alpha,
      // cortina: entra cobrindo antes do keyframe e sai revelando depois
      dir: t < times[i] ? "in" : "out",
    };
  }
  return null;
}

export function formatSeconds(s) {
  return `${s.toFixed(1).replace(".", ",")} s`;
}

/**
 * Opacidade de uma sobreposição de mídia no instante t: entra e sai em fade
 * curto e fica cheia no meio.
 *
 * @param {{start:number,end:number,opacity?:number}} ov
 */
export function overlayAlphaAt(ov, t) {
  const start = Number(ov.start) || 0;
  const end = Number(ov.end) || 0;
  if (end <= start || t < start || t > end) return 0;

  const total = end - start;
  const fade = Math.min(0.45, total / 3);
  let a = 1;
  if (t < start + fade) a = (t - start) / fade;
  else if (t > end - fade) a = (end - t) / fade;

  a = Math.max(0, Math.min(1, a));
  const base = ov.opacity == null ? 1 : Math.max(0, Math.min(1, Number(ov.opacity)));
  return a * base;
}
