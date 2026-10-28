import {
  totalDuration,
  keyframeTimes,
  segmentStart,
  segmentLength,
  sampleAt,
  textOpacityAt,
  transitionAt,
  overlayAlphaAt,
  formatSeconds,
  EASE_OPTIONS,
  MOTION_OPTIONS,
  TRANSITION_OPTIONS,
} from "./timeline.js";
import { renderVideo, isExportSupported } from "./recorder.js";
import { saveVideoFile } from "./saver.js";
import { drawGraphics, haversineKm, formatKm } from "./gfx.js";
import {
  loadFlag,
  flagImage,
  isoForCountry,
  preloadFlags,
} from "./flags.js";
import { THEMES, THEME_OPTIONS, themeById, themeAt, themeFilter } from "./themes.js";
import { AudioEngine, SFX_TYPES, sfxLabel } from "./audio.js";
import {
  putMedia,
  mediaURL,
  forgetURL,
  probeDuration,
  pruneMedia,
} from "./media.js";
import {
  normalize,
  bboxOfGeometry,
  buildCountryIndex,
  buildStateIndex,
  buildCityIndex,
  buildMunicipalityIndex,
  loadCityRows,
  search,
  zoomForBbox,
} from "./search.js";

const STORAGE_KEY = "mapcine.project.v1";

/**
 * Base do mapa: imagem de satélite (mesma textura do Google Earth), com os
 * nomes desenhados por nós em português. O estilo é montado aqui dentro para
 * não depender de um estilo pronto de terceiros — só os tiles e a fonte dos
 * rótulos vêm de fora.
 */
const SAT_TILES = [
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
];
const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

const MAP_STYLE = {
  version: 8,
  glyphs: GLYPHS,
  sources: {
    satelite: {
      type: "raster",
      tiles: SAT_TILES,
      tileSize: 256,
      maxzoom: 19,
      attribution:
        'Imagens © <a href="https://www.esri.com">Esri</a>, Maxar, Earthstar Geographics',
    },
  },
  layers: [
    { id: "fundo", type: "background", paint: { "background-color": "#05070b" } },
    {
      id: "satelite",
      type: "raster",
      source: "satelite",
      paint: { "raster-opacity": 1, "raster-fade-duration": 250 },
    },
  ],
};

const BASE_FILL = "#16233a";

/* ------------------------------------------------------------------ *
 * Estado
 * ------------------------------------------------------------------ */
const defaults = () => ({
  text: {
    heading: "",
    sub: "",
    color: "#f4e7c4",
    size: 42,
    position: "pos-bottom",
    shadow: true,
  },
  countries: {}, // { "Brazil": { color, opacity, fill, borderColor, borderWidth, glow, pulse, label } }
  states: {}, // { "BR-SP": { ... } }
  cities: {}, // { "c3448439": { name, lat, lon, color, mode: area|pin|both } }
  keyframes: [],
  overlays: [], // { id, mediaId, kind, name, x, y, scale, opacity, rotation, start, end }
  routes: [], // { id, from:[lon,lat], to:[lon,lat], fromName, toName, curve, color, width, start, end, ... }
  conflicts: [], // { id, atkKind, atkId, defKind, defId, result, start, duration, bomb, sound }
  regions: [], // { id, coords:[[lon,lat]], color, opacity, borderColor, borderWidth, glow, label }
  mapTheme: "natural",
  export: { res: "1920x1080", fps: 30 },
  audio: {
    enabled: true,
    source: "none", // none | ambient | file
    musicVolume: 0.45,
    sfxVolume: 0.85,
    narrationVolume: 1,
    duck: true,
    gap: 0.8, // intervalo depois da narração em cada cena
    offset: 0, // ajuste fino da narração em milissegundos
    events: [], // { id, type, time }
    imports: [], // efeitos importados { mediaId, name, duration }
  },
});

let state = defaults();
let playing = false;

/** Estado da linha do tempo (escala, cursor, seleção). */
const TL = { pps: 46, time: 0, selected: null };

/* Mídia carregada para a prévia: overlayId -> <img>/<video> */
const overlayEls = new Map();
let selectedOverlay = null;

const audio = new AudioEngine();
window.audio = audio; // inspeção em testes

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state = { ...defaults(), ...parsed };
    state.text = { ...defaults().text, ...(parsed.text || {}) };
    state.export = { ...defaults().export, ...(parsed.export || {}) };
    state.audio = { ...defaults().audio, ...(parsed.audio || {}) };
    state.audio.events = Array.isArray(state.audio.events)
      ? state.audio.events
          .filter((ev) => ev && ev.type && Number.isFinite(Number(ev.time)))
          .map((ev, i) => ({
            id: ev.id || `sfx_${i}`,
            type: ev.type,
            time: Math.max(0, Number(ev.time) || 0),
          }))
      : [];
    state.countries = parsed.countries || {};
    state.states = parsed.states || {};
    state.cities = parsed.cities || {};
    state.mapTheme = parsed.mapTheme || "natural";
    state.routes = Array.isArray(parsed.routes)
      ? parsed.routes
          .filter((r) => Array.isArray(r?.from) && Array.isArray(r?.to))
          .map((r, i) => ({
            id: r.id || `rt_${i}`,
            from: [Number(r.from[0]), Number(r.from[1])],
            to: [Number(r.to[0]), Number(r.to[1])],
            fromName: r.fromName || "Origem",
            toName: r.toName || "Destino",
            curve: Number.isFinite(r.curve) ? r.curve : 0.25,
            color: r.color || "#ffffff",
            width: Number(r.width) || 4.5,
            start: Number(r.start) || 0,
            end: Number(r.end) || 0,
            drawTime: Number(r.drawTime) || 1.4,
            arrow: r.arrow !== false,
            showLabel: r.showLabel !== false,
            labelText: r.labelText || "",
          }))
      : [];
    state.regions = Array.isArray(parsed.regions)
      ? parsed.regions
          .filter((r) => Array.isArray(r?.coords) && r.coords.length >= 3)
          .map((r, i) => ({
            id: r.id || `rg_${i}`,
            coords: r.coords.map((c) => [Number(c[0]), Number(c[1])]),
            color: r.color || "#e0a83c",
            opacity: Number.isFinite(r.opacity) ? r.opacity : 0.55,
            borderColor: r.borderColor || "#ffffff",
            borderWidth: Number.isFinite(r.borderWidth) ? r.borderWidth : 3,
            glow: r.glow !== false,
            label: r.label || "",
          }))
      : [];
    state.conflicts = Array.isArray(parsed.conflicts)
      ? parsed.conflicts.map((c, i) => normalizeConflict(c, i))
      : [];
    state.audio.imports = Array.isArray(state.audio.imports)
      ? state.audio.imports.filter((imp) => imp && imp.mediaId).map((imp) => ({
          mediaId: imp.mediaId,
          name: imp.name || "Som importado",
          duration: Number(imp.duration) || 0,
        }))
      : [];
    state.overlays = Array.isArray(parsed.overlays)
      ? parsed.overlays
          .filter((ov) => ov && ov.mediaId)
          .map((ov, i) => ({
            id: ov.id || `ov_${i}`,
            mediaId: ov.mediaId,
            kind: ov.kind || "image",
            name: ov.name || "Mídia",
            x: Number.isFinite(ov.x) ? ov.x : 0.5,
            y: Number.isFinite(ov.y) ? ov.y : 0.5,
            scale: Number.isFinite(ov.scale) ? ov.scale : 0.4,
            opacity: Number.isFinite(ov.opacity) ? ov.opacity : 1,
            rotation: Number(ov.rotation) || 0,
            start: Number(ov.start) || 0,
            end: Number(ov.end) || 5,
          }))
      : [];
    state.keyframes = (Array.isArray(parsed.keyframes) ? parsed.keyframes : []).map((kf) => ({
      motion: "smooth",
      transition: "none",
      ease: "easeInOut",
      theme: "",
      ...kf,
      narration: kf.narration && kf.narration.mediaId ? kf.narration : null,
    }));
  } catch (e) {
    console.warn("Falha ao carregar projeto salvo", e);
  }
}

function save() {
  recordHistory();
  persist();
  scheduleGfx();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("Falha ao salvar", e);
  }
}

/* ------------------------------------------------------------------ *
 * Desfazer / refazer
 *
 * Cada alteração salva gera um ponto no histórico. Alterações seguidas em
 * menos de 400 ms (arrastar um controle de cor, por exemplo) contam como uma
 * só, para o desfazer não voltar pixel a pixel.
 * ------------------------------------------------------------------ */
const HISTORY_LIMIT = 60;
let undoStack = [];
let redoStack = [];
let lastCommitted = null; // estado no último ponto do histórico
let historyTimer = null;
let historyLocked = false; // evita gravar histórico ao aplicar um estado

function commitHistory() {
  clearTimeout(historyTimer);
  historyTimer = null;
  const now = JSON.stringify(state);
  if (lastCommitted === null) {
    lastCommitted = now;
    updateHistoryButtons();
    return;
  }
  if (now === lastCommitted) {
    updateHistoryButtons();
    return;
  }
  undoStack.push(lastCommitted);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  lastCommitted = now;
  updateHistoryButtons();
}

function recordHistory() {
  if (historyLocked) return;
  const now = JSON.stringify(state);
  if (now === lastCommitted) return;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(commitHistory, 400);
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const undoBtn = $("#btn-undo");
  const redoBtn = $("#btn-redo");
  if (undoBtn) undoBtn.disabled = !undoStack.length && historyTimer === null;
  if (redoBtn) redoBtn.disabled = !redoStack.length;
}

function applyHistory(json) {
  historyLocked = true;
  const parsed = JSON.parse(json);
  state = { ...defaults(), ...parsed };
  state.text = { ...defaults().text, ...(parsed.text || {}) };
  state.export = { ...defaults().export, ...(parsed.export || {}) };
  state.audio = { ...defaults().audio, ...(parsed.audio || {}) };
  state.countries = parsed.countries || {};
  state.states = parsed.states || {};
  state.cities = parsed.cities || {};
  state.keyframes = Array.isArray(parsed.keyframes) ? parsed.keyframes : [];
  state.conflicts = Array.isArray(parsed.conflicts)
    ? parsed.conflicts.map((c, i) => normalizeConflict(c, i))
    : [];

  persist();
  renderAll();
  historyLocked = false;
  lastCommitted = json;
  updateHistoryButtons();
}

function undo() {
  commitHistory();
  if (!undoStack.length) {
    toast("Nada para desfazer");
    return;
  }
  const prev = undoStack.pop();
  redoStack.push(JSON.stringify(state));
  applyHistory(prev);
}

function redo() {
  commitHistory();
  if (!redoStack.length) {
    toast("Nada para refazer");
    return;
  }
  const next = redoStack.pop();
  undoStack.push(JSON.stringify(state));
  applyHistory(next);
}

/** Redesenha tudo que depende do estado do projeto. */
function renderAll() {
  applyAllCountries();
  applyAllStates();
  renderSelectedCities();
  renderSelection();
  renderKeyframes();
  syncTextUI();
  applyTextToDOM();
  syncAudioUI();
  renderOverlayList();
  prepareOverlayMedia().then(() => syncOverlaysDOM(TL.time || 0));
  renderTimeline();
  updateExportSummary();
  renderPlaceStyle();
  renderRouteSelects();
  renderRouteList();
  fillRouteEditor();
  renderConflictSelects();
  renderConflictList();
  fillConflictEditor();
  renderRegionList();
  fillRegionEditor();
  syncRegionControls();
  applyTheme(themeNow(TL.time || 0));
  scheduleGfx();
}

/* ------------------------------------------------------------------ *
 * Helpers de UI
 * ------------------------------------------------------------------ */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

/* ------------------------------------------------------------------ *
 * Mapa
 * ------------------------------------------------------------------ */
let countriesById = new Map(); // id (NAME) -> feature properties
let statesById = new Map(); // id (ISO 3166-2) -> registro
let citiesById = new Map(); // id ("c3448439" ou "m2927408") -> registro
let countryGeom = new Map(); // id (NAME) -> geometria (para desenhar no canvas)
let stateGeom = new Map(); // id (ISO 3166-2) -> geometria
let municipalityByCode = new Map(); // código IBGE -> registro
let countryIndex = [];
let stateIndex = [];
let cityIndex = [];
let municipalityIndex = [];
let searchIndex = [];
let appliedMunis = new Set();
let labelLayerId = null;
let labelPoints = [];

const map = (window.map = new maplibregl.Map({
  container: "map",
  style: MAP_STYLE,
  center: [10, 25],
  zoom: 2.2,
  pitch: 0,
  bearing: 0,
  attributionControl: { compact: true },
  maxPitch: 75,
  dragRotate: true,
}));

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
map.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: "metric" }), "bottom-left");

// mantém o canvas do mapa do tamanho do container (painel, orientação, export)
const mapResizeObserver = new ResizeObserver(() => map.resize());
mapResizeObserver.observe(document.getElementById("map"));

map.on("error", (e) => {
  console.warn("Erro no mapa:", e?.error?.message || e);
});

/* ------------------------------------------------------------------ *
 * Camadas de desenho: bandeiras, contornos, afinetes, rotas e regiões
 *
 * Tudo é desenhado em um canvas sobre o mapa, em coordenadas de tela. A
 * exportação usa o mesmo `buildGfxModel` e a mesma função de desenho, só
 * trocando a escala — o que aparece na prévia é o que sai no vídeo.
 * ------------------------------------------------------------------ */
const gfxCanvas = $("#overlay-map");
const gfxCtx = gfxCanvas.getContext("2d");
let gfxQueued = false;
let exporting = false;
let currentThemeKey = null;
let styleTarget = null;

const PLACE_STYLE_DEFAULTS = {
  fill: "color",
  styled: false,
  color: "#e0a83c",
  opacity: 0.65,
  borderColor: "#ffffff",
  borderWidth: 3.5,
  glow: 60, // 0..100
  pulse: false,
  label: false,
  mode: "area",
};

function placeStyle(rec) {
  return { ...PLACE_STYLE_DEFAULTS, ...(rec || {}) };
}

/** Preenchimento/contorno desenhado no canvas (o MapLibre fica transparente). */
function canvasStyled(sel) {
  if (!sel) return false;
  return Boolean(sel.styled) || Boolean(sel.pulse) || Boolean(sel.fill && sel.fill !== "color");
}

function scheduleGfx() {
  if (gfxQueued) return;
  gfxQueued = true;
  requestAnimationFrame(() => {
    gfxQueued = false;
    if (!exporting) drawGfxPreview(TL.time || 0);
  });
}

function resizeGfxCanvas() {
  const rect = gfxCanvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (gfxCanvas.width !== w || gfxCanvas.height !== h) {
    gfxCanvas.width = w;
    gfxCanvas.height = h;
  }
  gfxCanvas._cssW = rect.width;
  gfxCanvas._cssH = rect.height;
  gfxCanvas._dpr = dpr;
}

function previewGfxView() {
  const width = gfxCanvas._cssW || gfxCanvas.clientWidth || 1;
  return {
    width,
    height: gfxCanvas._cssH || gfxCanvas.clientHeight || 1,
    // tamanhos são pensados para um vídeo de 1080 px de largura
    scale: width / 1080,
    centerLng: map.getCenter().lng,
    project: ([lng, lat]) => {
      const p = map.project([lng, lat]);
      return [p.x, p.y];
    },
  };
}

function drawGfxPreview(t = 0) {
  resizeGfxCanvas();
  const dpr = gfxCanvas._dpr || 1;
  gfxCtx.setTransform(1, 0, 0, 1, 0, 0);
  gfxCtx.clearRect(0, 0, gfxCanvas.width, gfxCanvas.height);
  gfxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawGraphics(gfxCtx, previewGfxView(), buildGfxModel(t), t);
}

/** Posição do rótulo de um estado (mesma usada pelo mapa). */
function stateLabelSpot(id) {
  const rec = statesById.get(id);
  if (!rec) return null;
  return labelSpotFor({ _bbox: rec.bbox, lat: rec.lat, lon: rec.lon });
}

/** Modelo único de tudo que é desenhado sobre o mapa. */
function buildGfxModel(t = 0) {
  const model = { fills: [], outlines: [], routes: [], regions: [], labels: [], pins: [], marks: [], battles: [] };
  const animate = playing || exporting;
  const total = totalDuration(state.keyframes);

  /* ---- conflitos: quem ataca quem e o que acontece com o território ---- */
  const { effects: placeEffect, battles } = battleEffectsAt(t);
  model.battles = battles;

  const pushPlace = (sel, geometry, iso, name, spot, key) => {
    const st = placeStyle(sel);
    const fx = key ? placeEffect.get(key) : null;
    let color = st.color;
    let borderColor = st.borderColor;
    let pulse = st.pulse;
    let solid = false;

    if (fx) {
      if (fx.battle) {
        const s = battleStyleFor(fx, {
          color: st.color,
          borderColor: st.borderColor,
          alpha: st.opacity,
          pulse: st.pulse,
        });
        color = s.color;
        borderColor = s.borderColor;
        pulse = s.pulse;
        solid = fx.role === "def" && fx.battle.result === "win";
      } else if (fx.color) {
        color = fx.color;
        solid = true;
      }
    }

    if (canvasStyled(sel)) {
      if (st.fill !== "none") {
        if (st.fill === "flag" && iso && !flagImage(iso)) {
          // primeira exibição depois de abrir o projeto: carrega e redesenha
          loadFlag(iso).then(() => scheduleGfx());
        }
        model.fills.push({
          fill: solid ? "solid" : st.fill === "color" ? "solid" : st.fill,
          geometry,
          image: solid ? null : flagImage(iso),
          color,
          color2: sel.color2,
          alpha: st.opacity,
        });
      }
      model.outlines.push({
        geometry,
        borderColor,
        borderWidth: st.borderWidth,
        glow: Number(st.glow) > 0,
        glowBlur: 6 + Number(st.glow) * 0.18,
        pulse,
        alpha: 1,
      });
    }
    if (st.label && spot) {
      model.labels.push({ lon: spot[0], lat: spot[1], text: name, size: 30, alpha: 1 });
    }
  };

  for (const [id, sel] of Object.entries(state.countries)) {
    const props = countriesById.get(id);
    const geometry = countryGeom.get(id);
    if (!props || !geometry) continue;
    pushPlace(
      sel,
      geometry,
      isoForCountry(props),
      props.NAME_PT || props.NAME || id,
      labelSpotFor(props),
      `country:${id}`,
    );
  }

  for (const [id, sel] of Object.entries(state.states)) {
    const rec = statesById.get(id);
    const geometry = stateGeom.get(id);
    if (!rec || !geometry) continue;
    pushPlace(sel, geometry, "", rec.name || id, stateLabelSpot(id), `state:${id}`);
  }

  for (const [, c] of Object.entries(state.cities)) {
    const mode = c.mode === "pin" || c.mode === "both" ? c.mode : "area";
    if (mode !== "pin" && mode !== "both") continue;
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    model.pins.push({
      lon: c.lon,
      lat: c.lat,
      name: c.name,
      color: c.color || "#e0a83c",
      size: 12,
      labelSize: 26,
      pulse: c.pulse !== false,
      showLabel: c.label !== false,
      labelColor: "#ffffff",
      alpha: 1,
    });
  }

  for (const rt of state.routes) {
    if (!Array.isArray(rt.from) || !Array.isArray(rt.to)) continue;
    const start = routeStartTime(rt);
    const end = routeEndTime(rt, start);
    let alpha = 1;
    let progress = 1;
    if (animate) {
      if (t < start || (end > start && t > end)) continue;
      const drawTime = Math.max(0.25, Number(rt.drawTime) || 1.4);
      progress = Math.min(1, (t - start) / drawTime);
      alpha = Math.min(1, Math.max(0, (end - t) / 0.35));
      if (progress <= 0.001 || alpha <= 0) continue;
    }
    model.routes.push({
      from: rt.from,
      to: rt.to,
      curve: rt.curve,
      color: rt.color || "#ffffff",
      width: rt.width,
      arrow: rt.arrow !== false,
      label: rt.showLabel !== false,
      labelText: rt.labelText || formatKm(haversineKm(rt.from, rt.to)),
      km: haversineKm(rt.from, rt.to),
      progress,
      alpha,
    });
  }

  for (const rg of state.regions) {
    if (!Array.isArray(rg.coords) || rg.coords.length < 3) continue;
    model.regions.push({
      coords: rg.coords,
      color: rg.color,
      opacity: rg.opacity,
      borderColor: rg.borderColor,
      borderWidth: rg.borderWidth,
      glow: rg.glow !== false,
      label: rg.label,
      alpha: 1,
    });
  }

  if (regionDraft.active && regionDraft.coords.length) {
    const d = regionDraft.defaults;
    model.regions.push({
      coords: regionDraft.coords,
      draft: true,
      color: d.color,
      opacity: d.opacity,
      borderColor: d.borderColor,
      borderWidth: d.borderWidth ?? 3,
      label: "",
      alpha: 1,
    });
    model.marks = regionDraft.coords.map(([lon, lat]) => ({ lon, lat }));
  }

  return model;
}

map.on("move", scheduleGfx);
map.on("resize", scheduleGfx);
map.on("idle", scheduleGfx);

/* ---------- tema do mapa ---------- */
function applyTheme(theme) {
  const th = typeof theme === "string" ? themeById(theme) : theme;
  if (!th) return;
  if (th.id === currentThemeKey) return;
  currentThemeKey = th.id;
  const mapEl = $("#map");
  mapEl.style.filter = th.filter === "none" ? "" : th.filter;
  const tint = $("#theme-tint");
  if (tint) {
    tint.style.background = th.tint ? th.tint.color : "transparent";
    tint.style.opacity = th.tint ? String(th.tint.alpha) : "0";
  }
}

function themeNow(t = 0) {
  return themeAt(state.keyframes, state.mapTheme, t);
}

function mapFilterNow(t) {
  return themeFilter(themeNow(t));
}

function mapTintNow(t) {
  return themeNow(t).tint;
}

/* ---------- estilo por lugar ---------- */
function styleRecord(target) {
  if (!target) return null;
  if (target.kind === "country") return state.countries[target.id] || null;
  if (target.kind === "state") return state.states[target.id] || null;
  return state.cities[target.id] || null;
}

function styleName(target) {
  if (!target) return "";
  if (target.kind === "country") return countryLabel(target.id);
  if (target.kind === "state") return stateLabel(target.id);
  return state.cities[target.id]?.name || target.id;
}

function firstSelected() {
  const c = Object.keys(state.countries)[0];
  if (c) return { kind: "country", id: c };
  const s = Object.keys(state.states)[0];
  if (s) return { kind: "state", id: s };
  const ci = Object.keys(state.cities)[0];
  if (ci) return { kind: "city", id: ci };
  return null;
}

function ensureStyleTarget() {
  const rec = styleRecord(styleTarget);
  if (rec) return styleTarget;
  styleTarget = firstSelected();
  return styleTarget;
}

function applyPlaceStyle(target) {
  if (!target) return;
  if (target.kind === "country") applyCountry(target.id);
  else if (target.kind === "state") applyState(target.id);
  else renderSelectedCities();
}

function renderPlaceStyle() {
  const panel = $("#place-style");
  if (!panel) return;
  const target = ensureStyleTarget();
  const rec = styleRecord(target);
  const nameEl = $("#ps-name");

  const inputs = $$("#place-style select, #place-style input");
  for (const el of inputs) el.disabled = !rec;

  if (!rec) {
    nameEl.textContent = "—";
    $("#ps-hint").textContent =
      "Marque um país, estado ou cidade na busca para editar bandeira, contorno e alfinete.";
    $("#ps-pin-field").hidden = true;
    return;
  }

  const st = placeStyle(rec);
  nameEl.textContent = styleName(target);
  $("#ps-fill").value = st.fill || "color";
  $("#ps-border").value = st.borderColor || "#ffffff";
  $("#ps-width").value = String(st.borderWidth ?? 3.5);
  $("#ps-width-label").textContent = String(st.borderWidth ?? 3.5).replace(".", ",");
  $("#ps-glow").value = String(st.glow ?? 60);
  $("#ps-glow-label").textContent = `${Math.round(st.glow ?? 60)}%`;
  $("#ps-pulse").checked = Boolean(st.pulse);
  $("#ps-label").checked = Boolean(st.label);
  $("#ps-pin-field").hidden = target.kind !== "city";
  if (target.kind === "city") $("#ps-mode").value = st.mode || "area";

  const hints = {
    flag: "A bandeira é recortada pela forma do território e fica embutida no app.",
    stripes: "Listras diagonais na cor do lugar.",
    gradient: "Degradê da cor do lugar para o branco.",
    none: "Só o contorno aparece.",
    color: "Cor lisa, desenhada pelo mapa. Mude contorno/brilho para o desenho assumir.",
  };
  $("#ps-hint").textContent =
    target.kind === "city" && (st.mode === "pin" || st.mode === "both")
      ? "Cidade em alfinete: o ponto aparece sobre o mapa e o nome vem junto."
      : hints[st.fill] || hints.color;
}

function setPlaceStyle(patch) {
  const target = ensureStyleTarget();
  const rec = styleRecord(target);
  if (!rec) {
    toast("Selecione um lugar na lista primeiro.");
    return;
  }
  Object.assign(rec, patch);
  if (patch.fill === "flag" && target.kind === "country") {
    const iso = isoForCountry(countriesById.get(target.id));
    loadFlag(iso).then(() => scheduleGfx());
  }
  applyPlaceStyle(target);
  renderPlaceStyle();
  save();
}

/* ------------------------------------------------------------------ *
 * Rotas
 * ------------------------------------------------------------------ */
let selectedRouteId = null;

function routeTimeMax() {
  return Math.max(6, Math.ceil(totalDuration(state.keyframes)));
}

function placeAnchor(place) {
  if (Number.isFinite(place.lon) && Number.isFinite(place.lat)) return [place.lon, place.lat];
  if (place.bbox) {
    return [(place.bbox[0] + place.bbox[2]) / 2, (place.bbox[1] + place.bbox[3]) / 2];
  }
  return null;
}

function currentRoute() {
  return state.routes.find((r) => r.id === selectedRouteId) || null;
}

/* ------------------------------------------------------------------ *
 * A rota espera a câmera
 *
 * Uma rota tem coordenadas fixas no mapa. Se ela começa antes de a câmera
 * chegar ao lugar, o traço cresce fora de quadro e o vídeo perde o efeito.
 * Aqui descobrimos o primeiro instante em que a câmera enquadra a rota e a
 * animação (e o som) passam a começar ali.
 * ------------------------------------------------------------------ */

const mercY = (lat) =>
  0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);
const invMercY = (y) =>
  (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - 2 * y)));

/** Tamanho do vídeo final: é nele que a câmera precisa enquadrar a rota. */
function exportFrameSize() {
  const [w, h] = String(state.export.res || "1080x1920").split("x").map(Number);
  return { w: w > 0 ? w : 1080, h: h > 0 ? h : 1920 };
}

/**
 * Retângulo visível (em graus) de uma câmera de keyframe, no enquadramento do
 * vídeo exportado. Fórmula do MapLibre: 360° * largura / (512 * 2^zoom).
 */
function cameraFrame(cam, size) {
  const zoom = Number.isFinite(cam?.zoom) ? cam.zoom : map.getZoom();
  const lonSpan = Math.max(0.0005, (360 * size.w) / (512 * Math.pow(2, zoom)));
  const latSpan = (size.h / size.w) * (lonSpan / 360);
  const [lng, lat] = cam?.center || map.getCenter().toArray();
  const yc = mercY(Math.max(-85, Math.min(85, lat)));
  return {
    west: lng - lonSpan / 2,
    east: lng + lonSpan / 2,
    north: invMercY(Math.max(0, yc - latSpan / 2)),
    south: invMercY(Math.min(1, yc + latSpan / 2)),
  };
}

function insideFrame(frame, [lng, lat], pad = 0.08) {
  const dx = (frame.east - frame.west) * pad;
  const dy = (frame.north - frame.south) * pad;
  return (
    lng >= frame.west + dx &&
    lng <= frame.east - dx &&
    lat >= frame.south + dy &&
    lat <= frame.north - dy
  );
}

let routeArrivalCache = { sig: "", times: new Map() };

function routeArrivalKey() {
  return [
    state.keyframes.map((kf) => JSON.stringify(kf.camera)).join(";"),
    totalDuration(state.keyframes).toFixed(2),
    String(state.export.res || ""),
  ].join("|");
}

/** Primeiro instante em que a câmera mostra a rota (0 se já começa nela). */
function routeArrivalTime(rt) {
  if (!Array.isArray(rt.from) || !Array.isArray(rt.to)) return 0;
  if (!state.keyframes.length) return 0;
  const total = totalDuration(state.keyframes);
  if (total <= 0) return 0;

  const sig = routeArrivalKey();
  if (routeArrivalCache.sig !== sig) {
    routeArrivalCache = { sig, times: new Map() };
  }
  const key = `${rt.from[0]},${rt.from[1]}|${rt.to[0]},${rt.to[1]}`;
  if (routeArrivalCache.times.has(key)) return routeArrivalCache.times.get(key);

  const size = exportFrameSize();
  const mid = [(rt.from[0] + rt.to[0]) / 2, (rt.from[1] + rt.to[1]) / 2];
  const step = 0.05;
  let bestTime = 0;
  let bestScore = -1;

  for (let t = 0; t <= total + 1e-6; t += step) {
    const cam = sampleAt(state.keyframes, t);
    if (!cam) break;
    const frame = cameraFrame(cam, size);
    const score =
      (insideFrame(frame, rt.from) ? 1 : 0) +
      (insideFrame(frame, rt.to) ? 1 : 0) +
      (insideFrame(frame, mid) ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestTime = t;
    }
    if (score >= 2) {
      const value = +t.toFixed(2);
      routeArrivalCache.times.set(key, value);
      return value;
    }
  }

  const value = bestScore >= 1 ? +bestTime.toFixed(2) : 0;
  routeArrivalCache.times.set(key, value);
  return value;
}

/** Início real da rota: o que o utilizador pediu, mas nunca antes da câmera. */
function routeStartTime(rt) {
  const manual = Math.max(0, Number(rt.start) || 0);
  if (rt.autoCamera === false) return manual;
  return Math.max(manual, routeArrivalTime(rt));
}

/** Fim da rota, garantindo uma janela mínima depois do início. */
function routeEndTime(rt, start) {
  const total = totalDuration(state.keyframes);
  const end = Number(rt.end);
  if (Number.isFinite(end) && end > start + 0.2) return end;
  const draw = Math.max(1.2, Number(rt.drawTime) || 1.4);
  return start + draw + 0.4;
}

function renderRouteSelects() {
  const places = markedPlaces();
  const from = $("#rt-from");
  const to = $("#rt-to");
  if (!from || !to) return;

  for (const sel of [from, to]) {
    const prev = sel.value;
    sel.innerHTML = "";
    places.forEach((p, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = p.name;
      sel.appendChild(o);
    });
    if (places.length) {
      const keep = prev !== "" && places[Number(prev)] ? prev : String(sel === to && places.length > 1 ? 1 : 0);
      sel.value = keep;
    }
  }
  from.disabled = places.length < 2;
  to.disabled = places.length < 2;
  const btn = $("#btn-add-route");
  if (btn) btn.disabled = places.length < 2;
}

function renderRouteList() {
  const ul = $("#rt-list");
  if (!ul) return;
  ul.innerHTML = "";
  const count = $("#rt-count");
  if (count) count.textContent = String(state.routes.length);

  for (const rt of state.routes) {
    const li = document.createElement("li");
    li.className = "layer-row" + (rt.id === selectedRouteId ? " current" : "");

    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = rt.color || "#ffffff";

    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = `${rt.fromName} → ${rt.toName}`;
    const sub = document.createElement("span");
    sub.className = "layer-sub";
    sub.textContent = formatKm(haversineKm(rt.from, rt.to));
    name.appendChild(sub);

    name.addEventListener("click", () => {
      selectedRouteId = rt.id;
      renderRouteList();
      fillRouteEditor();
      seekTimeline(Number(rt.start) || 0);
    });

    const rm = document.createElement("button");
    rm.className = "remove";
    rm.textContent = "×";
    rm.title = "Remover rota";
    rm.addEventListener("click", () => {
      state.routes = state.routes.filter((r) => r.id !== rt.id);
      if (selectedRouteId === rt.id) selectedRouteId = null;
      renderRouteList();
      fillRouteEditor();
      renderTimeline();
      save();
    });

    li.append(sw, name, rm);
    ul.appendChild(li);
  }
}

function fillRouteEditor() {
  const ed = $("#rt-editor");
  if (!ed) return;
  const rt = currentRoute();
  if (!rt) {
    ed.hidden = true;
    return;
  }
  ed.hidden = false;
  const max = routeTimeMax();
  $("#rt-editor-title").textContent = `${rt.fromName} → ${rt.toName}`;
  $("#rt-color").value = rt.color || "#ffffff";
  $("#rt-width").value = String(rt.width ?? 4.5);
  $("#rt-width-label").textContent = String(rt.width ?? 4.5).replace(".", ",");
  $("#rt-curve").value = String(Math.round((rt.curve ?? 0.25) * 100));
  $("#rt-curve-label").textContent = `${Math.round((rt.curve ?? 0.25) * 100)}%`;
  $("#rt-label-text").value = rt.labelText || "";
  $("#rt-start").max = String(max);
  $("#rt-end").max = String(max);
  $("#rt-end").value = String(rt.end || max);

  const auto = rt.autoCamera !== false;
  const arrival = routeArrivalTime(rt);
  const effective = routeStartTime(rt);
  $("#rt-auto").checked = auto;
  $("#rt-start").disabled = auto;
  $("#rt-start").value = String(auto ? effective : rt.start || 0);
  $("#rt-start-label").textContent = formatTime(auto ? effective : rt.start || 0);
  const hint = $("#rt-camera-hint");
  if (hint) {
    if (!auto) {
      hint.textContent = "Modo manual: a rota começa no tempo escolhido em “Entra em”.";
    } else if (arrival > 0.01) {
      hint.textContent = `A câmera enquadra a rota em ${formatTime(arrival)} — o traço e o som começam aí.`;
    } else {
      hint.textContent = "A câmera já enquadra a rota no início do vídeo.";
    }
  }
  $("#rt-end-label").textContent = formatTime(rt.end || max);
  $("#rt-arrow").checked = rt.arrow !== false;
  $("#rt-show-label").checked = rt.showLabel !== false;
  $("#rt-sound").checked = rt.sound !== false;
}

function addRoute() {
  const places = markedPlaces();
  const from = places[Number($("#rt-from").value)];
  const to = places[Number($("#rt-to").value)];
  if (!from || !to || from === to) {
    toast("Marque dois lugares diferentes para ligar.");
    return;
  }
  const a = placeAnchor(from);
  const b = placeAnchor(to);
  if (!a || !b) {
    toast("Não foi possível localizar os pontos.");
    return;
  }
  const total = Math.max(1, totalDuration(state.keyframes));
  const rt = {
    id: `rt_${Date.now().toString(36)}`,
    from: a,
    to: b,
    fromName: from.name,
    toName: to.name,
    curve: 0.25,
    color: "#ffffff",
    width: 4.5,
    start: 0,
    end: total,
    drawTime: Math.min(1.6, Math.max(0.7, total * 0.4)),
    arrow: true,
    showLabel: true,
    sound: true,
    autoCamera: true,
    labelText: "",
  };
  state.routes.push(rt);
  selectedRouteId = rt.id;
  renderRouteList();
  fillRouteEditor();
  renderTimeline();
  save();
  toast(`Rota criada: ${formatKm(haversineKm(a, b))}`);
}

/* ------------------------------------------------------------------ *
 * Conflitos de invasão
 *
 * Um lugar ataca outro: a bomba cai, explode e o território muda de mãos
 * (ou não). O utilizador escolhe atacante, alvo e o resultado final.
 * ------------------------------------------------------------------ */

const CONFLICT_RESULTS = {
  win: "Conquista — o atacante toma o território",
  hold: "Resistência — o alvo segura o território",
  draw: "Empate — ninguém conquista nada",
};

let selectedConflictId = null;

function normalizeConflict(c, i = 0) {
  return {
    id: c.id || `cf_${i}`,
    atkKind: c.atkKind || "country",
    atkId: c.atkId || "",
    defKind: c.defKind || "country",
    defId: c.defId || "",
    result: ["win", "hold", "draw"].includes(c.result) ? c.result : "win",
    start: Math.max(0, Number(c.start) || 0),
    duration: Math.min(12, Math.max(0.8, Number(c.duration) || 3)),
    bomb: c.bomb !== false,
    sound: c.sound !== false,
  };
}

/** Dados de um lugar marcado (país, estado ou cidade) para o conflito. */
function conflictPlaceInfo(kind, id) {
  if (!kind || !id) return null;
  if (kind === "country") {
    const props = countriesById.get(id);
    const sel = state.countries[id];
    if (!props || !sel) return null;
    const bbox = props._bbox || null;
    const spot = labelSpotFor(props) || (bbox ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] : null);
    return {
      kind,
      id,
      name: countryLabel(id),
      color: sel.color || "#e0a83c",
      lon: spot?.[0],
      lat: spot?.[1],
    };
  }
  if (kind === "state") {
    const rec = statesById.get(id);
    const sel = state.states[id];
    if (!rec || !sel) return null;
    const lon = Number.isFinite(rec.lon)
      ? rec.lon
      : rec.bbox
        ? (rec.bbox[0] + rec.bbox[2]) / 2
        : null;
    const lat = Number.isFinite(rec.lat)
      ? rec.lat
      : rec.bbox
        ? (rec.bbox[1] + rec.bbox[3]) / 2
        : null;
    return { kind, id, name: rec.name || id, color: sel.color || "#e0a83c", lon, lat };
  }
  if (kind === "city") {
    const rec = citiesById.get(id);
    const sel = state.cities[id];
    if (!sel) return null;
    const lon = Number.isFinite(sel.lon) ? sel.lon : rec?.lon;
    const lat = Number.isFinite(sel.lat) ? sel.lat : rec?.lat;
    return { kind, id, name: sel.name || rec?.name || id, color: sel.color || "#e0a83c", lon, lat };
  }
  return null;
}

function currentConflict() {
  return state.conflicts.find((c) => c.id === selectedConflictId) || null;
}

function conflictLabel(c) {
  const a = conflictPlaceInfo(c.atkKind, c.atkId);
  const d = conflictPlaceInfo(c.defKind, c.defId);
  return `${a?.name || "Atacante"} → ${d?.name || "Alvo"}`;
}

function conflictEnd(c) {
  return Math.max(0, Number(c.start) || 0) + Math.max(0.8, Number(c.duration) || 3);
}

/** Lê "#rrggbb" ou "rgb(r,g,b)". */
function parseColor(value) {
  const s = String(value || "").trim();
  let m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(s);
  if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

/** Mistura duas cores (0 = a, 1 = b) e devolve sempre em hexadecimal. */
function mixColors(a, b, f) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return a || b || "#ffffff";
  const k = Math.max(0, Math.min(1, f));
  const ch = (i) =>
    Math.max(0, Math.min(255, Math.round(ca[i] + (cb[i] - ca[i]) * k)))
      .toString(16)
      .padStart(2, "0");
  return `#${ch(0)}${ch(1)}${ch(2)}`;
}

const smoothStep = (p) => {
  const x = Math.max(0, Math.min(1, p));
  return x * x * (3 - 2 * x);
};

/**
 * Estado visual de um lugar durante um conflito.
 */
function baseStyleFor(kind, id) {
  if (kind === "country") {
    const sel = state.countries[id];
    return sel ? placeStyle(sel) : null;
  }
  if (kind === "state") {
    const sel = state.states[id];
    return sel ? placeStyle(sel) : null;
  }
  if (kind === "city") {
    const c = state.cities[id];
    if (!c) return null;
    return {
      color: c.color || "#e0a83c",
      borderColor: "#ffffff",
      pulse: c.pulse !== false,
      opacity: Number.isFinite(c.opacity) ? c.opacity : 0.65,
    };
  }
  return null;
}

/**
 * Calcula, para o instante t, o efeito de cada lugar envolvido num conflito e
 * as batalhas para desenhar (bombas, explosões e faixa de resultado).
 */
function battleEffectsAt(t) {
  const effects = new Map();
  const battles = [];
  const conflicts = [...state.conflicts].sort(
    (a, b) => (Number(a.start) || 0) - (Number(b.start) || 0),
  );

  for (const c of conflicts) {
    const atk = conflictPlaceInfo(c.atkKind, c.atkId);
    const def = conflictPlaceInfo(c.defKind, c.defId);
    if (!atk || !def) continue;
    const atkKey = `${c.atkKind}:${c.atkId}`;
    const defKey = `${c.defKind}:${c.defId}`;
    const b = battleAt(c, t);
    const atkColor = effects.get(atkKey)?.color || atk.color;

    if (b) {
      const battle = {
        id: c.id,
        atk: { lon: atk.lon, lat: atk.lat, name: atk.name, color: atkColor },
        def: { lon: def.lon, lat: def.lat, name: def.name, color: def.color },
        result: c.result,
        p: b.p,
        bomb: c.bomb !== false,
        banner: null,
      };
      const appear = b.after
        ? Math.max(0, 1 - (t - b.t0 - b.dur) / b.tail)
        : smoothStep((b.p - 0.55) / 0.18);
      if (appear > 0.01) {
        battle.banner = {
          text:
            c.result === "win"
              ? `${atk.name} conquistou ${def.name}`
              : c.result === "hold"
                ? `${def.name} resistiu ao ataque`
                : `Empate: ${atk.name} × ${def.name}`,
          alpha: appear,
          size: 26,
        };
      }
      battles.push(battle);

      for (const [key, role] of [
        [defKey, "def"],
        [atkKey, "atk"],
      ]) {
        const [kind, id] = key.split(":");
        const base = baseStyleFor(kind, id);
        if (!base) continue;
        const s = battleStyleFor({ battle, role }, base);
        effects.set(key, {
          color: s.color,
          borderColor: s.borderColor,
          pulse: s.pulse,
          role,
          battle,
          conquered: role === "def" && c.result === "win",
        });
      }
    } else if (c.result === "win" && t >= conflictEnd(c)) {
      // território conquistado: fica com a cor do atacante até o fim do vídeo
      effects.set(defKey, {
        color: atkColor,
        borderColor: baseStyleFor(c.defKind, c.defId)?.borderColor || "#ffffff",
        pulse: false,
        conquered: true,
      });
    }
  }

  return { effects, battles };
}

/**
 * Aplica às camadas do mapa a cor de quem está sendo conquistado (e desfaz
 * quando o conflito termina sem conquista).
 */
const battleLayerState = new Map();

function battleFeatureId(key) {
  const [kind, id] = key.split(":");
  if (kind === "country") return { source: "countries", id, kind };
  if (kind === "state") return { source: "states", id, kind };
  if (kind === "city") {
    const c = state.cities[id];
    if (!c || !c.muniId) return null;
    return { source: "municipios", id: String(c.muniId), kind };
  }
  return null;
}

function syncBattleLayers(t) {
  const { effects } = battleEffectsAt(t);

  for (const [key, prev] of [...battleLayerState]) {
    if (effects.has(key)) continue;
    battleLayerState.delete(key);
    const target = battleFeatureId(key);
    if (!target) continue;
    const base = baseStyleFor(target.kind, target.id) || {};
    if (target.source === "countries") applyCountry(target.id);
    else if (target.source === "states") applyState(target.id);
    else if (target.source === "municipios" && state.cities[target.id]) {
      renderSelectedCities();
    }
  }

  for (const [key, fx] of effects) {
    const prev = battleLayerState.get(key);
    if (prev && prev.color === fx.color) continue;
    battleLayerState.set(key, fx);
    const target = battleFeatureId(key);
    if (!target) continue;
    const sel = target.source === "countries" ? state.countries[target.id] : null;
    if (target.source === "countries") {
      map.setFeatureState(
        { source: "countries", id: target.id },
        {
          color: fx.color,
          opacity: sel ? sel.opacity : 0.55,
          lineOpacity: Math.min(1, (sel ? sel.opacity : 0.55) + 0.35),
        },
      );
    } else if (target.source === "states") {
      const st = state.states[target.id];
      map.setFeatureState(
        { source: "states", id: target.id },
        {
          color: fx.color,
          opacity: st ? st.opacity : 0.55,
          lineOpacity: Math.min(1, (st ? st.opacity : 0.55) + 0.45),
        },
      );
    } else if (target.source === "municipios") {
      const c = state.cities[target.id];
      if (!c) continue;
      map.setFeatureState(
        { source: "municipios", id: target.id },
        {
          color: fx.color,
          opacity: Number.isFinite(c.opacity) ? c.opacity : 0.65,
          lineOpacity: 1,
          glowOpacity: 0.85,
        },
      );
    }
  }
}

/**
 * Efeito de cor do lugar durante o conflito: o alvo muda de cor na
 * conquista, pisca no impacto e o atacante reage ao resultado.
 */
function battleStyleFor(entry, base) {
  const { battle, role } = entry;
  const p = battle.p;
  const impact = 0.55;
  const flash = Math.exp(-Math.pow((p - impact) * 9, 2)); // pico no impacto
  const after = smoothStep((p - impact) / 0.45);
  const other = role === "def" ? battle.atk : battle.def;

  let color = base.color;
  let borderColor = base.borderColor;
  let pulse = base.pulse;

  if (role === "def" && battle.result === "win") {
    color = mixColors(base.color, other.color, after);
    color = mixColors(color, "#ffffff", flash * 0.85);
  } else if (role === "def" && battle.result === "hold") {
    color = mixColors(base.color, "#bfe9ff", flash * 0.9);
  } else if (role === "def" && battle.result === "draw") {
    color = mixColors(base.color, "#ffd166", flash * 0.9);
  } else if (role === "atk") {
    if (p < impact) {
      color = mixColors(base.color, "#ffffff", 0.14 * smoothStep(p / impact));
    } else if (battle.result === "win") {
      color = mixColors(base.color, other.color, 0.2 * after);
      color = mixColors(color, "#ffffff", flash * 0.6);
    } else if (battle.result === "hold") {
      color = mixColors(base.color, "#31363f", 0.3 * after);
    } else {
      color = mixColors(base.color, "#ffd166", flash * 0.8);
    }
  }

  if (flash > 0.02) {
    borderColor = mixColors(
      borderColor,
      battle.result === "hold" ? "#9fdcff" : "#ffffff",
      flash * 0.9,
    );
    pulse = true;
  }

  return { color, borderColor, pulse };
}

/** Estado do conflito no instante t (ou null se ainda não aconteceu). */
function battleAt(c, t) {
  const t0 = Math.max(0, Number(c.start) || 0);
  const dur = Math.max(0.8, Number(c.duration) || 3);
  const t1 = t0 + dur;
  const tail = 1.4;
  if (t < t0 - 0.02 || t > t1 + tail) return null;
  const p = t <= t1 ? (t - t0) / dur : 1;
  return { p: Math.max(0, Math.min(1, p)), after: t > t1, tail, t0, dur };
}

function renderConflictSelects() {
  const places = markedPlaces();
  for (const [sel, value] of [
    ["#cf-atk", null],
    ["#cf-def", null],
  ]) {
    const el = $(sel);
    if (!el) continue;
    const prev = value ?? el.value;
    el.innerHTML = "";
    places.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = `${p.kind}:${p.id}`;
      opt.textContent = `${p.kind === "country" ? "País" : p.kind === "state" ? "Estado" : "Cidade"} · ${p.name}`;
      el.appendChild(opt);
    });
    if (prev) el.value = prev;
  }
}

function renderConflictList() {
  const ul = $("#cf-list");
  if (!ul) return;
  ul.innerHTML = "";
  const count = $("#cf-count");
  if (count) count.textContent = String(state.conflicts.length);

  for (const c of state.conflicts) {
    const li = document.createElement("li");
    li.className = "layer-row";
    if (c.id === selectedConflictId) li.classList.add("current");

    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background =
      c.result === "win" ? "#ff6b6b" : c.result === "hold" ? "#5bc8ff" : "#ffd166";

    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = conflictLabel(c);
    const sub = document.createElement("span");
    sub.className = "layer-sub";
    sub.textContent = `${CONFLICT_RESULTS[c.result]?.split(" — ")[0] || ""} · ${formatTime(c.start)} · ${formatTime(c.duration)} s`;
    name.appendChild(sub);

    name.addEventListener("click", () => {
      selectedConflictId = c.id;
      renderConflictList();
      fillConflictEditor();
      seekTimeline(Math.max(0, Number(c.start) || 0));
    });

    const rm = document.createElement("button");
    rm.className = "remove";
    rm.textContent = "×";
    rm.title = "Remover conflito";
    rm.addEventListener("click", () => {
      state.conflicts = state.conflicts.filter((x) => x.id !== c.id);
      if (selectedConflictId === c.id) selectedConflictId = null;
      renderConflictList();
      fillConflictEditor();
      renderTimeline();
      save();
    });

    li.append(sw, name, rm);
    ul.appendChild(li);
  }
}

function fillConflictEditor() {
  const ed = $("#cf-editor");
  if (!ed) return;
  const c = currentConflict();
  if (!c) {
    ed.hidden = true;
    return;
  }
  ed.hidden = false;
  const max = routeTimeMax();
  $("#cf-editor-title").textContent = conflictLabel(c);
  $("#cf-atk").value = `${c.atkKind}:${c.atkId}`;
  $("#cf-def").value = `${c.defKind}:${c.defId}`;
  $("#cf-result").value = c.result;
  $("#cf-start").max = String(max);
  $("#cf-start").value = String(c.start || 0);
  $("#cf-start-label").textContent = formatTime(c.start || 0);
  $("#cf-dur").max = "12";
  $("#cf-dur").value = String(c.duration || 3);
  $("#cf-dur-label").textContent = `${(c.duration || 3).toFixed(1).replace(".", ",")} s`;
  $("#cf-bomb").checked = c.bomb !== false;
  $("#cf-sound").checked = c.sound !== false;
  const hint = $("#cf-hint");
  if (hint) {
    hint.textContent =
      c.result === "win"
        ? "No fim do conflito o território do alvo passa a usar a cor do atacante."
        : c.result === "hold"
          ? "O alvo segura o território: ele pisca no impacto e mantém a cor."
          : "Os dois lados piscam e o território continua como estava.";
  }
}

function addConflict() {
  const places = markedPlaces();
  if (places.length < 2) {
    toast("Marque pelo menos dois lugares (aba Mapa) para criar um conflito.");
    return;
  }
  const atk = $("#cf-atk")?.value || `${places[0].kind}:${places[0].id}`;
  const def = $("#cf-def")?.value || `${places[1].kind}:${places[1].id}`;
  if (atk === def) {
    toast("Escolha dois lugares diferentes.");
    return;
  }
  const [atkKind, atkId] = atk.split(":");
  const [defKind, defId] = def.split(":");
  const total = Math.max(1, totalDuration(state.keyframes));
  const last = state.conflicts.reduce((acc, c) => Math.max(acc, conflictEnd(c)), 0);
  // cabe inteiro no vídeo e, se possível, começa depois do último conflito
  const duration = Math.min(3.2, Math.max(0.8, total));
  const start = Math.max(0, Math.min(last, total - duration));

  const c = normalizeConflict(
    {
      id: `cf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      atkKind,
      atkId,
      defKind,
      defId,
      result: "win",
      start,
      duration: Math.min(duration, Math.max(0.8, total - start)),
      bomb: true,
      sound: true,
    },
    0,
  );
  state.conflicts.push(c);
  selectedConflictId = c.id;
  renderConflictList();
  fillConflictEditor();
  renderTimeline();
  save();
  toast(`Conflito criado: ${conflictLabel(c)}`);
}

/* ------------------------------------------------------------------ *
 * Regiões desenhadas à mão
 * ------------------------------------------------------------------ */
const regionDraft = {
  active: false,
  coords: [],
  defaults: {
    color: "#e0a83c",
    opacity: 0.55,
    borderColor: "#ffffff",
    borderWidth: 3,
    glow: true,
    label: "",
  },
};
let selectedRegionId = null;

function currentRegion() {
  return state.regions.find((r) => r.id === selectedRegionId) || null;
}

function renderRegionList() {
  const ul = $("#rg-list");
  if (!ul) return;
  ul.innerHTML = "";
  const count = $("#rg-count");
  if (count) count.textContent = String(state.regions.length);

  state.regions.forEach((rg, i) => {
    const li = document.createElement("li");
    li.className = "layer-row" + (rg.id === selectedRegionId ? " current" : "");

    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = rg.color || "#e0a83c";

    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = rg.label || `Região ${i + 1}`;
    const sub = document.createElement("span");
    sub.className = "layer-sub";
    sub.textContent = `${rg.coords.length} vértices`;
    name.appendChild(sub);

    name.addEventListener("click", () => {
      selectedRegionId = rg.id;
      renderRegionList();
      fillRegionEditor();
      const lngs = rg.coords.map((c) => c[0]);
      const lats = rg.coords.map((c) => c[1]);
      const bbox = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
      map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 60, duration: 900, maxZoom: 9 });
      scheduleGfx();
    });

    const rm = document.createElement("button");
    rm.className = "remove";
    rm.textContent = "×";
    rm.title = "Remover região";
    rm.addEventListener("click", () => {
      state.regions = state.regions.filter((r) => r.id !== rg.id);
      if (selectedRegionId === rg.id) selectedRegionId = null;
      renderRegionList();
      fillRegionEditor();
      save();
    });

    li.append(sw, name, rm);
    ul.appendChild(li);
  });
}

function fillRegionEditor() {
  const rg = currentRegion();
  const d = rg || regionDraft.defaults;
  $("#rg-color").value = d.color || "#e0a83c";
  $("#rg-opacity").value = String(Math.round((d.opacity ?? 0.55) * 100));
  $("#rg-opacity-label").textContent = `${Math.round((d.opacity ?? 0.55) * 100)}%`;
  $("#rg-border").value = d.borderColor || "#ffffff";
  $("#rg-label").value = d.label || "";
}

function syncRegionControls() {
  const active = regionDraft.active;
  const n = regionDraft.coords.length;
  $("#btn-region-draw").textContent = active ? "✎ Desenhando…" : "✎ Desenhar no mapa";
  $("#btn-region-finish").disabled = !active || n < 3;
  $("#btn-region-finish").textContent = `Concluir${n ? ` (${n})` : ""}`;
  $("#btn-region-cancel").disabled = !active;
  $("#stage").classList.toggle("draw-region", active);
  $("#rg-hint").textContent = active
    ? n < 3
      ? `Toque no mapa para marcar os vértices (${n} de 3 no mínimo).`
      : `${n} vértices marcados. Toque em “Concluir” para fechar a região.`
    : "Toque nos vértices da região no mapa e depois em “Concluir”. Serve para áreas como “Sahara” ou “Cerrado”.";
}

function startRegionDraw() {
  if (regionDraft.active) {
    cancelRegionDraw();
    return;
  }
  selectedRegionId = null;
  regionDraft.active = true;
  regionDraft.coords = [];
  renderRegionList();
  fillRegionEditor();
  syncRegionControls();
  scheduleGfx();
  toast("Toque no mapa para marcar os vértices.");
}

function cancelRegionDraw() {
  regionDraft.active = false;
  regionDraft.coords = [];
  syncRegionControls();
  scheduleGfx();
}

function finishRegionDraw() {
  if (!regionDraft.active) return;
  if (regionDraft.coords.length < 3) {
    toast("Marque pelo menos 3 vértices no mapa.");
    return;
  }
  const rg = {
    id: `rg_${Date.now().toString(36)}`,
    coords: regionDraft.coords.map((c) => [c[0], c[1]]),
    ...regionDraft.defaults,
  };
  state.regions.push(rg);
  selectedRegionId = rg.id;
  regionDraft.active = false;
  regionDraft.coords = [];
  regionDraft.defaults = { ...regionDraft.defaults, label: "" };
  renderRegionList();
  fillRegionEditor();
  syncRegionControls();
  save();
  toast("Região criada.");
}

/* ------------------------------------------------------------------ *
 * Temas
 * ------------------------------------------------------------------ */
function initThemeUI() {
  const sel = $("#th-theme");
  if (!sel) return;
  sel.innerHTML = "";
  for (const th of THEMES) {
    const o = document.createElement("option");
    o.value = th.id;
    o.textContent = th.label;
    sel.appendChild(o);
  }
  sel.value = state.mapTheme || "natural";
  sel.addEventListener("change", () => {
    state.mapTheme = sel.value;
    applyTheme(state.mapTheme);
    save();
    renderKeyframes();
  });
}

/* ------------------------------------------------------------------ *
 * Fontes de rótulo disponíveis no estilo base (evita symbol sem glifos).
 * ------------------------------------------------------------------ */
function pickTextFont() {
  const layers = map.getStyle().layers || [];
  for (const l of layers) {
    const f = l.layout && l.layout["text-font"];
    if (Array.isArray(f) && f.length) return f;
  }
  return ["Noto Sans Regular"];
}

map.on("load", async () => {
  map.resize();

  // insere as camadas de países abaixo dos rótulos do estilo base
  const layers = map.getStyle().layers || [];
  const symbol = layers.find((l) => l.type === "symbol");
  labelLayerId = symbol ? symbol.id : undefined;

  await loadCountries();
  addCityLayers();
  renderSelectedCities();

  map.on("click", onMapClick);

  map.getCanvas().style.cursor = "grab";
  renderSelection();
  renderKeyframes();
  syncTextUI();

  // primeira abertura (ou projeto sem keyframes): cria o inicial na câmera atual
  if (!state.keyframes.length) {
    state.keyframes.push({ id: "kf_start", camera: currentCamera(), duration: 0, ease: "easeInOut" });
    renderKeyframes();
    save();
  }
  updateExportSummary();

  // dados de busca carregados em segundo plano; os municípios dependem dos
  // estados para manter a ordem das camadas (município acima do estado)
  loadStates().then(() => loadMunicipalities());
  loadCities();
});

/* ------------------------------------------------------------------ *
 * Camadas
 * ------------------------------------------------------------------ */

/**
 * Ordem de desenho da base para o topo. Precisa ser explícita porque as
 * camadas entram em tempos diferentes (país, estado, município, marcados).
 */
const LAYER_ORDER = [
  "countries-fill",
  "countries-line",
  "countries-hairline",
  "states-fill",
  "states-borders",
  "states-line",
  "municipios-fill",
  "municipios-glow",
  "municipios-line",
  "cities-halo",
  "cities-dot",
  "countries-label",
  "states-label",
  "munis-label",
  "cities-label",
];

function restackLayers() {
  for (const id of LAYER_ORDER) {
    if (map.getLayer(id)) map.moveLayer(id);
  }
}

/** Onde o nome do país/estado é escrito: ponto oficial do Natural Earth. */
function labelSpotFor(p) {
  const lon = Number(p.LABEL_X);
  const lat = Number(p.LABEL_Y);
  if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat];
  const bbox = p._bbox;
  if (bbox) return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  if (Number.isFinite(p.lon) && Number.isFinite(p.lat)) return [p.lon, p.lat];
  return null;
}

async function loadCountries() {
  try {
    const geo = await fetch("data/countries.geojson").then((r) => r.json());
    for (const f of geo.features) {
      const id = f.properties?.NAME;
      if (!id) continue;
      f.properties._bbox = bboxOfGeometry(f.geometry);
      countriesById.set(id, f.properties);
      countryGeom.set(id, f.geometry);
    }

    map.addSource("countries", {
      type: "geojson",
      data: geo,
      promoteId: "NAME",
    });

    // rótulos de país/estado vêm de pontos próprios: colocar o texto no
    // polígono repetiria o nome em cada tile do mapa
    labelPoints = [];
    for (const [id, p] of countriesById) {
      const spot = labelSpotFor(p);
      if (!spot) continue;
      labelPoints.push({
        type: "Feature",
        properties: {
          kind: "country",
          text: p.NAME_PT || p.NAME || id,
          sort: Number(p.LABELRANK) || 10,
        },
        geometry: { type: "Point", coordinates: spot },
      });
    }

    map.addSource("place-labels", {
      type: "geojson",
      data: { type: "FeatureCollection", features: labelPoints },
    });

    map.addLayer(
      {
        id: "countries-fill",
        type: "fill",
        source: "countries",
        paint: {
          "fill-color": ["coalesce", ["feature-state", "color"], BASE_FILL],
          "fill-opacity": ["coalesce", ["feature-state", "opacity"], 0],
        },
      },
      labelLayerId,
    );

    map.addLayer(
      {
        id: "countries-line",
        type: "line",
        source: "countries",
        paint: {
          "line-color": ["coalesce", ["feature-state", "color"], "#ffffff"],
          "line-width": 1.1,
          "line-opacity": ["coalesce", ["feature-state", "lineOpacity"], 0],
        },
      },
      labelLayerId,
    );

    // divisa de todos os países, discreta: sobre a imagem de satélite dá a
    // leitura de mapa que o Google Earth tem
    map.addLayer(
      {
        id: "countries-hairline",
        type: "line",
        source: "countries",
        paint: {
          "line-color": "#ffffff",
          "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.5, 6, 1, 10, 1.3],
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 1, 0.16, 4, 0.3, 8, 0.2],
        },
      },
      labelLayerId,
    );

    map.addLayer(
      {
        id: "countries-label",
        type: "symbol",
        source: "place-labels",
        filter: ["==", ["get", "kind"], "country"],
        minzoom: 0.4,
        maxzoom: 7.5,
        layout: {
          "text-field": ["get", "text"],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 0.4, 8, 1.6, 10, 3, 12.5, 5.5, 16],
          "text-letter-spacing": 0.06,
          "text-max-width": 7,
          "text-allow-overlap": false,
          "text-padding": 4,
          "symbol-sort-key": ["coalesce", ["get", "sort"], 10],
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "rgba(5,7,11,.6)",
          "text-halo-width": 1.7,
        },
      },
      labelLayerId,
    );

    countryIndex = buildCountryIndex(countriesById);
    rebuildSearchIndex();
    applyAllCountries();
    restackLayers();
    scheduleGfx();
  } catch (err) {
    console.error(err);
    toast("Não foi possível carregar os países.");
  }
}

async function loadStates() {
  if (map.getSource("states")) return;
  setSearchStatus("carregando estados…");
  try {
    const geo = await fetch("data/admin1.geojson").then((r) => r.json());
    stateIndex = buildStateIndex(geo);
    for (const rec of stateIndex) statesById.set(rec.id, rec);
    for (const f of geo.features) {
      const id = f.properties?._id;
      if (id) stateGeom.set(id, f.geometry);
    }

    map.addSource("states", {
      type: "geojson",
      data: geo,
      promoteId: "_id",
    });

    map.addLayer(
      {
        id: "states-fill",
        type: "fill",
        source: "states",
        paint: {
          "fill-color": ["coalesce", ["feature-state", "color"], "#7fb2e5"],
          "fill-opacity": ["coalesce", ["feature-state", "opacity"], 0],
        },
      },
      labelLayerId,
    );

    map.addLayer(
      {
        id: "states-borders",
        type: "line",
        source: "states",
        paint: {
          // divisão interna visível a partir do zoom de país/estado
          "line-color": "rgba(255,255,255,.75)",
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            3, 0.4,
            6, 0.9,
            10, 1.4,
          ],
          "line-opacity": [
            "interpolate", ["linear"], ["zoom"],
            2.6, 0,
            3.8, 0.35,
            6, 0.42,
            10, 0.5,
          ],
        },
      },
      labelLayerId,
    );

    map.addLayer(
      {
        id: "states-line",
        type: "line",
        source: "states",
        paint: {
          "line-color": ["coalesce", ["feature-state", "color"], "#ffffff"],
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            2, 0.6,
            6, 1.6,
            10, 2.4,
          ],
          "line-opacity": ["coalesce", ["feature-state", "lineOpacity"], 0],
        },
      },
      labelLayerId,
    );

    // nomes de estado também vêm dos pontos de rótulo
    for (const rec of stateIndex) {
      const spot = labelSpotFor({ _bbox: rec.bbox, lat: rec.lat, lon: rec.lon });
      if (!spot) continue;
      labelPoints.push({
        type: "Feature",
        properties: { kind: "state", text: rec.name.toUpperCase(), sort: -Math.round(rec.weight * 1000) },
        geometry: { type: "Point", coordinates: spot },
      });
    }
    const labelSource = map.getSource("place-labels");
    if (labelSource) labelSource.setData({ type: "FeatureCollection", features: labelPoints });

    map.addLayer(
      {
        id: "states-label",
        type: "symbol",
        source: "place-labels",
        filter: ["==", ["get", "kind"], "state"],
        minzoom: 3.2,
        layout: {
          "text-field": ["get", "text"],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 3.2, 8.5, 6, 10.5, 10, 13],
          "text-letter-spacing": 0.12,
          "text-max-width": 6,
          "text-padding": 3,
          "text-allow-overlap": false,
          "symbol-sort-key": ["coalesce", ["get", "sort"], 0],
        },
        paint: {
          "text-color": "rgba(255,255,255,.85)",
          "text-halo-color": "rgba(5,7,11,.55)",
          "text-halo-width": 1.4,
        },
      },
      labelLayerId,
    );

    restackLayers();
    applyAllStates();
    rebuildSearchIndex();
    renderSelection();
    scheduleGfx();
  } catch (err) {
    console.warn("Estados indisponíveis:", err);
  }
}

async function loadCities() {
  if (cityIndex.length) return;
  setSearchStatus("carregando cidades…");
  try {
    const [rows, aliases] = await Promise.all([
      loadCityRows("data/cities.json.gz"),
      fetch("data/city-aliases.json")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);
    cityIndex = buildCityIndex(rows, countryNameByIso(), aliases);
    rebuildPlacesById();
    rebuildSearchIndex();
    renderSelectedCities();
    renderSelection();
  } catch (err) {
    console.warn("Cidades indisponíveis:", err);
    setSearchStatus("");
  }
}

async function loadMunicipalities() {
  if (map.getSource("municipios")) return;
  try {
    const geo = await fetch("data/municipios.geojson").then((r) => r.json());

    map.addSource("municipios", {
      type: "geojson",
      data: geo,
      promoteId: "id",
    });

    map.addLayer(
      {
        id: "municipios-fill",
        type: "fill",
        source: "municipios",
        paint: {
          "fill-color": ["coalesce", ["feature-state", "color"], "#e0a83c"],
          "fill-opacity": ["coalesce", ["feature-state", "opacity"], 0],
        },
      },
      labelLayerId,
    );

    // brilho em volta do contorno, como no vídeo de referência
    map.addLayer(
      {
        id: "municipios-glow",
        type: "line",
        source: "municipios",
        paint: {
          "line-color": ["coalesce", ["feature-state", "color"], "#e0a83c"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 3, 9, 6, 16, 10, 28],
          "line-blur": ["interpolate", ["linear"], ["zoom"], 3, 6, 6, 9, 10, 15],
          "line-opacity": ["coalesce", ["feature-state", "glowOpacity"], 0],
        },
      },
      labelLayerId,
    );

    map.addLayer(
      {
        id: "municipios-line",
        type: "line",
        source: "municipios",
        paint: {
          "line-color": ["coalesce", ["feature-state", "color"], "#e0a83c"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1.8, 6, 2.6, 10, 3.6],
          "line-opacity": ["coalesce", ["feature-state", "lineOpacity"], 0],
        },
      },
      labelLayerId,
    );

    municipalityIndex = buildMunicipalityIndex(geo);
    municipalityByCode = new Map(municipalityIndex.map((rec) => [rec.muniId, rec]));
    rebuildPlacesById();
    rebuildSearchIndex();

    // projetos antigos guardavam a cidade como ponto: adota o município
    if (migrateCitySelections()) save();

    renderSelectedCities();
    renderSelection();
    restackLayers();
  } catch (err) {
    console.warn("Municípios indisponíveis:", err);
  }
}

/** Converte seleções antigas (ponto) para o município correspondente. */
function migrateCitySelections() {
  let changed = false;
  const byName = new Map();
  for (const rec of municipalityIndex) {
    byName.set(`${rec.ufName}|${rec.norm}`, rec);
  }

  for (const [id, c] of Object.entries(state.cities)) {
    if (c.muniId) continue;
    const stateName = String(c.sub || "").split(" · ")[0];
    const rec = byName.get(`${stateName}|${normalize(c.name)}`);
    if (!rec) continue;

    delete state.cities[id];
    state.cities[rec.id] = {
      ...c,
      muniId: rec.muniId,
      sub: rec.sub,
      lat: Number.isFinite(rec.lat) ? rec.lat : c.lat,
      lon: Number.isFinite(rec.lon) ? rec.lon : c.lon,
    };
    changed = true;
  }
  return changed;
}

function rebuildPlacesById() {
  citiesById = new Map(cityIndex.map((rec) => [rec.id, rec]));
  for (const rec of municipalityIndex) citiesById.set(rec.id, rec);
}

function addCityLayers() {
  map.addSource("selected-cities", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "cities-halo",
    type: "circle",
    source: "selected-cities",
    filter: ["!=", ["get", "muni"], true],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 8, 6, 13, 12, 19],
      "circle-color": "#05070b",
      "circle-opacity": 0.32,
      "circle-blur": 0.6,
    },
  });

  // mesma linguagem do país/estado: preenchimento na opacidade escolhida
  // com contorno na cor cheia (sem anel branco)
  map.addLayer({
    id: "cities-dot",
    type: "circle",
    source: "selected-cities",
    filter: ["!=", ["get", "muni"], true],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 7, 6, 10, 12, 14],
      "circle-color": ["get", "color"],
      "circle-opacity": ["coalesce", ["get", "opacity"], 0.65],
      "circle-stroke-color": ["get", "color"],
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 2, 2.2, 8, 2.6, 12, 3],
      "circle-stroke-opacity": 1,
    },
  });

  map.addLayer({
    id: "cities-label",
    type: "symbol",
    source: "selected-cities",
    filter: ["!=", ["get", "muni"], true],
    minzoom: 3,
    layout: {
      "text-field": ["get", "label"],
      "text-font": pickTextFont(),
      "text-size": ["interpolate", ["linear"], ["zoom"], 2, 11, 6, 13, 12, 16],
      "text-letter-spacing": 0.04,
      "text-anchor": "top",
      "text-offset": [0, 1.1],
      "text-allow-overlap": true,
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "rgba(5,7,11,.92)",
      "text-halo-width": 2.4,
    },
  });

  // nome do município selecionado, no centro da área
  map.addLayer({
    id: "munis-label",
    type: "symbol",
    source: "selected-cities",
    filter: ["==", ["get", "muni"], true],
    minzoom: 3.5,
    layout: {
      "text-field": ["get", "label"],
      "text-font": pickTextFont(),
      "text-size": ["interpolate", ["linear"], ["zoom"], 2, 11, 6, 14, 12, 18],
      "text-letter-spacing": 0.04,
      "text-allow-overlap": true,
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "rgba(5,7,11,.92)",
      "text-halo-width": 2.4,
    },
  });

  restackLayers();
}

function countryNameByIso() {
  const names = new Map();
  for (const [, p] of countriesById) {
    const iso = p.ISO_A2 && p.ISO_A2 !== "-99" ? p.ISO_A2 : p.ISO_A2_EH;
    if (!iso || iso === "-99") continue;
    names.set(iso, p.NAME_PT || p.NAME || iso);
  }
  return names;
}

function rebuildSearchIndex() {
  // no Brasil a cidade é o município (com contorno): evita resultado duplicado
  const hideBrazil = municipalityIndex.length > 0;
  const worldCities = hideBrazil ? cityIndex.filter((rec) => rec.cc !== "BR") : cityIndex;
  searchIndex = [...countryIndex, ...stateIndex, ...worldCities, ...municipalityIndex];
  updateSearchStatusIdle();
}

/* ------------------------------------------------------------------ *
 * Clique no mapa
 * ------------------------------------------------------------------ */
function onMapClick(e) {
  if (playing) return;

  // desenhando uma região: cada toque vira um vértice
  if (regionDraft.active) {
    regionDraft.coords.push([
      Number(e.lngLat.lng.toFixed(5)),
      Number(e.lngLat.lat.toFixed(5)),
    ]);
    syncRegionControls();
    scheduleGfx();
    return;
  }

  // em zoom baixo os estados são pequenos demais: prioriza o país
  const zoom = map.getZoom();
  const wantStates = zoom >= 3.6;
  const wantMunis = zoom >= 7 && map.getLayer("municipios-fill");
  const layers = ["cities-dot"];
  if (wantMunis) layers.push("municipios-fill");
  if (wantStates && map.getLayer("states-fill")) layers.push("states-fill");
  if (map.getLayer("countries-fill")) layers.push("countries-fill");

  const hits = map.queryRenderedFeatures(e.point, { layers });
  if (!hits.length) return;

  const cityHit = hits.find((h) => h.layer.id === "cities-dot");
  if (cityHit) {
    toggleCity(cityHit.properties._id ?? cityHit.properties.id);
    return;
  }

  const muniHit = hits.find((h) => h.layer.id === "municipios-fill");
  if (muniHit) {
    const raw = String(muniHit.id ?? muniHit.properties?.id ?? "");
    const rec = municipalityByCode.get(raw) || municipalityByCode.get(raw.padStart(7, "0"));
    if (rec) {
      toggleCity(rec.id);
      return;
    }
  }

  const stateHit = hits.find((h) => h.layer.id === "states-fill");
  if (stateHit) {
    toggleState(stateHit.id ?? stateHit.properties._id);
    return;
  }

  const countryHit = hits.find((h) => h.layer.id === "countries-fill");
  if (countryHit) toggleCountry(countryHit.id ?? countryHit.properties.NAME);
}

/* ------------------------------------------------------------------ *
 * Seleção (países, estados e cidades)
 * ------------------------------------------------------------------ */
const KIND_LABEL = { country: "País", state: "Estado", city: "Cidade" };

function countryLabel(id) {
  const p = countriesById.get(id);
  return p?.NAME_PT || p?.NAME || id;
}

function stateLabel(id) {
  return statesById.get(id)?.name || id;
}

function currentStyle() {
  return {
    color: $("#global-color").value,
    opacity: Number($("#global-opacity").value) / 100,
  };
}

/* ---------- países ---------- */
function applyCountry(id) {
  if (!map.getSource("countries")) return;
  const sel = state.countries[id];
  if (sel) {
    const canvas = canvasStyled(sel);
    map.setFeatureState(
      { source: "countries", id },
      {
        color: sel.color,
        opacity: canvas ? 0 : sel.opacity,
        lineOpacity: canvas ? 0 : Math.min(1, sel.opacity + 0.35),
      },
    );
  } else {
    map.removeFeatureState({ source: "countries", id });
  }
}

function applyAllCountries() {
  const ids = new Set([...Object.keys(state.countries), ...countriesById.keys()]);
  for (const id of ids) applyCountry(id);
}

function toggleCountry(id) {
  if (state.countries[id]) delete state.countries[id];
  else state.countries[id] = currentStyle();
  applyCountry(id);
  renderSelection();
  save();
}

/* ---------- estados ---------- */
function applyState(id) {
  if (!map.getSource("states")) return;
  const sel = state.states[id];
  if (sel) {
    const canvas = canvasStyled(sel);
    map.setFeatureState(
      { source: "states", id },
      {
        color: sel.color,
        opacity: canvas ? 0 : sel.opacity,
        lineOpacity: canvas ? 0 : Math.min(1, sel.opacity + 0.45),
      },
    );
  } else {
    map.removeFeatureState({ source: "states", id });
  }
}

function applyAllStates() {
  const ids = new Set([...Object.keys(state.states), ...statesById.keys()]);
  for (const id of ids) applyState(id);
}

function toggleState(id) {
  if (state.states[id]) delete state.states[id];
  else state.states[id] = currentStyle();
  applyState(id);
  renderSelection();
  save();
}

/* ---------- cidades ---------- */
function renderSelectedCities() {
  const src = map.getSource("selected-cities");
  const muniSource = map.getSource("municipios");
  const features = [];
  const wanted = new Set();

  for (const [id, c] of Object.entries(state.cities)) {
    const muniId = c.muniId ? String(c.muniId) : null;
    const mode = c.mode === "pin" || c.mode === "both" ? c.mode : "area";
    const hasPin = mode === "pin" || mode === "both";

    if (muniId && mode !== "pin") {
      wanted.add(muniId);
      if (muniSource) {
        map.setFeatureState(
          { source: "municipios", id: muniId },
          {
            color: c.color || "#e0a83c",
            opacity: Number.isFinite(c.opacity) ? c.opacity : 0.65,
            lineOpacity: 1,
            glowOpacity: 0.85,
          },
        );
      }
    }

    // o alfinete é desenhado no canvas: dispensa o ponto/rótulo do MapLibre
    if (hasPin) continue;
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    features.push({
      type: "Feature",
      id,
      properties: {
        _id: id,
        color: c.color || "#e0a83c",
        opacity: Number.isFinite(c.opacity) ? c.opacity : 0.65,
        label: c.name,
        muni: Boolean(muniId),
      },
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    });
  }

  if (muniSource) {
    for (const muniId of appliedMunis) {
      if (!wanted.has(muniId)) {
        map.removeFeatureState({ source: "municipios", id: muniId });
      }
    }
  }
  appliedMunis = wanted;

  if (src) src.setData({ type: "FeatureCollection", features });
}

function toggleCity(id) {
  if (state.cities[id]) {
    delete state.cities[id];
  } else {
    const rec = citiesById.get(id);
    if (!rec) return;
    state.cities[id] = {
      name: rec.name,
      lat: rec.lat,
      lon: rec.lon,
      sub: rec.sub,
      color: currentStyle().color,
      opacity: currentStyle().opacity,
      muniId: rec.muniId || null,
    };
  }
  renderSelectedCities();
  renderSelection();
  save();
}

/* ---------- lista unificada ---------- */
function isSelected(rec) {
  if (rec.kind === "country") return Boolean(state.countries[rec.id]);
  if (rec.kind === "state") return Boolean(state.states[rec.id]);
  return Boolean(state.cities[rec.id]);
}

function selectPlace(rec) {
  if (isSelected(rec)) return;
  const { color, opacity } = currentStyle();
  if (rec.kind === "country") {
    state.countries[rec.id] = { color, opacity };
    applyCountry(rec.id);
  } else if (rec.kind === "state") {
    state.states[rec.id] = { color, opacity };
    applyState(rec.id);
  } else {
    state.cities[rec.id] = {
      name: rec.name,
      lat: rec.lat,
      lon: rec.lon,
      sub: rec.sub,
      color,
      opacity,
      muniId: rec.muniId || null,
    };
    renderSelectedCities();
  }
  save();
}

function goTo(rec) {
  if (rec.kind === "city" && rec.bbox) {
    map.fitBounds(
      [
        [rec.bbox[0], rec.bbox[1]],
        [rec.bbox[2], rec.bbox[3]],
      ],
      { padding: 56, duration: 1200, maxZoom: 11, essential: true },
    );
    return;
  }
  if (rec.kind === "city") {
    map.flyTo({
      center: [rec.lon, rec.lat],
      zoom: Math.max(map.getZoom(), 9),
      duration: 1200,
      essential: true,
    });
    return;
  }
  if (rec.bbox) {
    map.fitBounds(
      [
        [rec.bbox[0], rec.bbox[1]],
        [rec.bbox[2], rec.bbox[3]],
      ],
      {
        padding: 48,
        duration: 1200,
        maxZoom: rec.kind === "country" ? 5 : 8,
        essential: true,
      },
    );
    return;
  }
  if (Number.isFinite(rec.lat) && Number.isFinite(rec.lon)) {
    map.flyTo({ center: [rec.lon, rec.lat], zoom: 8, duration: 1200 });
  }
}

function selectionTotal() {
  return (
    Object.keys(state.countries).length +
    Object.keys(state.states).length +
    Object.keys(state.cities).length
  );
}

function selectedRow({ kind, id, name, color, sub }) {
  const li = document.createElement("li");
  li.className = "result-row";
  if (styleTarget && styleTarget.kind === kind && styleTarget.id === id) li.classList.add("current");

  const badge = document.createElement("span");
  badge.className = "result-badge";
  badge.dataset.kind = kind;
  badge.textContent = KIND_LABEL[kind];

  const text = document.createElement("span");
  text.className = "result-text tappable";
  text.title = `Voar até ${name}`;
  const n = document.createElement("span");
  n.className = "name";
  n.textContent = name;
  text.appendChild(n);
  if (sub) {
    const s = document.createElement("span");
    s.className = "sub";
    s.textContent = sub;
    text.appendChild(s);
  }
  text.addEventListener("click", () => {
    styleTarget = { kind, id };
    renderPlaceStyle();
    for (const row of $$("#selected-all .result-row")) row.classList.remove("current");
    li.classList.add("current");
    const place = markedPlaces().find((p) => p.kind === kind && p.id === id);
    if (place) goTo(place);
  });

  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = color || "#e0a83c";
  colorInput.title = `Cor de ${name}`;
  colorInput.setAttribute("aria-label", `Cor de ${name}`);
  colorInput.addEventListener("input", () => {
    if (kind === "country" && state.countries[id]) {
      state.countries[id].color = colorInput.value;
      applyCountry(id);
    } else if (kind === "state" && state.states[id]) {
      state.states[id].color = colorInput.value;
      applyState(id);
    } else if (kind === "city" && state.cities[id]) {
      state.cities[id].color = colorInput.value;
      renderSelectedCities();
    }
    save();
  });

  const rm = document.createElement("button");
  rm.className = "remove";
  rm.textContent = "×";
  rm.title = "Remover";
  rm.addEventListener("click", () => {
    if (kind === "country") toggleCountry(id);
    else if (kind === "state") toggleState(id);
    else toggleCity(id);
  });

  li.append(badge, text, colorInput, rm);
  return li;
}

function renderSelection() {
  $("#sel-count").textContent = String(selectionTotal());
  const ul = $("#selected-all");
  ul.innerHTML = "";

  const rows = [];
  for (const id of Object.keys(state.countries)) {
    rows.push({ kind: "country", id, name: countryLabel(id), color: state.countries[id].color });
  }
  for (const id of Object.keys(state.states)) {
    const rec = statesById.get(id);
    rows.push({
      kind: "state",
      id,
      name: stateLabel(id),
      color: state.states[id].color,
      sub: rec?.sub,
    });
  }
  for (const [id, c] of Object.entries(state.cities)) {
    rows.push({ kind: "city", id, name: c.name, color: c.color, sub: c.sub });
  }

  const order = { country: 0, state: 1, city: 2 };
  rows.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));

  for (const row of rows) ul.appendChild(selectedRow(row));

  renderQuickJump();
  renderPlaceStyle();
  renderRouteSelects();
  renderConflictSelects();
}

/* ---------- ir para um marcado ---------- */
let jumpIndex = -1;

/** Lista os locais marcados com o alvo de câmera de cada um. */
function markedPlaces() {
  const list = [];
  for (const id of Object.keys(state.countries)) {
    const p = countriesById.get(id);
    list.push({
      kind: "country",
      id,
      name: countryLabel(id),
      color: state.countries[id].color,
      bbox: p?._bbox || null,
    });
  }
  for (const id of Object.keys(state.states)) {
    const rec = statesById.get(id);
    list.push({
      kind: "state",
      id,
      name: rec?.name || id,
      color: state.states[id].color,
      bbox: rec?.bbox || null,
      lat: rec?.lat,
      lon: rec?.lon,
    });
  }
  for (const [id, c] of Object.entries(state.cities)) {
    const rec = citiesById.get(id);
    list.push({
      kind: "city",
      id,
      name: c.name,
      color: c.color,
      bbox: rec?.bbox || null,
      lat: Number.isFinite(c.lat) ? c.lat : rec?.lat,
      lon: Number.isFinite(c.lon) ? c.lon : rec?.lon,
    });
  }
  const order = { country: 0, state: 1, city: 2 };
  return list.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

function renderQuickJump() {
  const box = $("#quick-jump");
  if (!box) return;
  const places = markedPlaces();
  const count = $("#jump-count");
  if (count) count.textContent = String(places.length);
  box.innerHTML = "";

  if (!places.length) {
    const empty = document.createElement("span");
    empty.className = "jump-empty";
    empty.textContent = "Marque um país, estado ou cidade na aba Mapa.";
    box.appendChild(empty);
    return;
  }

  for (const place of places) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "jump-chip";
    chip.dataset.kind = place.kind;
    chip.title = `Voar até ${place.name}`;

    const dot = document.createElement("span");
    dot.className = "jump-dot";
    dot.style.background = place.color || "#e0a83c";

    const label = document.createElement("span");
    label.textContent = place.name;

    chip.append(dot, label);
    chip.addEventListener("click", () => {
      jumpIndex = places.indexOf(place);
      markActiveChip(chip);
      goTo(place);
      toast(`Voando para ${place.name}`);
    });
    box.appendChild(chip);
  }

  if (jumpIndex >= places.length) jumpIndex = -1;
}

function markActiveChip(chip) {
  for (const el of document.querySelectorAll("#quick-jump .jump-chip")) {
    el.classList.toggle("active", el === chip);
  }
}

/** Passa para o próximo (ou anterior) lugar marcado, para encadear keyframes. */
function cycleJump(delta) {
  const places = markedPlaces();
  if (!places.length) {
    toast("Nenhum lugar marcado ainda");
    return;
  }
  jumpIndex = (jumpIndex + delta + places.length) % places.length;
  const place = places[jumpIndex];
  goTo(place);
  const chips = document.querySelectorAll("#quick-jump .jump-chip");
  if (chips[jumpIndex]) markActiveChip(chips[jumpIndex]);
  toast(`${jumpIndex + 1}/${places.length} · ${place.name}`);
}

/* ---------- busca ---------- */
function setSearchStatus(text) {
  const el = $("#search-status");
  if (el) el.textContent = text;
}

function updateSearchStatusIdle() {
  const parts = [];
  if (stateIndex.length) parts.push(`${stateIndex.length} estados`);
  const cities = searchIndex.filter((rec) => rec.kind === "city").length;
  if (cities) parts.push(`${cities.toLocaleString("pt-BR")} cidades`);
  if (parts.length) setSearchStatus(parts.join(" · "));
}

function resultRow(rec, query) {
  const li = document.createElement("li");
  if (isSelected(rec)) li.classList.add("selected");

  const btn = document.createElement("button");
  btn.className = "result-main";
  btn.type = "button";

  const badge = document.createElement("span");
  badge.className = "result-badge";
  badge.dataset.kind = rec.kind;
  badge.textContent = KIND_LABEL[rec.kind];

  const text = document.createElement("span");
  text.className = "result-text";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = rec.name;
  const sub = document.createElement("span");
  sub.className = "sub";
  sub.textContent = rec.sub || "";
  text.append(name, sub);

  const go = document.createElement("span");
  go.className = "result-go";
  go.textContent = isSelected(rec) ? "✓" : "ir";

  btn.append(badge, text, go);
  btn.addEventListener("click", () => {
    goTo(rec);
    selectPlace(rec);
    renderSelection();
    renderSearch(query);
  });

  li.appendChild(btn);
  return li;
}

function renderSearch(query) {
  const ul = $("#search-results");
  if (!ul) return;
  ul.innerHTML = "";
  const results = search(searchIndex, query, 12);
  for (const rec of results) ul.appendChild(resultRow(rec, query));
  const pane = $("#pane-paises");
  if (pane) pane.classList.toggle("searching", results.length > 0);
}

/* ------------------------------------------------------------------ *
 * Keyframes
 * ------------------------------------------------------------------ */
function currentCamera() {
  const c = map.getCenter();
  return {
    center: [Number(c.lng.toFixed(5)), Number(c.lat.toFixed(5))],
    zoom: Number(map.getZoom().toFixed(3)),
    pitch: Number(map.getPitch().toFixed(1)),
    bearing: Number((((map.getBearing() % 360) + 360) % 360).toFixed(1)),
  };
}

function addKeyframe() {
  const cam = currentCamera();
  const kf = {
    id: `kf_${Date.now().toString(36)}`,
    camera: cam,
    duration: state.keyframes.length ? 3 : 0,
    hold: state.keyframes.length ? undefined : 0,
    ease: "easeInOut",
    motion: "smooth",
    transition: "none",
    narration: null,
    label: activePlaceName() || `Cena ${state.keyframes.length + 1}`,
  };
  state.keyframes.push(kf);
  selectedKeyframe = state.keyframes.length - 1;
  renderKeyframes();
  renderTimeline();
  save();
  toast(`Keyframe ${state.keyframes.length} · ${kf.label}`);
}

/** Nome do último lugar para onde a câmera voou (vira o nome da cena). */
function activePlaceName() {
  const places = markedPlaces();
  if (!places.length) return "";
  if (jumpIndex >= 0 && places[jumpIndex]) return places[jumpIndex].name;
  return "";
}

function updateCurrentKeyframe() {
  const idx = selectedKeyframe;
  if (idx == null || !state.keyframes[idx]) {
    toast("Selecione um keyframe na lista.");
    return;
  }
  state.keyframes[idx].camera = currentCamera();
  renderKeyframes();
  save();
  toast("Câmera atualizada");
}

let selectedKeyframe = null;

function applyKeyframeCamera(cam) {
  map.jumpTo({
    center: cam.center,
    zoom: cam.zoom,
    pitch: cam.pitch || 0,
    bearing: cam.bearing || 0,
  });
}

function labeledSelect(labelText, options, value, onChange, title) {
  const wrap = document.createElement("label");
  wrap.className = "kf-opt";

  const span = document.createElement("span");
  span.textContent = labelText;

  const sel = document.createElement("select");
  sel.title = title || labelText;
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.id;
    o.textContent = opt.label;
    sel.appendChild(o);
  }
  sel.value = options.some((o) => o.id === value) ? value : options[0].id;
  sel.addEventListener("change", () => onChange(sel.value));

  wrap.append(span, sel);
  return wrap;
}

function renderKeyframes() {
  const ol = $("#kf-list");
  ol.innerHTML = "";

  state.keyframes.forEach((kf, i) => {
    const li = document.createElement("li");
    if (i === selectedKeyframe) li.classList.add("current");

    const head = document.createElement("div");
    head.className = "kf-head";

    const badge = document.createElement("span");
    badge.className = "kf-badge";
    badge.textContent = String(i + 1);

    const cam = kf.camera || { center: [0, 0], zoom: 0 };
    const center = cam.center || [0, 0];

    const meta = document.createElement("span");
    meta.className = "kf-meta";
    const title = kf.label ? `<b>${escapeHtml(kf.label)}</b><br>` : "";
    meta.innerHTML = `${title}z <b>${Number(cam.zoom || 0).toFixed(1)}</b> · ${Number(center[1] || 0).toFixed(1)}°, ${Number(center[0] || 0).toFixed(1)}°`;

    // a duração do primeiro keyframe é a espera antes de começar; nos
    // demais é o tempo de viagem da câmera até ele
    const dur = document.createElement("input");
    dur.className = "kf-dur";
    dur.type = "number";
    dur.min = "0.5";
    dur.step = "0.5";
    dur.value = String(i === 0 ? Number(kf.hold) || 0 : Number(kf.duration) || 0);
    dur.title = i === 0 ? "Espera na primeira cena (s)" : "Duração até este keyframe (s)";
    dur.addEventListener("change", () => {
      const value = Math.max(i === 0 ? 0 : 0.5, Number(dur.value) || 0);
      if (i === 0) kf.hold = value;
      else kf.duration = value;
      save();
      updateExportSummary();
      renderTimeline();
    });

    const go = document.createElement("button");
    go.className = "icon-btn";
    go.textContent = "◎";
    go.title = "Ir para este keyframe";
    go.addEventListener("click", () => {
      selectedKeyframe = i;
      applyKeyframeCamera(kf.camera);
      renderKeyframes();
    });

    const rm = document.createElement("button");
    rm.className = "icon-btn";
    rm.textContent = "×";
    rm.title = "Remover";
    rm.addEventListener("click", () => {
      state.keyframes.splice(i, 1);
      if (selectedKeyframe === i) selectedKeyframe = null;
      else if (selectedKeyframe > i) selectedKeyframe--;
      renderKeyframes();
      save();
    });

    head.append(badge, meta, dur, go, rm);
    li.appendChild(head);

    // ---- narração da cena ----
    li.appendChild(narrationRow(i));

    // o primeiro keyframe é o ponto de partida: não tem movimento/transição
    if (i > 0 && kf.camera) {
      const opts = document.createElement("div");
      opts.className = "kf-opts";

      opts.appendChild(
        labeledSelect("Movimento", MOTION_OPTIONS, kf.motion || "smooth", (v) => {
          kf.motion = v;
          save();
        }, "Como a câmera viaja até este keyframe"),
      );

      opts.appendChild(
        labeledSelect("Suavidade", EASE_OPTIONS, kf.ease || "easeInOut", (v) => {
          kf.ease = v;
          save();
        }, "Curva de aceleração do trecho"),
      );

      opts.appendChild(
        labeledSelect("Transição", TRANSITION_OPTIONS, kf.transition || "none", (v) => {
          kf.transition = v;
          save();
        }, "Efeito visual quando a câmera chega neste keyframe"),
      );

      opts.appendChild(
        labeledSelect("Tema", THEME_OPTIONS, kf.theme || "", (v) => {
          kf.theme = v;
          save();
        }, "Tema do mapa a partir deste keyframe"),
      );

      li.appendChild(opts);
    }

    ol.appendChild(li);
  });

  $("#kf-hint").style.display = state.keyframes.length ? "none" : "block";
  updateExportSummary();
  syncAudioUI();
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

/** Linha de narração de um keyframe: importar / trocar / ajustar / remover. */
function narrationRow(index) {
  const kf = state.keyframes[index];
  const row = document.createElement("div");
  row.className = "kf-nar";

  const label = document.createElement("span");
  label.className = "kf-nar-name";
  if (kf.narration) {
    label.textContent = `${kf.narration.name} · ${formatTime(kf.narration.duration)}`;
    label.title = kf.narration.name;
  } else {
    label.textContent = "Sem narração";
    label.classList.add("empty");
  }

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "audio/*";
  input.hidden = true;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (file) attachNarration(index, file);
  });

  const pick = document.createElement("button");
  pick.className = "link";
  pick.textContent = kf.narration ? "trocar" : "importar";
  pick.addEventListener("click", () => input.click());

  row.append(label, pick, input);

  if (kf.narration) {
    const fit = document.createElement("button");
    fit.className = "link";
    fit.textContent = "ajustar";
    fit.title = "Duração da cena = narração + intervalo";
    fit.addEventListener("click", () => {
      fitNarration(index);
      renderKeyframes();
      renderTimeline();
      save();
      toast(`Cena com ${formatTime(segmentLength(state.keyframes, index))}`);
    });

    const del = document.createElement("button");
    del.className = "link danger";
    del.textContent = "remover";
    del.addEventListener("click", () => {
      kf.narration = null;
      renderKeyframes();
      renderTimeline();
      save();
    });

    row.append(fit, del);
  }

  return row;
}

async function attachNarration(index, file) {
  const kf = state.keyframes[index];
  if (!kf) return;
  const id = `narr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try {
    await putMedia(id, file, { name: file.name, kind: "narration" });
  } catch (err) {
    console.error(err);
    toast("Não foi possível guardar o áudio no aparelho.");
    return;
  }
  const duration = await probeDuration(file, "audio");
  if (!duration) {
    toast("Não consegui ler a duração desse áudio.");
  }
  kf.narration = { mediaId: id, name: file.name, duration: +duration.toFixed(2) };
  fitNarration(index);
  renderKeyframes();
  renderTimeline();
  save();
  toast(`Narração de ${formatTime(duration)} · cena de ${formatTime(segmentLength(state.keyframes, index))}`);
}

/** Iguala a duração da cena ao áudio mais o intervalo definido. */
function fitNarration(index) {
  const kf = state.keyframes[index];
  if (!kf?.narration) return 0;
  const gap = Math.max(0, Number(state.audio.gap) || 0);
  const value = Math.max(0.5, +(Number(kf.narration.duration) + gap).toFixed(2));
  if (index === 0) kf.hold = value;
  else kf.duration = value;
  return value;
}

/** Ajusta todas as cenas que têm narração. */
function fitAllNarrations() {
  let count = 0;
  state.keyframes.forEach((kf, i) => {
    if (!kf.narration) return;
    fitNarration(i);
    count++;
  });
  if (!count) {
    toast("Nenhuma cena tem narração ainda.");
    return;
  }
  renderKeyframes();
  renderTimeline();
  save();
  updateExportSummary();
  toast(`${count} cena(s) sincronizada(s) com o áudio`);
}


/* ------------------------------------------------------------------ *
 * Texto
 * ------------------------------------------------------------------ */
function syncTextUI() {
  $("#txt-heading").value = state.text.heading;
  $("#txt-sub").value = state.text.sub;
  $("#txt-color").value = state.text.color;
  $("#txt-size").value = String(state.text.size);
  $("#size-label").textContent = String(state.text.size);
  $("#txt-pos").value = state.text.position;
  $("#txt-shadow").checked = state.text.shadow;
  applyTextToDOM();
}

function applyTextToDOM() {
  const el = $("#overlay-text");
  el.className = state.text.position + (state.text.shadow ? " shadow" : "");
  el.style.setProperty("--txt-color", state.text.color);

  const h = $("#ov-heading");
  const s = $("#ov-sub");
  h.textContent = state.text.heading;
  s.textContent = state.text.sub;
  h.style.fontSize = `${state.text.size}px`;
  s.style.fontSize = `${Math.round(state.text.size * 0.43)}px`;
  h.style.color = state.text.color;
  s.style.color = state.text.color;

  const hasText = Boolean(state.text.heading || state.text.sub);
  el.classList.toggle("visible", hasText && !playing);
}

/* ------------------------------------------------------------------ *
 * Áudio
 * ------------------------------------------------------------------ */
function formatTime(s) {
  return `${Number(s || 0).toFixed(1).replace(".", ",")} s`;
}

function audioTimeMax() {
  return Math.max(1, totalDuration(state.keyframes));
}

function renderSfxGrid() {
  const grid = $("#au-sfx-grid");
  if (!grid || grid.childElementCount) return;
  for (const sfx of SFX_TYPES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sfx-btn";
    btn.textContent = sfx.label;
    btn.title = `Adicionar ${sfx.label} na posição escolhida`;
    btn.addEventListener("click", () => addSfx(sfx.id));
    grid.appendChild(btn);
  }
}

async function previewSfx(type) {
  try {
    await audio.load();
    if (state.audio.imports.length) await audio.loadCustomSfx(state.audio.imports);
    audio.schedule({
      events: [{ type, time: 0, volume: 1 }],
      source: "none",
      sfxVolume: state.audio.sfxVolume,
      destinations: [audio.ctx.destination],
    });
  } catch (err) {
    console.warn("Sem áudio:", err);
    toast("Áudio não disponível neste navegador.");
  }
}

/** Nome de um efeito: os prontos têm rótulo fixo, os importados vêm do arquivo. */
function sfxName(type) {
  const imp = state.audio.imports.find((i) => i.mediaId === type);
  return imp ? imp.name : sfxLabel(type);
}

function addSfx(type) {
  const time = Math.min(Number($("#au-time").value) || 0, audioTimeMax());
  state.audio.events.push({
    id: `sfx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    type,
    time,
  });
  state.audio.enabled = true;
  $("#au-enabled").checked = true;
  save();
  renderAudioEvents();
  updateExportSummary();
  previewSfx(type);
  toast(`${sfxName(type)} em ${formatTime(time)}`);
}

/** Importa um som do usuário e o deixa disponível na paleta. */
async function addImportedSfx(file) {
  if (!file) return;
  const mediaId = `sfx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try {
    await putMedia(mediaId, file, { name: file.name, kind: "sfx" });
  } catch (err) {
    console.error(err);
    toast("Não foi possível guardar o som.");
    return;
  }
  const duration = await probeDuration(file, "audio");
  state.audio.imports.push({ mediaId, name: file.name, duration: +duration.toFixed(2) });
  try {
    await audio.loadCustomSfx(state.audio.imports);
  } catch (err) {
    console.warn("Falha ao decodificar o som:", err);
  }
  renderImportedSfx();
  save();
  toast(`Som importado: ${file.name}`);
}

function renderImportedSfx() {
  const grid = $("#au-imported-grid");
  if (!grid) return;
  const count = $("#au-import-count");
  if (count) count.textContent = String(state.audio.imports.length);
  grid.innerHTML = "";

  if (!state.audio.imports.length) {
    const empty = document.createElement("span");
    empty.className = "jump-empty";
    empty.textContent = "Nenhum som seu ainda.";
    grid.appendChild(empty);
    return;
  }

  for (const imp of state.audio.imports) {
    const wrap = document.createElement("span");
    wrap.className = "sfx-chip";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sfx-btn";
    btn.textContent = imp.name;
    btn.title = `${imp.name} · ${formatTime(imp.duration)}`;
    btn.addEventListener("click", () => addSfx(imp.mediaId));

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "remove";
    rm.textContent = "×";
    rm.title = "Remover som importado";
    rm.addEventListener("click", () => {
      state.audio.imports = state.audio.imports.filter((i) => i.mediaId !== imp.mediaId);
      state.audio.events = state.audio.events.filter((e) => e.type !== imp.mediaId);
      forgetURL(imp.mediaId);
      renderImportedSfx();
      renderAudioEvents();
      save();
    });

    wrap.append(btn, rm);
    grid.appendChild(wrap);
  }
}

function renderAudioEvents() {
  const ul = $("#au-events");
  if (!ul) return;

  const events = [...state.audio.events].sort((a, b) => a.time - b.time);
  $("#au-count").textContent = String(events.length);
  ul.innerHTML = "";

  if (!events.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nenhum efeito ainda. Toque em um som acima.";
    ul.appendChild(li);
    renderTimeline();
    return;
  }

  for (const ev of events) {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "sfx-name";
    name.textContent = sfxName(ev.type);

    const time = document.createElement("input");
    time.className = "kf-dur";
    time.type = "number";
    time.min = "0";
    time.step = "0.1";
    time.value = Number(ev.time).toFixed(1);
    time.title = "Instante do efeito (s)";
    time.addEventListener("change", () => {
      ev.time = Math.max(0, Math.min(Number(time.value) || 0, audioTimeMax()));
      save();
      renderAudioEvents();
    });

    const rm = document.createElement("button");
    rm.className = "remove";
    rm.textContent = "×";
    rm.title = "Remover efeito";
    rm.addEventListener("click", () => {
      state.audio.events = state.audio.events.filter((e) => e.id !== ev.id);
      save();
      renderAudioEvents();
      updateExportSummary();
    });

    li.append(name, time, rm);
    ul.appendChild(li);
  }

  renderTimeline();
}

function syncAudioUI() {
  if (!$("#au-enabled")) return;

  $("#au-enabled").checked = Boolean(state.audio.enabled);
  $("#au-source").value = state.audio.source;
  $("#au-file-field").hidden = state.audio.source !== "file";
  $("#au-file-name").textContent = audio.fileName
    ? `${audio.fileName} · ${formatTime(audio.fileMusic?.duration || 0)}`
    : state.audio.source === "file"
      ? "Nenhum arquivo escolhido"
      : "";

  const music = Math.round(state.audio.musicVolume * 100);
  const sfx = Math.round(state.audio.sfxVolume * 100);
  const narr = Math.round((state.audio.narrationVolume ?? 1) * 100);
  $("#au-music").value = String(music);
  $("#au-music-label").textContent = `${music}%`;
  $("#au-sfx").value = String(sfx);
  $("#au-sfx-label").textContent = `${sfx}%`;
  $("#au-narr").value = String(narr);
  $("#au-narr-label").textContent = `${narr}%`;

  const gap = Math.round((Number(state.audio.gap) || 0) * 10);
  $("#au-gap").value = String(gap);
  $("#au-gap-label").textContent = formatTime((Number(state.audio.gap) || 0));

  $("#au-duck").checked = state.audio.duck !== false;

  const offset = Math.round(Number(state.audio.offset) || 0);
  $("#au-offset").value = String(offset);
  $("#au-offset-label").textContent = `${offset} ms`;

  const max = audioTimeMax();
  const time = $("#au-time");
  time.max = String(max);
  if (Number(time.value) > max) time.value = String(max);
  $("#au-time-label").textContent = formatTime(Number(time.value) || 0);

  renderSfxGrid();
  renderImportedSfx();
  renderAudioEvents();
}

/* ------------------------------------------------------------------ *
 * Sobreposições de mídia (imagem, GIF, vídeo)
 * ------------------------------------------------------------------ */
function currentOverlay() {
  return state.overlays.find((ov) => ov.id === selectedOverlay) || null;
}

/** Classifica o arquivo pelo tipo MIME / extensão. */
function overlayKind(file) {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  if (type.startsWith("video/") || /\.(mp4|webm|mov|m4v|ogv)$/.test(name)) return "video";
  if (type === "image/gif" || /\.gif$/.test(name)) return "gif";
  return "image";
}

async function addOverlayFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  const total = totalDuration(state.keyframes);
  const start =
    total > 0 ? Math.min(Math.max(0, TL.time || 0), Math.max(0, total - 2)) : 0;
  const end = total > 0 ? total : start + 4;
  let added = 0;
  let lastId = null;

  for (const file of list) {
    const kind = overlayKind(file);
    const id = `ov_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    try {
      await putMedia(id, file, { name: file.name, kind });
    } catch (err) {
      console.error(err);
      toast("Não foi possível guardar a mídia no aparelho.");
      continue;
    }

    state.overlays.push({
      id,
      mediaId: id,
      kind,
      name: file.name,
      x: 0.5,
      y: 0.5,
      scale: 0.4,
      opacity: 1,
      rotation: 0,
      start,
      end,
    });
    selectedOverlay = id;
    lastId = id;
    added++;
  }

  if (!added) return;
  if (lastId) TL.sel = { kind: "overlay", id: lastId };
  renderOverlayList();
  await prepareOverlayMedia();
  syncOverlaysDOM(TL.time, false);
  renderTimeline();
  seekTimeline(start);
  save();
  commitHistory();
  toast(`${added} mídia(s) adicionada(s)`);
}

function renderOverlayList() {
  const ul = $("#md-list");
  if (!ul) return;
  const count = $("#md-count");
  if (count) count.textContent = String(state.overlays.length);
  ul.innerHTML = "";

  if (!state.overlays.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nenhuma mídia. Importe uma imagem, GIF ou vídeo.";
    ul.appendChild(li);
    renderOverlayEditor();
    return;
  }

  for (const ov of state.overlays) {
    const li = document.createElement("li");
    if (ov.id === selectedOverlay) li.classList.add("current");

    const badge = document.createElement("span");
    badge.className = "result-badge";
    badge.textContent = ov.kind === "video" ? "Vídeo" : ov.kind === "gif" ? "GIF" : "Imagem";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = ov.name;
    name.title = `${ov.name} · ${formatTime(ov.start)} → ${formatTime(ov.end)}`;

    const rm = document.createElement("button");
    rm.className = "remove";
    rm.textContent = "×";
    rm.title = "Remover sobreposição";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      state.overlays = state.overlays.filter((o) => o.id !== ov.id);
      const el = overlayEls.get(ov.id);
      if (el) {
        el.remove();
        overlayEls.delete(ov.id);
      }
      if (selectedOverlay === ov.id) selectedOverlay = null;
      renderOverlayList();
      renderTimeline();
      save();
    });

    li.append(badge, name, rm);
    li.addEventListener("click", () => {
      selectedOverlay = ov.id;
      renderOverlayList();
      renderTimeline();
      seekTimeline(ov.start);
    });
    ul.appendChild(li);
  }

  renderOverlayEditor();
}

function renderOverlayEditor() {
  const box = $("#md-editor");
  if (!box) return;
  const ov = currentOverlay();
  box.hidden = !ov;
  if (!ov) return;

  $("#md-editor-title").textContent = ov.name;
  $("#md-x").value = String(Math.round((Number(ov.x) || 0.5) * 100));
  $("#md-x-label").textContent = `${Math.round((Number(ov.x) || 0.5) * 100)}%`;
  $("#md-y").value = String(Math.round((Number(ov.y) || 0.5) * 100));
  $("#md-y-label").textContent = `${Math.round((Number(ov.y) || 0.5) * 100)}%`;
  $("#md-scale").value = String(Math.round((Number(ov.scale) || 0.4) * 100));
  $("#md-scale-label").textContent = `${Math.round((Number(ov.scale) || 0.4) * 100)}%`;
  const op = Math.round((ov.opacity == null ? 1 : ov.opacity) * 100);
  $("#md-opacity").value = String(op);
  $("#md-opacity-label").textContent = `${op}%`;
  $("#md-rot").value = String(Math.round(Number(ov.rotation) || 0));
  $("#md-rot-label").textContent = `${Math.round(Number(ov.rotation) || 0)}°`;

  const total = Math.max(6, totalDuration(state.keyframes));
  const start = $("#md-start");
  const end = $("#md-end");
  start.max = String(total);
  end.max = String(total);
  start.value = String(Number(ov.start) || 0);
  end.value = String(Number(ov.end) || 0);
  $("#md-start-label").textContent = formatTime(Number(ov.start) || 0);
  $("#md-end-label").textContent = formatTime(Number(ov.end) || 0);
}

/** Cria os elementos de imagem/vídeo e espera o carregamento. */
async function prepareOverlayMedia() {
  for (const ov of state.overlays) {
    if (overlayEls.has(ov.id)) continue;
    const url = await mediaURL(ov.mediaId);
    if (!url) continue;

    let el;
    if (ov.kind === "video") {
      el = document.createElement("video");
      el.muted = true;
      el.loop = true;
      el.playsInline = true;
      el.setAttribute("playsinline", "");
      el.preload = "auto";
    } else {
      el = document.createElement("img");
      el.alt = "";
      el.decoding = "async";
    }
    el.className = "ov-media";
    el.src = url;
    overlayEls.set(ov.id, el);
  }

  // remove elementos órfãos
  const ids = new Set(state.overlays.map((o) => o.id));
  for (const [id, el] of overlayEls) {
    if (ids.has(id)) continue;
    el.remove();
    overlayEls.delete(id);
  }

  await Promise.all(
    [...overlayEls.values()].map((el) => {
      if (el.tagName === "IMG") {
        return el.complete ? null : new Promise((r) => {
          el.addEventListener("load", r, { once: true });
          el.addEventListener("error", r, { once: true });
        });
      }
      return el.readyState >= 2
        ? null
        : new Promise((r) => {
            el.addEventListener("loadeddata", r, { once: true });
            el.addEventListener("error", r, { once: true });
          });
    }),
  );

  syncOverlayDOMStructure();
}

function syncOverlayDOMStructure() {
  const host = $("#overlay-media");
  if (!host) return;
  const wanted = new Set();
  for (const ov of state.overlays) {
    const el = overlayEls.get(ov.id);
    if (!el) continue;
    wanted.add(el);
    if (el.parentNode !== host) host.appendChild(el);
  }
  for (const child of [...host.children]) {
    if (!wanted.has(child)) child.remove();
  }
}

/**
 * Posiciona as sobreposições na prévia.
 * @param {number} t instante atual
 * @param {boolean} live durante a reprodução respeita entra/sai; parado mostra tudo
 */
function syncOverlaysDOM(t, live = playing) {
  const host = $("#overlay-media");
  if (!host) return;
  const W = host.clientWidth || 1;
  const H = host.clientHeight || 1;

  for (const ov of state.overlays) {
    const el = overlayEls.get(ov.id);
    if (!el) continue;

    const alpha = live
      ? overlayAlphaAt(ov, t)
      : (ov.opacity == null ? 1 : Math.max(0, Math.min(1, Number(ov.opacity))));

    const w = Math.max(0.02, Number(ov.scale) || 0.4) * W;
    el.style.width = `${w}px`;
    el.style.left = `${(Number(ov.x) || 0.5) * W}px`;
    el.style.top = `${(Number(ov.y) || 0.5) * H}px`;
    el.style.opacity = alpha.toFixed(3);
    el.style.transform = `translate(-50%, -50%) rotate(${Number(ov.rotation) || 0}deg)`;
    el.style.display = alpha > 0.004 ? "block" : "none";
  }

  syncOverlayVideos(t, live);
}

/** Toca/pausa os vídeos conforme a faixa de tempo. */
function syncOverlayVideos(t, live) {
  for (const ov of state.overlays) {
    if (ov.kind !== "video") continue;
    const el = overlayEls.get(ov.id);
    if (!el) continue;
    const active = live && t >= (Number(ov.start) || 0) && t <= (Number(ov.end) || 0);
    if (active) {
      if (el.paused) el.play().catch(() => {});
    } else if (!el.paused) {
      el.pause();
      if (!live) el.currentTime = 0;
    }
  }
}

/** Desenha as sobreposições no canvas da exportação. */
function drawMediaOverlays(ctx, t) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  syncOverlayVideos(t, true);

  for (const ov of state.overlays) {
    const el = overlayEls.get(ov.id);
    if (!el) continue;
    const alpha = overlayAlphaAt(ov, t);
    if (alpha <= 0.004) continue;

    const srcW = el.naturalWidth || el.videoWidth || 0;
    const srcH = el.naturalHeight || el.videoHeight || 0;
    if (!srcW || !srcH) continue;

    const w = Math.max(0.02, Number(ov.scale) || 0.4) * W;
    const h = w * (srcH / srcW);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate((Number(ov.x) || 0.5) * W, (Number(ov.y) || 0.5) * H);
    ctx.rotate(((Number(ov.rotation) || 0) * Math.PI) / 180);
    try {
      ctx.drawImage(el, -w / 2, -h / 2, w, h);
    } catch (err) {
      /* quadro ainda não pronto: ignora */
    }
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ *
 * Linha do tempo (estilo editor de vídeo)
 * ------------------------------------------------------------------ */
/** Largura da coluna de nomes das faixas (precisa casar com o CSS). */
const TL_LANE_LEFT = 58;

function tlSpan() {
  return Math.max(6, totalDuration(state.keyframes));
}

function renderTimeline() {
  const content = $("#tl-content");
  if (!content) return;

  const span = tlSpan();
  content.style.width = `${Math.max(300, TL_LANE_LEFT + span * TL.pps + 90)}px`;

  renderRuler(span);
  renderCameraLane();
  renderNarrationLane();
  renderOverlayLane();
  renderRouteLane();
  renderConflictLane();
  renderSfxLane();

  const dur = $("#tl-dur");
  if (dur) dur.textContent = `de ${formatTime(totalDuration(state.keyframes))}`;
  updatePlayhead();
  syncTimelineTools();
}

function renderRuler(span) {
  const ruler = $("#tl-ruler");
  if (!ruler) return;
  ruler.innerHTML = "";
  const step = TL.pps >= 90 ? 0.5 : TL.pps >= 55 ? 1 : TL.pps >= 30 ? 2 : 5;
  const count = Math.ceil(span / step) + 1;

  for (let i = 0; i < count; i++) {
    const t = i * step;
    const tick = document.createElement("div");
    tick.className = "tl-tick";
    tick.style.left = `${t * TL.pps}px`;
    const label = document.createElement("span");
    label.textContent = `${t.toFixed(step < 1 ? 1 : 0).replace(".", ",")}s`;
    tick.appendChild(label);
    ruler.appendChild(tick);
  }
}

function tlClip({ start, length, className, label, title, handle }) {
  const el = document.createElement("div");
  el.className = `tl-clip ${className || ""}`.trim();
  el.style.left = `${Math.max(0, start) * TL.pps}px`;
  el.style.width = `${Math.max(6, length * TL.pps)}px`;
  if (title) el.title = title;

  if (label) {
    const span = document.createElement("span");
    span.className = "tl-clip-label";
    span.textContent = label;
    el.appendChild(span);
  }
  if (handle) {
    const h = document.createElement("span");
    h.className = "tl-clip-handle";
    el.appendChild(h);
  }
  return el;
}

/**
 * Arrasto genérico de blocos: `onDelta` recebe o deslocamento em segundos
 * desde o início do gesto, e `onTap` roda quando não houve arrasto.
 */
function bindTimelineClip(el, onDelta, onTap) {
  el.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    if (e.button != null && e.button !== 0) return;

    const resize = Boolean(e.target.closest(".tl-clip-handle"));
    const startX = e.clientX;
    let moved = false;

    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    const move = (ev) => {
      const delta = (ev.clientX - startX) / TL.pps;
      if (Math.abs(delta) > 0.02) moved = true;
      onDelta(delta, resize);
      updatePlayhead();
    };

    const finish = (ev) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", finish);
      el.removeEventListener("pointercancel", finish);
      try { el.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      if (!moved && onTap) onTap();
      renderTimeline();
      renderKeyframes();
      renderOverlayList();
      renderRouteList();
      fillRouteEditor();
      updateExportSummary();
      save();
    };

    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
  });
}

/* ------------------------------------------------------------------ *
 * Edição de blocos: dividir, cortar, duplicar e apagar
 *
 * A seleção vive em `TL.sel` (tipo + id) para valer em qualquer faixa e
 * sobreviver aos redesenho da linha do tempo.
 * ------------------------------------------------------------------ */
const TL_KIND_LABEL = {
  kf: "Câmera",
  overlay: "Mídia",
  route: "Rota",
  conflict: "Conflito",
  sfx: "Efeito",
};

const newClipId = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Trecho ocupado por um keyframe na linha do tempo. */
function kfRange(index) {
  const kf = state.keyframes[index];
  const times = keyframeTimes(state.keyframes);
  if (index === 0) return [0, Math.max(0, Number(kf.hold) || 0)];
  return [times[index - 1], times[index]];
}

/** Bloco selecionado, com o trecho que ele ocupa. */
function clipInfo() {
  const sel = TL.sel;
  if (!sel) return null;

  if (sel.kind === "kf") {
    const index = state.keyframes.findIndex((k) => k.id === sel.id);
    if (index < 0) return null;
    const [start, end] = kfRange(index);
    const kf = state.keyframes[index];
    return {
      kind: "kf",
      index,
      item: kf,
      start,
      end,
      name: kf.label || `Cena ${index + 1}`,
    };
  }

  if (sel.kind === "overlay") {
    const ov = state.overlays.find((o) => o.id === sel.id);
    if (!ov) return null;
    const start = Math.max(0, Number(ov.start) || 0);
    return {
      kind: "overlay",
      item: ov,
      start,
      end: Math.max(start + 0.2, Number(ov.end) || 0),
      name: ov.name || "Mídia",
    };
  }

  if (sel.kind === "route") {
    const rt = state.routes.find((r) => r.id === sel.id);
    if (!rt) return null;
    const start = routeStartTime(rt);
    return {
      kind: "route",
      item: rt,
      start,
      end: routeEndTime(rt, start),
      name: `${rt.fromName} → ${rt.toName}`,
    };
  }

  if (sel.kind === "sfx") {
    const ev = state.audio.events.find((x) => x.id === sel.id);
    if (!ev) return null;
    const start = Math.max(0, Number(ev.time) || 0);
    return { kind: "sfx", item: ev, start, end: start, name: sfxName(ev.type) };
  }

  if (sel.kind === "conflict") {
    const c = state.conflicts.find((x) => x.id === sel.id);
    if (!c) return null;
    const start = Math.max(0, Number(c.start) || 0);
    return {
      kind: "conflict",
      item: c,
      start,
      end: start + Math.max(0.8, Number(c.duration) || 3),
      name: conflictLabel(c),
    };
  }

  return null;
}

/** Marca o bloco como selecionado em qualquer faixa. */
function selectClip(kind, id) {
  TL.sel = { kind, id };
  hidePinHint();
  if (kind === "kf") {
    const i = state.keyframes.findIndex((k) => k.id === id);
    if (i >= 0) selectedKeyframe = i;
  } else if (kind === "overlay") {
    selectedOverlay = id;
  } else if (kind === "route") {
    selectedRouteId = id;
  } else if (kind === "conflict") {
    selectedConflictId = id;
  }
  syncTimelineTools();
}

/** Habilita só o que faz sentido para o bloco e a posição do cursor. */
function syncTimelineTools() {
  const label = $("#tl-sel");
  const info = clipInfo();
  const t = Number(TL.time) || 0;

  if (label) {
    label.textContent = info
      ? `${TL_KIND_LABEL[info.kind]} · ${info.name}`
      : "Toque num bloco para editar";
    label.classList.toggle("on", Boolean(info));
  }

  const span = info ? info.end - info.start : 0;
  const canSplit =
    Boolean(info) && info.kind !== "sfx" && span > 0.4 &&
    t > info.start + 0.2 && t < info.end - 0.2;
  const canCutStart =
    Boolean(info) && info.kind !== "sfx" && span > 0.4 &&
    t > info.start + 0.15 && t < info.end - 0.15;
  const canCutEnd =
    Boolean(info) && info.kind !== "sfx" && span > 0.4 &&
    t > info.start + 0.15 && t < info.end - 0.15;

  const set = (id, on) => {
    const el = $(id);
    if (el) el.disabled = !on;
  };
  set("#tl-split", canSplit);
  set("#tl-cut-start", canCutStart);
  set("#tl-cut-end", canCutEnd);
  set("#tl-dup", Boolean(info));
  set("#tl-del", Boolean(info));
  // trazer ao cursor: a primeira cena está presa ao início do vídeo
  set("#tl-pin", Boolean(info) && !(info.kind === "kf" && info.index === 0));
}

/** Redesenha tudo depois de editar um bloco. */
function afterTimelineEdit() {
  renderTimeline();
  renderKeyframes();
  renderOverlayList();
  renderRouteList();
  renderConflictList();
  fillRouteEditor();
  fillConflictEditor();
  updateExportSummary();
  syncTimelineTools();
  save();
  commitHistory(); // cada edição de bloco vira um passo próprio no histórico
  // o total pode ter mudado: reencaixa o cursor e redesenha a prévia
  seekTimeline(TL.time);
  scheduleGfx();
}

function splitAtPlayhead() {
  const info = clipInfo();
  if (!info) {
    toast("Toque num bloco da linha do tempo primeiro.");
    return;
  }
  const t = Number(TL.time.toFixed(2));
  if (info.kind === "sfx") {
    toast("Efeitos são um ponto no tempo: use Duplicar.");
    return;
  }
  if (info.end - info.start <= 0.4 || t <= info.start + 0.2 || t >= info.end - 0.2) {
    toast("Ponha o cursor dentro do bloco, com folga nas pontas.");
    return;
  }

  if (info.kind === "kf") splitKeyframe(info, t);
  else if (info.kind === "overlay") splitOverlay(info.item, t);
  else if (info.kind === "route") splitRoute(info.item, t);
  else if (info.kind === "conflict") splitConflict(info.item, t);

  afterTimelineEdit();
  toast("Bloco dividido no cursor.");
}

/** Divide o conflito: o primeiro fica mais curto, o segundo nasce no cursor. */
function splitConflict(c, t) {
  const index = state.conflicts.indexOf(c);
  const start = Math.max(0, Number(c.start) || 0);
  const dur = Math.max(0.8, Number(c.duration) || 3);
  const first = +(t - start).toFixed(2);
  const second = +(start + dur - t).toFixed(2);
  const clone = {
    ...c,
    id: newClipId("cf"),
    start: t,
    duration: Math.max(0.8, second),
  };
  c.duration = Math.max(0.8, first);
  state.conflicts.splice(index + 1, 0, clone);
  selectedConflictId = clone.id;
  TL.sel = { kind: "conflict", id: clone.id };
}

function splitKeyframe(info, t) {
  const { index, item: kf } = info;

  if (index === 0) {
    const hold = Number(kf.hold) || 0;
    kf.hold = t;
    const part = {
      ...kf,
      id: newClipId("kf"),
      camera: { ...kf.camera },
      duration: +(hold - t).toFixed(2),
      hold: undefined,
      narration: null,
      label: `${info.name} · parte 2`,
    };
    state.keyframes.splice(1, 0, part);
    TL.sel = { kind: "kf", id: part.id };
    selectedKeyframe = 1;
    return;
  }

  const times = keyframeTimes(state.keyframes);
  const cam = sampleAt(state.keyframes, t) || kf.camera;
  const part = {
    ...kf,
    id: newClipId("kf"),
    camera: { ...cam },
    duration: +(times[index] - t).toFixed(2),
    narration: null,
    label: `${info.name} · parte 2`,
  };
  kf.duration = +(t - times[index - 1]).toFixed(2);
  state.keyframes.splice(index + 1, 0, part);
  TL.sel = { kind: "kf", id: part.id };
  selectedKeyframe = index + 1;
}

function splitOverlay(ov, t) {
  const index = state.overlays.indexOf(ov);
  const clone = {
    ...ov,
    id: newClipId("ov"),
    start: t,
    end: Math.max(t + 0.2, Number(ov.end) || t + 1),
  };
  ov.end = t;
  state.overlays.splice(index + 1, 0, clone);
  selectedOverlay = clone.id;
  TL.sel = { kind: "overlay", id: clone.id };
  prepareOverlayMedia().then(() => syncOverlaysDOM(TL.time, false));
}

function splitRoute(rt, t) {
  const index = state.routes.indexOf(rt);
  const clone = {
    ...rt,
    id: newClipId("rt"),
    autoCamera: false,
    start: t,
    end: Math.max(t + 0.2, Number(rt.end) || t + 1),
  };
  rt.end = t;
  state.routes.splice(index + 1, 0, clone);
  selectedRouteId = clone.id;
  TL.sel = { kind: "route", id: clone.id };
}

/** `side` = "start" corta o começo; "end" corta o fim, até o cursor. */
function cutAtPlayhead(side) {
  const info = clipInfo();
  if (!info) {
    toast("Toque num bloco da linha do tempo primeiro.");
    return;
  }
  if (info.kind === "sfx") {
    toast("Efeitos são um ponto no tempo: use Apagar ou Duplicar.");
    return;
  }

  const t = Number(TL.time.toFixed(2));
  const MIN = 0.3;

  if (info.kind === "kf") {
    const i = info.index;
    if (side === "start") {
      if (i === 0) {
        toast("A abertura não tem trecho antes do cursor.");
        return;
      }
      if (info.end - t < MIN) {
        toast("Sobra pouco depois do cursor. Use Dividir.");
        return;
      }
      state.keyframes[i].duration = +(info.end - t).toFixed(2);
    } else {
      if (t - info.start < MIN) {
        toast("Sobra pouco antes do cursor. Use Dividir.");
        return;
      }
      if (i === 0) state.keyframes[0].hold = t;
      else state.keyframes[i].duration = +(t - info.start).toFixed(2);
    }
  } else if (info.kind === "overlay") {
    const ov = info.item;
    if (side === "start") {
      if (info.end - t < MIN) return toast("Sobra pouco depois do cursor.");
      ov.start = t;
    } else {
      if (t - info.start < MIN) return toast("Sobra pouco antes do cursor.");
      ov.end = t;
    }
  } else if (info.kind === "route") {
    const rt = info.item;
    if (side === "start") {
      if (info.end - t < MIN) return toast("Sobra pouco depois do cursor.");
      rt.autoCamera = false;
      rt.start = t;
    } else {
      if (t - info.start < MIN) return toast("Sobra pouco antes do cursor.");
      rt.end = t;
    }
  } else if (info.kind === "conflict") {
    const c = info.item;
    if (side === "start") {
      if (info.end - t < MIN) return toast("Sobra pouco depois do cursor.");
      c.start = t;
      c.duration = +(info.end - t).toFixed(2);
    } else {
      if (t - info.start < MIN) return toast("Sobra pouco antes do cursor.");
      c.duration = +(t - info.start).toFixed(2);
    }
  }

  afterTimelineEdit();
  toast(side === "start" ? "Começo cortado no cursor." : "Fim cortado no cursor.");
}

function deleteSelectedClip() {
  const info = clipInfo();
  if (!info) {
    toast("Toque num bloco da linha do tempo primeiro.");
    return;
  }

  if (info.kind === "kf") {
    state.keyframes.splice(info.index, 1);
    selectedKeyframe = null;
    const first = state.keyframes[0];
    if (first && !Number.isFinite(Number(first.hold))) first.hold = 0;
  } else if (info.kind === "overlay") {
    const el = overlayEls.get(info.item.id);
    if (el) {
      el.remove();
      overlayEls.delete(info.item.id);
    }
    state.overlays = state.overlays.filter((o) => o.id !== info.item.id);
    if (selectedOverlay === info.item.id) selectedOverlay = null;
    syncOverlaysDOM(TL.time, false);
  } else if (info.kind === "route") {
    state.routes = state.routes.filter((r) => r.id !== info.item.id);
    if (selectedRouteId === info.item.id) selectedRouteId = null;
  } else if (info.kind === "sfx") {
    state.audio.events = state.audio.events.filter((e) => e.id !== info.item.id);
  } else if (info.kind === "conflict") {
    state.conflicts = state.conflicts.filter((c) => c.id !== info.item.id);
    if (selectedConflictId === info.item.id) selectedConflictId = null;
    renderConflictList();
    fillConflictEditor();
  }

  TL.sel = null;
  afterTimelineEdit();
  toast("Bloco apagado.");
}

function duplicateSelectedClip() {
  const info = clipInfo();
  if (!info) {
    toast("Toque num bloco da linha do tempo primeiro.");
    return;
  }

  if (info.kind === "kf") {
    const copy = {
      ...info.item,
      id: newClipId("kf"),
      camera: { ...info.item.camera },
      duration: Math.max(0.5, Number(info.item.duration) || 1),
      hold: undefined,
      narration: null,
      label: `${info.name} (cópia)`,
    };
    state.keyframes.splice(info.index + 1, 0, copy);
    TL.sel = { kind: "kf", id: copy.id };
    selectedKeyframe = info.index + 1;
  } else if (info.kind === "overlay") {
    const len = Math.max(0.4, info.end - info.start);
    const span = tlSpan();
    const start = +Math.min(info.end, Math.max(0, span - len)).toFixed(2);
    const copy = {
      ...info.item,
      id: newClipId("ov"),
      start,
      end: +(start + len).toFixed(2),
    };
    const index = state.overlays.indexOf(info.item);
    state.overlays.splice(index + 1, 0, copy);
    selectedOverlay = copy.id;
    TL.sel = { kind: "overlay", id: copy.id };
    prepareOverlayMedia().then(() => syncOverlaysDOM(TL.time, false));
  } else if (info.kind === "route") {
    const len = Math.max(0.4, info.end - info.start);
    const span = tlSpan();
    const start = +Math.min(info.end, Math.max(0, span - len)).toFixed(2);
    const copy = {
      ...info.item,
      id: newClipId("rt"),
      autoCamera: false,
      start,
      end: +(start + len).toFixed(2),
    };
    const index = state.routes.indexOf(info.item);
    state.routes.splice(index + 1, 0, copy);
    selectedRouteId = copy.id;
    TL.sel = { kind: "route", id: copy.id };
  } else if (info.kind === "sfx") {
    const copy = {
      ...info.item,
      id: newClipId("sfx"),
      time: +(info.item.time + 0.4).toFixed(2),
    };
    state.audio.events.push(copy);
    TL.sel = { kind: "sfx", id: copy.id };
  } else if (info.kind === "conflict") {
    const len = Math.max(0.8, info.end - info.start);
    const copy = {
      ...info.item,
      id: newClipId("cf"),
      start: +info.end.toFixed(2),
      duration: +len.toFixed(2),
    };
    const index = state.conflicts.indexOf(info.item);
    state.conflicts.splice(index + 1, 0, copy);
    selectedConflictId = copy.id;
    TL.sel = { kind: "conflict", id: copy.id };
    renderConflictList();
    fillConflictEditor();
  }

  afterTimelineEdit();
  toast("Bloco duplicado.");
}

/**
 * Traz o bloco selecionado para a posição do cursor (playhead).
 * A câmara mantém a duração: o bloco anterior é que estica/encolhe.
 */
function snapSelectedToPlayhead() {
  const info = clipInfo();
  if (!info) {
    toast("Selecione um bloco da linha do tempo primeiro.");
    return;
  }
  let t = +Number(TL.time || 0).toFixed(2);
  const total = Math.max(0, totalDuration(state.keyframes));

  if (info.kind === "kf") {
    const i = info.index;
    if (i === 0) {
      toast("A primeira cena fica no início do vídeo.");
      return;
    }
    const times = keyframeTimes(state.keyframes);
    const prevStart = times[i - 1];
    const prevEnd = times[i];
    if (t <= prevStart + 0.3 || t >= prevEnd - 0.3) {
      toast("Ponha o cursor entre o começo e o fim deste bloco.");
      return;
    }
    const dur = +(info.end - info.start).toFixed(2);
    if (i - 1 === 0) state.keyframes[0].hold = t;
    else state.keyframes[i - 1].duration = +(t - prevStart).toFixed(2);
    state.keyframes[i].duration = dur;
  } else if (info.kind === "overlay" || info.kind === "route" || info.kind === "conflict") {
    const len = +(info.end - info.start).toFixed(2);
    // o bloco inteiro precisa caber no vídeo
    t = +Math.max(0, Math.min(t, Math.max(0, total - len))).toFixed(2);
    if (info.kind === "route") info.item.autoCamera = false;
    info.item.start = t;
    if (info.kind === "conflict") info.item.duration = len;
    else info.item.end = +(t + len).toFixed(2);
  } else if (info.kind === "sfx") {
    info.item.time = Math.min(t, total);
  }

  afterTimelineEdit();
  hidePinHint();
  toast(`Bloco movido para ${formatTime(t)}.`);
}

function renderCameraLane() {
  const lane = $("#tl-lane-camera");
  if (!lane) return;
  lane.innerHTML = "";
  const times = keyframeTimes(state.keyframes);

  state.keyframes.forEach((kf, i) => {
    const start = i === 0 ? 0 : times[i - 1];
    const length = i === 0 ? Number(kf.hold) || 0 : Number(kf.duration) || 0.5;

    if (i === 0 && length < 0.05) {
      const mark = document.createElement("div");
      mark.className = "tl-mark";
      mark.style.left = "0px";
      mark.title = "Início da animação";
      lane.appendChild(mark);
      return;
    }

    const name = kf.label || `Cena ${i + 1}`;
    const el = tlClip({
      start,
      length,
      className: "tl-kf",
      label: name,
      title: `${name} · ${formatTime(length)}`,
      handle: true,
    });
    if ((TL.sel && TL.sel.kind === "kf" && TL.sel.id === kf.id) || i === selectedKeyframe) {
      el.classList.add("current");
    }

    bindTimelineClip(
      el,
      (delta, resize) => {
        if (!resize) return;
        const value = Math.max(i === 0 ? 0.3 : 0.5, length + delta);
        if (i === 0) kf.hold = +value.toFixed(2);
        else kf.duration = +value.toFixed(2);
        el.style.width = `${Math.max(6, value * TL.pps)}px`;
      },
      () => {
        selectClip("kf", kf.id);
        applyKeyframeCamera(kf.camera);
        seekTimeline(i === 0 ? 0 : times[i]);
      },
    );

    lane.appendChild(el);
  });
}

function renderNarrationLane() {
  const lane = $("#tl-lane-narration");
  if (!lane) return;
  lane.innerHTML = "";

  state.keyframes.forEach((kf, i) => {
    if (!kf.narration) return;
    const base = segmentStart(state.keyframes, i);
    const start = Math.max(0, base + (Number(kf.narration.offset) || 0));
    const length = Math.max(0.2, Number(kf.narration.duration) || 0.2);

    const el = tlClip({
      start,
      length,
      className: "tl-nar",
      label: kf.narration.name,
      title: `${kf.narration.name} · ${formatTime(start)} → ${formatTime(start + length)}`,
    });

    bindTimelineClip(
      el,
      (delta) => {
        const offset = (Number(kf.narration.offset) || 0) + delta;
        kf.narration.offset = +offset.toFixed(2);
        const left = Math.max(0, base + offset);
        el.style.left = `${left * TL.pps}px`;
      },
      () => {
        selectedKeyframe = i;
        seekTimeline(start);
      },
    );

    lane.appendChild(el);
  });
}

function renderOverlayLane() {
  const lane = $("#tl-lane-overlay");
  if (!lane) return;
  lane.innerHTML = "";

  for (const ov of state.overlays) {
    const origStart = Math.max(0, Number(ov.start) || 0);
    const origEnd = Math.max(origStart + 0.2, Number(ov.end) || 0);
    const length = origEnd - origStart;

    const el = tlClip({
      start: origStart,
      length,
      className: `tl-ov tl-ov-${ov.kind}`,
      label: ov.name,
      title: `${ov.name} · ${formatTime(origStart)} → ${formatTime(origEnd)}`,
      handle: true,
    });
    if (ov.id === selectedOverlay) el.classList.add("current");

    bindTimelineClip(
      el,
      (delta, resize) => {
        if (resize) {
          ov.end = Math.max(origStart + 0.2, origEnd + delta);
          el.style.width = `${Math.max(6, (ov.end - origStart) * TL.pps)}px`;
        } else {
          const next = Math.max(0, origStart + delta);
          ov.start = +next.toFixed(2);
          ov.end = +(next + length).toFixed(2);
          el.style.left = `${ov.start * TL.pps}px`;
        }
      },
      () => {
        selectClip("overlay", ov.id);
        renderOverlayList();
        seekTimeline(origStart);
      },
    );

    lane.appendChild(el);
  }
}

function renderRouteLane() {
  const lane = $("#tl-lane-routes");
  if (!lane) return;
  lane.innerHTML = "";

  for (const rt of state.routes) {
    const origStart = routeStartTime(rt);
    const origEnd = routeEndTime(rt, origStart);
    const length = Math.max(0.3, origEnd - origStart);

    const el = tlClip({
      start: origStart,
      length,
      className: "tl-route",
      label: `${rt.fromName} → ${rt.toName}`,
      title: `${rt.fromName} → ${rt.toName} · ${formatTime(origStart)} → ${formatTime(origEnd)}${
        rt.autoCamera === false ? "" : " · espera a câmera"
      }`,
      handle: true,
    });
    if (rt.id === selectedRouteId) el.classList.add("current");

    bindTimelineClip(
      el,
      (delta, resize) => {
        if (resize) {
          rt.end = Math.max(origStart + 0.2, origEnd + delta);
          el.style.width = `${Math.max(6, (rt.end - origStart) * TL.pps)}px`;
        } else {
          // arrastar é uma escolha manual: deixa de seguir a câmera
          const next = Math.max(0, origStart + delta);
          rt.autoCamera = false;
          rt.start = +next.toFixed(2);
          rt.end = +(next + length).toFixed(2);
          el.style.left = `${rt.start * TL.pps}px`;
        }
      },
      () => {
        selectClip("route", rt.id);
        renderRouteList();
        fillRouteEditor();
        seekTimeline(origStart);
      },
    );

    lane.appendChild(el);
  }
}

function renderConflictLane() {
  const lane = $("#tl-lane-conflicts");
  if (!lane) return;
  lane.innerHTML = "";

  for (const c of state.conflicts) {
    const origStart = Math.max(0, Number(c.start) || 0);
    const length = Math.max(0.8, Number(c.duration) || 3);
    const label = conflictLabel(c);

    const el = tlClip({
      start: origStart,
      length,
      className: `tl-conflict ${c.result || "win"}`,
      label: `⚔ ${label}`,
      title: `${label} · ${formatTime(origStart)} · ${(length).toFixed(1).replace(".", ",")} s`,
      handle: true,
    });
    if (c.id === selectedConflictId) el.classList.add("current");

    bindTimelineClip(
      el,
      (delta, resize) => {
        if (resize) {
          c.duration = Math.max(0.8, length + delta);
          el.style.width = `${Math.max(6, c.duration * TL.pps)}px`;
        } else {
          c.start = Math.max(0, origStart + delta);
          el.style.left = `${c.start * TL.pps}px`;
        }
      },
      () => {
        selectClip("conflict", c.id);
        renderConflictList();
        fillConflictEditor();
        seekTimeline(origStart);
      },
    );

    lane.appendChild(el);
  }
}

function renderSfxLane() {
  const lane = $("#tl-lane-sfx");
  if (!lane) return;
  lane.innerHTML = "";

  for (const ev of state.audio.events) {
    const orig = Math.max(0, Number(ev.time) || 0);
    const el = document.createElement("div");
    el.className = "tl-sfx";
    if (TL.sel && TL.sel.kind === "sfx" && TL.sel.id === ev.id) el.classList.add("current");
    el.style.left = `${orig * TL.pps}px`;
    el.title = `${sfxName(ev.type)} · ${formatTime(orig)}`;

    const dot = document.createElement("span");
    dot.className = "tl-sfx-dot";
    const label = document.createElement("span");
    label.className = "tl-sfx-label";
    label.textContent = sfxName(ev.type);
    el.append(dot, label);

    bindTimelineClip(
      el,
      (delta) => {
        ev.time = Math.max(0, orig + delta);
        el.style.left = `${ev.time * TL.pps}px`;
      },
      () => {
        selectClip("sfx", ev.id);
        seekTimeline(orig);
      },
    );

    lane.appendChild(el);
  }
}

function updatePlayhead() {
  const head = $("#tl-playhead");
  if (head) head.style.left = `${TL_LANE_LEFT + Math.max(0, TL.time) * TL.pps}px`;
  const label = $("#tl-time");
  if (label) label.textContent = formatTime(TL.time);
  const grip = $("#tl-playhead-grip");
  if (grip) grip.textContent = formatTime(TL.time);
  updatePinHint();
}

let pinHintOn = false;

/**
 * Mostra, logo abaixo do cursor, a oferta de trazer o bloco selecionado para
 * ali. Aparece quando o utilizador para o cursor, não durante a reprodução.
 */
function updatePinHint() {
  const el = $("#tl-pin-hint");
  if (!el) return;
  const info = pinHintOn && !playing ? clipInfo() : null;
  if (!info) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = `📌 Trazer ${info.name}`;
  el.title = `Mover "${info.name}" para ${formatTime(TL.time)}`;

  const scroll = $("#tl-scroll");
  const left = TL_LANE_LEFT + Math.max(0, TL.time) * TL.pps + 12;
  const max = scroll
    ? scroll.scrollLeft + scroll.clientWidth - el.offsetWidth - 6
    : left;
  el.style.left = `${Math.max(TL_LANE_LEFT, Math.min(left, max))}px`;
}

function showPinHint() {
  pinHintOn = true;
  updatePinHint();
}

function hidePinHint() {
  pinHintOn = false;
  const el = $("#tl-pin-hint");
  if (el) el.hidden = true;
}

/**
 * Pega do cursor: pode arrastar pela régua de tempo, pela linha vermelha ou
 * pelo botão que fica no topo dela — bem maior para o dedo.
 */
function bindPlayheadDrag() {
  const head = $("#tl-playhead");
  if (!head) return;

  const start = (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    hidePinHint();
    try { head.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    const move = (ev) => {
      seekTimeline(timeFromEvent(ev));
    };
    const finish = (ev) => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", finish);
      head.removeEventListener("pointercancel", finish);
      try { head.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      showPinHint();
    };

    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", finish);
    head.addEventListener("pointercancel", finish);
    seekTimeline(timeFromEvent(e));
  };

  head.addEventListener("pointerdown", start);
}

function timeFromEvent(e) {
  const content = $("#tl-content");
  if (!content) return 0;
  const rect = content.getBoundingClientRect();
  return Math.max(0, (e.clientX - rect.left - TL_LANE_LEFT) / TL.pps);
}

function seekTimeline(t) {
  const total = totalDuration(state.keyframes);
  TL.time = Math.max(0, Math.min(t, Math.max(0, total)));
  updatePlayhead();
  syncTimelineTools();
  syncBattleLayers(TL.time);
  if (playing) return;
  applyCameraAt(TL.time);
  applyTheme(themeNow(TL.time));
  drawTransitionInDOM(TL.time);
  syncOverlaysDOM(TL.time, false);
  scheduleGfx();
}

function initTimeline() {
  const content = $("#tl-content");
  if (!content) return;

  let scrubbing = false;

  content.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".tl-clip")) return;
    if (e.target.closest("#tl-playhead")) return; // a pega do cursor cuida disso
    if (e.target.closest("#tl-pin-hint")) return; // o botão trata do clique
    scrubbing = true;
    hidePinHint();
    try { content.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    seekTimeline(timeFromEvent(e));
  });

  content.addEventListener("pointermove", (e) => {
    if (!scrubbing) return;
    seekTimeline(timeFromEvent(e));
  });

  const stop = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    try { content.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    showPinHint();
  };
  content.addEventListener("pointerup", stop);
  content.addEventListener("pointercancel", stop);

  // a linha vermelha também é uma pega (com a "-" do cursor no topo)
  bindPlayheadDrag();
  $("#tl-pin-hint")?.addEventListener("click", (e) => {
    e.stopPropagation();
    hidePinHint();
    snapSelectedToPlayhead();
  });
}

function setTimelineZoom(delta) {
  const next = Math.max(14, Math.min(140, TL.pps + delta));
  if (next === TL.pps) return;
  TL.pps = next;
  renderTimeline();
}

/* ------------------------------------------------------------------ *
 * Reprodução
 * ------------------------------------------------------------------ */
function applyCameraAt(t) {
  const cam = sampleAt(state.keyframes, t);
  if (!cam) return;
  // a cor do território conquistado depende do instante
  syncBattleLayers(t);
  map.jumpTo({
    center: cam.center,
    zoom: cam.zoom,
    pitch: cam.pitch || 0,
    bearing: cam.bearing || 0,
  });
}

function setProgress(p) {
  $("#progress-bar").style.width = `${Math.min(100, Math.max(0, p * 100))}%`;
}

function drawTransitionInDOM(t) {
  const el = $("#transition");
  if (!el) return;
  const tr = transitionAt(state.keyframes, t);
  if (!tr) {
    el.style.opacity = "0";
    el.style.clipPath = "";
    return;
  }
  el.style.background = tr.color;

  if (tr.kind === "wipe") {
    const w = $("#stage").clientWidth || 320;
    const edge = -0.25 * w + tr.alpha * 1.5 * w;
    const slant = w * 0.28;
    el.style.opacity = "1";
    el.style.clipPath = `polygon(0 0, ${edge + slant}px 0, ${edge}px 100%, 0 100%)`;
  } else {
    el.style.clipPath = "";
    el.style.opacity = String(tr.alpha);
  }
}

function audioPayload() {
  const total = totalDuration(state.keyframes);
  const events = state.audio.events
    .filter((ev) => Number(ev.time) < total + 0.05)
    .map((ev) => ({ type: ev.type, time: Number(ev.time) || 0, volume: 1 }));

  // cada rota tem o seu "percurso": o efeito começa com o traço e é esticado
  // (playbackRate) para durar exatamente o tempo do desenho; o início segue a
  // câmera, para o som entrar junto com a rota na tela
  for (const rt of state.routes) {
    if (rt.sound === false || !Array.isArray(rt.from)) continue;
    const start = routeStartTime(rt);
    if (start > total) continue;
    const draw = Math.min(3, Math.max(0.5, Number(rt.drawTime) || 1.4));
    events.push({
      type: "route",
      time: start,
      volume: 0.8,
      rate: +(1.8 / draw).toFixed(3),
    });
  }
  events.sort((a, b) => a.time - b.time);

  // conflitos: associate da bomba, explosão no impacto e o som do resultado
  for (const c of state.conflicts) {
    if (c.sound === false) continue;
    const dur = Math.max(0.8, Number(c.duration) || 3);
    const impact = c.start + dur * 0.55;
    if (c.bomb !== false) {
      events.push({ type: "riser", time: c.start, volume: 0.35, rate: +(1.6 / (dur * 0.55)).toFixed(3) });
      events.push({ type: "bomb", time: impact, volume: 0.95 });
    }
    const outcome = c.result === "win" ? "victory" : c.result === "hold" ? "defend" : "chime";
    events.push({ type: outcome, time: c.start + dur * 0.72, volume: 0.7 });
  }
  events.sort((a, b) => a.time - b.time);

  return {
    events,
    source: state.audio.source,
    musicVolume: state.audio.musicVolume,
    narrationVolume: state.audio.narrationVolume ?? 1,
    sfxVolume: state.audio.sfxVolume,
    duck: state.audio.duck !== false,
    offset: (Number(state.audio.offset) || 0) / 1000,
  };
}

/** Prepara os buffers de tudo que toca no projeto. */
async function prepareAudio() {
  await audio.load();
  if (state.audio.imports.length) await audio.loadCustomSfx(state.audio.imports);
  const ids = state.keyframes.map((kf) => kf.narration?.mediaId).filter(Boolean);
  if (ids.length) await audio.loadNarration(ids);
}

/** Narração posicionada no tempo absoluto de cada cena. */
function narrationClips() {
  const clips = [];
  state.keyframes.forEach((kf, i) => {
    const mediaId = kf.narration?.mediaId;
    if (!mediaId) return;
    const buffer = audio.narration.get(mediaId);
    if (!buffer) return;
    const start = segmentStart(state.keyframes, i) + (Number(kf.narration.offset) || 0);
    clips.push({ buffer, time: Math.max(0, start), volume: 1 });
  });
  return clips;
}

function hasNarration() {
  return state.keyframes.some((kf) => kf.narration?.mediaId);
}

async function play() {
  return startPlayback(0);
}

/** Reproduz a partir do cursor da linha do tempo. */
async function playFromTimeline() {
  if (playing) {
    stopPlayback();
    return;
  }
  const total = totalDuration(state.keyframes);
  const from = TL.time > 0.15 && TL.time < total ? TL.time : 0;
  return startPlayback(from);
}

/**
 * Reprodução real (e ponto de partida da exportação).
 * @param {number} from segundo inicial
 */
async function startPlayback(from = 0) {
  if (playing) return;
  const total = totalDuration(state.keyframes);
  if (total <= 0) {
    toast("Adicione 2 keyframes com duração para reproduzir.");
    return;
  }

  playing = true;
  hidePinHint();
  $("#btn-play").textContent = "■ Parar";
  const tlPlay = $("#tl-play");
  if (tlPlay) tlPlay.textContent = "■";
  $("#overlay-text").classList.add("visible");

  await prepareOverlayMedia();

  // áudio: prepara buffers e agenda junto com o início visual
  let audioHandle = null;
  let startAt = performance.now();
  if (state.audio.enabled) {
    try {
      await prepareAudio();
      const payload = audioPayload();
      const t0 = audio.ctx.currentTime + 0.12;
      audioHandle = audio.schedule({
        ...payload,
        events: payload.events
          .filter((ev) => ev.time >= from - 0.02)
          .map((ev) => ({ ...ev, time: Math.max(0, ev.time - from) })),
        narration: narrationClips()
          .filter((c) => c.time + c.buffer.duration > from)
          .map((c) => ({ ...c, time: Math.max(0, c.time - from) })),
        destinations: [audio.ctx.destination],
        startAt: t0,
      });
      startAt = performance.now() + 120;
    } catch (err) {
      console.warn("Áudio indisponível:", err);
    }
  }

  await new Promise((resolve) => {
    function frame(now) {
      if (!playing) return resolve();
      const t = Math.min(Math.max(from + (now - startAt) / 1000, from), total);
      applyCameraAt(t);
      applyTheme(themeNow(t));
      drawGfxPreview(t);
      $("#overlay-text").style.opacity = String(textOpacityAt(t, total));
      drawTransitionInDOM(t);
      syncOverlaysDOM(t, true);
      setProgress(t / total);
      TL.time = t;
      updatePlayhead();
      if (t >= total) return resolve();
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });

  playing = false;
  if (audioHandle) audioHandle.stop();
  audio.stopAll();
  $("#btn-play").textContent = "▶ Reproduzir";
  const tlBtn = $("#tl-play");
  if (tlBtn) tlBtn.textContent = "▶";
  $("#overlay-text").style.opacity = "";
  drawTransitionInDOM(-1);
  syncOverlayVideos(0, false);
  setProgress(0);
  applyTextToDOM();
  applyTheme(themeNow(TL.time));
  scheduleGfx();
}

function stopPlayback() {
  playing = false;
  audio.stopAll();
  $("#btn-play").textContent = "▶ Reproduzir";
  const tlBtn = $("#tl-play");
  if (tlBtn) tlBtn.textContent = "▶";
  drawTransitionInDOM(-1);
  syncOverlayVideos(0, false);
  setProgress(0);
  applyTheme(themeNow(TL.time));
  scheduleGfx();
}

/* ------------------------------------------------------------------ *
 * Exportação
 * ------------------------------------------------------------------ */
function parseRes() {
  const [w, h] = state.export.res.split("x").map(Number);
  return { width: w, height: h };
}

function drawText(ctx, t) {
  const { width, height } = ctx.canvas;
  const total = totalDuration(state.keyframes);
  const alpha = textOpacityAt(t, total);
  // escala pelo menor lado: vale para paisagem, retrato e quadrado
  const scale = Math.min(width, height) / 1080;

  const heading = state.text.heading.trim();
  const sub = state.text.sub.trim();
  if (!heading && !sub) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = "center";
  ctx.fillStyle = state.text.color;

  const headingSize = state.text.size * scale;
  const subSize = headingSize * 0.43;

  let anchorY;
  if (state.text.position === "pos-top") anchorY = height * 0.09;
  else if (state.text.position === "pos-center") anchorY = height * 0.5;
  else anchorY = height * 0.9;

  if (state.text.shadow) {
    ctx.shadowColor = "rgba(0,0,0,.85)";
    ctx.shadowBlur = 18 * scale;
    ctx.shadowOffsetY = 2 * scale;
  }

  if (heading) {
    ctx.font = `800 ${headingSize}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textBaseline = "alphabetic";
    const y = sub ? anchorY - subSize * 0.9 : anchorY;
    ctx.fillText(heading, width / 2, y, width * 0.9);
  }
  if (sub) {
    ctx.font = `500 ${subSize}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(sub, width / 2, anchorY, width * 0.9);
  }
  ctx.restore();
}

function drawTransition(ctx, t) {
  const tr = transitionAt(state.keyframes, t);
  if (!tr) return;
  const { width, height } = ctx.canvas;
  ctx.save();
  ctx.fillStyle = tr.color;
  if (tr.kind === "wipe") {
    // mesma cortina diagonal da prévia
    const edge = -0.25 * width + tr.alpha * 1.5 * width;
    const slant = width * 0.28;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(edge + slant, 0);
    ctx.lineTo(edge, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.globalAlpha = tr.alpha;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();
}

/** Projeção para o canvas de exportação (o mapa já está no tamanho final). */
function exportGfxView(ctx) {
  return {
    width: ctx.canvas.width,
    height: ctx.canvas.height,
    scale: ctx.canvas.width / 1080,
    centerLng: map.getCenter().lng,
    project: ([lng, lat]) => {
      const p = map.project([lng, lat]);
      return [p.x, p.y];
    },
  };
}

function drawOverlay(ctx, t) {
  drawGraphics(ctx, exportGfxView(ctx), buildGfxModel(t), t);
  drawMediaOverlays(ctx, t);
  drawText(ctx, t);
  drawTransition(ctx, t);
}

async function exportVideo() {
  if (playing) return;
  const total = totalDuration(state.keyframes);
  if (state.keyframes.length < 2 || total <= 0) {
    toast("Precisa de pelo menos 2 keyframes com duração.");
    return;
  }

  const { width, height } = parseRes();
  const fps = Number(state.export.fps);
  const mapEl = $("#map");
  const btn = $("#btn-render");

  btn.disabled = true;
  $("#render-status").textContent = "Preparando…";
  document.body.classList.add("exporting");
  $("#btn-play").disabled = true;
  $("#overlay-text").classList.remove("visible");
  $("#transition").style.opacity = "0";

  let audioDest = null;
  let audioHandle = null;
  let audioTrack = null;

  try {
    // áudio: só entra na faixa quando há trilha, efeitos ou narração
    const wantsAudio =
      state.audio.enabled &&
      (state.audio.source !== "none" ||
        state.audio.events.length > 0 ||
        state.routes.some((rt) => rt.sound !== false) ||
        state.conflicts.some((c) => c.sound !== false) ||
        hasNarration());

    $("#render-status").textContent = "Preparando mídia…";
    await prepareOverlayMedia();
    const flagIsos = Object.entries(state.countries)
      .filter(([, sel]) => sel.fill === "flag")
      .map(([id]) => isoForCountry(countriesById.get(id)))
      .filter(Boolean);
    if (flagIsos.length) await preloadFlags(flagIsos);
    for (const ov of state.overlays) {
      const el = overlayEls.get(ov.id);
      if (el && el.tagName === "VIDEO") {
        el.pause();
        el.currentTime = 0;
      }
    }

    if (wantsAudio) {
      try {
        $("#render-status").textContent = "Preparando áudio…";
        await prepareAudio();
        if (state.audio.source === "file" && !audio.fileMusic) {
          toast("Escolha um arquivo de áudio ou use a trilha ambiente.");
        }
        audioDest = audio.createRecordingDest();
        audioTrack = audioDest?.stream.getAudioTracks()[0] || null;
      } catch (err) {
        console.warn("Áudio indisponível na exportação:", err);
        toast("Vídeo será exportado sem áudio.");
        audioDest = null;
        audioTrack = null;
      }
    }

    exporting = true;
    const result = await renderVideo({
      map,
      mapEl,
      width,
      height,
      fps,
      total,
      audioTrack,
      onStart: () => {
        if (!audioDest) return;
        audioHandle = audio.schedule({
          ...audioPayload(),
          narration: narrationClips(),
          destinations: [audioDest],
          startAt: audio.ctx.currentTime + 0.02,
        });
      },
      applyCamera: applyCameraAt,
      drawOverlay,
      mapFilter: (t) => mapFilterNow(t),
      mapTint: (t) => mapTintNow(t),
      onProgress: (p) => {
        setProgress(p);
        $("#render-status").textContent = `Gravando… ${Math.round(p * 100)}%`;
      },
    });

    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const ext = result.mimeType.includes("mp4") ? "mp4" : "webm";
    const filename = `mapcine-${stamp}.${ext}`;

    $("#render-status").textContent = "Salvando o vídeo…";
    const saved = await saveVideoFile(result.blob, filename, {
      onProgress: (p) => {
        $("#render-status").textContent = `Salvando o vídeo… ${Math.round(p * 100)}%`;
      },
    });

    const summary =
      `${result.width}×${result.height} · ${formatSeconds(result.duration)} · ${(result.blob.size / 1048576).toFixed(1)} MB` +
      (audioTrack ? " · com áudio" : "");
    $("#render-status").textContent = saved.saved ? `Salvo em ${saved.path} · ${summary}` : `Pronto: ${summary}`;
    toast(saved.saved ? `Vídeo salvo em ${saved.path}` : "Vídeo gerado — confira os downloads.", 5000);
  } catch (err) {
    console.error(err);
    $("#render-status").textContent = `Erro: ${err.message}`;
  } finally {
    if (audioHandle) audioHandle.stop();
    audio.stopAll();
    syncOverlayVideos(0, false);
    exporting = false;
    btn.disabled = false;
    document.body.classList.remove("exporting");
    $("#btn-play").disabled = false;
    setProgress(0);
    applyTextToDOM();
    applyTheme(themeNow(TL.time));
    scheduleGfx();
  }
}

function updateExportSummary() {
  const total = totalDuration(state.keyframes);
  $("#ex-duration").textContent = formatSeconds(total);
  $("#ex-kf").textContent = String(state.keyframes.length);

  const narr = $("#ex-narr");
  if (narr) {
    const count = state.keyframes.filter((kf) => kf.narration).length;
    narr.textContent = count ? `${count} cena(s)` : "—";
  }

  const ovs = $("#ex-overlays");
  if (ovs) ovs.textContent = String(state.overlays.length);

  const exAudio = $("#ex-audio");
  if (exAudio) {
    if (!state.audio.enabled) exAudio.textContent = "Desligado";
    else if (
      state.audio.events.length ||
      state.audio.source !== "none" ||
      state.routes.some((rt) => rt.sound !== false) ||
      state.conflicts.some((c) => c.sound !== false) ||
      hasNarration()
    )
      exAudio.textContent = "Ligado";
    else exAudio.textContent = "Sem trilha";
  }

  const time = $("#au-time");
  if (time) {
    const max = Math.max(1, total);
    time.max = String(max);
    if (Number(time.value) > max) time.value = String(max);
    const label = $("#au-time-label");
    if (label) label.textContent = formatTime(Number(time.value) || 0);
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
/** Mantém a aba escolhida visível na tira de abas (que rola no celular). */
function centerTab(tab) {
  const nav = tab.closest(".tabs");
  if (!nav) return;
  const left = tab.offsetLeft - (nav.clientWidth - tab.offsetWidth) / 2;
  nav.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  nav.classList.toggle("has-prev", nav.scrollLeft > 4);
}

function initTabs() {
  const nav = $(".tabs");
  const updateFades = () => {
    if (!nav) return;
    nav.classList.toggle("has-prev", nav.scrollLeft > 4);
    nav.classList.toggle("has-more", nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 4);
  };
  if (nav) {
    nav.addEventListener("scroll", updateFades, { passive: true });
    requestAnimationFrame(updateFades);
  }

  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((t) => t.classList.remove("active"));
      $$(".pane").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $(`#pane-${tab.dataset.tab}`).classList.add("active");
      centerTab(tab);
      requestAnimationFrame(updateFades);
    });
  });
}

function initUI() {
  initTabs();

  $("#btn-play").addEventListener("click", () => (playing ? stopPlayback() : play()));
  $("#btn-undo").addEventListener("click", undo);
  $("#btn-redo").addEventListener("click", redo);
  $("#jump-prev").addEventListener("click", () => cycleJump(-1));
  $("#jump-next").addEventListener("click", () => cycleJump(1));
  renderQuickJump();
  $("#btn-export").addEventListener("click", () => {
    const tab = $$(".tab").find((t) => t.dataset.tab === "exportar");
    tab.click();
    $("#pane-exportar").scrollTop = 0;
  });
  $("#btn-render").addEventListener("click", exportVideo);

  $("#btn-add-kf").addEventListener("click", addKeyframe);
  $("#btn-update-kf").addEventListener("click", updateCurrentKeyframe);

  $("#place-search").addEventListener("input", (e) => {
    const q = e.target.value;
    renderSearch(q);
    $("#pane-paises").scrollTop = 0;
    if (normalize(q).length >= 2) setSearchStatus("");
    else updateSearchStatusIdle();
  });

  $("#btn-clear-countries").addEventListener("click", () => {
    for (const id of Object.keys(state.countries)) delete state.countries[id];
    for (const id of Object.keys(state.states)) delete state.states[id];
    for (const id of Object.keys(state.cities)) delete state.cities[id];
    applyAllCountries();
    applyAllStates();
    renderSelectedCities();
    renderSelection();
    save();
    renderSearch($("#place-search").value);
  });

  $("#global-opacity").addEventListener("input", (e) => {
    $("#opacity-label").textContent = `${e.target.value}%`;
  });

  // ---- estilo por lugar (bandeira, contorno, alfinete) ----
  $("#ps-fill").addEventListener("change", (e) => {
    setPlaceStyle({ fill: e.target.value, styled: e.target.value !== "color" });
  });
  $("#ps-border").addEventListener("input", (e) => {
    setPlaceStyle({ borderColor: e.target.value, styled: true });
  });
  $("#ps-width").addEventListener("input", (e) => {
    $("#ps-width-label").textContent = String(e.target.value).replace(".", ",");
    setPlaceStyle({ borderWidth: Number(e.target.value), styled: true });
  });
  $("#ps-glow").addEventListener("input", (e) => {
    $("#ps-glow-label").textContent = `${e.target.value}%`;
    setPlaceStyle({ glow: Number(e.target.value), styled: true });
  });
  $("#ps-pulse").addEventListener("change", (e) => {
    setPlaceStyle({ pulse: e.target.checked, ...(e.target.checked ? { styled: true } : {}) });
  });
  $("#ps-label").addEventListener("change", (e) => {
    setPlaceStyle({ label: e.target.checked });
  });
  $("#ps-mode").addEventListener("change", (e) => {
    setPlaceStyle({ mode: e.target.value });
  });

  // ---- temas ----
  initThemeUI();

  // ---- rotas ----
  $("#btn-add-route").addEventListener("click", addRoute);
  $("#rt-color").addEventListener("input", (e) => {
    const rt = currentRoute();
    if (!rt) return;
    rt.color = e.target.value;
    renderRouteList();
    save();
  });
  $("#rt-width").addEventListener("input", (e) => {
    const rt = currentRoute();
    if (!rt) return;
    rt.width = Number(e.target.value);
    $("#rt-width-label").textContent = String(e.target.value).replace(".", ",");
    save();
  });
  $("#rt-curve").addEventListener("input", (e) => {
    const rt = currentRoute();
    if (!rt) return;
    rt.curve = Number(e.target.value) / 100;
    $("#rt-curve-label").textContent = `${e.target.value}%`;
    save();
  });
  $("#rt-label-text").addEventListener("input", (e) => {
    const rt = currentRoute();
    if (!rt) return;
    rt.labelText = e.target.value;
    save();
  });
  $("#rt-start").addEventListener("input", (e) => {
    const rt = currentRoute();
    if (!rt) return;
    const value = Number(e.target.value);
    rt.start = value;
    if (rt.end <= value + 0.2) rt.end = value + 0.5;
    $("#rt-start-label").textContent = formatTime(value);
    $("#rt-end").value = String(rt.end);
    $("#rt-end-label").textContent = formatTime(rt.end);
    save();
  });
  $("#rt-start").addEventListener("change", renderTimeline);
  $("#rt-end").addEventListener("input", (e) => {
    const rt = currentRoute();
    if (!rt) return;
    rt.end = Math.max(rt.start + 0.2, Number(e.target.value));
    $("#rt-end-label").textContent = formatTime(rt.end);
    save();
  });
  $("#rt-end").addEventListener("change", renderTimeline);
  $("#rt-arrow").addEventListener("change", (e) => {
    const rt = currentRoute();
    if (!rt) return;
    rt.arrow = e.target.checked;
    save();
  });
  $("#rt-show-label").addEventListener("change", (e) => {
    const rt = currentRoute();
    if (!rt) return;
    rt.showLabel = e.target.checked;
    save();
  });
  $("#rt-sound").addEventListener("change", (e) => {
    const rt = currentRoute();
    if (!rt) return;
    rt.sound = e.target.checked;
    save();
    updateExportSummary();
    if (e.target.checked) previewSfx("route");
  });
  $("#rt-auto").addEventListener("change", (e) => {
    const rt = currentRoute();
    if (!rt) return;
    rt.autoCamera = e.target.checked;
    fillRouteEditor();
    renderTimeline();
    updateExportSummary();
    save();
    if (e.target.checked) {
      toast(`A rota começa quando a câmera enquadra (${formatTime(routeStartTime(rt))}).`);
    }
  });
  $("#btn-remove-route").addEventListener("click", () => {
    const rt = currentRoute();
    if (!rt) return;
    state.routes = state.routes.filter((r) => r.id !== rt.id);
    selectedRouteId = null;
    renderRouteList();
    fillRouteEditor();
    renderTimeline();
    save();
  });

  // ---- conflitos ----
  $("#btn-add-conflict").addEventListener("click", addConflict);
  $("#cf-atk").addEventListener("change", () => {
    const c = currentConflict();
    if (!c) return;
    const [kind, id] = $("#cf-atk").value.split(":");
    c.atkKind = kind;
    c.atkId = id;
    renderConflictList();
    fillConflictEditor();
    renderTimeline();
    save();
  });
  $("#cf-def").addEventListener("change", () => {
    const c = currentConflict();
    if (!c) return;
    const [kind, id] = $("#cf-def").value.split(":");
    c.defKind = kind;
    c.defId = id;
    renderConflictList();
    fillConflictEditor();
    renderTimeline();
    save();
  });
  $("#cf-result").addEventListener("change", (e) => {
    const c = currentConflict();
    if (!c) return;
    c.result = e.target.value;
    renderConflictList();
    fillConflictEditor();
    renderTimeline();
    save();
  });
  $("#cf-start").addEventListener("input", (e) => {
    const c = currentConflict();
    if (!c) return;
    c.start = Number(e.target.value);
    $("#cf-start-label").textContent = formatTime(c.start);
    renderTimeline();
    save();
  });
  $("#cf-start").addEventListener("change", () => {
    renderConflictList();
    save();
  });
  $("#cf-dur").addEventListener("input", (e) => {
    const c = currentConflict();
    if (!c) return;
    c.duration = Number(e.target.value);
    $("#cf-dur-label").textContent = `${c.duration.toFixed(1).replace(".", ",")} s`;
    renderTimeline();
    save();
  });
  $("#cf-dur").addEventListener("change", () => {
    renderConflictList();
    save();
  });
  $("#cf-bomb").addEventListener("change", (e) => {
    const c = currentConflict();
    if (!c) return;
    c.bomb = e.target.checked;
    save();
  });
  $("#cf-sound").addEventListener("change", (e) => {
    const c = currentConflict();
    if (!c) return;
    c.sound = e.target.checked;
    updateExportSummary();
    save();
  });
  $("#btn-remove-conflict").addEventListener("click", () => {
    const c = currentConflict();
    if (!c) return;
    state.conflicts = state.conflicts.filter((x) => x.id !== c.id);
    selectedConflictId = null;
    renderConflictList();
    fillConflictEditor();
    renderTimeline();
    save();
  });

  // ---- regiões ----
  $("#btn-region-draw").addEventListener("click", startRegionDraw);
  $("#btn-region-finish").addEventListener("click", finishRegionDraw);
  $("#btn-region-cancel").addEventListener("click", () => {
    cancelRegionDraw();
    fillRegionEditor();
  });

  const bindRegionField = (sel, key, transform) => {
    $(sel).addEventListener("input", (e) => {
      const value = transform ? transform(e.target.value) : e.target.value;
      const rg = currentRegion();
      if (rg) rg[key] = value;
      else regionDraft.defaults[key] = value;
      if (key === "opacity") $("#rg-opacity-label").textContent = `${Math.round(value * 100)}%`;
      renderRegionList();
      save();
    });
  };
  bindRegionField("#rg-color", "color");
  bindRegionField("#rg-border", "borderColor");
  bindRegionField("#rg-opacity", "opacity", (v) => Number(v) / 100);
  bindRegionField("#rg-label", "label");

  $("#txt-heading").addEventListener("input", (e) => {
    state.text.heading = e.target.value;
    applyTextToDOM();
    save();
  });
  $("#txt-sub").addEventListener("input", (e) => {
    state.text.sub = e.target.value;
    applyTextToDOM();
    save();
  });
  $("#txt-color").addEventListener("input", (e) => {
    state.text.color = e.target.value;
    applyTextToDOM();
    save();
  });
  $("#txt-size").addEventListener("input", (e) => {
    state.text.size = Number(e.target.value);
    $("#size-label").textContent = e.target.value;
    applyTextToDOM();
    save();
  });
  $("#txt-pos").addEventListener("change", (e) => {
    state.text.position = e.target.value;
    applyTextToDOM();
    save();
  });
  $("#txt-shadow").addEventListener("change", (e) => {
    state.text.shadow = e.target.checked;
    applyTextToDOM();
    save();
  });

  // áudio
  $("#au-enabled").addEventListener("change", (e) => {
    state.audio.enabled = e.target.checked;
    save();
    updateExportSummary();
  });

  $("#au-source").addEventListener("change", async (e) => {
    state.audio.source = e.target.value;
    $("#au-file-field").hidden = state.audio.source !== "file";
    save();
    updateExportSummary();
    if (state.audio.source !== "none") {
      try {
        await audio.load();
      } catch (err) {
        console.warn("Áudio indisponível:", err);
      }
    }
  });

  $("#au-file").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const name = $("#au-file-name");
    name.textContent = "Carregando…";
    try {
      await audio.load();
      await audio.setMusicFile(file);
      state.audio.source = "file";
      state.audio.enabled = true;
      $("#au-source").value = "file";
      $("#au-enabled").checked = true;
      name.textContent = `${audio.fileName} · ${formatTime(audio.fileMusic.duration)}`;
      save();
      updateExportSummary();
      toast("Trilha carregada.");
    } catch (err) {
      console.warn("Arquivo de áudio inválido:", err);
      name.textContent = "Não foi possível ler este arquivo.";
      toast("Áudio inválido ou formato não suportado.");
    }
  });

  $("#au-music").addEventListener("input", (e) => {
    state.audio.musicVolume = Number(e.target.value) / 100;
    $("#au-music-label").textContent = `${e.target.value}%`;
    save();
  });

  $("#au-sfx").addEventListener("input", (e) => {
    state.audio.sfxVolume = Number(e.target.value) / 100;
    $("#au-sfx-label").textContent = `${e.target.value}%`;
    save();
  });

  $("#au-time").addEventListener("input", (e) => {
    $("#au-time-label").textContent = formatTime(e.target.value);
  });

  $("#au-narr").addEventListener("input", (e) => {
    state.audio.narrationVolume = Number(e.target.value) / 100;
    $("#au-narr-label").textContent = `${e.target.value}%`;
    save();
  });

  $("#au-gap").addEventListener("input", (e) => {
    state.audio.gap = Number(e.target.value) / 10;
    $("#au-gap-label").textContent = formatTime(state.audio.gap);
    save();
  });

  $("#au-gap").addEventListener("change", () => {
    renderTimeline();
  });

  $("#au-duck").addEventListener("change", (e) => {
    state.audio.duck = e.target.checked;
    save();
  });

  $("#au-offset").addEventListener("input", (e) => {
    state.audio.offset = Number(e.target.value);
    $("#au-offset-label").textContent = `${state.audio.offset} ms`;
    save();
  });

  $("#btn-fit-all").addEventListener("click", fitAllNarrations);

  $("#au-import").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    for (const file of files) await addImportedSfx(file);
  });

  $("#btn-clear-sfx").addEventListener("click", () => {
    state.audio.events = [];
    save();
    renderAudioEvents();
    updateExportSummary();
  });

  // ---- mídia sobreposta ----
  $("#md-file").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    await addOverlayFiles(files);
  });

  const pickMedia = (selector, accept) => {
    const input = $(selector);
    if (!input) return;
    input.accept = accept;
    input.click();
  };
  $("#md-pick-image").addEventListener("click", () =>
    pickMedia("#md-file", "image/*"),
  );
  $("#md-pick-video").addEventListener("click", () =>
    pickMedia("#md-file", "image/gif,image/webp,image/*,video/*"),
  );

  const bindOverlaySlider = (sel, apply, label, format) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener("input", () => {
      const ov = currentOverlay();
      if (!ov) return;
      apply(ov, Number(el.value));
      const out = $(label);
      if (out) out.textContent = format(Number(el.value));
      syncOverlaysDOM(TL.time, false);
      updateExportSummary();
      save();
    });
    el.addEventListener("change", () => {
      renderTimeline();
      updateExportSummary();
    });
  };

  bindOverlaySlider("#md-x", (ov, v) => (ov.x = v / 100), "#md-x-label", (v) => `${v}%`);
  bindOverlaySlider("#md-y", (ov, v) => (ov.y = v / 100), "#md-y-label", (v) => `${v}%`);
  bindOverlaySlider("#md-scale", (ov, v) => (ov.scale = v / 100), "#md-scale-label", (v) => `${v}%`);
  bindOverlaySlider("#md-opacity", (ov, v) => (ov.opacity = v / 100), "#md-opacity-label", (v) => `${v}%`);
  bindOverlaySlider("#md-rot", (ov, v) => (ov.rotation = v), "#md-rot-label", (v) => `${v}°`);
  bindOverlaySlider("#md-start", (ov, v) => {
    ov.start = v;
    if (ov.end <= ov.start) ov.end = ov.start + 0.5;
  }, "#md-start-label", (v) => formatTime(v));
  bindOverlaySlider("#md-end", (ov, v) => {
    ov.end = Math.max(ov.start + 0.2, v);
  }, "#md-end-label", (v) => formatTime(v));

  $("#btn-prune-media").addEventListener("click", async () => {
    const used = new Set();
    for (const kf of state.keyframes) if (kf.narration?.mediaId) used.add(kf.narration.mediaId);
    for (const ov of state.overlays) used.add(ov.mediaId);
    for (const imp of state.audio.imports) used.add(imp.mediaId);
    try {
      const removed = await pruneMedia(used);
      toast(removed ? `${removed} arquivo(s) apagado(s)` : "Nada para limpar");
    } catch (err) {
      console.warn(err);
      toast("Não foi possível limpar agora.");
    }
  });

  // ---- linha do tempo ----
  initTimeline();
  $("#tl-play").addEventListener("click", playFromTimeline);
  $("#tl-zoom-in").addEventListener("click", () => setTimelineZoom(14));
  $("#tl-zoom-out").addEventListener("click", () => setTimelineZoom(-14));

  // edição de blocos
  $("#tl-split").addEventListener("click", splitAtPlayhead);
  $("#tl-cut-start").addEventListener("click", () => cutAtPlayhead("start"));
  $("#tl-cut-end").addEventListener("click", () => cutAtPlayhead("end"));
  $("#tl-dup").addEventListener("click", duplicateSelectedClip);
  $("#tl-del").addEventListener("click", deleteSelectedClip);

  // importar imagem direto da linha do tempo
  $("#tl-add-image").addEventListener("click", () => $("#tl-image-input").click());
  $("#tl-pin").addEventListener("click", snapSelectedToPlayhead);
  $("#tl-image-input").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    await addOverlayFiles(files);
  });

  $("#ex-res").addEventListener("change", (e) => {
    state.export.res = e.target.value;
    save();
  });
  $("#ex-fps").addEventListener("change", (e) => {
    state.export.fps = Number(e.target.value);
    save();
  });

  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const el = document.activeElement;
    const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    if (typing && el.type !== "range" && el.type !== "color") return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((key === "z" && e.shiftKey) || key === "y") {
      e.preventDefault();
      redo();
    }
  });

  // atalhos de edição de blocos (sem modificador)
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const el = document.activeElement;
    if (el) {
      const tag = el.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el.isContentEditable
      ) {
        return;
      }
    }
    const key = e.key;
    if (key === "Delete" || key === "Backspace") {
      if (!clipInfo()) return;
      e.preventDefault();
      deleteSelectedClip();
    } else if (key === "s" || key === "S") {
      if (!clipInfo()) return;
      e.preventDefault();
      splitAtPlayhead();
    } else if (key === "d" || key === "D") {
      if (!clipInfo()) return;
      e.preventDefault();
      duplicateSelectedClip();
    } else if (key === "p" || key === "P") {
      if (!clipInfo()) return;
      e.preventDefault();
      snapSelectedToPlayhead();
    }
  });

  if (!isExportSupported()) {
    $("#btn-render").disabled = true;
    $("#render-status").textContent = "Exportação não suportada neste navegador.";
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
load();
lastCommitted = JSON.stringify(state);
initUI();
updateHistoryButtons();
syncTextUI();
syncAudioUI();
updateExportSummary();
renderOverlayList();
prepareOverlayMedia().then(() => syncOverlaysDOM(0, false));
renderTimeline();
if (state.keyframes.length) renderKeyframes();
renderSelection();
setSearchStatus("carregando…");

renderPlaceStyle();
renderRouteSelects();
renderRouteList();
fillRouteEditor();
renderConflictSelects();
renderConflictList();
fillConflictEditor();
renderRegionList();
fillRegionEditor();
syncRegionControls();
applyTheme(themeNow(0));
scheduleGfx();

// inspeção em testes (console do navegador)
window.__mc = {
  state: () => state,
  markedPlaces,
  placeAnchor,
  buildGfxModel,
  renderRouteSelects,
  themeNow,
  seekTimeline,
  themeAt,
  tl: () => TL,
  clipInfo,
  selectClip,
  splitAtPlayhead,
  cutAtPlayhead,
  deleteSelectedClip,
  duplicateSelectedClip,
  renderTimeline,
  save,
  undo,
  redo,
  addOverlayFiles,
  audioPayload,
  routeStart: routeStartTime,
  routeArrival: routeArrivalTime,
  routeEnd: routeEndTime,
  snapSelectedToPlayhead,
  addConflict,
  renderConflictList,
  renderConflictSelects,
  fillConflictEditor,
  conflictPlaceInfo,
  battleAt,
  battleStyleFor,
  mixColors,
};

$("#ex-res").value = state.export.res;
$("#ex-fps").value = String(state.export.fps);
