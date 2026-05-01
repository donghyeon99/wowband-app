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

/** sdk.linkband UI 와 동일 (gamma 가 50Hz 가 아닌 45Hz 캡). */
export const EEG_BANDS: readonly BandRange[] = [
  { key: "delta", fMin: 1, fMax: 4 },
  { key: "theta", fMin: 4, fMax: 8 },
  { key: "alpha", fMin: 8, fMax: 13 },
  { key: "beta", fMin: 13, fMax: 30 },
  { key: "gamma", fMin: 30, fMax: 45 },
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
const BAND_BANDPASS_HIGH = 45;
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

  let dbSum = 0;
  let count = 0;
  for (let freq = fMin; freq <= fMax; freq++) {
    dbSum += morletPowerDb(filtered, freq);
    count++;
  }
  const avgDb = count > 0 ? dbSum / count : 0;
  // sensor-dashboard 와 동일 — linear 와 db 가 같은 값 (단순화). 차후 분리 가능.
  return { linear: avgDb, db: avgDb };
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
