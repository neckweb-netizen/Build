/**
 * Áudio do projeto: efeitos sintetizados (sem arquivos externos), trilha
 * ambiente gerada, narração importada e mistura para a prévia e para a
 * exportação.
 *
 * Os efeitos e a trilha são criados com WebAudio/OfflineAudioContext, então
 * nada é baixado. A narração e os efeitos importados vêm dos arquivos do
 * usuário (IndexedDB) e são decodificados sob demanda.
 */
import { getMedia } from "./media.js";

const SR = 44100;

export const SFX_TYPES = [
  { id: "route", label: "Rota", dur: 1.8 },
  { id: "bomb", label: "Bomba", dur: 1.5 },
  { id: "victory", label: "Vitória", dur: 1.3 },
  { id: "defend", label: "Defesa", dur: 0.95 },
  { id: "whoosh", label: "Whoosh", dur: 0.75 },
  { id: "impact", label: "Impacto", dur: 0.8 },
  { id: "pop", label: "Pop", dur: 0.28 },
  { id: "click", label: "Clique", dur: 0.14 },
  { id: "riser", label: "Riser", dur: 1.6 },
  { id: "chime", label: "Sino", dur: 1.4 },
  { id: "sub", label: "Grave", dur: 1.1 },
];

const SFX_SPEC = Object.fromEntries(SFX_TYPES.map((s) => [s.id, s]));

function noiseBuffer(ctx, dur) {
  const len = Math.max(1, Math.ceil(SR * dur));
  const buf = ctx.createBuffer(1, len, SR);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function envGain(ctx, points) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(0.0001, points[0][1]), points[0][0]);
  for (let i = 1; i < points.length; i++) {
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, points[i][1]), points[i][0]);
  }
  return g;
}

/* ------------------------------------------------------------------ *
 * Receitas dos efeitos
 * ------------------------------------------------------------------ */
const BUILD = {
  /**
   * Bomba: impacto grave no chão, explosão com ruído e estilhaços.
   */
  bomb(ctx, out) {
    // estalo inicial
    const crack = ctx.createBufferSource();
    crack.buffer = noiseBuffer(ctx, 0.12);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1800;
    const crackGain = envGain(ctx, [[0, 0.75], [0.1, 0.0001]]);
    crack.connect(hp).connect(crackGain).connect(out);
    crack.start(0);
    crack.stop(0.14);

    // sopro da explosão
    const air = ctx.createBufferSource();
    air.buffer = noiseBuffer(ctx, 1.5);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 0.8;
    lp.frequency.setValueAtTime(5200, 0);
    lp.frequency.exponentialRampToValueAtTime(320, 1.1);
    const airGain = envGain(ctx, [[0, 0.0001], [0.05, 0.85], [0.55, 0.3], [1.5, 0.0001]]);
    air.connect(lp).connect(airGain).connect(out);
    air.start(0);
    air.stop(1.5);

    // pancada grave
    const thump = ctx.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(120, 0);
    thump.frequency.exponentialRampToValueAtTime(32, 0.55);
    const thumpGain = envGain(ctx, [[0, 0.9], [0.75, 0.0001]]);
    thump.connect(thumpGain).connect(out);
    thump.start(0);
    thump.stop(0.8);

    // estilhaços queimando
    for (let i = 0; i < 5; i++) {
      const t0 = 0.22 + i * 0.16 + Math.random() * 0.06;
      const piece = ctx.createBufferSource();
      piece.buffer = noiseBuffer(ctx, 0.08);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 2600 + Math.random() * 2600;
      const pg = envGain(ctx, [[t0, 0.16], [t0 + 0.07, 0.0001]]);
      piece.connect(bp).connect(pg).connect(out);
      piece.start(t0);
      piece.stop(t0 + 0.09);
    }
  },

  /** Fanfarra curta de vitória. */
  victory(ctx, out) {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      const t0 = i * 0.13;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f;
      const g = envGain(ctx, [[t0, 0.0001], [t0 + 0.03, 0.34], [t0 + 0.5, 0.0001]]);
      osc.connect(g).connect(out);
      osc.start(t0);
      osc.stop(t0 + 0.55);

      const harm = ctx.createOscillator();
      harm.type = "sine";
      harm.frequency.value = f * 2;
      const hg = envGain(ctx, [[t0, 0.0001], [t0 + 0.03, 0.1], [t0 + 0.4, 0.0001]]);
      harm.connect(hg).connect(out);
      harm.start(t0);
      harm.stop(t0 + 0.45);
    });
  },

  /** Defesa: clangor metálico de escudo firme. */
  defend(ctx, out) {
    const metal = ctx.createBufferSource();
    metal.buffer = noiseBuffer(ctx, 0.3);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(3200, 0);
    bp.frequency.exponentialRampToValueAtTime(1400, 0.28);
    bp.Q.value = 3.5;
    const mg = envGain(ctx, [[0, 0.5], [0.3, 0.0001]]);
    metal.connect(bp).connect(mg).connect(out);
    metal.start(0);
    metal.stop(0.32);

    [523.25, 784, 1046.5].forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = f * (1 + i * 0.004);
      const g = envGain(ctx, [[0, 0.16 / (i + 1)], [0.55, 0.0001]]);
      osc.connect(g).connect(out);
      osc.start(0);
      osc.stop(0.6);
    });

    const guard = ctx.createOscillator();
    guard.type = "sine";
    guard.frequency.setValueAtTime(180, 0);
    guard.frequency.exponentialRampToValueAtTime(90, 0.3);
    const gg = envGain(ctx, [[0, 0.3], [0.4, 0.0001]]);
    guard.connect(gg).connect(out);
    guard.start(0);
    guard.stop(0.45);
  },

  /**
   * Percurso de rota: ar suave que abre e fecha, com corpo grave deslizante.
   * Sem transientes secos, para casar com o traço que cresce devagar.
   */
  route(ctx, out) {
    const air = ctx.createBufferSource();
    air.buffer = noiseBuffer(ctx, 1.8);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(380, 0);
    bp.frequency.exponentialRampToValueAtTime(2300, 0.9);
    bp.frequency.exponentialRampToValueAtTime(620, 1.78);
    const airGain = envGain(ctx, [[0, 0.0001], [0.5, 0.58], [1.15, 0.44], [1.8, 0.0001]]);
    air.connect(bp).connect(airGain).connect(out);
    air.start(0);
    air.stop(1.8);

    const body = ctx.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(150, 0);
    body.frequency.exponentialRampToValueAtTime(215, 0.85);
    body.frequency.exponentialRampToValueAtTime(120, 1.75);
    const bodyGain = envGain(ctx, [[0, 0.0001], [0.65, 0.22], [1.75, 0.0001]]);
    body.connect(bodyGain).connect(out);
    body.start(0);
    body.stop(1.8);

    const arrive = ctx.createOscillator();
    arrive.type = "triangle";
    arrive.frequency.setValueAtTime(880, 1.3);
    arrive.frequency.exponentialRampToValueAtTime(1320, 1.74);
    const arriveGain = envGain(ctx, [[1.28, 0.0001], [1.5, 0.07], [1.78, 0.0001]]);
    arrive.connect(arriveGain).connect(out);
    arrive.start(1.28);
    arrive.stop(1.8);
  },

  whoosh(ctx, out) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 0.75);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(280, 0);
    bp.frequency.exponentialRampToValueAtTime(3400, 0.55);
    bp.frequency.exponentialRampToValueAtTime(700, 0.75);
    const g = envGain(ctx, [[0, 0.0001], [0.22, 0.9], [0.75, 0.0001]]);
    src.connect(bp).connect(g).connect(out);
    src.start(0);
    src.stop(0.75);
  },

  impact(ctx, out) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150, 0);
    osc.frequency.exponentialRampToValueAtTime(42, 0.5);
    const g = envGain(ctx, [[0, 0.9], [0.55, 0.0001]]);
    osc.connect(g).connect(out);
    osc.start(0);
    osc.stop(0.65);

    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 0.35);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(1600, 0);
    lp.frequency.exponentialRampToValueAtTime(200, 0.3);
    const ng = envGain(ctx, [[0, 0.5], [0.3, 0.0001]]);
    n.connect(lp).connect(ng).connect(out);
    n.start(0);
    n.stop(0.35);
  },

  pop(ctx, out) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(520, 0);
    osc.frequency.exponentialRampToValueAtTime(1100, 0.07);
    const g = envGain(ctx, [[0, 0.7], [0.26, 0.0001]]);
    osc.connect(g).connect(out);
    osc.start(0);
    osc.stop(0.3);
  },

  click(ctx, out) {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 0.12);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2200;
    const g = envGain(ctx, [[0, 0.6], [0.1, 0.0001]]);
    n.connect(hp).connect(g).connect(out);
    n.start(0);
    n.stop(0.12);
  },

  riser(ctx, out) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(180, 0);
    osc.frequency.exponentialRampToValueAtTime(1800, 1.5);
    const g = envGain(ctx, [[0, 0.02], [1.35, 0.55], [1.6, 0.0001]]);
    osc.connect(g).connect(out);
    osc.start(0);
    osc.stop(1.6);

    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 1.6);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 2;
    bp.frequency.setValueAtTime(400, 0);
    bp.frequency.exponentialRampToValueAtTime(5000, 1.5);
    const ng = envGain(ctx, [[0, 0.0001], [1.4, 0.5], [1.6, 0.0001]]);
    n.connect(bp).connect(ng).connect(out);
    n.start(0);
    n.stop(1.6);
  },

  chime(ctx, out) {
    [880, 1320, 1760].forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      const g = envGain(ctx, [[0, 0.32 / (i + 1)], [1.4, 0.0001]]);
      osc.connect(g).connect(out);
      osc.start(0);
      osc.stop(1.4);
    });
  },

  sub(ctx, out) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(95, 0);
    osc.frequency.exponentialRampToValueAtTime(28, 0.9);
    const g = envGain(ctx, [[0, 0.85], [1.05, 0.0001]]);
    osc.connect(g).connect(out);
    osc.start(0);
    osc.stop(1.1);
  },
};

async function renderSfx(type) {
  const spec = SFX_SPEC[type];
  if (!spec) throw new Error(`Efeito desconhecido: ${type}`);
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * spec.dur), SR);
  BUILD[type](ctx, ctx.destination);
  return ctx.startRendering();
}

/** Trilha ambiente gerada (4 acordes em loop, 12 s). */
async function renderAmbient() {
  const dur = 12;
  const ctx = new OfflineAudioContext(2, SR * dur, SR);
  const chords = [
    [146.83, 174.61, 220.0, 293.66],
    [130.81, 164.81, 196.0, 261.63],
    [116.54, 146.83, 174.61, 233.08],
    [110.0, 130.81, 164.81, 220.0],
  ];
  const seg = dur / chords.length;

  chords.forEach((freqs, i) => {
    const t0 = i * seg;
    freqs.forEach((f, j) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      const amp = 0.075 / (j + 1);
      const g = envGain(ctx, [[t0, 0.0001], [t0 + 0.9, amp], [t0 + seg, 0.0001]]);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + seg + 0.02);
    });
  });

  return ctx.startRendering();
}

/* ------------------------------------------------------------------ *
 * Motor
 * ------------------------------------------------------------------ */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.sfx = new Map();
    this.narration = new Map(); // mediaId -> AudioBuffer
    this.ambient = null;
    this.fileMusic = null;
    this.fileName = "";
    this.nodes = [];
    this.ready = null;
  }

  async ensureCtx() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error("WebAudio não suportado neste navegador.");
      this.ctx = new Ctor();
    }
    if (this.ctx.state === "suspended") {
      // sem gesto do usuário o resume() pode nunca resolver; não travamos a
      // exportação por causa disso (o áudio simplesmente sai em silêncio)
      try {
        await Promise.race([
          this.ctx.resume(),
          new Promise((resolve) => setTimeout(resolve, 900)),
        ]);
      } catch {
        /* sem gesto do usuário */
      }
    }
    return this.ctx;
  }

  /** Prepara os buffers usados (efeitos + trilha). Idempotente. */
  load() {
    if (!this.ready) {
      this.ready = (async () => {
        await this.ensureCtx();
        await Promise.all(SFX_TYPES.map(async (s) => this.sfx.set(s.id, await renderSfx(s.id))));
        this.ambient = await renderAmbient();
      })().catch((err) => {
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  async setMusicFile(file) {
    const ctx = await this.ensureCtx();
    const data = await file.arrayBuffer();
    this.fileMusic = await ctx.decodeAudioData(data);
    this.fileName = file.name;
    return this.fileMusic;
  }

  hasMusic(source) {
    if (source === "ambient") return Boolean(this.ambient);
    if (source === "file") return Boolean(this.fileMusic);
    return false;
  }

  /** Decodifica a narração de cada cena (idempotente por id). */
  async loadNarration(ids = []) {
    const ctx = await this.ensureCtx();
    for (const id of ids) {
      if (!id || this.narration.has(id)) continue;
      try {
        const rec = await getMedia(id);
        if (!rec?.blob) continue;
        this.narration.set(id, await ctx.decodeAudioData(await rec.blob.arrayBuffer()));
      } catch (err) {
        console.warn("Narração inválida:", id, err);
      }
    }
    return this.narration;
  }

  /** Decodifica os efeitos importados pelo usuário (id = mediaId). */
  async loadCustomSfx(imports = []) {
    const ctx = await this.ensureCtx();
    for (const imp of imports) {
      const id = imp?.mediaId;
      if (!id || this.sfx.has(id)) continue;
      try {
        const rec = await getMedia(id);
        if (!rec?.blob) continue;
        this.sfx.set(id, await ctx.decodeAudioData(await rec.blob.arrayBuffer()));
      } catch (err) {
        console.warn("Efeito importado inválido:", id, err);
      }
    }
    return this.sfx;
  }

  hasSfx(id) {
    return this.sfx.has(id);
  }

  /**
   * Agenda trilha + efeitos + narração. `destinations` permite mandar para a
   * prévia (ctx.destination) e/ou para a captura de vídeo.
   *
   * A narração é uma lista de { buffer, time, volume } com tempo absoluto no
   * vídeo. Enquanto ela fala, a trilha é abaixada (ducking), o que mantém a
   * voz inteligível sem precisar mixar à mão.
   */
  schedule({
    events = [],
    narration = [],
    source = "none",
    musicVolume = 0.5,
    narrationVolume = 1,
    sfxVolume = 0.85,
    destinations = [],
    startAt = null,
    duck = true,
    offset = 0,
  }) {
    if (!this.ctx || !destinations.length) return { stop() {} };
    const ctx = this.ctx;
    const t0 = startAt ?? ctx.currentTime + 0.08;
    const created = [];

    const clips = narration
      .filter((c) => c && c.buffer)
      .map((c) => ({
        buffer: c.buffer,
        time: Math.max(0, (Number(c.time) || 0) + offset),
        volume: (Number(c.volume) || 1) * narrationVolume,
      }))
      .sort((a, b) => a.time - b.time);

    for (const dest of destinations) {
      // ---- trilha de fundo ----
      const musicBuffer =
        source === "ambient" ? this.ambient : source === "file" ? this.fileMusic : null;
      let musicGain = null;

      if (musicBuffer) {
        const src = ctx.createBufferSource();
        src.buffer = musicBuffer;
        src.loop = true;
        const g = ctx.createGain();
        g.gain.setValueAtTime(musicVolume, t0);
        src.connect(g).connect(dest);
        src.start(t0);
        created.push(src, g);
        musicGain = g;
      }

      // ---- abaixa a trilha durante a narração ----
      if (musicGain && duck && clips.length) {
        const low = musicVolume * 0.18;
        let cursor = t0;
        for (const clip of clips) {
          const s = t0 + clip.time;
          const e = s + Math.max(0.2, clip.buffer.duration || 0);
          const down = Math.max(cursor, s - 0.12);
          const up = e + 0.35;
          if (down >= up) continue; // narrações coladas: segue abaixado
          try {
            musicGain.gain.setValueAtTime(musicVolume, cursor);
            musicGain.gain.linearRampToValueAtTime(low, down);
            musicGain.gain.setValueAtTime(low, e);
            musicGain.gain.linearRampToValueAtTime(musicVolume, up);
          } catch {
            /* rampas fora de ordem: ignora este trecho */
          }
          cursor = up;
        }
      }

      // ---- narração ----
      for (const clip of clips) {
        const src = ctx.createBufferSource();
        src.buffer = clip.buffer;
        const g = ctx.createGain();
        g.gain.value = clip.volume;
        src.connect(g).connect(dest);
        src.start(t0 + clip.time);
        created.push(src, g);
      }

      // ---- efeitos ----
      for (const ev of events) {
        const buf = this.sfx.get(ev.type);
        if (!buf) continue;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        // rate ajusta a duração do efeito ao tempo do traço (rotas)
        const rate = Math.max(0.4, Math.min(3, Number(ev.rate) || 1));
        if (rate !== 1) src.playbackRate.value = rate;
        const g = ctx.createGain();
        g.gain.value = (Number(ev.volume) || 1) * sfxVolume;
        src.connect(g).connect(dest);
        src.start(t0 + Math.max(0, Number(ev.time) || 0));
        created.push(src, g);
      }
    }

    this.nodes = created;
    return {
      start: t0,
      stop: () => {
        for (const node of created) {
          try { node.stop ? node.stop() : node.disconnect(); } catch { /* já parado */ }
        }
        this.nodes = [];
      },
    };
  }

  stopAll() {
    for (const node of this.nodes) {
      try { node.stop ? node.stop() : node.disconnect(); } catch { /* ignore */ }
    }
    this.nodes = [];
  }

  /** Destino de gravação para a exportação. */
  createRecordingDest() {
    if (!this.ctx) return null;
    return this.ctx.createMediaStreamDestination();
  }
}

/** Nome legível de um efeito. */
export function sfxLabel(type) {
  return SFX_SPEC[type]?.label || type;
}
