/**
 * Gera www/data/cities.json(.gz) a partir do dump do GeoNames.
 *
 * Entrada: cities15000.txt + admin1CodesASCII.txt (baixados em %TEMP%\mapcine-data)
 * Saída:   [[geonameid, nome, lat, lon, país ISO2, estado, população], ...]
 *
 * Uso: node scripts/build-cities.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const SRC = path.join(process.env.TEMP, "mapcine-data");
const OUT = path.join(process.cwd(), "www", "data");

const citiesTxt = path.join(SRC, "cities15000.txt");
const admin1Txt = path.join(SRC, "admin1CodesASCII.txt");

if (!fs.existsSync(citiesTxt)) {
  console.error(`Faltando ${citiesTxt}. Baixe cities15000.zip do GeoNames e extraia.`);
  process.exit(1);
}

// "BR.27" -> "São Paulo"
const admin1 = new Map();
if (fs.existsSync(admin1Txt)) {
  for (const line of fs.readFileSync(admin1Txt, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const [code, name] = line.split("\t");
    if (code && name) admin1.set(code, name);
  }
}

// Nomes usados em português para cidades estrangeiras (exônimos).
// [nome em português, nome no GeoNames, país ISO2]
const PT_ALIASES = [
  ["Londres", "London", "GB"],
  ["Moscou", "Moscow", "RU"],
  ["Pequim", "Beijing", "CN"],
  ["Xangai", "Shanghai", "CN"],
  ["Cantão", "Guangzhou", "CN"],
  ["Tóquio", "Tokyo", "JP"],
  ["Seul", "Seoul", "KR"],
  ["Roma", "Rome", "IT"],
  ["Milão", "Milan", "IT"],
  ["Nápoles", "Naples", "IT"],
  ["Turim", "Turin", "IT"],
  ["Florença", "Florence", "IT"],
  ["Veneza", "Venice", "IT"],
  ["Gênova", "Genoa", "IT"],
  ["Bolonha", "Bologna", "IT"],
  ["Munique", "Munich", "DE"],
  ["Colônia", "Cologne", "DE"],
  ["Frankfurt", "Frankfurt am Main", "DE"],
  ["Nuremberg", "Nürnberg", "DE"],
  ["Viena", "Vienna", "AT"],
  ["Varsóvia", "Warsaw", "PL"],
  ["Cracóvia", "Kraków", "PL"],
  ["Copenhague", "Copenhagen", "DK"],
  ["Amesterdã", "Amsterdam", "NL"],
  ["Bruxelas", "Brussels", "BE"],
  ["Genebra", "Geneva", "CH"],
  ["Zurique", "Zurich", "CH"],
  ["Atenas", "Athens", "GR"],
  ["Tessalônica", "Thessaloniki", "GR"],
  ["Istambul", "Istanbul", "TR"],
  ["Ancara", "Ankara", "TR"],
  ["Teerã", "Tehran", "IR"],
  ["Bagdá", "Baghdad", "IQ"],
  ["Damasco", "Damascus", "SY"],
  ["Beirute", "Beirut", "LB"],
  ["Jerusalém", "Jerusalem", "IL"],
  ["Meca", "Mecca", "SA"],
  ["Nova Délhi", "New Delhi", "IN"],
  ["Deli", "Delhi", "IN"],
  ["Bombaim", "Mumbai", "IN"],
  ["Calcutá", "Kolkata", "IN"],
  ["Madras", "Chennai", "IN"],
  ["Bangalore", "Bengaluru", "IN"],
  ["Bancoc", "Bangkok", "TH"],
  ["Jacarta", "Jakarta", "ID"],
  ["Hanói", "Hanoi", "VN"],
  ["Saigon", "Ho Chi Minh City", "VN"],
  ["Rangum", "Yangon", "MM"],
  ["Katmandu", "Kathmandu", "NP"],
  ["Islamabade", "Islamabad", "PK"],
  ["Cabul", "Kabul", "AF"],
  ["Ulan Bator", "Ulaanbaatar", "MN"],
  ["Singapura", "Singapore", "SG"],
  ["Cidade do Cabo", "Cape Town", "ZA"],
  ["Joanesburgo", "Johannesburg", "ZA"],
  ["Pretória", "Pretoria", "ZA"],
  ["Nairóbi", "Nairobi", "KE"],
  ["Adis Abeba", "Addis Ababa", "ET"],
  ["Marraquexe", "Marrakesh", "MA"],
  ["Túnis", "Tunis", "TN"],
  ["Argel", "Algiers", "DZ"],
  ["Trípoli", "Tripoli", "LY"],
  ["Dacar", "Dakar", "SN"],
  ["Abidjã", "Abidjan", "CI"],
  ["Acra", "Accra", "GH"],
  ["Brazavile", "Brazzaville", "CG"],
  ["Cidade do México", "Mexico City", "MX"],
  ["Havana", "Havana", "CU"],
  ["São Domingos", "Santo Domingo", "DO"],
  ["Porto Príncipe", "Port-au-Prince", "HT"],
  ["Montevidéu", "Montevideo", "UY"],
  ["Assunção", "Asunción", "PY"],
  ["Nova York", "New York City", "US"],
  ["Filadélfia", "Philadelphia", "US"],
  ["São Francisco", "San Francisco", "US"],
  ["Nova Orleães", "New Orleans", "US"],
  ["Madri", "Madrid", "ES"],
  ["Sevilha", "Seville", "ES"],
  ["Valência", "Valencia", "ES"],
  ["Bucareste", "Bucharest", "RO"],
  ["Budapeste", "Budapest", "HU"],
  ["Praga", "Prague", "CZ"],
  ["Sófia", "Sofia", "BG"],
  ["Belgrado", "Belgrade", "RS"],
  ["Liubliana", "Ljubljana", "SI"],
  ["Escópia", "Skopje", "MK"],
  ["Kiev", "Kyiv", "UA"],
  ["Helsinque", "Helsinki", "FI"],
  ["Estocolmo", "Stockholm", "SE"],
  ["Edimburgo", "Edinburgh", "GB"],
  ["Marselha", "Marseille", "FR"],
  ["Bordéus", "Bordeaux", "FR"],
  ["Estrasburgo", "Strasbourg", "FR"],
  ["Berna", "Bern", "CH"],
  ["Erevan", "Yerevan", "AM"],
  ["Daca", "Dhaka", "BD"],
  ["Quebec", "Québec", "CA"],
  ["Lisboa", "Lisbon", "PT"],
  ["Copenhaga", "Copenhagen", "DK"],
  ["Cracóvia", "Krakow", "PL"],
];

function normalize(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Mapeia geonameid -> lista de nomes alternativos normalizados.
 * O nome canônico é procurado por nome + país, ficando com a cidade mais populosa.
 */
function buildAliases(rows) {
  const key = (name, cc) => `${normalize(name)}|${cc}`;
  const best = new Map();
  for (const row of rows) {
    const k = key(row[1], row[4]);
    const current = best.get(k);
    if (!current || row[6] > current[6]) best.set(k, row);
  }

  const aliases = {};
  for (const [pt, canonical, cc] of PT_ALIASES) {
    const row = best.get(key(canonical, cc));
    if (!row) continue;
    const id = `c${row[0]}`;
    const alias = normalize(pt);
    if (alias === normalize(row[1])) continue;
    (aliases[id] ||= []).push(alias);
  }
  return aliases;
}

const rows = [];
let skipped = 0;

for (const line of fs.readFileSync(citiesTxt, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const f = line.split("\t");
  // geonameid 0 | name 1 | asciiname 2 | alternates 3 | lat 4 | lon 5 |
  // feature class 6 | feature code 7 | country 8 | cc2 9 | admin1 10 | ...
  const id = Number(f[0]);
  const name = f[1];
  const lat = Number(f[4]);
  const lon = Number(f[5]);
  const cc = f[8];
  const a1code = f[10];
  const pop = Number(f[14]) || 0;

  if (!id || !name || !cc || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    skipped++;
    continue;
  }

  const state = a1code ? admin1.get(`${cc}.${a1code}`) || "" : "";
  rows.push([id, name, Number(lat.toFixed(4)), Number(lon.toFixed(4)), cc, state, pop]);
}

rows.sort((a, b) => b[6] - a[6]);

const json = JSON.stringify(rows);
fs.writeFileSync(path.join(OUT, "cities.json"), json);
fs.writeFileSync(path.join(OUT, "cities.json.gz"), zlib.gzipSync(json, { level: 9 }));

const aliases = buildAliases(rows);
const aliasJson = JSON.stringify(aliases);
fs.writeFileSync(path.join(OUT, "city-aliases.json"), aliasJson);

const mb = (n) => (n / 1048576).toFixed(2) + " MB";
console.log(`cidades: ${rows.length} (ignoradas ${skipped})`);
console.log(`estados resolvidos: ${admin1.size}`);
console.log(`cities.json    ${mb(Buffer.byteLength(json))}`);
console.log(`cities.json.gz ${mb(zlib.gzipSync(json).length)}`);
console.log(`exônimos PT    ${Object.keys(aliases).length} (${mb(Buffer.byteLength(aliasJson))})`);
