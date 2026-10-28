/**
 * Baixa as bandeiras usadas no preenchimento de países.
 *
 * Fonte: flagcdn.com (imagens de domínio público, derivadas da Wikimedia).
 * Os arquivos ficam em www/assets/flags/<ISO2>.png e vão embutidos no APK —
 * o app não precisa de internet para desenhar a bandeira.
 *
 * Uso: node scripts/fetch-flags.mjs [--force]
 */
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const FLAGS_DIR = path.join(ROOT, "www", "assets", "flags");
const WIDTH = 640;

/** Países do Natural Earth sem ISO_A2 válido (mapeamento manual). */
const ISO_OVERRIDES = {
  France: "FR",
  Norway: "NO",
  Kosovo: "XK",
  Somaliland: "SO",
  "N. Cyprus": "TR",
};

const force = process.argv.includes("--force");

const geo = JSON.parse(await readFile(path.join(ROOT, "www", "data", "countries.geojson"), "utf8"));

const wanted = new Map(); // iso2 -> nome do país
for (const f of geo.features) {
  const p = f.properties || {};
  let iso = String(p.ISO_A2 || "").toUpperCase();
  if (!iso || iso === "-99") iso = ISO_OVERRIDES[p.NAME] || "";
  if (!/^[A-Z]{2}$/.test(iso)) continue;
  wanted.set(iso, p.NAME_PT || p.NAME || iso);
}

await mkdir(FLAGS_DIR, { recursive: true });

let downloaded = 0;
let skipped = 0;
let failed = [];

for (const [iso, label] of [...wanted].sort()) {
  const code = iso.toLowerCase();
  const file = path.join(FLAGS_DIR, `${code}.png`);
  if (!force && existsSync(file)) {
    skipped++;
    continue;
  }
  const url = `https://flagcdn.com/w${WIDTH}/${code}.png`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // bandeiras de listras simples comprimem muito (Áustria ~200 bytes),
    // então valida a assinatura PNG em vez do tamanho
    if (buf.length < 60 || buf.subarray(1, 4).toString() !== "PNG") throw new Error("não é PNG");
    await writeFile(file, buf);
    downloaded++;
  } catch (err) {
    failed.push(`${iso} (${label}): ${err.message}`);
  }
}

const files = (await readdir(FLAGS_DIR)).filter((f) => f.endsWith(".png"));
let total = 0;
for (const f of files) total += (await stat(path.join(FLAGS_DIR, f))).size;

console.log(`bandeiras: ${files.length} arquivos · ${(total / 1048576).toFixed(2)} MB`);
console.log(`baixadas agora: ${downloaded} · já existiam: ${skipped}`);
if (failed.length) {
  console.log(`falharam (${failed.length}):`);
  for (const f of failed) console.log("  - " + f);
}
