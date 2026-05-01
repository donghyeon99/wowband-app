/**
 * DSP unit tests — biquad primitives + EEG filter cascade.
 *
 * sensor-dashboard `src/lib/dsp/{biquad,eegPipeline}.ts` 와 numerical 등가성을
 * 검증하는 게 아니라 **filter 의도대로 동작** (notch 가 60Hz 차단, LP 가 200Hz 차단
 * 등) 만 검증. fs 차이 (250 → 500) 가 우리 포팅에 정확히 반영됐는지 확인.
 */
import { describe, expect, it } from "vitest";

import {
  type BiquadCoefs,
  EEG_BANDS,
  EEG_SAMPLE_RATE,
  EEG_TRANSIENT_SAMPLES,
  computeBandPower,
  computeSpectrum,
  createBiquadState,
  createEegChannelFilter,
  highpassCoefs,
  lowpassCoefs,
  notchCoefs,
  processBiquad,
  processEegSample,
} from "../src/linkband/dsp";

const FS = EEG_SAMPLE_RATE;

function generateSine(freq: number, n: number, amplitude = 100): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(amplitude * Math.sin((2 * Math.PI * freq * i) / FS));
  }
  return out;
}

function applyFilter(coefs: BiquadCoefs, input: number[]): number[] {
  const state = createBiquadState();
  return input.map((x) => processBiquad(coefs, state, x));
}

function maxAbs(arr: number[]): number {
  let m = 0;
  for (const v of arr) {
    const a = Math.abs(v);
    if (a > m) m = a;
  }
  return m;
}

describe("DSP fs (spec §7, §17 Q7)", () => {
  it("EEG_SAMPLE_RATE = 500 (실측 확정값, Kotlin SDK 의 250 X)", () => {
    expect(EEG_SAMPLE_RATE).toBe(500);
  });

  it("EEG_TRANSIENT_SAMPLES = 500 (1초 settling, fs 와 1:1)", () => {
    expect(EEG_TRANSIENT_SAMPLES).toBe(500);
  });
});

describe("notch (60Hz, Q=2)", () => {
  it("60Hz sine 을 <20% 진폭으로 감쇠", () => {
    const coefs = notchCoefs(FS, 60, 2);
    const filtered = applyFilter(coefs, generateSine(60, 2000, 100));
    expect(maxAbs(filtered.slice(1000))).toBeLessThan(20);
  });

  it("10Hz sine 은 거의 통과 (>80% 진폭 유지)", () => {
    const coefs = notchCoefs(FS, 60, 2);
    const filtered = applyFilter(coefs, generateSine(10, 2000, 100));
    expect(maxAbs(filtered.slice(500))).toBeGreaterThan(80);
  });
});

describe("highpass (1Hz, Butterworth)", () => {
  it("DC offset 제거 (50 평탄 입력 → settle 후 ~0)", () => {
    const coefs = highpassCoefs(FS, 1, 1 / Math.SQRT2);
    const dc = new Array(2000).fill(50);
    const filtered = applyFilter(coefs, dc);
    expect(maxAbs(filtered.slice(1500))).toBeLessThan(5);
  });

  it("10Hz sine 거의 통과", () => {
    const coefs = highpassCoefs(FS, 1, 1 / Math.SQRT2);
    const filtered = applyFilter(coefs, generateSine(10, 2000, 100));
    expect(maxAbs(filtered.slice(500))).toBeGreaterThan(80);
  });
});

describe("lowpass (45Hz, Butterworth)", () => {
  it("10Hz sine 거의 통과", () => {
    const coefs = lowpassCoefs(FS, 45, 1 / Math.SQRT2);
    const filtered = applyFilter(coefs, generateSine(10, 2000, 100));
    expect(maxAbs(filtered.slice(500))).toBeGreaterThan(80);
  });

  it("200Hz sine 을 <15% 진폭으로 감쇠 (cutoff 의 ~4.4 octave 위)", () => {
    const coefs = lowpassCoefs(FS, 45, 1 / Math.SQRT2);
    const filtered = applyFilter(coefs, generateSine(200, 2000, 100));
    expect(maxAbs(filtered.slice(500))).toBeLessThan(15);
  });
});

describe("computeSpectrum (DFT)", () => {
  it("10Hz sine 입력 → spectrum peak 가 10Hz 근처", () => {
    const raw = generateSine(10, 1500, 50);
    const spec = computeSpectrum(raw, FS, 1, 45);
    expect(spec.length).toBe(45);
    let peak = spec[0];
    for (const p of spec) if (p[1] > peak[1]) peak = p;
    expect(peak[0]).toBeGreaterThanOrEqual(9);
    expect(peak[0]).toBeLessThanOrEqual(11);
  });

  it("입력 < MIN_SAMPLES (64) 이면 빈 배열", () => {
    const tiny = generateSine(10, 32, 50);
    expect(computeSpectrum(tiny, FS, 1, 45)).toEqual([]);
  });
});

describe("computeBandPower (Morlet on linkband-style filter)", () => {
  it("10Hz sine → alpha (8-13Hz) > delta (1-4Hz) by clear margin", () => {
    // BAND_POWER_MIN_RAW = 600 (1.2s @ 500Hz), 충분히 길게 1500.
    const raw = generateSine(10, 1500, 50);
    const alpha = computeBandPower(raw, FS, 8, 13);
    const delta = computeBandPower(raw, FS, 1, 4);
    expect(alpha.db).toBeGreaterThan(delta.db);
    expect(alpha.db - delta.db).toBeGreaterThan(10); // 적어도 10dB 차이
  });

  it("입력 < BAND_POWER_MIN_RAW 면 zero 반환", () => {
    const tiny = generateSine(10, 100, 50);
    expect(computeBandPower(tiny, FS, 8, 13)).toEqual({ linear: 0, db: 0 });
  });
});

describe("EEG_BANDS", () => {
  it("Delta/Theta/Alpha/Beta/Gamma 5 band 정의 (sensor-dashboard 동일)", () => {
    expect(EEG_BANDS.map((b) => b.key)).toEqual([
      "delta",
      "theta",
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(EEG_BANDS[2]).toEqual({ key: "alpha", fMin: 8, fMax: 13 });
    expect(EEG_BANDS[4].fMax).toBe(45); // gamma capped at 45 (not 50)
  });
});

describe("EEG channel cascade (notch → HP → LP)", () => {
  it("transient (처음 EEG_TRANSIENT_SAMPLES 샘플) 동안 0 반환", () => {
    const filter = createEegChannelFilter();
    for (let i = 0; i < EEG_TRANSIENT_SAMPLES; i++) {
      expect(processEegSample(filter, 100)).toBe(0);
    }
  });

  it("60Hz sine 차단 (transient 이후 <20% 진폭)", () => {
    const filter = createEegChannelFilter();
    const out = generateSine(60, 2500, 100).map((x) => processEegSample(filter, x));
    expect(maxAbs(out.slice(EEG_TRANSIENT_SAMPLES + 500))).toBeLessThan(20);
  });

  it("10Hz sine 통과 (transient 이후 >70% 진폭)", () => {
    const filter = createEegChannelFilter();
    const out = generateSine(10, 2500, 100).map((x) => processEegSample(filter, x));
    expect(maxAbs(out.slice(EEG_TRANSIENT_SAMPLES + 500))).toBeGreaterThan(70);
  });
});
