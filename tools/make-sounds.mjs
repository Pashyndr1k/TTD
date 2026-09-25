// make-sounds.mjs — the kit's sample sounds in assets/sounds/, synthesized from numbers:
//   step.wav — a footstep: a short thump with a gritty tail (the kit's sample game).
//   The TTD remake's effects (Game.SOUNDS): click, build, demolish, cash, whistle, chuff, horn,
//   bus, ship, plane, crash, breakdown, news, error.
// Generated — no source file, no licence questions; replace it with a recording. Other files in
// assets/sounds are ordinary assets — this tool does not touch them.
// An effect of your own is a few lines here: an oscillator or noise() × an envelope -> writeWav.
// A LOOPED sound must not click at the seam: make the noise and the envelope periodic over the
// loop and run the filter one loop ahead of the part you keep (see loopedNoise).
//
//   node tools/make-sounds.mjs          # writes the files
//   node tools/make-sounds.mjs --check  # exit 1 if a file on disk differs
//
// WAV: PCM 16 bit, mono, 22050 Hz — small files, plenty for effects.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets', 'sounds');
const RATE = 22050;

// White noise −1..1 from a seed: the same bytes on every run (a plain LCG, 32 bit).
function noise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x80000000 - 1;
  };
}

// One-pole low-pass: k 0..1, smaller — duller.
function lowpass(k) {
  let y = 0;
  return (x) => (y += k * (x - y));
}

// A footstep, 0.14 s: a sine thump sliding 110 -> 55 Hz plus dull noise, both dying fast.
function step() {
  const n = Math.round(RATE * 0.14), out = new Float64Array(n);
  const rnd = noise(7), lp = lowpass(0.25);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    phase += 2 * Math.PI * (55 + 55 * Math.exp(-t * 40)) / RATE;
    const attack = Math.min(1, t / 0.004);
    out[i] = attack * (0.8 * Math.sin(phase) * Math.exp(-t * 38) + 0.5 * lp(rnd()) * Math.exp(-t * 55));
  }
  return out;
}

// A looped ambience (wind, blades, a machine), seconds long: dull noise that swells twice per
// loop. The noise sequence and the swell are periodic over the loop, and the filter runs one
// loop ahead of the part that is kept — its state at the end equals its state at the start,
// so the loop point is inaudible.
export function loopedNoise(seconds = 2, seed = 11, cutoff = 0.06, gain = 3.2) {
  const n = Math.round(RATE * seconds), out = new Float64Array(n), seq = new Float64Array(n);
  const rnd = noise(seed), lp = lowpass(cutoff);
  for (let i = 0; i < n; i++) seq[i] = rnd();
  for (let i = 0; i < 2 * n; i++) {
    const v = lp(seq[i % n]);
    if (i < n) continue;
    const swell = Math.sin(2 * Math.PI * (i - n) / n);
    out[i - n] = v * (0.35 + 0.65 * swell * swell) * gain;
  }
  return out;
}

// --- The TTD remake's sounds (Game.SOUNDS) ---------------------------------------------------

/** Samples of `seconds` from f(t, i) (t — seconds). */
function render(seconds, f) {
  const n = Math.round(RATE * seconds), out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = f(i / RATE, i);
  return out;
}

/** Attack / release envelope (seconds), 1 in between. */
function env(t, len, a, r) {
  return Math.min(1, t / Math.max(1e-4, a)) * Math.min(1, Math.max(0, (len - t) / Math.max(1e-4, r)));
}

/** A band of noise: noise through two one-pole filters (low-pass k1 minus low-pass k2). */
function bandNoise(seed, k1, k2) {
  const r = noise(seed), a = lowpass(k1), b = lowpass(k2);
  return () => { const x = r(); return a(x) - b(x); };
}

// A UI click, 0.03 s.
function click() {
  const r = noise(3), lp = lowpass(0.5);
  return render(0.03, (t) => (Math.sin(2 * Math.PI * 1800 * t) * 0.5 + lp(r()) * 0.5) * Math.exp(-t * 180));
}

// Construction: two dull metallic clanks (TTD's building sound).
function build() {
  const r = noise(5), lp = lowpass(0.3);
  return render(0.4, (t) => {
    const hit = (t0) => t < t0 ? 0 : Math.exp(-(t - t0) * 30) * (Math.sin(2 * Math.PI * 420 * (t - t0)) * 0.5 + Math.sin(2 * Math.PI * 1130 * (t - t0)) * 0.25 + lp(r()) * 0.4);
    return 0.8 * (hit(0) + 0.8 * hit(0.17));
  });
}

// Demolition: a low rumbling blast.
function demolish() {
  const r = noise(9), lp = lowpass(0.08), lp2 = lowpass(0.3);
  return render(0.7, (t) => { const x = r(); return (lp(x) * 4 + lp2(x) * 0.6 * Math.exp(-t * 20)) * Math.exp(-t * 5) * Math.min(1, t / 0.005); });
}

// Income: a cash register — a bell with a rattle first.
function cash() {
  const r = noise(13);
  return render(0.7, (t) => {
    const rattle = t < 0.08 ? r() * 0.3 * (1 - t / 0.08) : 0;
    const bell = t < 0.07 ? 0 : Math.exp(-(t - 0.07) * 6) * (Math.sin(2 * Math.PI * 1568 * t) * 0.35 + Math.sin(2 * Math.PI * 2093 * t) * 0.25 + Math.sin(2 * Math.PI * 3136 * t) * 0.1);
    return rattle + bell;
  });
}

// Steam whistle: a breathy chord that swells and fades.
function whistle() {
  const bn = bandNoise(17, 0.5, 0.2), len = 0.9;
  return render(len, (t) => env(t, len, 0.06, 0.25) * (Math.sin(2 * Math.PI * 690 * t) * 0.3 + Math.sin(2 * Math.PI * 870 * t) * 0.25 + Math.sin(2 * Math.PI * 1035 * t) * 0.12 + bn() * 0.5));
}

// One chuff of a steam engine: a short burst of hissing noise.
function chuff() {
  const bn = bandNoise(19, 0.35, 0.05);
  return render(0.16, (t) => bn() * 1.6 * Math.min(1, t / 0.008) * Math.exp(-t * 26));
}

// Diesel / electric horn: a two-tone blare (rich harmonics).
function horn() {
  const len = 0.8;
  const saw = (f, t) => 2 * ((f * t) % 1) - 1;
  const lp = lowpass(0.25);
  return render(len, (t) => env(t, len, 0.03, 0.12) * lp(saw(311, t) * 0.3 + saw(370, t) * 0.3));
}

// Bus / lorry: a short honk.
function bus() {
  const len = 0.35, lp = lowpass(0.3);
  const sq = (f, t) => Math.sign(Math.sin(2 * Math.PI * f * t));
  return render(len, (t) => env(t, len, 0.01, 0.06) * lp(sq(420, t) * 0.25 + sq(525, t) * 0.2));
}

// Ship: a deep foghorn.
function ship() {
  const len = 1.5, lp = lowpass(0.12);
  const saw = (f, t) => 2 * ((f * t) % 1) - 1;
  return render(len, (t) => env(t, len, 0.12, 0.35) * lp(saw(98, t) * 0.5 + saw(147, t) * 0.25) * 1.6);
}

// Aircraft take-off: a jet roar that swells and brightens.
function plane() {
  const r = noise(23), len = 2.2;
  let y = 0;
  return render(len, (t) => {
    const k = 0.03 + 0.25 * Math.min(1, t / len);
    y += k * (r() - y);
    return y * 2.2 * env(t, len, 0.5, 0.6);
  });
}

// A crash: a big explosion with a long tail.
function crash() {
  const r = noise(29), lp = lowpass(0.05), lp2 = lowpass(0.4);
  return render(1.4, (t) => { const x = r(); return (lp(x) * 6 * Math.exp(-t * 3) + lp2(x) * 0.8 * Math.exp(-t * 12)) * Math.min(1, t / 0.004); });
}

// A breakdown: an engine sputtering out — pops getting slower.
function breakdown() {
  const r = noise(31), lp = lowpass(0.2);
  const pops = [0, 0.09, 0.2, 0.34, 0.52, 0.75];
  return render(0.9, (t) => {
    let v = 0;
    for (const p of pops) if (t >= p) v += Math.exp(-(t - p) * 45) * (Math.sin(2 * Math.PI * 90 * (t - p)) * 0.6 + lp(r()) * 0.6);
    return v * 0.9;
  });
}

// News: a three-note chime (C E G).
function news() {
  return render(0.9, (t) => {
    let v = 0;
    [[0, 523.3], [0.13, 659.3], [0.26, 784]].forEach(([t0, f]) => { if (t >= t0) v += Math.exp(-(t - t0) * 5) * Math.sin(2 * Math.PI * f * (t - t0)) * 0.3; });
    return v;
  });
}

// An error: a short low buzz.
function error() {
  const len = 0.18;
  return render(len, (t) => env(t, len, 0.005, 0.03) * Math.sign(Math.sin(2 * Math.PI * 150 * t)) * 0.3);
}

// Samples −1..1 -> the bytes of a WAV file.
function writeWav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);          // fmt chunk size
  head.writeUInt16LE(1, 20);           // PCM
  head.writeUInt16LE(1, 22);           // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);    // bytes per second
  head.writeUInt16LE(2, 32);           // bytes per sample frame
  head.writeUInt16LE(16, 34);          // bits
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// File name -> bytes. Only what this tool owns: other files in assets/sounds are left alone.
function buildSounds() {
  return {
    'step.wav': writeWav(step()),
    'click.wav': writeWav(click()), 'build.wav': writeWav(build()), 'demolish.wav': writeWav(demolish()),
    'cash.wav': writeWav(cash()), 'whistle.wav': writeWav(whistle()), 'chuff.wav': writeWav(chuff()),
    'horn.wav': writeWav(horn()), 'bus.wav': writeWav(bus()), 'ship.wav': writeWav(ship()),
    'plane.wav': writeWav(plane()), 'crash.wav': writeWav(crash()), 'breakdown.wav': writeWav(breakdown()),
    'news.wav': writeWav(news()), 'error.wav': writeWav(error()),
  };
}

export { buildSounds, OUT_DIR, RATE };

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  const sounds = buildSounds(), check = process.argv.includes('--check');
  let differs = false;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, bytes] of Object.entries(sounds)) {
    const file = path.join(OUT_DIR, name);
    if (check) {
      const same = fs.existsSync(file) && fs.readFileSync(file).equals(bytes);
      console.log(name + (same ? ' is up to date' : ' differs from the generator'));
      differs = differs || !same;
    } else {
      fs.writeFileSync(file, bytes);
      console.log(`${path.relative(ROOT, file).split(path.sep).join('/')}: ${bytes.length} bytes, ${((bytes.length - 44) / 2 / RATE).toFixed(2)} s`);
    }
  }
  if (check) process.exit(differs ? 1 : 0);
}
