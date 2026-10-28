const EXPRESSION = `(async () => {
  const out = { caps: {
    DecompressionStream: typeof DecompressionStream,
    BlobStream: typeof Blob.prototype.stream,
    TextDecoder: typeof TextDecoder,
    fetch: typeof fetch,
  } };
  try {
    const res = await fetch('data/cities.json.gz');
    out.status = res.status;
    out.type = res.headers.get('content-type');
    out.encoding = res.headers.get('content-encoding');
    out.len = res.headers.get('content-length');
    const buf = new Uint8Array(await res.arrayBuffer());
    out.bytes = buf.length;
    out.magic = [buf[0], buf[1]];
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      if (typeof DecompressionStream === 'function') {
        try {
          const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
          const text = await new Response(stream).text();
          out.decompressedLen = text.length;
          out.parse = JSON.parse(text).length;
        } catch (e) { out.decompressError = String(e); }
      } else {
        out.decompressError = 'sem DecompressionStream';
      }
    } else {
      out.textLen = new TextDecoder().decode(buf).length;
    }
  } catch (e) {
    out.fetchError = String(e);
  }
  return out;
})()`;

const res = await fetch("http://127.0.0.1:9222/json");
const targets = await res.json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout")), 90000);
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: EXPRESSION, awaitPromise: true, returnByValue: true } }));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== 1) return;
    clearTimeout(timer); ws.close();
    if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 600)));
    else resolve(msg.result?.result?.value);
  };
  ws.onerror = (e) => { clearTimeout(timer); reject(new Error("ws: " + e.message)); };
});
console.log(JSON.stringify(result, null, 2));
