import {
  TUNINGS, stringsFor, midiToFreq, cents, freqToNote, nearestString, rms,
  detectPitchMPM, analyzeVibration,
} from './pitch.mjs';

const $ = (id) => document.getElementById(id);
const els = {
  hint: $('hint'), display: $('display'), ticks: $('ticks'), needle: $('needle'),
  note: $('note'), octave: $('octave'), cents: $('cents'), freq: $('freq'),
  strings: $('strings'), toggle: $('toggle'), a4: $('a4'), status: $('status'), tuning: $('tuning'),
};

const HINTS = {
  mic: 'Toque uma corda perto do microfone. Também funciona com o celular apoiado no corpo da guitarra: o microfone capta a vibração da madeira.',
  vib: 'Apoie o celular deitado sobre o corpo da guitarra, escolha a corda e toque-a. Modo experimental: usa o acelerômetro e depende do sensor do aparelho.',
};

const state = {
  mode: 'mic',          // 'mic' | 'vib'
  running: false,
  a4: 440,
  tuning: TUNINGS[0],
  strings: stringsFor(TUNINGS[0]),
  string: 'auto',       // 'auto' | string id
  shownCents: 0,        // posição suavizada do ponteiro
  targetCents: 0,
  lastReadingAt: 0,
};

// ----------------------------------------------------------------- Gauge
function buildTicks() {
  const frag = document.createDocumentFragment();
  for (let c = -50; c <= 50; c += 10) {
    const a = ((c / 50) * 45 - 90) * (Math.PI / 180);
    const major = c % 50 === 0 || c === 0;
    const r1 = 86, r2 = major ? 74 : 78;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', 100 + r1 * Math.cos(a)); line.setAttribute('y1', 100 + r1 * Math.sin(a));
    line.setAttribute('x2', 100 + r2 * Math.cos(a)); line.setAttribute('y2', 100 + r2 * Math.sin(a));
    if (major) line.classList.add('major');
    frag.appendChild(line);
    if (major) {
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', 100 + 66 * Math.cos(a)); t.setAttribute('y', 100 + 66 * Math.sin(a) + 2.5);
      t.textContent = c === 0 ? '0' : (c > 0 ? '+' : '') + c;
      frag.appendChild(t);
    }
  }
  els.ticks.appendChild(frag);
}

function animateNeedle() {
  const target = Math.max(-50, Math.min(50, state.targetCents));
  state.shownCents += (target - state.shownCents) * 0.18;
  els.needle.setAttribute('transform', `rotate(${(state.shownCents / 50) * 45} 100 100)`);
  requestAnimationFrame(animateNeedle);
}

// ----------------------------------------------------------------- Strings UI
function buildStrings() {
  els.strings.innerHTML = '';
  const manualOnly = state.mode === 'vib';
  els.strings.dataset.manualOnly = manualOnly;
  if (!state.strings.some((s) => s.id === state.string) && state.string !== 'auto') state.string = 'auto';
  if (manualOnly && state.string === 'auto') state.string = state.strings[0].id;
  if (!manualOnly) els.strings.appendChild(stringButton('auto', 'Auto', ''));
  for (const s of state.strings) els.strings.appendChild(stringButton(s.id, s.note, s.label));
  updateStringSelection();
}

function stringButton(id, main, sub) {
  const b = document.createElement('button');
  b.dataset.id = id;
  b.innerHTML = `${main}<small>${sub || '&nbsp;'}</small>`;
  b.addEventListener('click', () => { state.string = id; updateStringSelection(); });
  return b;
}

function updateStringSelection(detectedId) {
  for (const b of els.strings.querySelectorAll('button')) {
    b.classList.toggle('selected', b.dataset.id === state.string);
    b.classList.toggle('detected', state.string === 'auto' && b.dataset.id === detectedId);
  }
}

// ----------------------------------------------------------------- Readout
function showReading({ freq, cents: c, note, octave, stringId }) {
  state.targetCents = c;
  state.lastReadingAt = performance.now();
  els.note.textContent = note;
  els.octave.textContent = octave ?? '';
  const abs = Math.abs(c);
  els.cents.textContent = abs < 3 ? 'Afinado' : `${c > 0 ? '+' : ''}${c.toFixed(0)} cents ${c > 0 ? '(alto, afrouxe)' : '(baixo, aperte)'}`;
  els.freq.textContent = `${freq.toFixed(1)} Hz`;
  els.display.dataset.state = abs < 3 ? 'ok' : abs < 12 ? 'near' : 'off';
  updateStringSelection(stringId);
}

function showIdle(text = 'Toque uma corda') {
  els.display.dataset.state = 'idle';
  els.cents.textContent = text;
  els.freq.innerHTML = '&nbsp;';
  els.note.textContent = '–';
  els.octave.textContent = '';
  state.targetCents = 0;
  updateStringSelection(null);
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

// Converte uma frequência medida em leitura, respeitando a corda escolhida.
function readingFromFreq(freq) {
  if (state.string === 'auto') {
    const n = freqToNote(freq, state.a4, state.tuning.flats);
    const ns = nearestString(freq, state.a4, state.strings);
    return { freq, cents: n.cents, note: n.name, octave: n.octave, stringId: Math.abs(ns.cents) < 120 ? ns.string.id : null };
  }
  const s = state.strings.find((x) => x.id === state.string);
  return { freq, cents: cents(freq, midiToFreq(s.midi, state.a4)), note: s.note, octave: s.id.slice(-1), stringId: s.id };
}

// ----------------------------------------------------------------- Microfone
const mic = { stream: null, ctx: null, analyser: null, buf: null, timer: 0, recent: [] };

async function startMic() {
  mic.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  mic.ctx = new (window.AudioContext || window.webkitAudioContext)();
  await mic.ctx.resume();
  const src = mic.ctx.createMediaStreamSource(mic.stream);
  mic.analyser = mic.ctx.createAnalyser();
  mic.analyser.fftSize = 4096;
  src.connect(mic.analyser);
  mic.buf = new Float32Array(mic.analyser.fftSize);
  mic.recent = [];
  setStatus(`Microfone ativo · ${mic.ctx.sampleRate} Hz`);
  mic.timer = setInterval(micTick, 60);
}

function micTick() {
  mic.analyser.getFloatTimeDomainData(mic.buf);
  const level = rms(mic.buf);
  const now = performance.now();
  if (level > 0.008) {
    const r = detectPitchMPM(mic.buf, mic.ctx.sampleRate, { minFreq: 60, maxFreq: 1000 });
    if (r && r.clarity > 0.88) {
      mic.recent.push({ t: now, f: r.freq });
    }
  }
  mic.recent = mic.recent.filter((x) => now - x.t < 400);
  if (mic.recent.length >= 2) {
    const fs = mic.recent.map((x) => x.f).sort((a, b) => a - b);
    const median = fs[Math.floor(fs.length / 2)];
    showReading(readingFromFreq(median));
  } else if (now - state.lastReadingAt > 1200) {
    showIdle();
  }
}

function stopMic() {
  clearInterval(mic.timer);
  mic.stream?.getTracks().forEach((t) => t.stop());
  mic.ctx?.close();
  mic.stream = mic.ctx = mic.analyser = null;
}

// ----------------------------------------------------------------- Vibração
const vib = { samples: [], timer: 0, onMotion: null, recent: [] };
const VIB_WINDOW_MS = 3000;

async function startVib() {
  if (typeof DeviceMotionEvent === 'undefined') throw new Error('Este aparelho não expõe o acelerômetro ao navegador.');
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    const p = await DeviceMotionEvent.requestPermission();
    if (p !== 'granted') throw new Error('Permissão de movimento negada.');
  }
  vib.samples = [];
  vib.recent = [];
  vib.onMotion = (e) => {
    const a = e.acceleration && e.acceleration.x != null ? e.acceleration : e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    vib.samples.push({ t: e.timeStamp, x: a.x, y: a.y, z: a.z });
    const cutoff = e.timeStamp - VIB_WINDOW_MS - 500;
    while (vib.samples.length && vib.samples[0].t < cutoff) vib.samples.shift();
  };
  window.addEventListener('devicemotion', vib.onMotion);
  setStatus('Aguardando dados do acelerômetro…');
  vib.timer = setInterval(vibTick, 300);
}

function vibTick() {
  const all = vib.samples;
  if (all.length < 40) { setStatus(`Acelerômetro: ${all.length} amostras… (verifique se o site está em HTTPS)`); return; }
  const tEnd = all[all.length - 1].t;
  const win = all.filter((s) => s.t >= tEnd - VIB_WINDOW_MS);
  const n = win.length;
  const dur = (win[n - 1].t - win[0].t) / 1000;
  const fs = (n - 1) / dur;

  // Jitter de entrega: desvio-padrão dos intervalos entre eventos.
  let mi = 0; for (let i = 1; i < n; i++) mi += win[i].t - win[i - 1].t; mi /= n - 1;
  let vi = 0; for (let i = 1; i < n; i++) vi += ((win[i].t - win[i - 1].t) - mi) ** 2; vi /= n - 1;
  const jitterMs = Math.sqrt(vi);

  // Eixo com mais energia (normalmente Z, perpendicular ao tampo).
  let best = null;
  for (const axis of ['x', 'y', 'z']) {
    const arr = Float64Array.from(win, (s) => s[axis]);
    let m = 0; for (const v of arr) m += v; m /= n;
    let varc = 0; for (const v of arr) varc += (v - m) ** 2;
    if (!best || varc > best.varc) best = { axis, arr, varc, rmsLevel: Math.sqrt(varc / n) };
  }

  const s = state.strings.find((x) => x.id === state.string);
  const r = analyzeVibration(best.arr, fs, midiToFreq(s.midi, state.a4));
  const info = `Acelerômetro ${fs.toFixed(1)} Hz · jitter ${jitterMs.toFixed(1)} ms · eixo ${best.axis.toUpperCase()} · nível ${(best.rmsLevel * 1000).toFixed(1)} mm/s²`;

  if (r && r.unreachable) {
    setStatus(`${info} — esta corda cai numa zona cega a ${fs.toFixed(0)} Hz; tente o modo Microfone`, true);
    showIdle('Corda fora do alcance do sensor');
    return;
  }
  let extra = jitterMs > 2.5 ? ' · jitter alto, leitura pouco confiável' : '';
  if (r && r.mirrorAxisCents != null && Math.abs(r.mirrorAxisCents) < 60) {
    extra += ` · nesta corda a direção é confiável até ±${Math.abs(r.mirrorAxisCents).toFixed(0)} cents`;
  }
  setStatus(info + extra);
  const now = performance.now();
  if (r) vib.recent.push({ t: now, c: r.cents });
  vib.recent = vib.recent.filter((x) => now - x.t < 1200 && x.t <= now);
  if (r && vib.recent.length >= 2) {
    // Mediana das últimas leituras: descarta um salto isolado.
    const cs = vib.recent.map((x) => x.c).sort((a, b) => a - b);
    const c = cs[Math.floor(cs.length / 2)];
    const f = midiToFreq(s.midi, state.a4) * Math.pow(2, c / 1200);
    showReading({ freq: f, cents: c, note: s.note, octave: s.id.slice(-1), stringId: s.id });
  } else if (now - state.lastReadingAt > 1500) {
    showIdle('Toque a corda com o celular apoiado');
  }
}

function stopVib() {
  clearInterval(vib.timer);
  if (vib.onMotion) window.removeEventListener('devicemotion', vib.onMotion);
  vib.onMotion = null;
  vib.samples = [];
}

// ----------------------------------------------------------------- Controle
let wakeLock = null;

async function start() {
  if (!window.isSecureContext) {
    setStatus('Microfone e sensores exigem HTTPS (ou localhost). Abra o app por um endereço seguro.', true);
    return;
  }
  try {
    if (state.mode === 'mic') await startMic(); else await startVib();
    state.running = true;
    els.toggle.textContent = 'Parar';
    els.toggle.classList.add('running');
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* opcional */ }
  } catch (err) {
    setStatus(`Não foi possível iniciar: ${err.message}`, true);
    stop();
  }
}

function stop() {
  stopMic(); stopVib();
  state.running = false;
  els.toggle.textContent = 'Iniciar';
  els.toggle.classList.remove('running');
  wakeLock?.release?.(); wakeLock = null;
  showIdle();
}

function setMode(mode) {
  if (state.mode === mode) return;
  const wasRunning = state.running;
  stop();
  state.mode = mode;
  for (const b of document.querySelectorAll('.mode')) {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  }
  els.hint.textContent = HINTS[mode];
  buildStrings();
  setStatus('');
  if (wasRunning) start();
}

for (const b of document.querySelectorAll('.mode')) b.addEventListener('click', () => setMode(b.dataset.mode));
els.toggle.addEventListener('click', () => (state.running ? stop() : start()));
els.a4.addEventListener('change', () => {
  const v = Number(els.a4.value);
  if (v >= 400 && v <= 480) state.a4 = v; else els.a4.value = state.a4;
});
document.addEventListener('visibilitychange', () => { if (document.hidden && state.running) stop(); });

for (const t of TUNINGS) {
  const o = document.createElement('option');
  o.value = t.id; o.textContent = t.name;
  els.tuning.appendChild(o);
}
els.tuning.addEventListener('change', () => {
  state.tuning = TUNINGS.find((t) => t.id === els.tuning.value) || TUNINGS[0];
  state.strings = stringsFor(state.tuning);
  mic.recent = []; vib.recent = [];
  buildStrings();
  showIdle();
});

buildTicks();
els.hint.textContent = HINTS[state.mode];
buildStrings();
showIdle();
requestAnimationFrame(animateNeedle);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
