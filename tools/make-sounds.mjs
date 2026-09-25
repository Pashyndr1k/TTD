// make-sounds.mjs — the kit's sample sounds in assets/sounds/, synthesized from numbers:
//   step.wav — a footstep: a short thump with a gritty tail (the kit's sample game).
//   The TTD remake's effects (Game.SOUNDS): click, build, demolish, cash, whistle, chuff, horn,
//   bus, ship, plane, crash, breakdown, news, error; and three 8-bit tunes (music_rails,
//   music_night, music_rag — Game.MUSIC) from a tiny four-voice tracker.
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

// --- 8-bit music: a tiny four-voice tracker (pulse lead, pulse arpeggio, triangle bass, noise) ---
//
// A song is data: tempo, swing, chords and a lead line per bar, eight eighth-note steps per bar
// ('C5' — a note, '-' — hold, '.' — rest). The accompaniment is generated from the chords:
// oom-pah bass on the triangle, arpeggiated chord stabs on the second pulse, hats and a snare on
// the noise channel. The whole song plays twice, the second time with the arpeggio voice
// doubling the tune an octave down. Written as 8-bit PCM at 11025 Hz: the grit is the point.

const MUSIC_RATE = 11025;
const NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const midiOf = (name) => { const m = /^([A-G][#b]?)(-?\d)$/.exec(name); return 12 * (Number(m[2]) + 1) + NOTE[m[1]]; };
const freqOf = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
const CHORD = { '': [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11] };
const chordNotes = (name) => { const m = /^([A-G][#b]?)(m7|maj7|m|7)?$/.exec(name); return { root: NOTE[m[1]], tones: CHORD[m[2] || ''] }; };

function tracker(song) {
  const R = MUSIC_RATE, beat = 60 / song.bpm, swing = song.swing || 0.5;
  const bars = song.bars.length, passes = 2;
  const barLen = beat * 4, total = barLen * bars * passes;
  const out = new Float64Array(Math.ceil(total * R));
  // Start time of eighth step k within a bar (swung pairs).
  const stepT = (k) => Math.floor(k / 2) * beat + (k % 2 ? beat * swing : 0);
  const stepLen = (k) => (k % 2 ? beat * (1 - swing) : beat * swing);
  const add = (t0, dur, f) => {
    const i0 = Math.max(0, Math.floor(t0 * R)), i1 = Math.min(out.length, Math.floor((t0 + dur) * R));
    for (let i = i0; i < i1; i++) out[i] += f(i / R - t0, i);
  };
  const pulse = (freq, duty, vol, dur, vib) => (t) => {
    const env = Math.min(1, t / 0.004) * (0.75 + 0.25 * Math.exp(-t * 6)) * Math.min(1, (dur - t) / 0.02);
    const f = freq * (1 + (vib && t > 0.18 ? 0.006 * Math.sin(2 * Math.PI * 5.5 * t) : 0));
    return ((t * f) % 1 < duty ? 1 : -1) * vol * env;
  };
  const tri = (freq, vol, dur) => (t) => {
    const ph = (t * freq) % 1, env = Math.min(1, t / 0.003) * Math.min(1, (dur - t) / 0.015);
    // NES-like stepped triangle (16 levels).
    return (Math.round((ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph) * 7.5) / 7.5) * vol * env;
  };
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x80000000 - 1);
  const hat = (vol) => (t) => rnd() * vol * Math.exp(-t * 90);
  const snare = (vol) => (t) => (rnd() * 0.8 + Math.sin(2 * Math.PI * 180 * t) * 0.4) * vol * Math.exp(-t * 22);
  const kick = (vol) => (t) => Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-t * 30)) * t) * vol * Math.exp(-t * 14);

  for (let pass = 0; pass < passes; pass++) {
    for (let b = 0; b < bars; b++) {
      const t0 = (pass * bars + b) * barLen;
      const [chordName, line] = song.bars[b];
      const ch = chordNotes(chordName);
      // Lead: notes with holds.
      const steps = line.trim().split(/\s+/);
      for (let k = 0; k < steps.length; k++) {
        const tok = steps[k];
        if (tok === '-' || tok === '.') continue;
        let len = stepLen(k), j = k + 1;
        while (j < steps.length && steps[j] === '-') { len += stepLen(j); j++; }
        const midi = midiOf(tok) + (song.transpose || 0);
        add(t0 + stepT(k), len * 0.95, pulse(freqOf(midi), 0.25, song.lead || 0.2, len * 0.95, true));
        if (pass === 1) add(t0 + stepT(k), len * 0.9, pulse(freqOf(midi - 12), 0.125, 0.09, len * 0.9, false));
      }
      const rootMidi = 36 + ch.root + (song.transpose || 0);
      for (let q = 0; q < 4; q++) {
        const tq = t0 + q * beat;
        // Bass: root on 1 and 3, the fifth on 2 and 4 (oom-pah).
        const bn = rootMidi + (q % 2 ? 7 : 0) - (ch.root > 6 ? 12 : 0);
        add(tq, beat * 0.85, tri(freqOf(bn), 0.3, beat * 0.85));
        // Chord stabs on the off-beats, arpeggiated fast (a pulse can only play one note).
        if (pass === 0) {
          const ts = tq + beat * swing, dur = beat * (1 - swing) * 0.9;
          add(ts, dur, (t, i) => {
            const n = ch.tones[Math.floor(t / 0.03) % ch.tones.length];
            return pulse(freqOf(60 + ch.root + n + (song.transpose || 0) - (ch.root > 7 ? 12 : 0)), 0.125, 0.08, dur, false)(t);
          });
        }
        // Drums: kick on 1 and 3, snare on 2 and 4, hats on the off-beats.
        add(tq, 0.25, q % 2 ? snare(song.drums || 0.12) : kick((song.drums || 0.12) * 1.8));
        add(tq + beat * swing, 0.06, hat((song.drums || 0.12) * 0.5));
      }
    }
  }
  // Soft limit.
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i] * 1.2) * 0.9;
  return out;
}

// Three original tunes, in the spirit of TTD's jazzy soundtrack.
const SONGS = {
  // Bright and swung, C major.
  'music_rails.wav': { bpm: 138, swing: 0.6, bars: [
    ['C', 'E5 - G5 - C6 - B5 A5'], ['C', 'G5 - - - E5 - C5 -'], ['F', 'F5 - A5 - C6 - A5 F5'], ['C', 'E5 - - - . . G5 -'],
    ['G', 'D5 - G5 - B5 - A5 G5'], ['G7', 'F5 - D5 - B4 - G4 -'], ['C', 'C5 E5 G5 C6 B5 G5 E5 C5'], ['C', 'D5 - - - . . G5 G5'],
    ['Am', 'A5 - C6 - E6 - C6 A5'], ['Em', 'G5 - - - E5 - B4 -'], ['F', 'C5 - F5 - A5 - C6 A5'], ['C', 'G5 - E5 - C5 - . G5'],
    ['Dm', 'F5 - A5 - D6 - C6 A5'], ['G', 'B5 - - - G5 - D5 -'], ['C', 'E5 G5 C6 - G5 E5 C5 -'], ['G', 'D5 - B4 - G4 - . .'],
  ] },
  // Slow and moody, A minor.
  'music_night.wav': { bpm: 112, swing: 0.5, lead: 0.18, drums: 0.09, bars: [
    ['Am', 'A4 - - C5 E5 - - D5'], ['Am', 'C5 - B4 - A4 - - -'], ['Dm', 'D5 - - F5 A5 - - G5'], ['Am', 'E5 - - - . . . .'],
    ['F', 'F5 - E5 - D5 - C5 -'], ['G', 'B4 - C5 - D5 - G5 -'], ['E', 'G#5 - - - E5 - - -'], ['E7', 'D5 - - - B4 - G#4 -'],
    ['Am', 'A4 - C5 - E5 - A5 -'], ['Am', 'G5 - E5 - C5 - E5 -'], ['Dm', 'F5 - - - D5 - A4 -'], ['Dm', 'F5 - E5 - D5 - C5 -'],
    ['F', 'C5 - A4 - F4 - A4 -'], ['E', 'B4 - - - G#4 - B4 -'], ['Am', 'A4 - - - - - . .'], ['E', 'E5 - D5 - C5 - B4 -'],
  ] },
  // A ragtime romp, F major.
  'music_rag.wav': { bpm: 150, swing: 0.64, bars: [
    ['F', 'A5 - . A5 C6 - A5 F5'], ['F', 'G5 A5 - F5 - . C5 -'], ['C7', 'E5 - G5 - Bb5 - G5 E5'], ['C7', 'C5 - - - . . C5 D5'],
    ['F', 'F5 - A5 - C6 - D6 C6'], ['F7', 'A5 - Eb5 - F5 - A5 -'], ['Bb', 'Bb5 - D6 - F6 - D6 Bb5'], ['Bb', 'A5 G5 F5 - D5 - . .'],
    ['F', 'C5 F5 A5 - C6 - A5 -'], ['D7', 'F#5 - A5 - D6 - C6 A5'], ['Gm', 'G5 - Bb5 - D6 - Bb5 G5'], ['C7', 'E5 - G5 - C6 - Bb5 G5'],
    ['F', 'A5 - F5 - C5 - F5 A5'], ['C7', 'G5 - E5 - C5 - E5 G5'], ['F', 'F5 - A5 - C6 - A5 -'], ['F', 'F5 - - - . . . .'],
  ] },
};

// Samples −1..1 -> the bytes of a WAV file: 16-bit at RATE, or 8-bit unsigned at `rate`.
function writeWav(samples, rate, bits) {
  rate = rate || RATE;
  bits = bits || 16;
  const bps = bits / 8;
  const data = Buffer.alloc(samples.length * bps);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    if (bits === 8) data.writeUInt8(Math.round(v * 127) + 128, i);
    else data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);          // fmt chunk size
  head.writeUInt16LE(1, 20);           // PCM
  head.writeUInt16LE(1, 22);           // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * bps, 28);  // bytes per second
  head.writeUInt16LE(bps, 32);         // bytes per sample frame
  head.writeUInt16LE(bits, 34);        // bits
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
    ...Object.fromEntries(Object.entries(SONGS).map(([name, song]) => [name, writeWav(tracker(song), MUSIC_RATE, 8)])),
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
      const secs = (bytes.length - 44) / bytes.readUInt32LE(28);   // data bytes / bytes per second
      console.log(`${path.relative(ROOT, file).split(path.sep).join('/')}: ${bytes.length} bytes, ${secs.toFixed(2)} s`);
    }
  }
  if (check) process.exit(differs ? 1 : 0);
}
