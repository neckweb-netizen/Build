/**
 * Busca unificada: países, estados/províncias e cidades.
 *
 * Os índices são construídos uma vez, em memória, e normalizados sem acentos
 * para que "sao paulo" encontre "São Paulo".
 */

/* ------------------------------------------------------------------ *
 * Normalização
 * ------------------------------------------------------------------ */
export function normalize(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ *
 * Geometria
 * ------------------------------------------------------------------ */
function visitCoords(geom, fn) {
  if (!geom) return;
  const walk = (c) => {
    if (typeof c[0] === "number") fn(c);
    else for (const item of c) walk(item);
  };
  if (geom.type === "GeometryCollection") {
    for (const g of geom.geometries || []) visitCoords(g, fn);
  } else if (geom.coordinates) {
    walk(geom.coordinates);
  }
}

export function bboxOfGeometry(geom) {
  if (!geom) return null;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  visitCoords(geom, ([lng, lat]) => {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  });
  if (!Number.isFinite(minLng)) return null;
  return [minLng, minLat, maxLng, maxLat];
}

export function centerOfBbox(bbox) {
  if (!bbox) return null;
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

/* ------------------------------------------------------------------ *
 * Índices
 * ------------------------------------------------------------------ */

/** Área aproximada de um bbox, em km² (usada como fallback). */
function bboxAreaKm2(bbox) {
  if (!bbox) return 0;
  const [x0, y0, x1, y1] = bbox;
  const R = 6371;
  const midLat = ((y0 + y1) / 2) * (Math.PI / 180);
  const w = Math.abs((x1 - x0) * (Math.PI / 180)) * R * Math.cos(midLat);
  const h = Math.abs((y1 - y0) * (Math.PI / 180)) * R;
  return Math.abs(w * h);
}

/** Área de um anel em km² (aproximação esférica). */
function ringAreaKm2(ring) {
  if (!ring || ring.length < 3) return 0;
  const R = 6371;
  const rad = Math.PI / 180;
  let total = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[i + 1];
    total += (lng2 - lng1) * rad * (2 + Math.sin(lat1 * rad) + Math.sin(lat2 * rad));
  }
  return Math.abs((total * R * R) / 2);
}

/** Área real do polígono (subtrai buracos), em km². */
function geometryAreaKm2(geom) {
  if (!geom) return 0;
  if (geom.type === "Polygon") {
    const [outer, ...holes] = geom.coordinates;
    return Math.max(0, ringAreaKm2(outer) - holes.reduce((sum, h) => sum + ringAreaKm2(h), 0));
  }
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.reduce((sum, poly) => {
      const [outer, ...holes] = poly;
      return sum + Math.max(0, ringAreaKm2(outer) - holes.reduce((s, h) => s + ringAreaKm2(h), 0));
    }, 0);
  }
  if (geom.type === "GeometryCollection") {
    return (geom.geometries || []).reduce((sum, g) => sum + geometryAreaKm2(g), 0);
  }
  return 0;
}

/**
 * Países a partir das propriedades do GeoJSON.
 * @param {Map<string, object>} propsById id (NAME) -> properties
 */
export function buildCountryIndex(propsById) {
  const out = [];
  for (const [id, p] of propsById) {
    const name = p.NAME_PT || p.NAME || id;
    out.push({
      kind: "country",
      id,
      name,
      norm: normalize(name),
      normAlt: normalize(p.NAME || ""),
      alt: null,
      sub: "",
      weight: 25,
      bbox: p._bbox || null,
      lat: null,
      lon: null,
    });
  }
  return out;
}

/**
 * Estados/províncias. Garante um id único (o Natural Earth repete alguns
 * códigos ISO) e calcula o bounding box de cada unidade.
 * @param {object} geojson
 */
export function buildStateIndex(geojson) {
  const out = [];
  const used = new Map();

  for (const f of geojson.features) {
    const p = f.properties || {};
    const iso = String(p.iso_3166_2 || "").trim();
    const base = iso || `A1-${out.length}`;
    const seen = used.get(base) || 0;
    used.set(base, seen + 1);
    const id = seen === 0 ? base : `${base}#${seen + 1}`;

    p._id = id;

    const name = (p.name || "").trim() || id;
    const bbox = bboxOfGeometry(f.geometry);
    const center = centerOfBbox(bbox);
    const area = geometryAreaKm2(f.geometry) || bboxAreaKm2(bbox);
    // usado como prioridade de rótulo: unidades grandes ganham espaço
    p._area = Math.round(area);

    out.push({
      kind: "state",
      id,
      name,
      norm: normalize(name),
      normAlt: "",
      alt: null,
      sub: [p.type_en || "Estado", p.admin].filter(Boolean).join(" · "),
      // área serve de "popularidade" para desempatar unidades homônimas
      weight: 3.5 + 0.5 * Math.log10(area + 1),
      bbox,
      lat: center ? center[1] : null,
      lon: center ? center[0] : null,
    });
  }
  return out;
}

/**
 * Cidades a partir das linhas compactas geradas por scripts/build-cities.mjs:
 * [geonameid, nome, lat, lon, país ISO2, estado, população]
 */
export function buildCityIndex(rows, countryNames, aliases = null) {
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const [gid, name, lat, lon, cc, admin1, pop] = rows[i];
    const country = countryNames.get(cc) || cc;
    const id = `c${gid}`;
    const alt = aliases && aliases[id] ? aliases[id] : null;
    out[i] = {
      kind: "city",
      id,
      cc,
      name,
      norm: normalize(name),
      normAlt: "",
      alt,
      sub: admin1 ? `${admin1} · ${country}` : country,
      weight: Math.log10(pop + 1),
      bbox: null,
      lat,
      lon,
    };
  }
  return out;
}

/**
 * Municípios brasileiros (malha do IBGE). Cada um vira uma "cidade" com
 * contorno próprio; a população do GeoNames, quando existe, define o peso.
 * @param {object} geojson
 */
export function buildMunicipalityIndex(geojson) {
  const out = [];
  for (const f of geojson.features || []) {
    const p = f.properties || {};
    const code = String(p.id || "").trim();
    if (!code) continue;

    const name = String(p.name || "").trim();
    if (!name) continue;

    const bbox = bboxOfGeometry(f.geometry);
    const center = centerOfBbox(bbox);
    const area = geometryAreaKm2(f.geometry) || bboxAreaKm2(bbox);
    const pop = Number(p.pop) || 0;

    // ponto de rótulo: coordenada da cidade quando conhecida (o centro do
    // bbox cai no mar em Salvador); senão o centro do maior anel do polígono
    const known = Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.lat !== null;
    const spot = known
      ? [Number(p.lon), Number(p.lat)]
      : centerOfLargestRing(f.geometry) || center;

    out.push({
      kind: "city",
      id: `m${code}`,
      muniId: code,
      cc: "BR",
      name,
      norm: normalize(name),
      normAlt: "",
      alt: null,
      sub: p.uf ? `Município · ${p.uf} · Brasil` : "Município · Brasil",
      ufName: p.ufName || "",
      // cidades conhecidas usam população; as demais desempatam pela área
      weight: pop > 0 ? Math.log10(pop + 1) + 0.5 : 2 + 0.5 * Math.log10(area + 1),
      bbox,
      lat: spot ? spot[1] : null,
      lon: spot ? spot[0] : null,
    });
  }
  return out;
}

/** Centro do bbox do maior anel (contorno externo mais extenso). */
function centerOfLargestRing(geom) {
  const polys =
    geom?.type === "Polygon"
      ? [geom.coordinates]
      : geom?.type === "MultiPolygon"
        ? geom.coordinates
        : [];
  let best = null;
  let bestArea = 0;
  for (const poly of polys) {
    const ring = poly?.[0];
    if (!ring || ring.length < 3) continue;
    const area = ringAreaKm2(ring);
    if (area > bestArea) {
      bestArea = area;
      best = ring;
    }
  }
  if (!best) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of best) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/* ------------------------------------------------------------------ *
 * Carregamento das cidades (gzip + DecompressionStream)
 * ------------------------------------------------------------------ */
export async function loadCityRows(url) {
  // O empacotador do Android descompacta assets .gz (o arquivo chega como
  // "cities.json"), então tentamos o nome comprimido e depois o simples.
  let res = await fetch(url);
  if (!res.ok) res = await fetch(url.replace(/\.gz$/, ""));
  if (!res.ok) throw new Error(`Falha ao baixar cidades (HTTP ${res.status})`);

  const buf = new Uint8Array(await res.arrayBuffer());
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;

  let text;
  if (!isGzip) {
    // servidor já entregou descompactado (Content-Encoding: gzip ou asset Android)
    text = new TextDecoder().decode(buf);
  } else if (typeof DecompressionStream === "function") {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    text = await new Response(stream).text();
  } else {
    throw new Error("Este navegador não descompacta gzip.");
  }

  return JSON.parse(text);
}

/* ------------------------------------------------------------------ *
 * Ranking
 * ------------------------------------------------------------------ */
/** 0 = igual, 1 = começa com, 2 = começa uma palavra, 3 = contém. */
function matchTier(norm, term) {
  if (norm === term) return 0;
  if (norm.startsWith(term)) return 1;
  const idx = norm.indexOf(term);
  if (idx < 0) return Infinity;
  const prev = norm[idx - 1];
  if (prev === " " || prev === "-" || prev === "'" || prev === "(") return 2;
  return 3;
}

function bestTier(rec, term) {
  let tier = matchTier(rec.norm, term);
  if (tier !== Infinity) return tier;
  if (rec.normAlt) {
    tier = matchTier(rec.normAlt, term);
    if (tier !== Infinity) return tier;
  }
  if (rec.alt) {
    for (const alias of rec.alt) {
      const t = matchTier(alias, term);
      if (t !== Infinity) return t;
    }
  }
  return Infinity;
}

/**
 * @param {Array} index lista de registros
 * @param {string} query
 * @param {number} limit
 */
export function search(index, query, limit = 12) {
  const term = normalize(query);
  if (term.length < 2) return [];

  const scored = [];
  for (const rec of index) {
    const tier = bestTier(rec, term);
    if (tier === Infinity) continue;
    scored.push({ rec, tier });
  }

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (b.rec.weight !== a.rec.weight) return b.rec.weight - a.rec.weight;
    return a.rec.name.localeCompare(b.rec.name);
  });

  const out = [];
  const seen = new Set();
  for (const { rec } of scored) {
    const key = `${rec.kind}:${rec.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
    if (out.length >= limit) break;
  }
  return out;
}

/** Zoom aproximado para enquadrar um local. */
export function zoomForBbox(bbox) {
  if (!bbox) return 9;
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  if (span > 60) return 2.4;
  if (span > 30) return 3.2;
  if (span > 12) return 4.2;
  if (span > 5) return 5.2;
  if (span > 2) return 6.2;
  if (span > 0.5) return 7.4;
  return 9;
}
