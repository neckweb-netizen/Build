/**
 * Teste no aparelho: busca de estados e cidades dentro do WebView do app.
 * Requer: adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *
 * Uso: node scripts/device-search-test.mjs
 */
const EXPRESSION = `(async () => {
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);

  try {
    // espera mapa + camadas + índice de cidades
    for (let i = 0; i < 100; i++) {
      const ok = window.map && window.map.getLayer && window.map.getLayer('states-fill')
        && window.map.getLayer('cities-dot')
        && /cidades/.test(q('#search-status')?.textContent || '');
      if (ok) break;
      await wait(300);
    }
    out.status = q('#search-status')?.textContent || '';
    out.layers = ['countries-fill', 'states-fill', 'cities-dot', 'cities-label']
      .filter((id) => window.map.getLayer(id));

    const type = async (text) => {
      const el = q('#place-search');
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(350);
      return [...document.querySelectorAll('#search-results li')].map((li) => ({
        badge: li.querySelector('.result-badge')?.textContent,
        name: li.querySelector('.name')?.textContent,
        sub: li.querySelector('.sub')?.textContent,
      }));
    };

    out.para = (await type('para')).slice(0, 3);
    out.londres = (await type('londres')).slice(0, 2);
    out.saoPaulo = (await type('sao paulo')).slice(0, 3);

    // seleciona o primeiro resultado (cidade de São Paulo)
    q('#search-results .result-main').click();
    await wait(2000);
    const c = window.map.getCenter();
    out.cam = { lng: +c.lng.toFixed(2), lat: +c.lat.toFixed(2), zoom: +window.map.getZoom().toFixed(2) };
    out.cityFeatures = (window.map.getSource('selected-cities')._data?.features || [])
      .map((f) => f.properties.label);
    out.selected = q('#sel-count')?.textContent;
    out.selectedList = [...document.querySelectorAll('#selected-all li .name')].map((n) => n.textContent);

    // busca de estado + destaque
    await type('mato grosso');
    q('#search-results .result-main').click();
    await wait(1800);
    const st = window.map.getFeatureState({ source: 'states', id: 'BR-MT' });
    out.stateFeature = st;
  } catch (err) {
    out.error = String(err && err.stack || err);
  }
  return out;
})()`;

const res = await fetch("http://127.0.0.1:9222/json");
const targets = await res.json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("Nenhuma página no CDP. O app está aberto?");

const ws = new WebSocket(page.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout no CDP")), 120000);
  ws.onopen = () => {
    ws.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: EXPRESSION, awaitPromise: true, returnByValue: true },
    }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== 1) return;
    clearTimeout(timer);
    ws.close();
    if (msg.result?.exceptionDetails) {
      reject(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 800)));
    } else {
      resolve(msg.result?.result?.value);
    }
  };
  ws.onerror = (e) => { clearTimeout(timer); reject(new Error("erro WS: " + (e.message || "desconhecido"))); };
});

console.log(JSON.stringify(result, null, 2));
