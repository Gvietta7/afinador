import {
  TUNINGS, stringsFor, midiToFreq, cents, freqToNote, nearestString, rms,
  detectPitchMPM, analyzeVibration,
} from './pitch.mjs';

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'), pill: $('pill'), pillText: $('pillText'),
  segments: $('segments'), needle: $('needle'),
  note: $('note'), octave: $('octave'), centsVal: document.querySelector('#cents .cents-val'), freq: $('freq'),
  advice: $('advice'), adviceText: $('adviceText'),
  strings: $('strings'), stringsThumb: $('stringsThumb'),
  toggle: $('toggle'), toggleLabel: document.querySelector('#toggle .start-label'),
  a4: $('a4'), status: $('status'), tuning: $('tuning'), tuningName: $('tuningName'), copyBtn: $('copyBtn'),
};

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

const HINTS = {
  mic: { idle: 'Toque uma corda solta', listening: 'Ouvindo…' },
  vib: { idle: 'Apoie o celular no tampo e toque a corda', listening: 'Lendo o sensor…' },
};

const state = {
  mode: 'mic',           // 'mic' | 'vib'
  running: false,
  a4: 440,
  tuning: TUNINGS[0],
  strings: stringsFor(TUNINGS[0]),
  string: 'auto',        // 'auto' | id da corda
  ui: 'idle',            // idle | starting | listening | ok | near | off | lost | error
  lastReadingAt: 0,
  lastNote: '',
};

// ----------------------------------------------------------------- indicador
// 31 segmentos de −50 a +50 cents, em arco de −60° a +60°.
const SEG_COUNT = 31;
const ARC_DEG = 60;
const CX = 200, CY = 206, R_OUT = 176, R_IN_MINOR = 160, R_IN_MAJOR = 152;
const segEls = [];

function angleFor(c) { return ((c / 50) * ARC_DEG - 90) * (Math.PI / 180); }

function buildSegments() {
  const ns = 'http://www.w3.org/2000/svg';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < SEG_COUNT; i++) {
    const c = -50 + (100 * i) / (SEG_COUNT - 1);
    const a = angleFor(c);
    const major = i % 5 === 0;
    const center = i === (SEG_COUNT - 1) / 2;
    const rIn = center ? R_IN_MAJOR - 4 : major ? R_IN_MAJOR : R_IN_MINOR;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', (CX + R_OUT * Math.cos(a)).toFixed(2));
    line.setAttribute('y1', (CY + R_OUT * Math.sin(a)).toFixed(2));
    line.setAttribute('x2', (CX + rIn * Math.cos(a)).toFixed(2));
    line.setAttribute('y2', (CY + rIn * Math.sin(a)).toFixed(2));
    line.classList.add('seg-tick');
    if (major) line.classList.add('major');
    if (center) line.classList.add('center');
    line.dataset.cents = c;
    frag.appendChild(line);
    segEls.push({ el: line, c });
  }
  els.segments.appendChild(frag);
}

function litSegments(c, active) {
  for (const s of segEls) {
    const lit = active && (c >= 0 ? s.c >= -0.01 && s.c <= c + 1.7 : s.c <= 0.01 && s.c >= c - 1.7);
    s.el.classList.toggle('lit', lit);
  }
}

// Ponteiro com mola criticamente amortecida: segue rápido, não treme, não oscila.
const spring = { x: 0, v: 0, target: 0, k: 140, last: 0 };
function animateNeedle(now) {
  const dt = Math.min(0.05, (now - (spring.last || now)) / 1000);
  spring.last = now;
  const target = Math.max(-50, Math.min(50, spring.target));
  if (REDUCED.matches) { spring.x = target; spring.v = 0; }
  else {
    const damping = 2 * Math.sqrt(spring.k);
    const a = spring.k * (target - spring.x) - damping * spring.v;
    spring.v += a * dt;
    spring.x += spring.v * dt;
  }
  els.needle.setAttribute('transform', `rotate(${((spring.x / 50) * ARC_DEG).toFixed(3)} ${CX} ${CY})`);
  requestAnimationFrame(animateNeedle);
}

// ----------------------------------------------------------------- estado da interface
let wasOk = false;
function setUi(ui) {
  if (state.ui === ui) return;
  state.ui = ui;
  els.app.dataset.state = ui;
  if (ui === 'ok' && !wasOk) {
    try { navigator.vibrate?.(18); } catch { /* opcional */ }
  }
  wasOk = ui === 'ok';
}

function setPill(text) { els.pillText.textContent = text; }

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function setMicLevel(level) {
  els.app.style.setProperty('--level', Math.min(1, level * 14).toFixed(3));
}

function showReading({ freq, cents: c, note, octave, stringId }) {
  state.lastReadingAt = performance.now();
  spring.target = c;
  const abs = Math.abs(c);
  setUi(abs < 3 ? 'ok' : abs < 12 ? 'near' : 'off');
  litSegments(c, true);

  if (note !== state.lastNote) {
    state.lastNote = note;
    els.note.textContent = note;
    if (!REDUCED.matches) {
      els.note.classList.remove('swap');
      void els.note.offsetWidth;
      els.note.classList.add('swap');
    }
  }
  els.octave.textContent = octave ?? '';
  els.centsVal.textContent = `${c > 0 ? '+' : c < 0 ? '−' : ''}${Math.abs(c).toFixed(0)}`;
  els.freq.textContent = `${freq.toFixed(1)} Hz`;

  if (abs < 3) {
    els.adviceText.textContent = 'Afinada';
    els.advice.dataset.dir = 'ok';
  } else if (c < 0) {
    els.adviceText.textContent = abs < 12 ? 'Aperte um pouco' : 'Aperte a corda';
    els.advice.dataset.dir = 'flat';
  } else {
    els.adviceText.textContent = abs < 12 ? 'Afrouxe um pouco' : 'Afrouxe a corda';
    els.advice.dataset.dir = 'sharp';
  }
  const sName = stringId ? state.strings.find((s) => s.id === stringId) : null;
  setPill(sName ? `${sName.label} corda · ${sName.note}${sName.id.slice(-1)}` : HINTS[state.mode].listening);
  updateStringSelection(stringId);
}

function showWaiting(kind = 'listening') {
  // kind: 'idle' | 'listening' | 'lost' | 'starting'
  setUi(kind);
  spring.target = 0;
  litSegments(0, false);
  state.lastNote = '';
  els.note.textContent = '–';
  els.octave.textContent = '';
  els.centsVal.textContent = '0';
  els.freq.textContent = '— Hz';
  els.adviceText.textContent = HINTS[state.mode].idle;
  els.advice.dataset.dir = '';
  if (kind === 'idle') setPill('Pronto para começar');
  else if (kind === 'starting') setPill(state.mode === 'mic' ? 'Pedindo acesso ao microfone…' : 'Pedindo acesso ao sensor…');
  else if (kind === 'lost') setPill('Sinal perdido, toque de novo');
  else setPill(HINTS[state.mode].listening);
  updateStringSelection(null);
}

function showError(message) {
  setUi('error');
  spring.target = 0;
  litSegments(0, false);
  setPill(message);
}

// ----------------------------------------------------------------- cordas
function buildStrings() {
  for (const b of els.strings.querySelectorAll('button')) b.remove();
  const manualOnly = state.mode === 'vib';
  if (!state.strings.some((s) => s.id === state.string) && state.string !== 'auto') state.string = 'auto';
  if (manualOnly && state.string === 'auto') state.string = state.strings[0].id;
  if (!manualOnly) els.strings.appendChild(stringButton('auto', 'Auto', '', true));
  for (const s of state.strings) els.strings.appendChild(stringButton(s.id, s.note, s.label));
  updateStringSelection(null);
  requestAnimationFrame(moveStringsThumb);
}

function stringButton(id, main, sub, isAuto = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.id = id;
  if (isAuto) b.classList.add('auto');
  b.innerHTML = `${main}<small>${sub || '&nbsp;'}</small>`;
  b.addEventListener('click', () => { state.string = id; updateStringSelection(null); moveStringsThumb(); });
  return b;
}

function updateStringSelection(detectedId) {
  for (const b of els.strings.querySelectorAll('button')) {
    b.classList.toggle('selected', b.dataset.id === state.string);
    b.classList.toggle('detected', state.string === 'auto' && b.dataset.id === detectedId);
  }
}

function moveStringsThumb() {
  const sel = els.strings.querySelector('button.selected');
  if (!sel) { els.stringsThumb.style.opacity = '0'; return; }
  const parent = els.strings.getBoundingClientRect();
  const r = sel.getBoundingClientRect();
  els.stringsThumb.style.opacity = '1';
  els.stringsThumb.style.width = `${r.width}px`;
  els.stringsThumb.style.transform = `translateX(${r.left - parent.left - 4}px)`;
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
  showWaiting('listening');
  mic.timer = setInterval(micTick, 60);
}

function micTick() {
  mic.analyser.getFloatTimeDomainData(mic.buf);
  const level = rms(mic.buf);
  setMicLevel(level);
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
  } else if (state.lastReadingAt && now - state.lastReadingAt > 1200 && state.ui !== 'lost' && state.ui !== 'listening') {
    showWaiting('lost');
  } else if (state.ui === 'lost' && now - state.lastReadingAt > 3500) {
    showWaiting('listening');
  }
}

function stopMic() {
  clearInterval(mic.timer);
  mic.stream?.getTracks().forEach((t) => t.stop());
  mic.ctx?.close();
  mic.stream = mic.ctx = mic.analyser = null;
  setMicLevel(0);
}

// ----------------------------------------------------------------- Vibração
const vib = { samples: [], timer: 0, onMotion: null, recent: [], lastWindow: null };
const VIB_WINDOW_MS = 3000;

async function startVib() {
  if (typeof DeviceMotionEvent === 'undefined') throw new Error('Este aparelho não expõe o acelerômetro ao navegador');
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    const p = await DeviceMotionEvent.requestPermission();
    if (p !== 'granted') throw new Error('Permissão de movimento negada');
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
  showWaiting('listening');
  vib.timer = setInterval(vibTick, 300);
}

function vibTick() {
  const all = vib.samples;
  if (all.length < 40) { setStatus(`Acelerômetro: ${all.length} amostras… (o site precisa estar em HTTPS)`); return; }
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
  setMicLevel(Math.min(1, best.rmsLevel * 4));

  const s = state.strings.find((x) => x.id === state.string);
  const r = analyzeVibration(best.arr, fs, midiToFreq(s.midi, state.a4));
  const info = `Sensor ${fs.toFixed(1)} Hz · jitter ${jitterMs.toFixed(1)} ms · eixo ${best.axis.toUpperCase()} · nível ${(best.rmsLevel * 1000).toFixed(1)} mm/s²`;

  if (r && r.unreachable) {
    setStatus(`${info} — esta corda cai numa zona cega a ${fs.toFixed(0)} Hz; use o modo Microfone`, true);
    showWaiting('listening');
    setPill('Corda fora do alcance do sensor');
    return;
  }
  let extra = jitterMs > 2.5 ? ' · jitter alto, leitura pouco confiável' : '';
  if (r && r.mirrorAxisCents != null && Math.abs(r.mirrorAxisCents) < 60) {
    extra += ` · direção confiável até ±${Math.abs(r.mirrorAxisCents).toFixed(0)} cents`;
  }
  if (!r) {
    // Diagnóstico: quão perto do limiar (3,5) a melhor hipótese chegou.
    const diag = analyzeVibration(best.arr, fs, midiToFreq(s.midi, state.a4), { minRatio: 0 });
    if (diag && !diag.unreachable) extra += ` · confiança ${diag.snr.toFixed(1)} (mín. 3,5)`;
  }
  vib.lastWindow = { fs, jitterMs, axis: best.axis, string: s.id, a4: state.a4, samples: Array.from(best.arr, (v) => +v.toFixed(4)) };
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
  } else if (state.lastReadingAt && now - state.lastReadingAt > 1500 && state.ui !== 'lost' && state.ui !== 'listening') {
    showWaiting('lost');
  } else if (state.ui === 'lost' && now - state.lastReadingAt > 4000) {
    showWaiting('listening');
  }
}

// Copia a última janela do sensor (3 s) para análise fora do app.
async function copySensorData() {
  if (!vib.lastWindow) { els.copyBtn.textContent = 'Sem dados ainda'; return; }
  try {
    await navigator.clipboard.writeText(JSON.stringify(vib.lastWindow));
    els.copyBtn.textContent = 'Copiado';
  } catch {
    els.copyBtn.textContent = 'Não foi possível copiar';
  }
  setTimeout(() => { els.copyBtn.textContent = 'Copiar dados do sensor'; }, 1800);
}

function stopVib() {
  clearInterval(vib.timer);
  if (vib.onMotion) window.removeEventListener('devicemotion', vib.onMotion);
  vib.onMotion = null;
  vib.samples = [];
  setMicLevel(0);
}

// ----------------------------------------------------------------- Controle
let wakeLock = null;

async function start() {
  if (!window.isSecureContext) {
    showError('Este endereço não é seguro');
    setStatus('Microfone e sensores exigem HTTPS ou localhost. Abra o app por um endereço seguro.', true);
    return;
  }
  showWaiting('starting');
  els.toggle.disabled = true;
  try {
    if (state.mode === 'mic') await startMic(); else await startVib();
    state.running = true;
    state.lastReadingAt = 0;
    els.toggleLabel.textContent = 'Parar';
    els.toggle.classList.add('running');
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* opcional */ }
  } catch (err) {
    const denied = /denied|permission|NotAllowed/i.test(err.name + ' ' + err.message);
    stopMic(); stopVib();
    state.running = false;
    showError(denied
      ? (state.mode === 'mic' ? 'Sem acesso ao microfone' : 'Sem acesso ao sensor de movimento')
      : 'Não foi possível iniciar');
    setStatus(denied
      ? 'Permita o acesso nas configurações do navegador e toque em Iniciar de novo.'
      : err.message, true);
  } finally {
    els.toggle.disabled = false;
  }
}

function stop() {
  stopMic(); stopVib();
  state.running = false;
  state.lastReadingAt = 0;
  els.toggleLabel.textContent = 'Iniciar';
  els.toggle.classList.remove('running');
  wakeLock?.release?.(); wakeLock = null;
  showWaiting('idle');
  setStatus('');
}

function setMode(mode) {
  if (state.mode === mode) return;
  const wasRunning = state.running;
  stop();
  state.mode = mode;
  els.app.dataset.mode = mode;
  for (const b of document.querySelectorAll('.seg-btn')) {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  }
  buildStrings();
  showWaiting('idle');
  if (wasRunning) start();
}

for (const b of document.querySelectorAll('.seg-btn')) b.addEventListener('click', () => setMode(b.dataset.mode));
els.toggle.addEventListener('click', () => (state.running ? stop() : start()));
els.a4.addEventListener('change', () => {
  const v = Number(els.a4.value);
  if (v >= 400 && v <= 480) state.a4 = v; else els.a4.value = state.a4;
});
document.addEventListener('visibilitychange', () => { if (document.hidden && state.running) stop(); });
window.addEventListener('resize', moveStringsThumb);
els.copyBtn.addEventListener('click', copySensorData);

for (const t of TUNINGS) {
  const o = document.createElement('option');
  o.value = t.id; o.textContent = t.name;
  els.tuning.appendChild(o);
}
els.tuning.addEventListener('change', () => {
  state.tuning = TUNINGS.find((t) => t.id === els.tuning.value) || TUNINGS[0];
  state.strings = stringsFor(state.tuning);
  els.tuningName.textContent = state.tuning.name.split(' (')[0];
  mic.recent = []; vib.recent = [];
  buildStrings();
  if (state.running) showWaiting('listening'); else showWaiting('idle');
});

if (document.visibilityState === 'visible' && !REDUCED.matches) {
  els.app.classList.add('enter');
  // Garante o estado final mesmo se o navegador pausar animações (aba em segundo plano).
  setTimeout(() => els.app.classList.remove('enter'), 1200);
}
buildSegments();
buildStrings();
showWaiting('idle');
requestAnimationFrame(animateNeedle);
if (document.fonts?.ready) document.fonts.ready.then(moveStringsThumb);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
