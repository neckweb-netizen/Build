/**
 * Prepara os assets copiados pelo `cap sync` para o build do APK.
 *
 * O AAPT2 trata `arquivo.json.gz` e `arquivo.json` como o mesmo recurso e
 * falha o build com "Duplicate resources". Como o app tenta o `.gz` e cai no
 * `.json` quando ele não existe, basta remover os `.gz` do pacote.
 *
 * Uso: node scripts/prepare-android.mjs  (ou npm run android:prepare)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "android/app/src/main/assets/public");

if (!fs.existsSync(assets)) {
  console.error(`Sem assets em ${assets}. Rode "npx cap sync android" antes.`);
  process.exit(1);
}

let removed = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".gz")) {
      fs.unlinkSync(full);
      removed++;
      console.log(`removido ${path.relative(assets, full)}`);
    }
  }
}

walk(assets);
console.log(`${removed} arquivo(s) .gz removido(s) dos assets do Android.`);
