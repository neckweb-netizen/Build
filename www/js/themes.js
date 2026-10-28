/**
 * Temas visuais do mapa.
 *
 * Cada tema é um filtro (aplicado no elemento do mapa na prévia e no
 * `ctx.filter` na exportação) mais uma camada de tingimento. Assim o mesmo
 * visual sai igual no celular e no vídeo, sem recarregar o estilo do MapLibre.
 */

import { keyframeTimes } from "./timeline.js";

export const THEMES = [
  {
    id: "natural",
    label: "Satélite (padrão)",
    filter: "none",
    tint: null,
  },
  {
    id: "claro",
    label: "Claro",
    filter: "brightness(1.35) saturate(.7) contrast(.9)",
    tint: { color: "#eef4ff", alpha: 0.2 },
  },
  {
    id: "escuro",
    label: "Escuro",
    filter: "brightness(.52) saturate(.6) contrast(1.12)",
    tint: { color: "#04070d", alpha: 0.28 },
  },
  {
    id: "sepia",
    label: "Sépia",
    filter: "sepia(.85) saturate(.7) brightness(1.06) contrast(.95)",
    tint: { color: "#f0d9a8", alpha: 0.1 },
  },
  {
    id: "planta",
    label: "Planta azul",
    filter: "grayscale(1) brightness(.8) contrast(1.05) sepia(1) hue-rotate(165deg) saturate(2.4)",
    tint: { color: "#0a2b4a", alpha: 0.3 },
  },
];

export const THEME_OPTIONS = [
  { id: "", label: "Herdar do projeto" },
  ...THEMES.map((t) => ({ id: t.id, label: t.label })),
];

export function themeById(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

/**
 * Tema em vigor no instante t: o último keyframe que já chegou e define um
 * tema; se nenhum definir, vale o tema do projeto.
 *
 * @param {Array} keyframes
 * @param {string} fallbackId tema do projeto
 * @param {number} t segundos
 */
export function themeAt(keyframes, fallbackId, t) {
  let id = fallbackId || "natural";
  const time = Number(t) || 0;
  const times = keyframeTimes(keyframes || []);
  for (let i = 0; i < (keyframes?.length || 0); i++) {
    // o primeiro keyframe já vale desde o início (é o quadro de abertura)
    const at = i === 0 ? 0 : times[i];
    if (time + 0.001 < at) break;
    if (keyframes[i].theme) id = keyframes[i].theme;
  }
  return themeById(id);
}

/** Filtro CSS do tema, ou null quando não há nada a aplicar. */
export function themeFilter(theme) {
  if (!theme || !theme.filter || theme.filter === "none") return null;
  return theme.filter;
}
