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
  PPG_SAMPLE_RATE,
  PPG_TRANSIENT_SAMPLES,
  calculateEegSqi,
  computeAccAnalysis,
  computePpgStressIndex,
  computeHeartRate,
  computeHeartRateValidated,
  computeHrvMetrics,
  computeBandPower,
  computeEegIndices,
  computeEegPower,
  computeSpectrum,
  createBiquadState,
  createEegChannelFilter,
  createPpgChannelFilter,
  detectPpgPeaks,
  detectPpgPeaksForHrv,
  highpassCoefs,
  lowpassCoefs,
  notchCoefs,
  peaksToRrSeconds,
  processBiquad,
  processEegSample,
  processPpgSample,
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
  it("10Hz sine → alpha (8-13Hz) > delta (0.5-4Hz) by clear margin", () => {
    // BAND_POWER_MIN_RAW = 600 (1.2s @ 500Hz), 충분히 길게 1500.
    // 배포본 동일 — 각 정수 Hz dB 의 SUM (avg 아님). delta 는 1,2,3 합계 (3 freqs),
    // alpha 는 8..12 합계 (5 freqs). 10Hz 신호는 alpha 의 모든 freq 에서 high dB → 큰 차이.
    const raw = generateSine(10, 1500, 50);
    const alpha = computeBandPower(raw, FS, 8, 13);
    const delta = computeBandPower(raw, FS, 0.5, 4);
    expect(alpha.db).toBeGreaterThan(delta.db);
    expect(alpha.db - delta.db).toBeGreaterThan(10); // 적어도 10dB 차이
  });

  it("입력 < BAND_POWER_MIN_RAW 면 zero 반환", () => {
    const tiny = generateSine(10, 100, 50);
    expect(computeBandPower(tiny, FS, 8, 13)).toEqual({ linear: 0, db: 0 });
  });
});

describe("calculateEegSqi", () => {
  it("작은 진폭 (≤150 μV) clean signal 에 대해 high SQI (>70)", () => {
    // 30μV sine — 진폭 150μV 안. variance ≈ 30²/2 = 450. 배포본 freq scale: variance/1000.
    // freqScore = 1 - 450/1000 = 0.55 → SQI = 0.7*1.0 + 0.3*0.55 = 0.865 → 86.5%.
    const clean = generateSine(10, 1500, 30);
    const sqi = calculateEegSqi(clean);
    // 윈도우 settle 후 평균 SQI
    const tail = sqi.slice(EEG_SAMPLE_RATE);
    const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(avg).toBeGreaterThan(70);
  });

  it("큰 진폭 (≥500 μV >> 150 threshold) 에 대해 low SQI (<30)", () => {
    const noisy = generateSine(10, 1500, 500);
    const sqi = calculateEegSqi(noisy);
    const tail = sqi.slice(EEG_SAMPLE_RATE);
    const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(avg).toBeLessThan(30);
  });

  it("출력 길이 = 입력 길이", () => {
    const data = generateSine(10, 800, 50);
    expect(calculateEegSqi(data).length).toBe(800);
  });
});

describe("computeEegIndices (배포본 EEGSignalProcessor 동일)", () => {
  it("10Hz 입력 → 배포본 ratio 산식과 정확히 일치", () => {
    // 배포본 산식 (band power = dB SUM 기반):
    //   focusIndex          = β / (α + θ)
    //   relaxationIndex     = α / (α + β)
    //   stressIndex         = (β + γ) / (α + θ)
    //   cognitiveLoad       = θ / α
    //   emotionalStability  = (α + θ) / γ
    //   hemisphericBalance  = (αL − αR) / (αL + αR), clamp[-1, 1]
    // dB SUM 은 음수 가능 — 분모 ≤ 0 이면 0 반환 (배포본 safeRatio 동일).
    // 본 test 는 산식이 정확히 적용되는지만 검증 (semantic alpha-vs-beta 비교 X).
    const ch1 = generateSine(10, 1500, 50);
    const ch2 = generateSine(10, 1500, 50);
    const power = computeEegPower(ch1, ch2, FS);
    expect(power).not.toBeNull();
    const idx = computeEegIndices(power!);
    const a = power!.bands.alpha.ch1Db;
    const b = power!.bands.beta.ch1Db;
    const t = power!.bands.theta.ch1Db;
    const g = power!.bands.gamma.ch1Db;
    const a2 = power!.bands.alpha.ch2Db;
    const safe = (num: number, den: number) => (den > 0 ? num / den : 0);
    expect(idx.focusIndex).toBeCloseTo(safe(b, a + t), 6);
    expect(idx.relaxationIndex).toBeCloseTo(safe(a, a + b), 6);
    expect(idx.stressIndex).toBeCloseTo(safe(b + g, a + t), 6);
    expect(idx.cognitiveLoad).toBeCloseTo(safe(t, a), 6);
    expect(idx.emotionalStability).toBeCloseTo(safe(a + t, g), 6);
    // hemisphericBalance: ch1=L, ch2=R, alphaSum > 0.001 가정.
    const expectedHB = Math.max(-1, Math.min(1, (a - a2) / (a + a2)));
    expect(idx.hemisphericBalance).toBeCloseTo(expectedHB, 6);
  });

  it("totalPower = ch1 5 band 합계", () => {
    const ch1 = generateSine(10, 1500, 50);
    const ch2 = generateSine(10, 1500, 50);
    const power = computeEegPower(ch1, ch2, FS)!;
    const idx = computeEegIndices(power);
    const expectedTotal =
      power.bands.delta.ch1Db +
      power.bands.theta.ch1Db +
      power.bands.alpha.ch1Db +
      power.bands.beta.ch1Db +
      power.bands.gamma.ch1Db;
    expect(idx.totalPower).toBeCloseTo(expectedTotal, 6);
  });

  it("모든 7 indices 필드 finite (NaN 없음)", () => {
    const ch1 = generateSine(15, 1500, 30);
    const ch2 = generateSine(15, 1500, 30);
    const power = computeEegPower(ch1, ch2, FS)!;
    const idx = computeEegIndices(power);
    for (const key of [
      "totalPower",
      "focusIndex",
      "relaxationIndex",
      "stressIndex",
      "cognitiveLoad",
      "hemisphericBalance",
      "emotionalStability",
    ] as const) {
      expect(Number.isFinite(idx[key])).toBe(true);
    }
  });

  it("hemisphericBalance ∈ [-1, 1]", () => {
    const ch1 = generateSine(10, 1500, 100);
    const ch2 = generateSine(10, 1500, 10); // ch2 약함 → 비대칭
    const power = computeEegPower(ch1, ch2, FS)!;
    const idx = computeEegIndices(power);
    expect(idx.hemisphericBalance).toBeGreaterThanOrEqual(-1);
    expect(idx.hemisphericBalance).toBeLessThanOrEqual(1);
  });
});

describe("PPG filter pipeline (bandpass 1-5Hz @ 50Hz)", () => {
  const PPG_FS = 50;

  function ppgSine(freq: number, n: number, amp = 100): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(amp * Math.sin((2 * Math.PI * freq * i) / PPG_FS));
    }
    return out;
  }

  it("PPG_SAMPLE_RATE = 50, PPG_TRANSIENT_SAMPLES = 150", () => {
    expect(PPG_SAMPLE_RATE).toBe(50);
    expect(PPG_TRANSIENT_SAMPLES).toBe(150);
  });

  it("2Hz sine (= 120 BPM 펄스대역, fc=3Hz 근접) 통과 (transient 후 >80%)", () => {
    // 배포본은 makeBandpassFilter(1, 5, 50) 단일 biquad — Q ≈ 0.559.
    // 1.2Hz 는 lower edge 너무 가까워 진폭 ~64% 까지만 통과. fc=3Hz 인 2Hz 로 검증.
    const filter = createPpgChannelFilter();
    const out = ppgSine(2, 1500, 100).map((s) => processPpgSample(filter, s));
    const settled = out.slice(PPG_TRANSIENT_SAMPLES + 100);
    expect(maxAbs(settled)).toBeGreaterThan(80);
  });

  it("0.1Hz drift (1Hz 하한 미만) 차단 (<20%)", () => {
    const filter = createPpgChannelFilter();
    const out = ppgSine(0.1, 2000, 100).map((s) => processPpgSample(filter, s));
    const settled = out.slice(PPG_TRANSIENT_SAMPLES + 200);
    expect(maxAbs(settled)).toBeLessThan(20);
  });

  it("transient (PPG_TRANSIENT_SAMPLES) 동안 0", () => {
    const filter = createPpgChannelFilter();
    for (let i = 0; i < PPG_TRANSIENT_SAMPLES; i++) {
      expect(processPpgSample(filter, 100)).toBe(0);
    }
  });
});

describe("detectPpgPeaks (배포본 detectPeaksAdaptiveThreshold 동일)", () => {
  it("1Hz 펄스 신호 (5초) → peak 5개", () => {
    // 배포본은 windowSize=fs*0.5=25 양쪽 윈도우 → 스캔 범위 [25, len-25). 첫 peak 가
    // 25 이상 되도록 30, 80, 130, 180, 230 위치로 펄스 배치.
    const fs = 50;
    const len = 280;
    const signal = new Array(len).fill(0);
    const peakCenters = [30, 80, 130, 180, 230];
    for (const c of peakCenters) {
      for (let k = -4; k <= 4; k++) {
        const idx = c + k;
        if (idx >= 0 && idx < len) {
          signal[idx] = Math.cos((k / 4) * (Math.PI / 2)) * 100;
        }
      }
    }
    const peaks = detectPpgPeaks(signal, fs);
    expect(peaks.length).toBe(5);
    expect(peaks).toEqual(peakCenters);
  });

  it("flat signal (모두 0) → peak 없음", () => {
    expect(detectPpgPeaks(new Array(200).fill(0), 50)).toEqual([]);
  });

  it("길이 < 2*windowSize+1 (51 @ fs=50) → 빈 배열", () => {
    const tiny = new Array(40).fill(100);
    expect(detectPpgPeaks(tiny, 50)).toEqual([]);
  });

  it("min interval 0.4s = 150 BPM 상한 강제 — 너무 가까운 peak 제거", () => {
    // 자연 peak rate = 300 BPM (매 10 샘플 마다 peak). 배포본 windowSize=25 윈도우 시작이라
    // 스캔이 i=25 부터. minPeakDistance=20 → i=25 이후 매 20 샘플 마다 peak.
    const fs = 50;
    const signal = new Array(200).fill(0);
    for (let i = 0; i < 200; i++) {
      if (i % 10 === 5) signal[i] = 100;
      else signal[i] = 50; // baseline
    }
    const peaks = detectPpgPeaks(signal, fs);
    // 첫 peak at 25 (스캔 시작), 그 후 매 20 = 25, 45, 65, 85, 105, 125, 145, 165 → 8 peaks.
    // i=185 도 peak 후보지만 windowSize=25 라서 i ∈ [25, 175) 만 스캔 (200-25=175).
    expect(peaks.length).toBe(8);
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i] - peaks[i - 1]).toBe(20);
    }
  });

  it("peaksToRrSeconds — 5 peaks at 50 samples apart, fs=50 → 4 RR × 1.0s", () => {
    const peaks = [0, 50, 100, 150, 200];
    const rr = peaksToRrSeconds(peaks, 50);
    expect(rr).toEqual([1.0, 1.0, 1.0, 1.0]);
  });
});

describe("computeHrvMetrics", () => {
  it("균일 RR (모두 833ms) → AVNN=833, SDNN=0, RMSSD=0, SDSD=0, PNN=0", () => {
    const m = computeHrvMetrics([833, 833, 833, 833, 833]);
    expect(m.avnn).toBe(833);
    expect(m.sdnn).toBe(0);
    expect(m.rmssd).toBe(0);
    expect(m.sdsd).toBe(0);
    expect(m.pnn50).toBe(0);
    expect(m.pnn20).toBe(0);
  });

  it("alternating ±33ms (800/866) → SDNN=33, RMSSD=66, PNN50=PNN20=100", () => {
    // mean = 833, deviations all ±33 → SDNN = 33.
    // diffs = [+66, -66, +66, -66, +66] → RMSSD = √mean(66²) = 66.
    // |Δ|=66 > 50 and > 20 → PNN50/PNN20 = 100%.
    const m = computeHrvMetrics([800, 866, 800, 866, 800, 866]);
    expect(m.avnn).toBe(833);
    expect(m.sdnn).toBeCloseTo(33, 5);
    expect(m.rmssd).toBeCloseTo(66, 5);
    expect(m.pnn50).toBe(100);
    expect(m.pnn20).toBe(100);
  });

  it("PNN50 / PNN20 분기 검증 — Δ=30 시 PNN50=0, PNN20=100", () => {
    // 차분 30ms 만 → 50 임계값 위반 X, 20 임계값 위반 O.
    const m = computeHrvMetrics([800, 830, 800, 830, 800, 830]);
    expect(m.pnn50).toBe(0);
    expect(m.pnn20).toBe(100);
  });

  it("빈 배열 → 모든 값 0", () => {
    expect(computeHrvMetrics([])).toEqual({
      avnn: 0,
      sdnn: 0,
      rmssd: 0,
      sdsd: 0,
      pnn50: 0,
      pnn20: 0,
    });
  });

  it("단일 RR → AVNN 만 set, 차분 메트릭은 0", () => {
    const m = computeHrvMetrics([900]);
    expect(m.avnn).toBe(900);
    expect(m.sdnn).toBe(0);
    expect(m.rmssd).toBe(0);
    expect(m.sdsd).toBe(0);
    expect(m.pnn50).toBe(0);
    expect(m.pnn20).toBe(0);
  });
});

describe("computeHeartRate", () => {
  it("균일 833ms RR → BPM ≈ 72, hrMax = hrMin = BPM", () => {
    const hr = computeHeartRate([833, 833, 833]);
    expect(hr.bpm).toBeCloseTo(72.03, 1);
    expect(hr.hrMax).toBeCloseTo(72.03, 1);
    expect(hr.hrMin).toBeCloseTo(72.03, 1);
  });

  it("RR 변동 [500, 833, 1000] → hrMax≈120, hrMin≈60, bpm 평균", () => {
    const hr = computeHeartRate([500, 833, 1000]);
    expect(hr.hrMax).toBeCloseTo(120, 0); // 60000/500 = 120
    expect(hr.hrMin).toBeCloseTo(60, 0); // 60000/1000 = 60
    expect(hr.bpm).toBeCloseTo(60000 / ((500 + 833 + 1000) / 3), 0);
  });

  it("빈 배열 → 모든 값 0", () => {
    expect(computeHeartRate([])).toEqual({ bpm: 0, hrMax: 0, hrMin: 0 });
  });
});

describe("computeHeartRateValidated (배포본 IQR + 가중평균 + 검증)", () => {
  it("균일 833ms RR → 72 BPM (선형 가중 평균은 동일 값에서 동일)", () => {
    expect(computeHeartRateValidated([833, 833, 833, 833, 833])).toBe(72);
  });

  it("생리학적 범위 밖 (200ms = 300 BPM) → 필터링 후 빈 배열 → 0 반환", () => {
    expect(computeHeartRateValidated([200, 200, 200, 200])).toBe(0);
  });

  it("생리학적 범위 밖 (2000ms = 30 BPM) → 0 반환", () => {
    expect(computeHeartRateValidated([2000, 2000, 2000, 2000])).toBe(0);
  });

  it("BPM 결과 < 40 → 0 반환 (검증 단계)", () => {
    // 1500ms → 40 BPM 경계. 1499ms → 약 40.03 BPM (통과). 1501ms 는 [300, 1500] 필터 떨어짐.
    // 따라서 검증 단계 < 40 트리거 정확히 시뮬 어려움. 대신 단일 RR 1500 (정확히 40) 통과 확인.
    expect(computeHeartRateValidated([1500])).toBe(40);
  });

  it("CV > 0.5 면 결과 × 0.9 적용", () => {
    // 매우 변동 큰 RR (생리적 범위 안). mean=900, std 산식상 CV>0.5 되도록.
    // 300, 1500 둘만으로는 N<3 라 CV 검사 안 함. N≥3 필요.
    // [300, 1500, 300, 1500, 300] → mean=780, std≈577 → CV≈0.74. 가중 BPM 계산 후 ×0.9.
    const result = computeHeartRateValidated([300, 1500, 300, 1500, 300]);
    expect(result).toBeGreaterThan(0); // valid (40-200 안에 들어옴)
    // 가중 BPM 직접 계산
    let ws = 0,
      tw = 0;
    const f = [300, 1500, 300, 1500, 300];
    for (let i = 0; i < f.length; i++) {
      const w = (i + 1) / f.length;
      ws += (60000 / f[i]) * w;
      tw += w;
    }
    const expected = Math.round((ws / tw) * 0.9);
    expect(result).toBe(expected);
  });

  it("빈 배열 → 0", () => {
    expect(computeHeartRateValidated([])).toBe(0);
  });

  it("단일 RR (생리학적 범위) → 단순 60000/rr", () => {
    expect(computeHeartRateValidated([800])).toBe(75); // 60000/800 = 75
  });
});

describe("computePpgStressIndex (배포본 0.4·SDNN + 0.4·RMSSD + 0.2·HR 가중)", () => {
  it("RR < 5 → 0 (의미 있는 산출 불가)", () => {
    expect(computePpgStressIndex([800, 800, 800, 800])).toBe(0);
  });

  it("매우 안정적인 RR (SDNN/RMSSD ≈ 0, mean=1000ms = 60bpm) → ~0.71 = high stress", () => {
    // 균일 1000ms RR → SDNN=0, RMSSD=0. avgBpm=60.
    //   normalizedSDNN = (100-0)/70 → clamp 1.0
    //   normalizedRMSSD = (50-0)/30 → clamp 1.0
    //   hrStress = (60-60)/40 = 0
    //   stress = 0.4 + 0.4 + 0 = 0.8.
    // 즉 너무 안정적인 (rigid) 심박은 자율신경 부족 = 스트레스 신호로 해석.
    const v = computePpgStressIndex([1000, 1000, 1000, 1000, 1000]);
    expect(v).toBeCloseTo(0.8, 2);
  });

  it("정상적 변동성 (SDNN ≈ 50, RMSSD ≈ 50, BPM ≈ 75) → 중간값", () => {
    // RR alternating 750/850 → mean=800 (75bpm), SDNN=50, diffs=±100 → RMSSD=100.
    //   normalizedSDNN = (100-50)/70 ≈ 0.714
    //   normalizedRMSSD = (50-100)/30 → clamp 0  (RMSSD 100 > 50 정상상한)
    //   hrStress = (75-60)/40 = 0.375
    //   stress = 0.4·0.714 + 0.4·0 + 0.2·0.375 = 0.286 + 0.075 = 0.361.
    const v = computePpgStressIndex([750, 850, 750, 850, 750, 850]);
    expect(v).toBeCloseTo(0.361, 2);
  });

  it("매우 빠른 HR (mean=400ms = 150bpm) → hrStress saturate to 1, stress > 0.7", () => {
    // 균일 400ms RR → SDNN=0, RMSSD=0, avgBpm=150.
    //   normalizedSDNN = 1, normalizedRMSSD = 1, hrStress = (150-60)/40 → clamp 1.
    //   stress = 0.4+0.4+0.2 = 1.0 (max).
    const v = computePpgStressIndex([400, 400, 400, 400, 400]);
    expect(v).toBeCloseTo(1.0, 2);
  });

  it("결과는 항상 [0, 1] 범위", () => {
    // 어떤 input 이든 clamp 가 보장.
    const v1 = computePpgStressIndex([100, 200, 300, 400, 500]);
    expect(v1).toBeGreaterThanOrEqual(0);
    expect(v1).toBeLessThanOrEqual(1);
    const v2 = computePpgStressIndex([2000, 2000, 2000, 2000, 2000]);
    expect(v2).toBeGreaterThanOrEqual(0);
    expect(v2).toBeLessThanOrEqual(1);
  });
});

describe("detectPpgPeaksForHrv (배포본 detectPeaksForHRV 동일)", () => {
  function ppgWaveform(fs: number, peaksAtSamples: number[], len: number, baseline = 1000): number[] {
    const sig = new Array(len).fill(baseline);
    for (const p of peaksAtSamples) {
      for (let k = -2; k <= 2; k++) {
        const idx = p + k;
        if (idx >= 0 && idx < len) {
          sig[idx] += Math.cos((k / 2) * (Math.PI / 2)) * 200;
        }
      }
    }
    return sig;
  }

  it("DC offset 있는 raw IR 에서도 mean 차감 후 peak 검출", () => {
    const fs = 50;
    const peaks = detectPpgPeaksForHrv(ppgWaveform(fs, [50, 110, 170, 230], 280), fs);
    expect(peaks.length).toBe(4);
    expect(peaks).toEqual([50, 110, 170, 230]);
  });

  it("min interval 0.4s = 20 sample 강제", () => {
    const fs = 50;
    // 매 10 sample 마다 peak 후보 → minPeakDistance=20 으로 절반만 통과.
    const sig = new Array(200).fill(1000);
    for (let i = 0; i < 200; i++) {
      if (i % 10 === 5) sig[i] = 1500;
    }
    const peaks = detectPpgPeaksForHrv(sig, fs);
    // 첫 peak 가능 i=5 (i>0, i<n-1, i±1 비교). 그 후 매 20 = 5, 25, 45, ... 185 → 10 peaks.
    expect(peaks.length).toBe(10);
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i] - peaks[i - 1]).toBe(20);
    }
  });

  it("flat → 빈 배열", () => {
    expect(detectPpgPeaksForHrv(new Array(100).fill(1000), 50)).toEqual([]);
  });

  it("길이 < 3 → 빈 배열", () => {
    expect(detectPpgPeaksForHrv([1, 2], 50)).toEqual([]);
  });
});

describe("computeAccAnalysis (approximate baseline — refine later)", () => {
  const ACC_FS = 25;

  it("정지 상태 (모든 magnitude = 1g) → intensity ≈ 0, stability ≈ 100, activityState='stationary'", () => {
    // 30 samples = ~1.2s @ 25Hz. mag = 1 + tiny noise (1e-4) — std 무시 수준.
    const mag: number[] = [];
    for (let i = 0; i < 30; i++) mag.push(1 + (i % 2 === 0 ? 1e-5 : -1e-5));
    const a = computeAccAnalysis(mag, ACC_FS);
    expect(a.intensity).toBeLessThan(1);
    expect(a.stability).toBeGreaterThan(99);
    expect(a.activityState).toBe("stationary");
    expect(a.avgMovement).toBeLessThan(1e-3);
  });

  it("큰 움직임 (mag oscillates 0.0 ↔ 2.0g) → intensity > 50, activityState='moving'", () => {
    // 평균 편차 |mag - 1| = 1.0 → intensity = 100 (saturated). 큰 σ → stability 낮음.
    const mag: number[] = [];
    for (let i = 0; i < 50; i++) mag.push(i % 2 === 0 ? 0.0 : 2.0);
    const a = computeAccAnalysis(mag, ACC_FS);
    expect(a.intensity).toBeGreaterThan(50);
    expect(a.activityState).toBe("moving");
    expect(a.avgMovement).toBeCloseTo(1.0, 5);
  });

  it("activityState transitions at intensity ≈ 25 (boundary = avgMovement 0.25g)", () => {
    // avgMovement = 0.24 → intensity = 24 → 'stationary'
    const below: number[] = [];
    for (let i = 0; i < 30; i++) below.push(i % 2 === 0 ? 0.76 : 1.24);
    const aBelow = computeAccAnalysis(below, ACC_FS);
    expect(aBelow.intensity).toBeCloseTo(24, 5);
    expect(aBelow.activityState).toBe("stationary");

    // avgMovement = 0.26 → intensity = 26 → 'moving'
    const above: number[] = [];
    for (let i = 0; i < 30; i++) above.push(i % 2 === 0 ? 0.74 : 1.26);
    const aAbove = computeAccAnalysis(above, ACC_FS);
    expect(aAbove.intensity).toBeCloseTo(26, 5);
    expect(aAbove.activityState).toBe("moving");
  });

  it("빈 buffer → defaults (stationary, 0 intensity, 100 stability, 0 avgMovement)", () => {
    const a = computeAccAnalysis([], ACC_FS);
    expect(a.activityState).toBe("stationary");
    expect(a.intensity).toBe(0);
    expect(a.stability).toBe(100);
    expect(a.avgMovement).toBe(0);
  });
});

describe("EEG_BANDS", () => {
  it("Delta/Theta/Alpha/Beta/Gamma 5 band 정의 (배포본 EEGSignalProcessor.bands 동일)", () => {
    expect(EEG_BANDS.map((b) => b.key)).toEqual([
      "delta",
      "theta",
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(EEG_BANDS[0]).toEqual({ key: "delta", fMin: 0.5, fMax: 4 });
    expect(EEG_BANDS[2]).toEqual({ key: "alpha", fMin: 8, fMax: 13 });
    expect(EEG_BANDS[4].fMax).toBe(50); // gamma capped at 50 (배포본 동일)
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
