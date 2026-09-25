// Original CacheBell sounds, synthesized from scratch under the project's MIT license.
// The animal recordings are bundled separately; do not overwrite them here.
// Development-only generator; the plugin will play the resulting PCM WAV files.
import { mkdirSync, writeFileSync } from "node:fs";

const rate = 44_100;
const tau = 2 * Math.PI;
const output = new URL("../sounds/", import.meta.url);
mkdirSync(output, { recursive: true });

function bell(t, frequency) {
  if (t < 0) return 0;
  const attack = 1 - Math.exp(-t * 700);
  return attack * (
    Math.sin(tau * frequency * t) * Math.exp(-t * 6) +
    0.18 * Math.sin(tau * frequency * 2.01 * t) * Math.exp(-t * 12) +
    0.07 * Math.sin(tau * frequency * 2.76 * t) * Math.exp(-t * 20)
  );
}

function pulse(t, frequency, duration) {
  if (t < 0 || t > duration) return 0;
  const envelope = Math.sin(Math.PI * t / duration) ** 2;
  return envelope * (
    Math.sin(tau * frequency * t) + 0.12 * Math.sin(tau * frequency * 2 * t)
  );
}

function knock(t) {
  if (t < 0) return 0;
  return (1 - Math.exp(-t * 1600)) * (
    Math.sin(tau * 330 * t) * Math.exp(-t * 42) +
    0.5 * Math.sin(tau * 720 * t) * Math.exp(-t * 65) +
    0.15 * Math.sin(tau * 1240 * t) * Math.exp(-t * 100)
  );
}

const sounds = [
  { name: "chime", duration: 0.95, sample: (t) =>
    bell(t, 659.25) + 0.8 * bell(t - 0.18, 987.77) },
  { name: "pulse", duration: 0.55, sample: (t) =>
    pulse(t, 440, 0.09) + pulse(t - 0.12, 660, 0.09) +
    0.8 * pulse(t - 0.24, 880, 0.17) },
  { name: "knock", duration: 0.5, sample: (t) =>
    knock(t) + 0.8 * knock(t - 0.16) },
];

for (const sound of sounds) {
  const samples = Float64Array.from({ length: Math.round(rate * sound.duration) }, (_, i) => {
    const t = i / rate;
    // A little leading silence and a final fade avoid start/end discontinuities.
    const fade = Math.min(1, (sound.duration - t) / 0.025);
    return sound.sample(t - 0.015) * fade;
  });
  const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const gain = 0.55 / peak;
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    wav.writeInt16LE(Math.round(samples[i] * gain * 32767), 44 + i * 2);
  }
  writeFileSync(new URL(`${sound.name}.wav`, output), wav);
  console.log(`${sound.name}: ${sound.duration}s, mono PCM16 / ${rate} Hz, peak -5.2 dBFS`);
}
