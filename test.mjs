import { detectPitchMPM, analyzeVibration, midiToFreq, cents, STRINGS } from './pitch.mjs';

let fails = 0;
function check(name, ok, detail) { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${detail || ''}`); if (!ok) fails++; }

// Sinal tipo guitarra: fundamental + harmônicos decaindo, com ruído.
// J = atraso aleatório (s) de cada amostra, modelo de sample-and-hold do navegador.
function guitar(f, fs, seconds, { J = 0, noise = 0.05 } = {}) {
  const n = Math.floor(fs * seconds);
  const amps = [1, 0.6, 0.4, 0.25, 0.15];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs + Math.random() * J;
    let v = 0;
    for (let h = 0; h < amps.length; h++) v += amps[h] * Math.sin(2 * Math.PI * f * (h + 1) * t + h);
    out[i] = v * Math.exp(-t * 0.3) + (Math.random() - 0.5) * noise;
  }
  return out;
}

// --- Microfone (MPM) ---
const SR = 48000;
for (const s of STRINGS) {
  for (const off of [-30, 0, 25]) {
    const f0 = midiToFreq(s.midi) * Math.pow(2, off / 1200);
    const buf = guitar(f0, SR, 4096 / SR, { noise: 0.02 });
    const r = detectPitchMPM(buf, SR);
    const err = r ? cents(r.freq, f0) : NaN;
    check(`MPM ${s.id} ${off > 0 ? '+' : ''}${off}c`, r && Math.abs(err) < 2, `erro=${err.toFixed(2)}c clareza=${r && r.clarity.toFixed(2)}`);
  }
}

// --- Vibração (acelerômetro a 60 e 100 Hz, amostragem uniforme e com 1 ms de jitter) ---
for (const fs of [60, 100]) {
  for (const J of [0, 0.001]) {
    for (const s of STRINGS) {
      for (const off of [-20, 0, 15]) {
        const f0 = midiToFreq(s.midi) * Math.pow(2, off / 1200);
        const buf = guitar(f0, fs, 3, { J });
        const r = analyzeVibration(buf, fs, midiToFreq(s.midi));
        const name = `VIB fs=${fs} J=${J * 1000}ms ${s.id} ${off > 0 ? '+' : ''}${off}c`;
        if (r && r.unreachable) { console.log(`SKIP ${name} (corda fora do alcance nesta taxa)`); continue; }
        const err = r ? r.cents - off : NaN;
        check(name, r && Math.abs(err) < 6, `medido=${r && r.cents.toFixed(1)}c erro=${err.toFixed(1)}c conf=${r && r.snr.toFixed(1)}`);
      }
    }
  }
}

// Ruído puro não deve detectar nada (20 tentativas)
let falsePos = 0;
for (let i = 0; i < 20; i++) {
  const r = analyzeVibration(new Float64Array(180).map(() => (Math.random() - 0.5) * 0.05), 60, midiToFreq(STRINGS[i % 6].midi));
  if (r && !r.unreachable) falsePos++;
}
check('VIB ruído puro sem falso positivo', falsePos === 0, `${falsePos}/20`);

console.log(fails ? `\n${fails} falha(s)` : '\nTudo OK');
process.exit(fails ? 1 : 0);
