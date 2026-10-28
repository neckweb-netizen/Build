/**
 * Bandeiras dos países (embutidas em www/assets/flags).
 *
 * As imagens vêm do flagcdn.com (domínio público, derivadas da Wikimedia) e
 * ficam no aparelho — o preenchimento funciona sem internet.
 */

const BASE = "assets/flags";

/** Países do Natural Earth sem ISO_A2 válido. */
export const ISO_OVERRIDES = {
  France: "FR",
  Norway: "NO",
  Kosovo: "XK",
  Somaliland: "SO",
  "N. Cyprus": "TR",
};

const cache = new Map(); // iso2 -> Promise<HTMLImageElement|null>
const ready = new Map(); // iso2 -> HTMLImageElement (carregada)

export function isoForCountry(properties) {
  if (!properties) return "";
  const raw = String(properties.ISO_A2 || "").toUpperCase();
  if (/^[A-Z]{2}$/.test(raw) && raw !== "-99") return raw;
  return ISO_OVERRIDES[properties.NAME] || "";
}

/** Imagem já carregada, ou null. Usada no desenho (síncrono). */
export function flagImage(iso) {
  return ready.get(String(iso || "").toUpperCase()) || null;
}

export function hasFlag(iso) {
  return ready.has(String(iso || "").toUpperCase());
}

/**
 * Carrega a bandeira (idempotente). Nunca rejeita: se faltar o arquivo,
 * resolve null e o desenho cai no preenchimento por cor.
 */
export function loadFlag(iso) {
  const code = String(iso || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return Promise.resolve(null);
  if (cache.has(code)) return cache.get(code);

  const p = new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      ready.set(code, img);
      resolve(img);
    };
    img.onerror = () => resolve(null);
    img.src = `${BASE}/${code.toLowerCase()}.png`;
  });
  cache.set(code, p);
  return p;
}

/** Carrega várias de uma vez (silencioso). */
export function preloadFlags(list = []) {
  return Promise.all([...new Set(list)].map((iso) => loadFlag(iso)));
}
