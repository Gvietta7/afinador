// Algoritmos de afinação compartilhados entre navegador e testes em Node.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export function noteName(midi, flats = false) {
  return (flats ? NOTE_NAMES_FLAT : NOTE_NAMES)[((midi % 12) + 12) % 12];
}

// Afinações disponíveis (notas MIDI da 6ª à 1ª corda).
// Padrão: E2=40 A2=45 D3=50 G3=55 B3=59 E4=64
export const TUNINGS = [
  { id: 'standard', name: 'Padrão (E A D G B E)', midis: [40, 45, 50, 55, 59, 64] },
  { id: 'half-down', name: 'Meio tom abaixo (Eb Ab Db Gb Bb Eb)', midis: [39, 44, 49, 54, 58, 63], flats: true },
  { id: 'whole-down', name: 'Um tom abaixo (D G C F A D)', midis: [38, 43, 48, 53, 57, 62] },
  { id: 'drop-d', name: 'Drop D (D A D G B E)', midis: [38, 45, 50, 55, 59, 64] },
  { id: 'drop-c', name: 'Drop C (C G C F A D)', midis: [36, 43, 48, 53, 57, 62] },
  { id: 'open-g', name: 'Open G (D G D G B D)', midis: [38, 43, 50, 55, 59, 62] },
  { id: 'open-d', name: 'Open D (D A D F# A D)', midis: [38, 45, 50, 54, 57, 62] },
  { id: 'dadgad', name: 'DADGAD', midis: [38, 45, 50, 55, 57, 62] },
];

const LABELS = ['6ª', '5ª', '4ª', '3ª', '2ª', '1ª'];

export function stringsFor(tuning) {
  return tuning.midis.map((midi, i) => ({
    id: `${noteName(midi)}${Math.floor(midi / 12) - 1}`,
    label: LABELS[i],
    note: noteName(midi, tuning.flats),
    midi,
  }));
}

// Afinação padrão da guitarra (grave -> agudo)
export const STRINGS = stringsFor(TUNINGS[0]);

export function midiToFreq(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function cents(f, ref) {
  return 1200 * Math.log2(f / ref);
}

export function freqToNote(f, a4 = 440, flats = false) {
  const midi = Math.round(69 + 12 * Math.log2(f / a4));
  return {
    midi,
    name: noteName(midi, flats),
    octave: Math.floor(midi / 12) - 1,
    cents: cents(f, midiToFreq(midi, a4)),
  };
}

export function nearestString(f, a4 = 440, strings = STRINGS) {
  let best = null;
  for (const s of strings) {
    const c = cents(f, midiToFreq(s.midi, a4));
    if (!best || Math.abs(c) < Math.abs(best.cents)) best = { string: s, cents: c };
  }
  return best;
}

export function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

// ---------------------------------------------------------------------------
// MODO MICROFONE: McLeod Pitch Method (NSDF + máximos-chave + interpolação).
// Robusto para sinais harmônicos como cordas de guitarra.
// ---------------------------------------------------------------------------
export function detectPitchMPM(buf, sampleRate, { minFreq = 60, maxFreq = 1000, threshold = 0.9 } = {}) {
  const n = buf.length;
  const maxTau = Math.min(n - 2, Math.floor(sampleRate / minFreq));
  const minTau = Math.max(2, Math.floor(sampleRate / maxFreq));

  const nsdf = new Float32Array(maxTau + 1);
  for (let tau = 0; tau <= maxTau; tau++) {
    let acf = 0, m = 0;
    for (let i = 0; i < n - tau; i++) {
      const a = buf[i], b = buf[i + tau];
      acf += a * b;
      m += a * a + b * b;
    }
    nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
  }

  // Máximos-chave: maior valor de cada lobo positivo após o primeiro cruzamento negativo.
  const maxima = [];
  let tau = minTau;
  while (tau <= maxTau && nsdf[tau] > 0) tau++;
  while (tau <= maxTau) {
    while (tau <= maxTau && nsdf[tau] <= 0) tau++;
    let peakTau = -1, peakVal = -Infinity;
    while (tau <= maxTau && nsdf[tau] > 0) {
      if (nsdf[tau] > peakVal) { peakVal = nsdf[tau]; peakTau = tau; }
      tau++;
    }
    if (peakTau > 0) maxima.push({ tau: peakTau, val: peakVal });
  }
  if (!maxima.length) return null;

  let highest = -Infinity;
  for (const m of maxima) if (m.val > highest) highest = m.val;
  const pick = maxima.find((m) => m.val >= threshold * highest);

  let t = pick.tau;
  if (t > 0 && t < maxTau) {
    const y0 = nsdf[t - 1], y1 = nsdf[t], y2 = nsdf[t + 1];
    const d = y0 - 2 * y1 + y2;
    if (d !== 0) t += (0.5 * (y0 - y2)) / d;
  }
  return { freq: sampleRate / t, clarity: pick.val };
}

// ---------------------------------------------------------------------------
// MODO VIBRAÇÃO
// O acelerômetro do celular entrega ~60 Hz, muito abaixo das frequências das
// cordas (82 a 330 Hz). O sinal chega "dobrado" (aliasing), e todos os
// harmônicos caem na mesma faixa de 0 a fs/2. Como sabemos a corda alvo,
// varremos um desvio candidato (em cents) e, para cada um, somamos a energia
// do sinal exatamente onde o fundamental e os harmônicos cairiam depois do
// aliasing. O desvio que maximiza essa soma é o resultado (filtro pente no
// domínio dobrado). Isso desambigua os harmônicos entre si.
// ---------------------------------------------------------------------------
export function aliasOf(f, fs) {
  const k = Math.round(f / fs);
  const d = f - k * fs; // em [-fs/2, fs/2]
  return { fAlias: Math.abs(d), folded: d < 0 };
}

export function hannDetrend(samples) {
  const n = samples.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean /= n;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    x[i] = (samples[i] - mean) * w;
  }
  return x;
}

// Amplitude espectral (DFT direta) numa única frequência.
function amplitudeAt(x, fs, f) {
  let re = 0, im = 0;
  const w = (2 * Math.PI * f) / fs;
  for (let i = 0; i < x.length; i++) {
    re += x[i] * Math.cos(w * i);
    im -= x[i] * Math.sin(w * i);
  }
  return Math.sqrt(re * re + im * im);
}

function usableHarmonics(fTarget, fs, harmonics, margin) {
  return harmonics.filter((h) => {
    const { fAlias } = aliasOf(fTarget * h, fs);
    return fAlias > margin && fAlias < fs / 2 - margin;
  });
}

export function analyzeVibration(
  samples,
  fs,
  fTarget,
  { harmonics = [1, 2, 3, 4], rangeCents = 60, stepCents = 0.5, minRatio = 3.5, margin = 1.5, weight = (h) => 1 / Math.sqrt(h) } = {},
) {
  if (samples.length < 32 || fs < 20) return null;
  const usable = usableHarmonics(fTarget, fs, harmonics, margin);
  if (!usable.length) return { unreachable: true, fs };

  const x = hannDetrend(samples);
  const scores = [];
  const grid = [];
  let bestIdx = -1, bestScore = -1;
  for (let c = -rangeCents; c <= rangeCents + 1e-9; c += stepCents) {
    const f = fTarget * Math.pow(2, c / 1200);
    let score = 0;
    for (const h of usable) {
      const { fAlias } = aliasOf(f * h, fs);
      if (fAlias < 0.5 || fAlias > fs / 2 - 0.5) continue;
      score += weight(h) * amplitudeAt(x, fs, fAlias);
    }
    grid.push(c);
    scores.push(score);
    if (score > bestScore) { bestScore = score; bestIdx = scores.length - 1; }
  }
  if (bestIdx < 0) return null;
  // Máximo encostado na borda da varredura costuma ser o alias de outro harmônico.
  if (Math.abs(grid[bestIdx]) > rangeCents - 2 * stepCents) return null;

  // Confiança: pico em relação à mediana da varredura.
  const sorted = scores.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1e-12;
  const ratio = bestScore / median;
  if (ratio < minRatio) return null;

  // Ambiguidade de espelho: um sinal em f e outro em (k·fs − f) produzem
  // amostras idênticas, em TODOS os harmônicos. Quando o espelho do melhor
  // candidato também cai na faixa, não há como distinguir pelos dados; a
  // escolha razoável é o candidato mais perto da nota alvo (a corda costuma
  // estar quase afinada). Informamos o eixo do espelho para a interface
  // avisar até onde a direção é confiável.
  let ambiguous = false;
  let mirrorAxisCents = null;
  {
    const fBest = fTarget * Math.pow(2, grid[bestIdx] / 1200);
    const k = Math.round((2 * fBest) / fs);
    const fMirror = k * fs - fBest;
    if (fMirror > 0) {
      const cMirror = cents(fMirror, fTarget);
      mirrorAxisCents = cents((k * fs) / 2, fTarget);
      if (Math.abs(cMirror) <= rangeCents && Math.abs(cMirror - grid[bestIdx]) > 3) {
        const idx = Math.min(scores.length - 1, Math.max(0, Math.round((cMirror + rangeCents) / stepCents)));
        const mirrorScore = Math.max(scores[idx - 1] ?? 0, scores[idx] ?? 0, scores[idx + 1] ?? 0);
        if (mirrorScore > 0.85 * bestScore) {
          ambiguous = true;
          if (Math.abs(cMirror) < Math.abs(grid[bestIdx])) {
            let bi = idx;
            for (const j of [idx - 1, idx + 1]) if (scores[j] != null && scores[j] > scores[bi]) bi = j;
            bestIdx = bi;
          }
        }
      }
    }
  }

  // Refino parabólico ao redor do melhor ponto.
  let c = grid[bestIdx];
  if (bestIdx > 0 && bestIdx < scores.length - 1) {
    const y0 = scores[bestIdx - 1], y1 = scores[bestIdx], y2 = scores[bestIdx + 1];
    const d = y0 - 2 * y1 + y2;
    if (d !== 0) c += (stepCents * 0.5 * (y0 - y2)) / d;
  }
  const freq = fTarget * Math.pow(2, c / 1200);
  return { freq, cents: c, snr: ratio, harmonics: usable, fs, ambiguous, mirrorAxisCents };
}

// Tenta todas as cordas e devolve a de melhor confiança.
export function analyzeVibrationAuto(samples, fs, a4 = 440, opts, strings = STRINGS) {
  let best = null;
  for (const s of strings) {
    const r = analyzeVibration(samples, fs, midiToFreq(s.midi, a4), opts);
    if (r && !r.unreachable && (!best || r.snr > best.snr)) best = { ...r, string: s };
  }
  return best;
}
