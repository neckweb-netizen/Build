/**
 * Gera www/data/municipios.geojson (malha municipal do Brasil) a partir do
 * GeoJSON simplificado do IBGE (geojs-100-mun.json).
 *
 * Uso:
 *   node scripts/build-municipios.mjs <entrada-simplificada.geojson>
 *
 * A entrada pode ser gerada com:
 *   npx mapshaper municipios.json -simplify 3% keep-shapes \
 *     -o municipios-simpl.geojson format=geojson precision=0.0001
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = process.argv[2];
if (!input) {
  console.error("Uso: node scripts/build-municipios.mjs <entrada.geojson>");
  process.exit(1);
}

/* Código IBGE (2 primeiros dígitos) -> UF */
const UF = {
  11: ["RO", "Rondônia"],
  12: ["AC", "Acre"],
  13: ["AM", "Amazonas"],
  14: ["RR", "Roraima"],
  15: ["PA", "Pará"],
  16: ["AP", "Amapá"],
  17: ["TO", "Tocantins"],
  21: ["MA", "Maranhão"],
  22: ["PI", "Piauí"],
  23: ["CE", "Ceará"],
  24: ["RN", "Rio Grande do Norte"],
  25: ["PB", "Paraíba"],
  26: ["PE", "Pernambuco"],
  27: ["AL", "Alagoas"],
  28: ["SE", "Sergipe"],
  29: ["BA", "Bahia"],
  31: ["MG", "Minas Gerais"],
  32: ["ES", "Espírito Santo"],
  33: ["RJ", "Rio de Janeiro"],
  35: ["SP", "São Paulo"],
  41: ["PR", "Paraná"],
  42: ["SC", "Santa Catarina"],
  43: ["RS", "Rio Grande do Sul"],
  50: ["MS", "Mato Grosso do Sul"],
  51: ["MT", "Mato Grosso"],
  52: ["GO", "Goiás"],
  53: ["DF", "Distrito Federal"],
};

function normalize(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/*
 * População e coordenadas do GeoNames: a população desempata a busca e as
 * coordenadas dão o ponto representativo do município (o centro do bbox cai
 * em baía, lago ou floresta em vários casos).
 */
const geoByKey = new Map();
try {
  const rows = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(root, "www/data/cities.json.gz"))).toString("utf8"),
  );
  for (const row of rows) {
    const [gid, name, lat, lon, cc, admin1, pop] = row;
    if (cc !== "BR") continue;
    const key = `${normalize(admin1)}|${normalize(name)}`;
    const current = geoByKey.get(key);
    const people = Number(pop) || 0;
    if (!current || people > current.pop) geoByKey.set(key, { pop: people, lat, lon });
    void gid;
  }
} catch (err) {
  console.warn("Sem cidades do GeoNames para juntar população:", err.message);
}

const geo = JSON.parse(fs.readFileSync(input, "utf8"));
const features = [];

for (const f of geo.features) {
  const p = f.properties || {};
  const code = String(p.id || "").padStart(7, "0");
  const [uf, ufName] = UF[Number(code.slice(0, 2))] || ["", ""];
  if (!uf) continue;

  const name = String(p.name || p.description || "").trim();
  if (!name) continue;

  const geo = geoByKey.get(`${normalize(ufName)}|${normalize(name)}`);
  const pop = geo ? geo.pop : 0;

  features.push({
    type: "Feature",
    properties: {
      id: code,
      name,
      uf,
      ufName,
      pop,
      lat: geo ? geo.lat : null,
      lon: geo ? geo.lon : null,
    },
    geometry: f.geometry,
  });
}

const out = { type: "FeatureCollection", features };
const dest = path.join(root, "www/data/municipios.geojson");
fs.writeFileSync(dest, JSON.stringify(out));

const withPop = features.filter((f) => f.properties.pop > 0).length;
console.log(
  `municípios: ${features.length} · com população: ${withPop} · ${(fs.statSync(dest).size / 1048576).toFixed(2)} MB`,
);
console.log(`escrito em ${dest}`);
