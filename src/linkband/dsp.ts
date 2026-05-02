/**
 * Link Band DSP — TS port of sensor-dashboard `src/lib/dsp/{biquad,eegPipeline,spectrum}.ts`.
 *
 * 단일 파일로 통합 — sensor-dashboard 의 3 파일 (`biquad.ts`, `eegPipeline.ts`,
 * `spectrum.ts`) 의 함수·상수를 한 곳에. SQI / 분석 지표 등도 추후 이 파일에 추가.
 *
 * **fs 차이 (중요)**: sensor-dashboard 는 `EEG_SAMPLE_RATE = 250` 가정.
 * 우리 spec §7 / §17 Q7 실측 확정값은 **500Hz**. 하드코드 250 직접 복사하면 모든
 * 필터 cutoff 가 절반 이상으로 어긋남. 본 포팅은 `EEG_SAMPLE_RATE = EEG_FS = 500`
 * 으로 갱신, 모든 시간-기반 상수 (transient 등) 같은 비율로 스케일.
 *
 * 본 commit 범위: biquad primitives + EEG 단일-샘플 필터 cascade (notch → HP → LP).
 * spectrum / SQI / indices 는 후속 commits.
 */
import { EEG_FS } from "./models";

// ─── Biquad primitives (sensor-dashboard `biquad.ts` 미러) ────────────────

export interface BiquadState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export interface BiquadCoefs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export const createBiquadState = (): BiquadState => ({ x1: 0, x2: 0, y1: 0, y2: 0 });

/** RBJ notch — `f0` 주변 좁은 stopband. Q 가 클수록 더 좁음. */
export function notchCoefs(sampleRate: number, f0: number, q: number): BiquadCoefs {
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: 1 / a0,
    b1: (-2 * cos) / a0,
    b2: 1 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** RBJ 2-pole highpass — `f0` 이하 차단. Butterworth 면 Q = 1/√2. */
export function highpassCoefs(sampleRate: number, f0: number, q: number): BiquadCoefs {
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cos) / 2) / a0,
    b1: (-(1 + cos)) / a0,
    b2: ((1 + cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** RBJ 2-pole lowpass — `f0` 이상 차단. */
export function lowpassCoefs(sampleRate: number, f0: number, q: number): BiquadCoefs {
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cos) / 2) / a0,
    b1: (1 - cos) / a0,
    b2: ((1 - cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** RBJ "constant 0 dB peak gain" bandpass — `f0` 중심 통과대. linkband Yf 와 호환. */
export function bandpassCoefs(sampleRate: number, f0: number, q: number): BiquadCoefs {
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** linkband Yf.calcBandpassQ — band-pass Q 산식. */
export function calcLinkbandBandpassQ(fLow: number, fHigh: number): number {
  const fc = (fLow + fHigh) / 2;
  const bw = fHigh - fc;
  const n = Math.pow(10, Math.floor(Math.log10(fc)));
  return (n * Math.sqrt((fc - bw) * (fc + bw))) / (2 * bw);
}

/** linkband Yf.calcNotchQ — notch Q 산식 (대역폭 `bw` 기반). */
export function calcLinkbandNotchQ(f0: number, bw: number): number {
  const n = Math.pow(10, Math.floor(Math.log10(f0)));
  return (n * f0 * bw) / Math.sqrt((f0 - bw) * (f0 + bw));
}

/** Direct-form II transposed biquad — 한 샘플 처리 후 state 갱신. */
export function processBiquad(coefs: BiquadCoefs, state: BiquadState, x: number): number {
  const y =
    coefs.b0 * x +
    coefs.b1 * state.x1 +
    coefs.b2 * state.x2 -
    coefs.a1 * state.y1 -
    coefs.a2 * state.y2;
  state.x2 = state.x1;
  state.x1 = x;
  state.y2 = state.y1;
  state.y1 = y;
  return y;
}

// ─── EEG filter cascade (sensor-dashboard `eegPipeline.ts` 미러, fs 갱신) ──

export const EEG_SAMPLE_RATE = EEG_FS; // 500 (sensor-dashboard 의 250 → 500)
/** 1초 transient (필터 settling). sensor-dashboard 에서 250 (1s @ 250Hz) → 500 (1s @ 500Hz). */
export const EEG_TRANSIENT_SAMPLES = EEG_FS;

const BUTTERWORTH_Q = 1 / Math.SQRT2;
const NOTCH_COEFS = notchCoefs(EEG_SAMPLE_RATE, 60, 2); // Q=2 linkband 호환
const HP_COEFS = highpassCoefs(EEG_SAMPLE_RATE, 1, BUTTERWORTH_Q);
const LP_COEFS = lowpassCoefs(EEG_SAMPLE_RATE, 45, BUTTERWORTH_Q);

export interface EegChannelFilter {
  notch: BiquadState;
  hp: BiquadState;
  lp: BiquadState;
  samplesProcessed: number;
}

export const createEegChannelFilter = (): EegChannelFilter => ({
  notch: createBiquadState(),
  hp: createBiquadState(),
  lp: createBiquadState(),
  samplesProcessed: 0,
});

/**
 * EEG 단일 raw 샘플 → notch (60Hz) → HP (1Hz) → LP (45Hz) cascade 후 filtered 값.
 * `filter` 를 in-place 갱신. transient (`EEG_TRANSIENT_SAMPLES` 동안) 에선 0 반환.
 */
export function processEegSample(filter: EegChannelFilter, sample: number): number {
  const n = processBiquad(NOTCH_COEFS, filter.notch, sample);
  const h = processBiquad(HP_COEFS, filter.hp, n);
  const l = processBiquad(LP_COEFS, filter.lp, h);
  const out = filter.samplesProcessed < EEG_TRANSIENT_SAMPLES ? 0 : l;
  filter.samplesProcessed++;
  return out;
}

// ─── Spectrum + band power (sensor-dashboard `spectrum.ts` 미러) ──────────
// fs 변경 (250 → EEG_FS=500). 시간-기반 상수도 동일 비율로 스케일.

export interface BandRange {
  key: "delta" | "theta" | "alpha" | "beta" | "gamma";
  fMin: number;
  fMax: number;
}

/** sdk.linkband 배포본 EEGSignalProcessor.bands 와 동일 (delta 0.5Hz 시작, gamma 50Hz 캡). */
export const EEG_BANDS: readonly BandRange[] = [
  { key: "delta", fMin: 0.5, fMax: 4 },
  { key: "theta", fMin: 4, fMax: 8 },
  { key: "alpha", fMin: 8, fMax: 13 },
  { key: "beta", fMin: 13, fMax: 30 },
  { key: "gamma", fMin: 30, fMax: 50 },
];

const MIN_SAMPLES = 64; // DFT 최소 입력 (frequency-only 임계값, fs 무관)
const DFT_WINDOW = EEG_FS; // 1초 윈도우 — sensor-dashboard 의 256 (= 1.024s @ 250Hz) 와 시간 등가

/** Leading 0 (transient placeholder) 제거 — sensor-dashboard 와 동일. */
function stripTransient(data: number[]): number[] {
  let start = 0;
  while (start < data.length && data[start] === 0) start++;
  return start > 0 ? data.slice(start) : data;
}

/** 단일 주파수에서 Goertzel-스타일 DFT power 를 dB 로. */
function dftPowerDb(samples: number[], N: number, freq: number, sampleRate: number): number {
  let real = 0;
  let imag = 0;
  for (let n = 0; n < N; n++) {
    const angle = (2 * Math.PI * freq * n) / sampleRate;
    real += samples[n] * Math.cos(angle);
    imag -= samples[n] * Math.sin(angle);
  }
  const power = (real * real + imag * imag) / N;
  return power > 0 ? 10 * Math.log10(power) : -100;
}

/**
 * Power spectrum — `[freq, dB]` 페어 배열 반환. `kMin`..`kMax` (Hz, integer) 범위.
 * DC 제거 (mean subtraction) 후 마지막 `DFT_WINDOW` 샘플에 대해 freq 별 DFT.
 *
 * `_cacheKey` 는 sensor-dashboard 의 history 호환용 파라미터 — 캐시 freeze
 * 버그로 비활성. 받기만 하고 무시.
 */
export function computeSpectrum(
  rawData: number[],
  sampleRate: number,
  kMin = 1,
  kMax = 45,
  _cacheKey?: string,
): [number, number][] {
  const data = stripTransient(rawData);
  if (data.length < MIN_SAMPLES) return [];
  const samples = data.slice(-Math.min(DFT_WINDOW, data.length));
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i];
  mean /= samples.length;
  const dc = samples.map((v) => v - mean);

  const N = dc.length;
  const out: [number, number][] = new Array(kMax - kMin + 1);
  for (let freq = kMin; freq <= kMax; freq++) {
    out[freq - kMin] = [freq, dftPowerDb(dc, N, freq, sampleRate)];
  }
  return out;
}

// ─── linkband-style filter chain (band-power 전용) ─────────────────────────
// fs 갱신: 250 → EEG_FS (= 500). Q 는 그대로 (절대 주파수 기반 산식).

const BAND_SR = EEG_FS;
const BAND_FILTER_TRANSIENT = EEG_FS; // 1초 transient
const BAND_BANDPASS_LOW = 1;
const BAND_BANDPASS_HIGH = 50;
const BAND_BANDPASS_FC = (BAND_BANDPASS_LOW + BAND_BANDPASS_HIGH) / 2;
const BP_NOTCH_COEFS = notchCoefs(BAND_SR, 60, calcLinkbandNotchQ(60, 2));
const BP_BANDPASS_COEFS = bandpassCoefs(
  BAND_SR,
  BAND_BANDPASS_FC,
  calcLinkbandBandpassQ(BAND_BANDPASS_LOW, BAND_BANDPASS_HIGH),
);

/** linkband-style batch filter — notch (Q≈20) → bandpass (1-45Hz Q≈1.5), 1초 transient skip. */
function batchFilter(raw: number[]): number[] {
  const notchState = createBiquadState();
  const bpState = createBiquadState();
  const out = new Array<number>(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const n = processBiquad(BP_NOTCH_COEFS, notchState, raw[i]);
    out[i] = processBiquad(BP_BANDPASS_COEFS, bpState, n);
  }
  return out.slice(BAND_FILTER_TRANSIENT);
}

// ─── Morlet wavelet power (band-power 의 시간-주파수 해상도) ───────────────

function morletPowerDb(data: number[], freq: number): number {
  const sigma = 7;
  const idealLen = Math.floor((sigma * BAND_SR) / freq);
  const minLen = Math.max(32, Math.floor(BAND_SR / freq));
  const maxLen = Math.min(data.length, Math.floor((2 * BAND_SR) / freq));
  const waveletLen = Math.max(minLen, Math.min(maxLen, idealLen));
  if (waveletLen > data.length) return -100;

  const halfLen = (waveletLen - 1) / 2;
  const norm = Math.pow(Math.PI, -0.25) * Math.sqrt(2 / sigma);
  const wReal = new Array<number>(waveletLen);
  const wImag = new Array<number>(waveletLen);
  for (let i = 0; i < waveletLen; i++) {
    const t = (i - halfLen) / BAND_SR;
    const g = Math.exp((-t * t) / (2 * sigma * sigma));
    const a = 2 * Math.PI * freq * t;
    wReal[i] = norm * g * Math.cos(a);
    wImag[i] = norm * g * Math.sin(a);
  }

  const convLen = data.length - waveletLen + 1;
  if (convLen <= 0) return -100;
  let totalPower = 0;
  for (let i = 0; i < convLen; i++) {
    let re = 0;
    let im = 0;
    for (let j = 0; j < waveletLen; j++) {
      const s = data[i + j];
      re += s * wReal[j];
      im += s * wImag[j];
    }
    totalPower += re * re + im * im;
  }
  const avg = totalPower / convLen;
  return avg > 0 ? 10 * Math.log10(avg) : -100;
}

export interface BandPowerLinearDb {
  linear: number;
  db: number;
}

// fs 스케일된 minimum / window 상수.
const BAND_POWER_MIN_RAW = 2 * EEG_FS / 5; // 600 = 1.2s — sensor-dashboard 300 (1.2s @ 250Hz)
const BAND_POWER_WINDOW_RAW = 2 * EEG_FS; // 1000 = 2s — sensor-dashboard 500

/**
 * band power (linear/dB) — linkband-style filter + Morlet wavelet on RAW EEG.
 * `_sampleRate` 는 API 호환용 — 내부적으로 `BAND_SR` (= EEG_FS) 고정.
 */
export function computeBandPower(
  rawEeg: number[],
  _sampleRate: number,
  fMin: number,
  fMax: number,
  _cacheKey?: string,
): BandPowerLinearDb {
  if (rawEeg.length < BAND_POWER_MIN_RAW) return { linear: 0, db: 0 };
  const batch = rawEeg.slice(-BAND_POWER_WINDOW_RAW);
  const filtered = batchFilter(batch);
  if (filtered.length < MIN_SAMPLES) return { linear: 0, db: 0 };

  // 배포본 EEGSignalProcessor.computeBandPowers 와 동일 — band 안의 각 정수 Hz dB 값을
  // **합산** (평균이 아님). 결과는 정수 Hz count 수만큼 더 큼.
  // 배포본은 frequencies = [1..45] 로 spectrum 을 만든 후 band 별로 `freq >= min && freq < max`
  // 조건으로 합산. 우리는 직접 iterate — 동일한 정수 Hz set 을 사용하기 위해
  // `Math.ceil(fMin)..min(fMax-1, 45)` 로 (delta 0.5 → 1 부터, fMax exclusive).
  const lo = Math.max(1, Math.ceil(fMin));
  const hi = Math.min(45, Math.floor(fMax - 1e-9));
  // fMax 가 정수면 deployed `< fMax` 와 동일하게 fMax-1 까지. fMax=4 → hi=3 (Math.floor(3.999...)=3).
  let dbSum = 0;
  for (let freq = lo; freq <= hi; freq++) {
    dbSum += morletPowerDb(filtered, freq);
  }
  // sensor-dashboard 와 동일 — linear 와 db 가 같은 값 (단순화). 차후 분리 가능.
  return { linear: dbSum, db: dbSum };
}

export interface ComputedEegPower {
  bands: Record<
    BandRange["key"],
    { ch1Linear: number; ch2Linear: number; ch1Db: number; ch2Db: number }
  >;
  totalPowerLinear: number;
}

/** 양 채널 RAW EEG → 5 band 별 power. ch1/ch2 모두 < BAND_POWER_MIN_RAW 면 null. */
export function computeEegPower(
  fp1Raw: number[],
  fp2Raw: number[],
  sampleRate: number,
): ComputedEegPower | null {
  if (fp1Raw.length < BAND_POWER_MIN_RAW || fp2Raw.length < BAND_POWER_MIN_RAW) return null;
  const bands = {} as ComputedEegPower["bands"];
  let totalLinear = 0;
  for (const band of EEG_BANDS) {
    const ch1 = computeBandPower(fp1Raw, sampleRate, band.fMin, band.fMax, `ch1_${band.key}`);
    const ch2 = computeBandPower(fp2Raw, sampleRate, band.fMin, band.fMax, `ch2_${band.key}`);
    bands[band.key] = {
      ch1Linear: ch1.linear,
      ch2Linear: ch2.linear,
      ch1Db: ch1.db,
      ch2Db: ch2.db,
    };
    totalLinear += (ch1.linear + ch2.linear) / 2;
  }
  return { bands, totalPowerLinear: totalLinear };
}

// ─── EEG Signal Quality Index (sensor-dashboard `eegPipeline.ts` 미러) ────
// 윈도우만 fs 비례로 스케일 (125 → 250). amplitude threshold (150 μV) 는
// EEG 진폭 절대값이라 fs 무관 — 그대로.

const EEG_SQI_WINDOW = EEG_FS / 2; // 0.5초 윈도우 (sensor-dashboard 125 = 0.5s @ 250Hz)
const EEG_AMP_THRESHOLD = 150; // μV

/**
 * Amplitude-기반 EEG SQI — sdk.linkband 로직 그대로.
 *
 * Combined SQI = 70% amplitude + 30% frequency (variance-based).
 * - 윈도우당 local DC 제거 (linkband mean subtraction 매칭).
 * - amplitude SQI: |x − mean| ≤ 150 μV 면 1, 초과분 비례 감점.
 * - frequency SQI: variance / 150² 가 작을수록 1, 클수록 0.
 *
 * 입력은 filtered EEG (notch+HP+LP cascade 통과). raw 에 직접 호출 시 saturated
 * (~336,083 μV) 에서 amp threshold 가 의미 없어짐 — filtered 신호 기준 동작.
 */
export function calculateEegSqi(filteredData: number[]): number[] {
  const len = filteredData.length;
  const ampSqi = new Array<number>(len).fill(0);
  const freqSqi = new Array<number>(len).fill(0);

  for (let i = 0; i <= len - EEG_SQI_WINDOW; i++) {
    let mean = 0;
    for (let j = i; j < i + EEG_SQI_WINDOW; j++) mean += filteredData[j];
    mean /= EEG_SQI_WINDOW;

    let ampSum = 0;
    for (let j = i; j < i + EEG_SQI_WINDOW; j++) {
      const amp = Math.abs(filteredData[j] - mean);
      if (amp <= EEG_AMP_THRESHOLD) {
        ampSum += 1;
      } else {
        const excess = Math.min((amp - EEG_AMP_THRESHOLD) / EEG_AMP_THRESHOLD, 1);
        ampSum += Math.max(0, 1 - excess);
      }
    }
    const ampAvg = ampSum / EEG_SQI_WINDOW;

    let varSum = 0;
    for (let j = i; j < i + EEG_SQI_WINDOW; j++) varSum += (filteredData[j] - mean) ** 2;
    const variance = varSum / EEG_SQI_WINDOW;
    // 배포본 EEGSignalProcessor.calculateFrequencySQI — variance / 1000 scale (μV² 단위).
    const freqScore = Math.max(0, Math.min(1, 1 - variance / 1000));

    for (let j = i; j < i + EEG_SQI_WINDOW && j < len; j++) {
      ampSqi[j] = ampAvg;
      freqSqi[j] = freqScore;
    }
  }

  return ampSqi.map((a, i) => (0.7 * a + 0.3 * freqSqi[i]) * 100);
}

// ─── EEG Analysis Indices (own derivation — see note) ─────────────────────
//
// **Note (spec §17 추가 검증 필요)**: sensor-dashboard 는 indices 를 외부 linkband
// SDK 결과로 직접 받아 store 에 저장 (`eegAdapter.ts` `normalizeEegAnalysis`).
// TS 측에 자체 산식 없음. 우리는 spectrum 의 band power 결과로부터 EEG literature
// 의 표준 비율식으로 derivation. sensor-dashboard 의 numerical 값과 차이 가능 —
// 실 디바이스 비교 검증 필요 (사용자 향후 결정).

export interface EegIndices {
  /** Sum of all ch1 band powers (delta + theta + alpha + beta + gamma). */
  totalPower: number;
  /** β / (α + θ) — focused 상태. ch1 single-channel. */
  focusIndex: number;
  /** α / (α + β) — relaxed 상태 (배포본 정의). ch1 single-channel. */
  relaxationIndex: number;
  /** (β + γ) / (α + θ) — 스트레스 지표. ch1 single-channel. */
  stressIndex: number;
  /** θ / α — 인지 부하. ch1 single-channel. */
  cognitiveLoad: number;
  /** (αL − αR) / (αL + αR) — 좌/우 비대칭. ch1=FP1=L, ch2=FP2=R. clamp[-1, 1]. */
  hemisphericBalance: number;
  /** (α + θ) / γ — 정서 안정성. ch1 single-channel. */
  emotionalStability: number;
}

// ─── PPG filter pipeline (sensor-dashboard `ppgPipeline.ts` 미러) ─────────
// fs=50Hz 동일 — 스케일 없음.

export const PPG_SAMPLE_RATE = 50;
/** ~3s warm-up. 0.5Hz HP biquad τ ≈ 0.32s 라 settling 까지 3 time constants 필요. */
export const PPG_TRANSIENT_SAMPLES = 150;

// 배포본 PPGSignalProcessor.applySimpleFilter — `makeBandpassFilter(1.0, 5.0, 50)` 단일 biquad.
// linkband Yf.calcBandpassQ(fc=3, bw=2, n=1) → Q ≈ 0.559.
const PPG_BANDPASS_LOW = 1.0;
const PPG_BANDPASS_HIGH = 5.0;
const PPG_BANDPASS_FC = (PPG_BANDPASS_LOW + PPG_BANDPASS_HIGH) / 2;
const PPG_BP_COEFS = bandpassCoefs(
  PPG_SAMPLE_RATE,
  PPG_BANDPASS_FC,
  calcLinkbandBandpassQ(PPG_BANDPASS_LOW, PPG_BANDPASS_HIGH),
);

export interface PpgChannelFilter {
  bp: BiquadState;
  samplesProcessed: number;
}

export const createPpgChannelFilter = (): PpgChannelFilter => ({
  bp: createBiquadState(),
  samplesProcessed: 0,
});

/**
 * PPG 단일 raw 샘플 → bandpass (1-5Hz) 단일 biquad. 1-5Hz 가 심박 펄스 대역.
 * `filter` 를 in-place 갱신. transient (`PPG_TRANSIENT_SAMPLES` 동안) 에선 0.
 */
export function processPpgSample(filter: PpgChannelFilter, sample: number): number {
  const y = processBiquad(PPG_BP_COEFS, filter.bp, sample);
  const out = filter.samplesProcessed < PPG_TRANSIENT_SAMPLES ? 0 : y;
  filter.samplesProcessed++;
  return out;
}

const PPG_SQI_WINDOW = 25;
const PPG_SQI_AMP_THRESHOLD = 250;

/**
 * Amplitude-based PPG SQI — sdk.linkband 로직. 25-sample sliding window 에서
 * local DC 제거 후 amplitude ≤ 250 면 1.0, 초과분 비례 감점. 0-100% scaled.
 */
export function calculatePpgSqi(filteredData: number[]): number[] {
  const len = filteredData.length;
  const result = new Array<number>(len).fill(0);
  for (let i = 0; i <= len - PPG_SQI_WINDOW; i++) {
    let mean = 0;
    for (let j = i; j < i + PPG_SQI_WINDOW; j++) mean += filteredData[j];
    mean /= PPG_SQI_WINDOW;

    let sum = 0;
    for (let j = i; j < i + PPG_SQI_WINDOW; j++) {
      const amp = Math.abs(filteredData[j] - mean);
      if (amp <= PPG_SQI_AMP_THRESHOLD) {
        sum += 1;
      } else {
        const excess = Math.min((amp - PPG_SQI_AMP_THRESHOLD) / PPG_SQI_AMP_THRESHOLD, 1);
        sum += Math.max(0, 1 - excess);
      }
    }
    const avg = sum / PPG_SQI_WINDOW;
    for (let j = i; j < i + PPG_SQI_WINDOW; j++) {
      result[j] = avg * 100;
    }
  }
  return result;
}

/**
 * 적응형 임계값 PPG peak 검출 — 배포본 PPGSignalProcessor.detectPeaksAdaptiveThreshold 동일.
 *
 * - 0.5초 window (양쪽 fs*0.5) 의 local max/mean 으로 동적 threshold = mean + (max-mean)*0.6.
 * - 5-point peak shape: data[i] > data[i±1] AND > data[i±2].
 * - min peak distance = fs * 0.4 (= 150 BPM 상한).
 *
 * 길이 < 2*windowSize+1 (≈ 1초 @ fs) 이면 빈 배열. 반환은 인덱스 배열.
 */
export function detectPpgPeaks(filtered: number[], fs: number): number[] {
  const peaks: number[] = [];
  const n = filtered.length;
  const windowSize = Math.floor(fs * 0.5); // 0.5s 한쪽 윈도우
  const minPeakDistance = Math.floor(fs * 0.4); // 0.4s = 150 BPM 상한
  if (n < 2 * windowSize + 1) return peaks;

  for (let i = windowSize; i < n - windowSize; i++) {
    // local window [i-windowSize, i+windowSize) — 배포본 slice 동일.
    let localMax = -Infinity;
    let localSum = 0;
    const winLen = 2 * windowSize;
    for (let j = i - windowSize; j < i + windowSize; j++) {
      const v = filtered[j];
      if (v > localMax) localMax = v;
      localSum += v;
    }
    const localMean = localSum / winLen;
    const threshold = localMean + (localMax - localMean) * 0.6;

    if (
      filtered[i] > threshold &&
      filtered[i] > filtered[i - 1] &&
      filtered[i] > filtered[i + 1] &&
      filtered[i] > filtered[i - 2] &&
      filtered[i] > filtered[i + 2] &&
      (peaks.length === 0 || i - peaks[peaks.length - 1] >= minPeakDistance)
    ) {
      peaks.push(i);
    }
  }
  return peaks;
}

/**
 * HRV 전용 PPG peak 검출 — 배포본 PPGSignalProcessor.detectPeaksForHRV 동일.
 *
 * Raw IR 데이터 (필터 X) 직접 사용. mean 차감 후 max × 0.5 threshold,
 * 3-point peak shape (i-1, i, i+1), min interval = fs * 0.4.
 *
 * 사용처: HRV/RR 계산 — view layer 가 raw IR 직접 전달.
 */
export function detectPpgPeaksForHrv(rawIr: number[], fs: number): number[] {
  const peaks: number[] = [];
  const n = rawIr.length;
  if (n < 3) return peaks;

  let mean = 0;
  for (const v of rawIr) mean += v;
  mean /= n;
  // normalize (subtract mean) & find max for threshold
  let max = -Infinity;
  for (const v of rawIr) {
    const norm = v - mean;
    if (norm > max) max = norm;
  }
  if (max <= 0) return peaks;
  const threshold = max * 0.5;

  const minPeakDistance = Math.floor(fs * 0.4);

  for (let i = 1; i < n - 1; i++) {
    const a = rawIr[i - 1] - mean;
    const b = rawIr[i] - mean;
    const c = rawIr[i + 1] - mean;
    if (
      b > threshold &&
      b > a &&
      b > c &&
      (peaks.length === 0 || i - peaks[peaks.length - 1] >= minPeakDistance)
    ) {
      peaks.push(i);
    }
  }
  return peaks;
}

/** Peak 인덱스 → RR interval (seconds). */
export function peaksToRrSeconds(peaks: number[], fs: number): number[] {
  const rr: number[] = [];
  for (let i = 1; i < peaks.length; i++) {
    rr.push((peaks[i] - peaks[i - 1]) / fs);
  }
  return rr;
}

// ─── HRV metrics (RR-based, 표준 HRV literature) ──────────────────────────

export interface HrvMetrics {
  /** mean RR (ms) — Average NN interval. */
  avnn: number;
  /** std deviation of RR (ms) — population (divide by N). */
  sdnn: number;
  /** RMS of successive differences (ms). */
  rmssd: number;
  /** std deviation of successive differences (ms). */
  sdsd: number;
  /** % of |Δ RR| > 50 ms. */
  pnn50: number;
  /** % of |Δ RR| > 20 ms. */
  pnn20: number;
}

/** RR ms 배열 → 6 standard HRV metrics. 빈 배열이면 모두 0. */
export function computeHrvMetrics(rrIntervalsMs: number[]): HrvMetrics {
  const n = rrIntervalsMs.length;
  if (n === 0) return { avnn: 0, sdnn: 0, rmssd: 0, sdsd: 0, pnn50: 0, pnn20: 0 };

  let sum = 0;
  for (const rr of rrIntervalsMs) sum += rr;
  const avnn = sum / n;

  let varSum = 0;
  for (const rr of rrIntervalsMs) varSum += (rr - avnn) ** 2;
  const sdnn = Math.sqrt(varSum / n);

  if (n < 2) return { avnn, sdnn, rmssd: 0, sdsd: 0, pnn50: 0, pnn20: 0 };

  // Successive differences (NN[i+1] - NN[i]).
  const m = n - 1;
  const diffs: number[] = new Array(m);
  for (let i = 0; i < m; i++) diffs[i] = rrIntervalsMs[i + 1] - rrIntervalsMs[i];

  let sqSum = 0;
  for (const d of diffs) sqSum += d * d;
  const rmssd = Math.sqrt(sqSum / m);

  let dMean = 0;
  for (const d of diffs) dMean += d;
  dMean /= m;
  let dVarSum = 0;
  for (const d of diffs) dVarSum += (d - dMean) ** 2;
  const sdsd = Math.sqrt(dVarSum / m);

  let p50 = 0;
  let p20 = 0;
  for (const d of diffs) {
    const a = Math.abs(d);
    if (a > 50) p50++;
    if (a > 20) p20++;
  }
  const pnn50 = (p50 / m) * 100;
  const pnn20 = (p20 / m) * 100;

  return { avnn, sdnn, rmssd, sdsd, pnn50, pnn20 };
}

export interface HeartRate {
  /** average instantaneous BPM = 60000 / mean(RR). */
  bpm: number;
  /** BPM at min RR (= max instantaneous BPM). */
  hrMax: number;
  /** BPM at max RR (= min instantaneous BPM). */
  hrMin: number;
}

/**
 * BPM with IQR outlier removal + linear-weighted mean + physiological validation.
 * 배포본 PPGSignalProcessor 의 calculateRRIntervalsWithOutlierRemoval +
 * calculateWeightedHeartRate + validateAndSmoothHeartRate 합본.
 *
 * 단계:
 *  1. 생리학적 범위 [300, 1500] ms 필터링.
 *  2. IQR 1.5× 통계적 outlier 제거 (sortedRR 의 q1/q3 인덱스 = floor(N*0.25), floor(N*0.75)).
 *  3. 선형 가중 평균: 각 RR 의 instantaneous BPM (60000/rr) 에 weight (i+1)/N 가중.
 *  4. 검증: BPM ∉ [40, 200] → 0 반환. CV > 0.5 → BPM × 0.9 (감쇠).
 *  5. Math.round.
 *
 * `computeHeartRate` 와 별도 — 후자는 hrMax/hrMin 도 필요한 trend chart 용.
 */
export function computeHeartRateValidated(rrIntervalsMs: number[]): number {
  // 1. 생리학적 범위 필터.
  const valid = rrIntervalsMs.filter((rr) => rr >= 300 && rr <= 1500);
  if (valid.length === 0) return 0;
  if (valid.length === 1) {
    const bpm = 60000 / valid[0];
    if (bpm < 40 || bpm > 200) return 0;
    return Math.round(bpm);
  }

  // 2. IQR 1.5× outlier 제거. 배포본 인덱스 산식 동일 (Math.floor 기반, exclusive 아님).
  const sorted = [...valid].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;
  const filtered = valid.filter((rr) => rr >= lowerBound && rr <= upperBound);
  if (filtered.length === 0) return 0;

  // 3. 선형 가중 평균.
  let weightedSum = 0;
  let totalWeight = 0;
  for (let i = 0; i < filtered.length; i++) {
    const weight = (i + 1) / filtered.length;
    weightedSum += (60000 / filtered[i]) * weight;
    totalWeight += weight;
  }
  const bpm = weightedSum / totalWeight;

  // 4. 검증.
  if (bpm < 40 || bpm > 200) return 0;
  if (filtered.length >= 3) {
    const meanRR = filtered.reduce((s, v) => s + v, 0) / filtered.length;
    const varRR =
      filtered.reduce((s, v) => s + (v - meanRR) ** 2, 0) / filtered.length;
    const cv = Math.sqrt(varRR) / meanRR;
    if (cv > 0.5) return Math.round(bpm * 0.9);
  }
  return Math.round(bpm);
}

// ─── PPG Stress Index (HRV-based normalized 0..1) ────────────────────────
//
// 배포본 `sdk_PPGSignalProcessor.ts:1388-1424` 의 `computeStressIndex` 정확 동일.
// SDNN / RMSSD / 평균 HR 세 정규화의 가중 합 (0.4 / 0.4 / 0.2):
//   - SDNN low → 스트레스 ↑ (정상 30-100ms, normalize 100-sdnn / 70 → 0..1)
//   - RMSSD low → 스트레스 ↑ (정상 20-50ms, normalize 50-rmssd / 30 → 0..1)
//   - HR high → 스트레스 ↑ (정상 60-100bpm, normalize bpm-60 / 40 → 0..1)
// 결과는 [0, 1] clamp. 0.30..0.70 = "normal" (ppgIndexThresholds.ppgStressIndex 첫 normal level).
// RR 5개 미만이면 의미 있는 값 산출 불가 → 0 반환.

/** RR ms 배열 → 0..1 정규화된 PPG stress index. RR < 5 면 0. */
export function computePpgStressIndex(rrIntervalsMs: number[]): number {
  if (rrIntervalsMs.length < 5) return 0;

  // SDNN — population std (배포본과 동일 N divisor).
  const mean = rrIntervalsMs.reduce((s, v) => s + v, 0) / rrIntervalsMs.length;
  const varRR =
    rrIntervalsMs.reduce((s, v) => s + (v - mean) ** 2, 0) / rrIntervalsMs.length;
  const sdnn = Math.sqrt(varRR);

  // RMSSD — successive differences std.
  let sqDiffSum = 0;
  for (let i = 1; i < rrIntervalsMs.length; i++) {
    const d = rrIntervalsMs[i] - rrIntervalsMs[i - 1];
    sqDiffSum += d * d;
  }
  const rmssd = Math.sqrt(sqDiffSum / (rrIntervalsMs.length - 1));

  // 정규화 — 낮은 HRV / 빠른 HR → 높은 스트레스.
  const normalizedSdnn = Math.max(0, Math.min(1, (100 - sdnn) / 70));
  const normalizedRmssd = Math.max(0, Math.min(1, (50 - rmssd) / 30));
  const avgBpm = 60000 / mean;
  const hrStress = Math.max(0, Math.min(1, (avgBpm - 60) / 40));

  // 가중 합 — SDNN/RMSSD 각 0.4, HR 0.2.
  const stressIndex = normalizedSdnn * 0.4 + normalizedRmssd * 0.4 + hrStress * 0.2;
  return Math.max(0, Math.min(1, stressIndex));
}

// ─── ACC analysis (movement intensity / postural stability) ──────────────
//
// **Note**: sensor-dashboard 는 ACC analysis 를 SSE backend 로부터 받아 store
// 에 저장 (`accAdapter.normalizeAccAnalysis`) — TS 측에 자체 산식 없음. linkband
// SDK Python core 도 ACC analysis 를 내장하지 않음 (raw stream 만). 따라서 이
// 산식은 **approximate baseline (refine later)** — `accIndexThresholds.intensity`
// boundary (25 = sedentary→light) 와 `accIndexThresholds.stability` 의 70%
// "Stable" 임계값에 맞춰 normalize. magnitude 는 g 단위 (정지 시 ≈ 1g).
//
//   avgMovement   = mean(|magnitude − 1|)        — 1g rest baseline 으로부터 편차
//   intensity     = 100 × clamp(avgMovement / 1.0g, 0, 1)        — 0..100%
//   stability     = 100 × (1 − clamp(σ_mag / 0.5g, 0, 1))        — high σ → low stability
//   activityState = intensity < 25 ? 'stationary' : 'moving'     — threshold first level
//
// σ_max = 0.5g 는 normal walking 에서 magnitude 표준편차 ~0.3-0.5g (보고된 wearable
// IMU literature 값) 기반 — 실 디바이스 검증 후 조정 가능. avgMovement 1g 도
// 동일 — 격렬한 운동 시 |mag - 1g| 평균 ~1g 도달.

export type ActivityState = "stationary" | "moving";

export interface AccAnalysis {
  /** 'stationary' (intensity < 25) 또는 'moving'. */
  activityState: ActivityState;
  /** 0..100% — 큰 움직임 정도. */
  intensity: number;
  /** 0..100% — 자세 안정성 (낮은 magnitude variance 일수록 높음). */
  stability: number;
  /** mean(|magnitude − 1|) — g 단위. 1g rest baseline 편차. */
  avgMovement: number;
}

/** approximate normalization 상수 — 실 디바이스 검증 후 조정 (위 노트 참조). */
const ACC_INTENSITY_REF_G = 1.0;
const ACC_STABILITY_SIGMA_MAX_G = 0.5;
const ACC_INTENSITY_STATIONARY_THRESHOLD = 25; // accIndexThresholds.intensity 첫 boundary

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * ACC magnitude buffer (g 단위) → 4-tuple analysis.
 *
 * 빈 buffer / fs ≤ 0 이면 0 / 'stationary'. View layer 가 raw int16 → g 변환
 * 후 magnitude = √(x²+y²+z²) 를 누적해 전달.
 *
 * `_fs` 는 API 호환용 — 본 산식은 sample rate 무관 (mean/std 만 사용).
 */
export function computeAccAnalysis(
  magnitudeBuf: number[],
  _fs: number,
): AccAnalysis {
  const n = magnitudeBuf.length;
  if (n === 0) {
    return { activityState: "stationary", intensity: 0, stability: 100, avgMovement: 0 };
  }

  // mean(|mag - 1|) — 1g rest baseline 편차.
  let absDevSum = 0;
  let magSum = 0;
  for (let i = 0; i < n; i++) {
    absDevSum += Math.abs(magnitudeBuf[i] - 1);
    magSum += magnitudeBuf[i];
  }
  const avgMovement = absDevSum / n;
  const meanMag = magSum / n;

  // σ_magnitude — population std (divide by N, sensor-dashboard 와 동일 패턴).
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    varSum += (magnitudeBuf[i] - meanMag) ** 2;
  }
  const sigma = Math.sqrt(varSum / n);

  const intensity = 100 * clamp01(avgMovement / ACC_INTENSITY_REF_G);
  const stability = 100 * (1 - clamp01(sigma / ACC_STABILITY_SIGMA_MAX_G));
  const activityState: ActivityState =
    intensity < ACC_INTENSITY_STATIONARY_THRESHOLD ? "stationary" : "moving";

  return { activityState, intensity, stability, avgMovement };
}

/** RR ms 배열 → 평균/최대/최소 BPM. 빈 배열이면 모두 0. */
export function computeHeartRate(rrIntervalsMs: number[]): HeartRate {
  if (rrIntervalsMs.length === 0) return { bpm: 0, hrMax: 0, hrMin: 0 };

  let sum = 0;
  let minRr = Number.POSITIVE_INFINITY;
  let maxRr = Number.NEGATIVE_INFINITY;
  for (const rr of rrIntervalsMs) {
    sum += rr;
    if (rr < minRr) minRr = rr;
    if (rr > maxRr) maxRr = rr;
  }
  const avgRr = sum / rrIntervalsMs.length;

  return {
    bpm: avgRr > 0 ? 60000 / avgRr : 0,
    hrMax: minRr > 0 ? 60000 / minRr : 0,
    hrMin: maxRr > 0 ? 60000 / maxRr : 0,
  };
}

/**
 * Band power → 7 EEG analysis indices (배포본 EEGSignalProcessor 동일).
 *
 * 배포본은 ch1 (single channel) band power 만으로 대부분의 index 를 계산.
 * hemisphericBalance 만 ch1/ch2 alpha 양쪽 사용.
 *
 * 모든 0-나누기 가드 — 분모 ≤ 0 이면 0 반환. hemisphericBalance 는 분모 < 0.001 일 때
 * 한쪽이 우세하면 ±1, 그 외 0 (배포본 동일). 결과는 [-1, 1] 로 clamp.
 */
export function computeEegIndices(power: ComputedEegPower): EegIndices {
  const b = power.bands;
  const ch1Delta = b.delta.ch1Db;
  const ch1Theta = b.theta.ch1Db;
  const ch1Alpha = b.alpha.ch1Db;
  const ch1Beta = b.beta.ch1Db;
  const ch1Gamma = b.gamma.ch1Db;
  const ch2Alpha = b.alpha.ch2Db;

  const safeRatio = (num: number, den: number): number => (den > 0 ? num / den : 0);

  const focusIndex = safeRatio(ch1Beta, ch1Alpha + ch1Theta);
  const relaxationIndex = safeRatio(ch1Alpha, ch1Alpha + ch1Beta);
  const stressIndex = safeRatio(ch1Beta + ch1Gamma, ch1Alpha + ch1Theta);
  const cognitiveLoad = safeRatio(ch1Theta, ch1Alpha);
  const emotionalStability = safeRatio(ch1Alpha + ch1Theta, ch1Gamma);

  // hemisphericBalance — 배포본 동일: ch1=L (FP1), ch2=R (FP2).
  const alphaSum = ch1Alpha + ch2Alpha;
  let hemisphericBalance = 0;
  if (alphaSum > 0.001) {
    hemisphericBalance = (ch1Alpha - ch2Alpha) / alphaSum;
  } else if (ch1Alpha > 0 || ch2Alpha > 0) {
    hemisphericBalance = ch1Alpha > ch2Alpha ? 1 : -1;
  }
  hemisphericBalance = Math.max(-1, Math.min(1, hemisphericBalance));

  const totalPower = ch1Delta + ch1Theta + ch1Alpha + ch1Beta + ch1Gamma;

  return {
    totalPower,
    focusIndex,
    relaxationIndex,
    stressIndex,
    cognitiveLoad,
    hemisphericBalance,
    emotionalStability,
  };
}
