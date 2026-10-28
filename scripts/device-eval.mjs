/**
 * Executa uma expressão dentro do WebView do app (depuração).
 * Uso: node scripts/device-eval.mjs "window.map.getZoom()"
 */
const expression = process.argv[2];
if (!expression) {
  console.error('Uso: node scripts/device-eval.mjs "<expressao>"');
  process.exit(1);
}

const res = await fetch("http://127.0.0.1:9222/json");
const targets = await res.json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("Nenhuma página no CDP. O app está aberto?");

const ws = new WebSocket(page.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout no CDP")), 60000);
  ws.onopen = () => ws.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression, awaitPromise: true, returnByValue: true },
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
