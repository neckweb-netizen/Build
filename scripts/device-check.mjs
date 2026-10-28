/**
 * Verificação de dispositivo: monta uma animação e exporta vídeo dentro do
 * WebView do app, via CDP.
 *
 * Requer: adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 * Uso:    node scripts/device-check.mjs
 */
const EXPRESSION = `(async () => {
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);

  try {
    for (let i = 0; i < 120; i++) {
      const ok = window.map?.getLayer?.('states-fill') && /cidades/.test(q('#search-status')?.textContent || '');
      if (ok) break;
      await wait(300);
    }
    out.viewport = { w: innerWidth, h: innerHeight, dpr: devicePixelRatio };
    out.busca = q('#search-status')?.textContent || '';
    out.caps = {
      mediaRecorder: typeof MediaRecorder !== 'undefined',
      captureStream: typeof HTMLCanvasElement.prototype.captureStream === 'function',
      vp9: typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/webm;codecs=vp9'),
    };

    // limpa o projeto para um teste determinístico
    q('#btn-clear-countries').click();
    await wait(300);

    // keyframe 1: mundo
    const first = () => q('#kf-list li .icon-btn');
    window.map.jumpTo({ center: [12, 22], zoom: 1.5, pitch: 0, bearing: 0 });
    await wait(400);
    first().click();
    await wait(200);
    q('#btn-update-kf').click();
    await wait(200);

    // keyframe 2: Brasil inclinado
    window.map.jumpTo({ center: [-49, -12], zoom: 4.1, pitch: 45, bearing: 18 });
    await wait(500);
    q('#btn-add-kf').click();
    await wait(400);

    const durs = document.querySelectorAll('#kf-list .kf-dur');
    const last = durs[durs.length - 1];
    last.value = '4';
    last.dispatchEvent(new Event('change', { bubbles: true }));

    // país + estado + cidade pela busca
    const type = async (t) => {
      const el = q('#place-search');
      el.value = t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(350);
    };
    await type('brasil');
    q('#search-results .result-main').click();
    await wait(300);
    await type('pará');
    q('#search-results .result-main').click();
    await wait(300);
    await type('belém');
    q('#search-results .result-main').click();
    await wait(1800);

    // texto
    const setText = (sel, v) => { const el = q(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    setText('#txt-heading', 'Brasil');
    setText('#txt-sub', 'do litoral ao interior');

    out.kf = document.querySelectorAll('#kf-list li').length;
    out.duration = q('#ex-duration').textContent;
    out.selecionados = [...document.querySelectorAll('#selected-all li .name')].map((n) => n.textContent);

    // playback
    q('#btn-play').click();
    await wait(1800);
    const c = window.map.getCenter();
    out.cameraMeio = { lng: +c.lng.toFixed(1), lat: +c.lat.toFixed(1), zoom: +window.map.getZoom().toFixed(2), pitch: +window.map.getPitch().toFixed(0) };
    await wait(3000);

    // exportação
    q('#ex-res').value = '1280x720';
    q('#ex-res').dispatchEvent(new Event('change', { bubbles: true }));
    q('#ex-fps').value = '24';
    q('#ex-fps').dispatchEvent(new Event('change', { bubbles: true }));

    const t0 = Date.now();
    q('#btn-render').click();
    let status = '';
    while (Date.now() - t0 < 60000) {
      await wait(500);
      status = q('#render-status').textContent;
      if (/Pronto|Erro/.test(status)) break;
    }
    out.exportStatus = status;
    out.exportSegundos = +((Date.now() - t0) / 1000).toFixed(1);
  } catch (err) {
    out.error = String((err && err.stack) || err);
  }
  return out;
})()`;

const res = await fetch("http://127.0.0.1:9222/json");
const targets = await res.json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("Nenhuma página no CDP. O app está aberto?");

const ws = new WebSocket(page.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout no CDP")), 180000);
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
