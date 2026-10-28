/**
 * Desenho vetorial sobre o mapa: bandeira preenchendo o território, regiões
 * livres, rotas com seta e distância, e alfinetes com etiqueta.
 *
 * Tudo é desenhado em coordenadas de tela (o mapa projeta lng/lat) para que a
 * prévia e a exportação usem exatamente o mesmo código — a diferença é só o
 * fator de escala (`view.scale`). Nada aqui depende do DOM ou do MapLibre.
 */

const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/* ------------------------------------------------------------------ *
 * Geografia
 * ------------------------------------------------------------------ */

export function haversineKm(a, b) {
  const R = 6371.0088;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Formata distância em km no padrão brasileiro. */
export function formatKm(km) {
  const n = Math.round(km);
  return `${n.toLocaleString("pt-BR")} km`;
}

/** Mercator normalizado (0..1), suficiente para curvas estáveis. */
function mercator([lng, lat]) {
  const x = (lng + 180) / 360;
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return { x, y };
}

function unmercator({ x, y }) {
  const lng = x * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lng, lat];
}

/**
 * Pontos do arco entre dois lugares. `curve` em -1..1: positivo dobra para um
 * lado, negativo para o outro, 0 é reta.
 */
export function arcPoints(from, to, curve = 0.25, steps = 64) {
  const a = mercator(from);
  const b = mercator(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1e-9;
  // perpendicular ao segmento, deslocada do meio
  const cx = (a.x + b.x) / 2 + (-dy / len) * (len * curve);
  const cy = (a.y + b.y) / 2 + (dx / len) * (len * curve);

  const out = [];
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const u = (1 - s) * (1 - s);
    const v = 2 * (1 - s) * s;
    const w = s * s;
    out.push(unmercator({ x: u * a.x + v * cx + w * b.x, y: u * a.y + v * cy + w * b.y }));
  }
  return out;
}

/**
 * Garante que os anéis não cruzem o antimeridiano "por dentro": desloca as
 * longitudes em 360° até ficarem contíguas e perto do centro do mapa.
 */
function unwrapRing(ring, refLng) {
  if (!ring.length) return ring;
  const out = [];
  let prev = null;
  for (const [lng, lat] of ring) {
    let L = lng;
    if (prev === null) {
      while (L - refLng > 180) L -= 360;
      while (L - refLng < -180) L += 360;
    } else {
      while (L - prev > 180) L -= 360;
      while (L - prev < -180) L += 360;
    }
    prev = L;
    out.push([L, lat]);
  }
  return out;
}

function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

/**
 * Projeta a geometria e devolve o caminho no canvas.
 * @returns {{path: Path2D, bounds: {x0:number,y0:number,x1:number,y1:number}, polys: Array}}
 */
function projectGeometry(view, geometry) {
  const path = new Path2D();
  const polys = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

  for (const poly of polygonsOf(geometry)) {
    const p = new Path2D();
    let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;

    for (const ring of poly) {
      const pts = unwrapRing(ring, view.centerLng ?? 0);
      for (let i = 0; i < pts.length; i++) {
        const [x, y] = view.project(pts[i]);
        if (i === 0) p.moveTo(x, y);
        else p.lineTo(x, y);
        if (x < px0) px0 = x;
        if (y < py0) py0 = y;
        if (x > px1) px1 = x;
        if (y > py1) py1 = y;
      }
      p.closePath();
      path.addPath(p);
    }

    if (Number.isFinite(px0)) {
      polys.push({ path: p, x0: px0, y0: py0, x1: px1, y1: py1 });
      x0 = Math.min(x0, px0);
      y0 = Math.min(y0, py0);
      x1 = Math.max(x1, px1);
      y1 = Math.max(y1, py1);
    }
  }

  return { path, bounds: { x0, y0, x1, y1 }, polys };
}

/** Desenha a imagem cobrindo a caixa, sem distorcer a proporção. */
function coverImage(ctx, img, x0, y0, x1, y1) {
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const ir = (img.naturalWidth || img.width) / (img.naturalHeight || img.height);
  const br = w / h;
  let dw = w, dh = h, dx = x0, dy = y0;
  if (ir > br) {
    dh = h;
    dw = h * ir;
    dx = x0 - (dw - w) / 2;
  } else {
    dw = w;
    dh = w / ir;
    dy = y0 - (dh - h) / 2;
  }
  ctx.drawImage(img, dx, dy, dw, dh);
}

/* ------------------------------------------------------------------ *
 * Peças
 * ------------------------------------------------------------------ */

/** Bandeira dentro do território (recortada pela forma do país). */
function drawFlagFill(ctx, view, item, alpha) {
  const { geometry, image } = item;
  if (!geometry) return;
  if (!image) {
    drawSolidFill(ctx, view, { ...item, fill: "solid" }, alpha);
    return;
  }
  const geo = projectGeometry(view, geometry);
  const b = geo.bounds;
  if (!Number.isFinite(b.x0)) return;

  const wide = b.x1 - b.x0 > view.width * 2.2;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.clip(geo.path);

  if (wide) {
    // país espalhado (ilhas, territórios): uma bandeira por polígono
    for (const p of geo.polys) {
      ctx.save();
      ctx.clip(p.path);
      coverImage(ctx, image, p.x0, p.y0, p.x1, p.y1);
      ctx.restore();
    }
  } else {
    coverImage(ctx, image, b.x0, b.y0, b.x1, b.y1);
  }
  ctx.restore();
}

/** Preenchimento liso (cor do lugar, sem depender do MapLibre). */
function drawSolidFill(ctx, view, item, alpha) {
  const geo = projectGeometry(view, item.geometry);
  if (!Number.isFinite(geo.bounds.x0)) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = item.color || "#e0a83c";
  ctx.fill(geo.path);
  ctx.restore();
}

/** Listras diagonais e degradê, para quem não quer bandeira. */
function drawPatternFill(ctx, view, item, alpha) {
  const geo = projectGeometry(view, item.geometry);
  const b = geo.bounds;
  if (!Number.isFinite(b.x0)) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.clip(geo.path);

  if (item.fill === "stripes") {
    ctx.fillStyle = item.color || "#e0a83c";
    ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    ctx.fillStyle = "rgba(255,255,255,.42)";
    const step = Math.max(10, (b.x1 - b.x0) / 9);
    for (let x = b.x0 - (b.y1 - b.y0); x < b.x1; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, b.y1);
      ctx.lineTo(x + (b.y1 - b.y0), b.y0);
      ctx.lineTo(x + (b.y1 - b.y0) + step * 0.45, b.y0);
      ctx.lineTo(x + step * 0.45, b.y1);
      ctx.closePath();
      ctx.fill();
    }
  } else {
    const g = ctx.createLinearGradient(b.x0, b.y0, b.x1, b.y1);
    g.addColorStop(0, item.color || "#e0a83c");
    g.addColorStop(1, item.color2 || "rgba(255,255,255,.15)");
    ctx.fillStyle = g;
    ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  }
  ctx.restore();
}

/** Contorno do território com brilho e pulso opcionais. */
function drawOutline(ctx, view, item, t, alpha) {
  const geo = projectGeometry(view, item.geometry);
  if (!Number.isFinite(geo.bounds.x0)) return;

  const scale = view.scale || 1;
  const pulse = item.pulse ? 0.5 + 0.5 * Math.sin((t || 0) * Math.PI * 2 * (item.pulseSpeed || 0.5)) : 1;
  const width = Math.max(0.6, (item.borderWidth ?? 2) * scale);
  const color = item.borderColor || "#ffffff";

  ctx.save();
  ctx.globalAlpha = alpha * (item.pulse ? 0.45 + 0.55 * pulse : 1);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (item.glow) {
    ctx.shadowColor = item.glowColor || color;
    ctx.shadowBlur = (item.glowBlur ?? 16) * scale * (item.pulse ? 0.6 + 0.9 * pulse : 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke(geo.path);
    ctx.stroke(geo.path);
  }

  ctx.shadowBlur = 0;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke(geo.path);
  ctx.restore();
}

/** Região livre desenhada pelo usuário. */
function drawRegion(ctx, view, region, t, alpha) {
  if (!region.coords || region.coords.length < 2) return;
  const geometry = { type: "Polygon", coordinates: [region.coords] };
  const geo = projectGeometry(view, geometry);
  if (!Number.isFinite(geo.bounds.x0)) return;

  const scale = view.scale || 1;
  const op = (region.opacity == null ? 0.55 : region.opacity) * alpha;

  ctx.save();
  if (region.color) {
    ctx.globalAlpha = region.draft ? op * 0.4 : op;
    ctx.fillStyle = region.color;
    ctx.fill(geo.path);
  }

  if (region.borderWidth !== 0) {
    ctx.globalAlpha = alpha;
    ctx.lineJoin = "round";
    if (region.draft) ctx.setLineDash([7 * scale, 5 * scale]);
    if (region.glow) {
      ctx.shadowColor = region.borderColor || "#ffffff";
      ctx.shadowBlur = 14 * scale;
    }
    ctx.strokeStyle = region.borderColor || "#ffffff";
    ctx.lineWidth = Math.max(0.5, (region.borderWidth ?? 2) * scale);
    ctx.stroke(geo.path);
  }
  ctx.restore();

  if (region.label) {
    const c = ctx.canvas;
    const cx = (geo.bounds.x0 + geo.bounds.x1) / 2;
    const cy = (geo.bounds.y0 + geo.bounds.y1) / 2;
    drawChip(ctx, {
      x: cx,
      y: cy,
      text: region.label,
      color: region.labelColor || "#ffffff",
      size: (region.labelSize ?? 26) * scale,
      style: region.labelStyle || "plain",
      alpha,
      canvasW: c.width,
    });
  }
}

/** Suaviza o crescimento do traço: lento no começo, rápido no meio, lento no fim. */
function easeInOutSine(p) {
  const x = Math.min(1, Math.max(0, p));
  return 0.5 - Math.cos(Math.PI * x) / 2;
}

/** Comprimento acumulado de uma polilinha em coordenadas de tela. */
function polylineLengths(pts) {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    acc.push(acc[i - 1] + Math.hypot(dx, dy));
  }
  return acc;
}

/**
 * Recorta a polilinha no comprimento `len` (em pixels de tela), interpolando a
 * ponta. Sem isso o traço cresce aos saltos de um ponto para o outro.
 */
function clipPolyline(pts, acc, len) {
  const total = acc[acc.length - 1] || 0;
  const limit = Math.max(0, Math.min(len, total));
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (acc[i] <= limit) {
      out.push(pts[i]);
      continue;
    }
    const seg = acc[i] - acc[i - 1];
    const f = seg > 0 ? (limit - acc[i - 1]) / seg : 0;
    out.push([
      pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
      pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f,
    ]);
    break;
  }
  const tip = out[out.length - 1];
  const prev = out.length > 1 ? out[out.length - 2] : tip;
  return { points: out, tip, angle: Math.atan2(tip[1] - prev[1], tip[0] - prev[0]) };
}

/** Rota: curva feita à mão, traço que cresce suave, seta e etiqueta de km. */
function drawRoute(ctx, view, route, t, alpha) {
  if (!route.from || !route.to) return;
  const scale = view.scale || 1;
  const pts = arcPoints(route.from, route.to, route.curve ?? 0.25, Math.max(48, route.steps || 180));
  const raw = Math.max(0, Math.min(1, route.progress ?? 1));
  if (raw <= 0.001) return;

  const progress = raw >= 0.999 ? 1 : easeInOutSine(raw);
  const screen = pts.map((p) => view.project(p));
  const acc = polylineLengths(screen);
  const draw = clipPolyline(screen, acc, acc[acc.length - 1] * progress);
  if (draw.points.length < 2) return;

  const width = Math.max(0.7, (route.width ?? 3.2) * scale);
  const color = route.color || "#ffffff";

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // halo escuro por baixo, para a linha aparecer sobre o satélite
  ctx.strokeStyle = "rgba(0,0,0,.35)";
  ctx.lineWidth = width * 2.1;
  tracePath(ctx, draw.points);
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (route.glow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 12 * scale;
  }
  tracePath(ctx, draw.points);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // ponta luminosa enquanto o traço cresce (dá a sensação de percurso)
  if (progress < 0.999) {
    const [tx, ty] = draw.tip;
    const r = Math.max(2, width * 0.95);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 16 * scale;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(tx, ty, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = alpha * 0.3;
    ctx.beginPath();
    ctx.arc(tx, ty, r * 2.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha;
  }

  // seta na ponta, já com o traço completo
  if (route.arrow !== false && progress > 0.995 && draw.points.length >= 2) {
    const tip = draw.tip;
    const prev = draw.points[Math.max(0, draw.points.length - 3)];
    const ang = Math.atan2(tip[1] - prev[1], tip[0] - prev[0]);
    const aw = Math.max(5, 11 * scale);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tip[0], tip[1]);
    ctx.lineTo(tip[0] - Math.cos(ang - 0.42) * aw * 1.5, tip[1] - Math.sin(ang - 0.42) * aw * 1.5);
    ctx.lineTo(tip[0] - Math.cos(ang + 0.42) * aw * 1.5, tip[1] - Math.sin(ang + 0.42) * aw * 1.5);
    ctx.closePath();
    ctx.fill();
  }

  // etiqueta de distância no meio do arco, aparecendo depois do traço passar
  if (route.label !== false) {
    const appear = Math.min(1, Math.max(0, (progress - 0.45) / 0.3));
    if (appear > 0.01) {
      const idx = Math.min(
        screen.length - 1,
        Math.max(0, Math.floor(screen.length * (route.labelAt ?? 0.5))),
      );
      const mid = screen[idx] || screen[screen.length - 1];
      const text = route.labelText || formatKm(route.km || 0);
      const size = (route.labelSize ?? 15) * scale;
      drawChip(ctx, {
        x: mid[0],
        y: mid[1] - size * 0.9,
        text,
        color: route.labelColor || "#ffffff",
        size,
        style: "plain",
        alpha: alpha * appear,
        canvasW: ctx.canvas.width,
      });
    }
  }

  ctx.restore();
}

function tracePath(ctx, screen) {
  ctx.beginPath();
  for (let i = 0; i < screen.length; i++) {
    const [x, y] = screen[i];
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
}

/**
 * Texto com halo (estilo mapa) ou em pílula escura.
 * `canvasW` serve só para não deixar o texto sair da tela.
 */
export function drawChip(ctx, { x, y, text, color = "#fff", size = 14, style = "plain", alpha = 1, canvasW = 0 }) {
  if (!text) return;
  const label = String(text);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `700 ${size}px ${FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const maxW = canvasW ? canvasW * 0.9 : Infinity;
  let w = ctx.measureText(label).width;
  let text2 = label;
  if (w > maxW) {
    while (text2.length > 4 && w > maxW) {
      text2 = text2.slice(0, -2);
      w = ctx.measureText(text2 + "…").width;
    }
    text2 += "…";
  }

  if (style === "pill") {
    const padX = size * 0.55;
    const padY = size * 0.34;
    const bw = w + padX * 2;
    const bh = size + padY * 2;
    const r = bh / 2;
    ctx.beginPath();
    ctx.moveTo(x - bw / 2 + r, y - bh / 2);
    ctx.arcTo(x + bw / 2, y - bh / 2, x + bw / 2, y + bh / 2, r);
    ctx.arcTo(x + bw / 2, y + bh / 2, x - bw / 2, y + bh / 2, r);
    ctx.arcTo(x - bw / 2, y + bh / 2, x - bw / 2, y - bh / 2, r);
    ctx.arcTo(x - bw / 2, y - bh / 2, x + bw / 2, y - bh / 2, r);
    ctx.closePath();
    ctx.fillStyle = "rgba(9,11,16,.72)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.22)";
    ctx.lineWidth = Math.max(0.6, size * 0.05);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(text2, x, y + size * 0.02);
  } else {
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0,0,0,.72)";
    ctx.lineWidth = Math.max(2, size * 0.34);
    ctx.strokeText(text2, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text2, x, y);
  }
  ctx.restore();
}

/** Alfinete de cidade: ponto + etiqueta. */
function drawPin(ctx, view, pin, t, alpha) {
  const [x, y] = view.project([pin.lon, pin.lat]);
  const scale = view.scale || 1;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  // fora da tela: evita desenhar à toa
  if (x < -80 * scale || y < -80 * scale || x > view.width + 80 * scale || y > view.height + 80 * scale) {
    return;
  }

  const r = Math.max(3.2, (pin.size ?? 5) * scale);
  const color = pin.color || "#e0a83c";

  ctx.save();
  ctx.globalAlpha = alpha;

  // pulso suave (opcional)
  if (pin.pulse) {
    const k = (Math.sin((t || 0) * Math.PI * 2 * 0.7) + 1) / 2;
    ctx.beginPath();
    ctx.arc(x, y, r * (1.8 + k * 1.6), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha * (0.26 - k * 0.18);
    ctx.fill();
    ctx.globalAlpha = alpha;
  }

  ctx.beginPath();
  ctx.arc(x, y, r + Math.max(1.4, 1.8 * scale), 0, Math.PI * 2);
  ctx.fillStyle = "rgba(8,10,14,.55)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.6 * scale);
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();

  if (pin.name && pin.showLabel !== false) {
    const size = (pin.labelSize ?? 12.5) * scale;
    const style = pin.labelStyle || "plain";
    const below = pin.labelBelow !== false;
    drawChip(ctx, {
      x,
      y: below ? y + r + size * 1.05 : y - r - size * 1.05,
      text: pin.name,
      color: pin.labelColor || "#ffffff",
      size,
      style,
      alpha,
      canvasW: ctx.canvas.width,
    });
  }

  ctx.restore();
}

/** Nome solto sobre o mapa (país/estado), sem ponto. */
function drawLabel(ctx, view, label, alpha) {
  const [x, y] = view.project([label.lon, label.lat]);
  const scale = view.scale || 1;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (x < -120 * scale || y < -60 * scale || x > view.width + 120 * scale || y > view.height + 60 * scale) {
    return;
  }
  drawChip(ctx, {
    x,
    y,
    text: label.text,
    color: label.color || "#ffffff",
    size: (label.size ?? 30) * scale,
    style: label.style || "plain",
    alpha,
    canvasW: ctx.canvas.width,
  });
}

/** Vértice do desenho de região em andamento. */
function drawMark(ctx, view, mark) {
  const [x, y] = view.project([mark.lon, mark.lat]);
  const scale = view.scale || 1;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const r = 3.4 * scale;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r + 2 * scale, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(8,10,14,.65)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Passe único
 * ------------------------------------------------------------------ */

/**
 * Conflito territorial: a bomba cai do atacante sobre o alvo, explode e o
 * resultado aparece (conquista, resistência ou empate).
 */
function drawBattle(ctx, view, battle) {
  const a = battle.atk;
  const d = battle.def;
  if (!a || !d) return;
  if (!Number.isFinite(a.lon) || !Number.isFinite(d.lon)) return;

  const scale = view.scale || 1;
  const [ax, ay] = view.project([a.lon, a.lat]);
  const [dx, dy] = view.project([d.lon, d.lat]);
  if (!Number.isFinite(ax) || !Number.isFinite(dx)) return;

  const p = Math.max(0, Math.min(1, battle.p ?? 1));
  const impact = 0.55;
  const dist = Math.hypot(dx - ax, dy - ay);
  const color = battle.result === "win" ? "#ff6b6b" : battle.result === "hold" ? "#5bc8ff" : "#ffd166";

  ctx.save();

  // linha de invasão enquanto a bomba voa
  if (battle.bomb && p < impact && dist > 8) {
    const f = easeInOutSine(Math.max(0, p / impact));
    const bx = ax + (dx - ax) * f;
    const by = ay + (dy - ay) * f;
    ctx.setLineDash([9 * scale, 7 * scale]);
    ctx.lineDashOffset = -p * 40 * scale;
    ctx.strokeStyle = "rgba(255,255,255,.5)";
    ctx.lineWidth = Math.max(1, 2.2 * scale);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // bomba em queda (arco)
  if (battle.bomb && p < impact) {
    const f = p / impact;
    const bx = ax + (dx - ax) * f;
    const arc = Math.sin(Math.PI * f) * Math.min(140, dist * 0.3) * scale;
    const by = ay + (dy - ay) * f - arc;
    drawBomb(ctx, bx, by, scale, f);
  }

  // explosão no ponto de impacto
  if (p >= impact) {
    const e = Math.min(1, (p - impact) / (1 - impact));
    const fade = Math.max(0, 1 - e * 1.25);
    if (fade > 0.01) {
      const r = Math.max(18, Math.min(160, dist * 0.22 + 40)) * scale;
      const g = ctx.createRadialGradient(dx, dy, 0, dx, dy, r);
      g.addColorStop(0, `rgba(255,245,210,${0.85 * fade})`);
      g.addColorStop(0.35, `rgba(255,170,60,${0.6 * fade})`);
      g.addColorStop(0.7, `rgba(190,60,30,${0.3 * fade})`);
      g.addColorStop(1, "rgba(40,20,10,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(dx, dy, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(255,220,150,${0.7 * fade})`;
      ctx.lineWidth = Math.max(1, 3 * scale);
      ctx.beginPath();
      ctx.arc(dx, dy, r * (0.35 + e * 0.9), 0, Math.PI * 2);
      ctx.stroke();
    }

    // escudo na resistência, onda de choque no empate
    if (battle.result === "hold") {
      const s = 0.4 + e * 0.9;
      ctx.strokeStyle = `rgba(91,200,255,${Math.max(0, 0.8 - e)})`;
      ctx.lineWidth = Math.max(1.5, 5 * scale);
      ctx.beginPath();
      ctx.arc(dx, dy, 46 * scale * s, 0, Math.PI * 2);
      ctx.stroke();
    } else if (battle.result === "draw") {
      const mx = (ax + dx) / 2;
      const my = (ay + dy) / 2;
      ctx.strokeStyle = `rgba(255,209,102,${Math.max(0, 0.7 - e)})`;
      ctx.lineWidth = Math.max(1.5, 4 * scale);
      ctx.beginPath();
      ctx.arc(mx, my, 30 * scale * (0.4 + e * 1.4), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // faixa com o resultado
  if (battle.banner && battle.banner.alpha > 0.01) {
    const size = (battle.banner.size ?? 26) * scale;
    // a faixa não pode sair da tela quando o alvo está na borda
    ctx.save();
    ctx.font = `700 ${size}px ${FONT_STACK}`;
    const textW = Math.min(ctx.measureText(battle.banner.text).width, view.width * 0.9);
    ctx.restore();
    const half = textW / 2 + size * 0.55 + 6 * scale;
    const padX = Math.min(half, view.width / 2);
    const y = Math.max(size * 1.6, dy - 54 * scale);
    drawChip(ctx, {
      x: Math.max(padX, Math.min(dx, view.width - padX)),
      y,
      text: battle.banner.text,
      color: color,
      size,
      style: "pill",
      alpha: battle.banner.alpha,
      canvasW: view.width,
    });
  }

  ctx.restore();
}

/** Pequena bomba escura com pavio aceso. */
function drawBomb(ctx, x, y, scale, f) {
  const r = Math.max(3.5, 8 * scale);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(f * 3.2);

  // pavio
  ctx.strokeStyle = "#c9a06a";
  ctx.lineWidth = Math.max(1, 1.8 * scale);
  ctx.beginPath();
  ctx.moveTo(r * 0.5, -r * 0.7);
  ctx.quadraticCurveTo(r * 1.3, -r * 1.4, r * 0.9, -r * 1.9);
  ctx.stroke();

  // faísca
  const spark = 2.6 * scale + Math.sin(f * 40) * 0.9 * scale;
  ctx.fillStyle = "#ffd166";
  ctx.shadowColor = "#ff9f1c";
  ctx.shadowBlur = 10 * scale;
  ctx.beginPath();
  ctx.arc(r * 0.9, -r * 1.9, Math.max(1, spark), 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // corpo
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.1, 0, 0, r);
  g.addColorStop(0, "#6b7280");
  g.addColorStop(0.5, "#26292f");
  g.addColorStop(1, "#0b0c0f");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Desenha o modelo inteiro.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{project:(lngLat:number[])=>number[], width:number, height:number, scale?:number, centerLng?:number}} view
 * @param {{regions?:Array, fills?:Array, outlines?:Array, routes?:Array, labels?:Array, pins?:Array, marks?:Array, battles?:Array}} model
 * @param {number} t instante (s) para pulso/animação
 */
export function drawGraphics(ctx, view, model, t = 0) {
  if (!model) return;
  for (const region of model.regions || []) drawRegion(ctx, view, region, t, region.alpha ?? 1);
  for (const item of model.fills || []) {
    const alpha = item.alpha ?? 1;
    if (item.fill === "flag") drawFlagFill(ctx, view, item, alpha);
    else if (item.fill === "solid") drawSolidFill(ctx, view, item, alpha);
    else drawPatternFill(ctx, view, item, alpha);
  }
  for (const item of model.outlines || []) drawOutline(ctx, view, item, t, item.alpha ?? 1);
  for (const route of model.routes || []) drawRoute(ctx, view, route, t, route.alpha ?? 1);
  for (const battle of model.battles || []) drawBattle(ctx, view, battle);
  for (const label of model.labels || []) drawLabel(ctx, view, label, label.alpha ?? 1);
  for (const pin of model.pins || []) drawPin(ctx, view, pin, t, pin.alpha ?? 1);
  for (const mark of model.marks || []) drawMark(ctx, view, mark);
}
