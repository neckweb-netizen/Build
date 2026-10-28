/**
 * Teste no aparelho: cores por estado/cidade + divisões internas.
 * Requer: adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 */
const EXPRESSION = `(async () => {
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);

  try {
    for (let i = 0; i < 120; i++) {
      const ok = window.map?.getLayer?.('states-borders')
        && window.map.getLayer('cities-dot')
        && /cidades/.test(q('#search-status')?.textContent || '');
      if (ok) break;
      await wait(300);
    }
    out.status = q('#search-status')?.textContent || '';
    out.borders = !!window.map.getLayer('states-borders');

    const type = async (text) => {
      const el = q('#place-search');
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(350);
      return [...document.querySelectorAll('#search-results li')].map((li) => li.querySelector('.name')?.textContent);
    };

    // limpa e seleciona um estado + uma cidade pela busca
    q('#btn-clear-countries').click();
    await wait(400);

    await type('bahia');
    q('#search-results .result-main').click();
    await wait(1500);

    await type('salvador');
    q('#search-results .result-main').click();
    await wait(1500);

    out.rows = [...document.querySelectorAll('#selected-all li')].map((r) => ({
      badge: r.querySelector('.result-badge').textContent,
      name: r.querySelector('.name').textContent,
      color: r.querySelector('input[type=color]').value,
    }));

    // muda a cor do estado e da cidade
    const rows = [...document.querySelectorAll('#selected-all li')];
    const stateRow = rows.find((r) => r.querySelector('.result-badge').textContent === 'Estado');
    const cityRow = rows.find((r) => r.querySelector('.result-badge').textContent === 'Cidade');

    if (stateRow) {
      const inp = stateRow.querySelector('input[type=color]');
      inp.value = '#3f7bd6';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(400);
      out.stateFeature = window.map.getFeatureState({ source: 'states', id: 'BR-BA' });
    }
    if (cityRow) {
      const inp = cityRow.querySelector('input[type=color]');
      inp.value = '#3ef0a0';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(400);
      out.cityFeature = (window.map.getSource('selected-cities')._data?.features || []).map((f) => f.properties);
    }

    // quantos limites internos estão na tela
    out.bordersRendered = window.map.queryRenderedFeatures({ layers: ['states-borders'] }).length;
    const c = window.map.getCenter();
    out.cam = { lng: +c.lng.toFixed(2), lat: +c.lat.toFixed(2), zoom: +window.map.getZoom().toFixed(2) };
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
  const timer = setTimeout(() => reject(new Error("timeout no CDP")), 150000);
  ws.onopen = () => ws.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression: EXPRESSION, awaitPromise: true, returnByValue: true },
  }));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== 1) return;
    clearTimeout(timer);
    ws.close();
    if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 800)));
    else resolve(msg.result?.result?.value);
  };
  ws.onerror = (e) => { clearTimeout(timer); reject(new Error("erro WS: " + (e.message || "desconhecido"))); };
});

console.log(JSON.stringify(result, null, 2));
