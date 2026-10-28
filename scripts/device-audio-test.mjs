/**
 * Teste no aparelho: áudio na prévia + exportação com faixa de áudio.
 * Requer: adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 * Uso:    node scripts/device-audio-test.mjs
 */
const EXPRESSION = `(async () => {
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const set = (sel, value, ev = 'input') => {
    const el = q(sel);
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event(ev, { bubbles: true }));
  };

  try {
    for (let i = 0; i < 120; i++) {
      const ok = window.map?.getLayer?.('states-fill') && /cidades/.test(q('#search-status')?.textContent || '');
      if (ok) break;
      await wait(300);
    }
    out.busca = q('#search-status')?.textContent || '';
    out.mimeOpus = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus');

    // projeto com 2 keyframes
    click(q('#btn-clear-countries'));
    await wait(300);
    window.map.jumpTo({ center: [12, 22], zoom: 1.6, pitch: 0, bearing: 0 });
    await wait(400);
    click(q('#kf-list li .icon-btn'));
    await wait(200);
    click(q('#btn-update-kf'));
    await wait(200);
    window.map.jumpTo({ center: [-48, -12], zoom: 5, pitch: 40, bearing: 15 });
    await wait(500);
    click(q('#btn-add-kf'));
    await wait(400);
    const durs = document.querySelectorAll('#kf-list .kf-dur');
    const last = durs[durs.length - 1];
    last.value = '3';
    last.dispatchEvent(new Event('change', { bubbles: true }));

    // áudio: trilha ambiente + 2 efeitos
    set('#au-source', 'ambient', 'change');
    set('#au-music', '55');
    set('#au-sfx', '90');
    await wait(500);

    set('#au-time', '0');
    click(document.querySelectorAll('#au-sfx-grid .sfx-btn')[0]);
    await wait(400);
    set('#au-time', '2');
    click(document.querySelectorAll('#au-sfx-grid .sfx-btn')[5]);
    await wait(500);

    out.ctx = window.audio?.ctx?.state || null;
    out.sfxBuffers = window.audio?.sfx?.size || 0;
    out.ambient = !!window.audio?.ambient;
    out.events = [...document.querySelectorAll('#au-events li')].map((li) => li.textContent);
    out.exAudio = q('#ex-audio')?.textContent;

    // prévia curta para checar agendamento
    click(q('#btn-play'));
    await wait(1200);
    out.audioNodesDuringPlay = window.audio?.nodes?.length ?? -1;
    await wait(2200);

    // exporta com áudio
    let captured = null;
    const origUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { if (b instanceof Blob) captured = b; return origUrl(b); };

    const rates = document.querySelectorAll('#kf-list .kf-dur');
    rates[rates.length - 1].value = '2';
    rates[rates.length - 1].dispatchEvent(new Event('change', { bubbles: true }));

    q('#ex-res').value = '1280x720';
    q('#ex-res').dispatchEvent(new Event('change', { bubbles: true }));
    q('#ex-fps').value = '24';
    q('#ex-fps').dispatchEvent(new Event('change', { bubbles: true }));

    const t0 = Date.now();
    click(q('#btn-render'));
    let status = '';
    while (Date.now() - t0 < 60000) {
      await wait(400);
      status = q('#render-status').textContent;
      if (/Pronto|Erro/.test(status)) break;
    }
    out.exportStatus = status;
    out.exportSeconds = +((Date.now() - t0) / 1000).toFixed(1);

    if (captured) {
      out.blobType = captured.type;
      out.blobMB = +(captured.size / 1048576).toFixed(2);
      const bytes = new Uint8Array(await captured.arrayBuffer());
      out.hasOpusHead = new TextDecoder('latin1').decode(bytes.slice(0, 200000)).includes('OpusHead');
    }
    URL.createObjectURL = origUrl;
    out.audioAfterExport = window.audio?.nodes?.length ?? -1;
  } catch (err) {
    out.error = String((err && err.stack) || err);
  }
  return out;
})()`;

const res = await fetch("http://127.0.0.1:9222/json");
const targets = await res.json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("Nenhuma página no CDP. O app está aberto e em primeiro plano?");

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
