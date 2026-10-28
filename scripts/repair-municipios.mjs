/**
 * Repara municípios cuja geometria veio degenerada do dump do IBGE
 * (o geojs-100-mun.json colapsa algumas cidades litorâneas em 4-12 pontos).
 *
 * Para esses casos busca a malha oficial na API v3 do IBGE e substitui a
 * geometria em www/data/municipios.geojson, preservando as propriedades.
 *
 * Uso: node scripts/repair-municipios.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "www/data/municipios.geojson");

function pointCount(geom) {
  const walk = (c) => (typeof c[0] === "number" ? 1 : c.reduce((sum, item) => sum + walk(item), 0));
  return geom?.coordinates ? walk(geom.coordinates) : 0;
}

function simplifyRing(points, tol) {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = tol * tol;

  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [x1, y1] = points[a];
    const [x2, y2] = points[b];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let best = -1;
    let bestIndex = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d2 = (px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2;
      if (d2 > best) {
        best = d2;
        bestIndex = i;
      }
    }
    if (best > tol2) {
      keep[bestIndex] = 1;
      stack.push([a, bestIndex], [bestIndex, b]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function simplifyGeometry(geom, tol = 0.002) {
  const polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  const kept = polygons
    .map((poly) => [simplifyRing(poly[0], tol), ...(poly.slice(1) || []).map((ring) => simplifyRing(ring, tol))])
    .filter((poly) => poly[0].length >= 4);
  if (!kept.length) return null;
  return kept.length === 1
    ? { type: "Polygon", coordinates: kept[0] }
    : { type: "MultiPolygon", coordinates: kept };
}

const geo = JSON.parse(fs.readFileSync(file, "utf8"));
const broken = geo.features.filter((f) => pointCount(f.geometry) < 8);
console.log(`municípios com geometria degenerada: ${broken.length}`);

let fixed = 0;
for (const feature of broken) {
  const code = feature.properties.id;
  const url =
    `https://servicodados.ibge.gov.br/api/v3/malhas/municipios/${code}` +
    "?formato=application/vnd.geo+json&qualidade=intermediaria";
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const source = data.features?.[0]?.geometry || data.geometry;
    const geometry = source ? simplifyGeometry(source) : null;
    if (!geometry) throw new Error("geometria vazia");
    feature.geometry = geometry;
    fixed++;
    console.log(`ok ${code} ${feature.properties.name} — ${pointCount(geometry)} pontos`);
  } catch (err) {
    console.warn(`falhou ${code} ${feature.properties.name}: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 120));
}

fs.writeFileSync(file, JSON.stringify(geo));
console.log(
  `reparados ${fixed}/${broken.length} · ${(fs.statSync(file).size / 1048576).toFixed(2)} MB`,
);
