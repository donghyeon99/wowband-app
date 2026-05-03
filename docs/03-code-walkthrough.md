# Code Walkthrough — wowband-app

이 문서는 BLE 헤드밴드에서 흘러 나오는 byte stream 이 화면 위 픽셀로 변환되기까지의
전체 데이터 흐름을, **실제 소스 코드 발췌** 와 함께 한 파일에 정리한다. 각 발췌
위에는 file path 와 대략적인 line range 가 명시되어 있다.

내용은 다음 순서로 진행된다:

1. 진입점 (`src/main.ts`) — 부트스트랩, BLE 활성화 순서, replay 파이프라인.
2. 데이터 처리 (`src/linkband/`) — models, parser, DSP, thresholds.
3. UI (`src/ui/`) — layout chrome, 차트 wrapper, metric / index / band-power 카드,
   3 sensor view (eeg / ppg / acc).
4. 센서별 처리 흐름 요약 표.
5. 외부 reference (numerical 정답지 위치).

---

## 1. 진입점 — `src/main.ts`

### 부트스트랩 단계

페이지 부트스트랩은 다음 단계로 진행된다 (`src/main.ts` 전체에 걸쳐):

1. `Parser` 인스턴스 1개 생성 (line 41).
2. `index.html` 의 mount point 들을 `getElementById` 로 잡고 (line 45-62), 누락 시
   바로 throw — layout 이 깨져있는 경우 빠르게 실패하도록.
3. `createHeader` / `createVisualizerHeader` / `createTabs` / `createFooter`
   호출로 페이지 chrome 구성 (line 64-127).
4. `createEegView` / `createPpgView` / `createAccView` 를 **모두** 호출해서 3 view
   를 한 번에 생성 (line 97-99). 활성 탭만 보이지만 비활성 탭의 view 도 데이터
   buffer 를 채워둔다.
5. `activateTab("eeg")` 로 EEG 탭을 디폴트로 띄움 (line 127).

### View 생명주기

비활성 탭의 view 도 BLE batch 를 받아 buffer 를 채워둔다. 사용자가 탭을 전환하면
ECharts 인스턴스가 0×0 으로 init 되어있을 수 있는 케이스를 복구하기 위해
`views[id].resize()` 를 호출한다.

**`src/main.ts` (L91-114)**

```typescript
// Views — single instance per sensor, never disposed (page lifetime).
// 비활성 탭의 view 도 background 에서 데이터를 받아 buffer 를 채워둔다 → 탭 전환 시
// 즉시 그래프가 그려져 있음 (sensor-dashboard 와 동일 동작).
//
// Activation 전 (모든 컨테이너 visible) 에 createXxxView 호출해야 ECharts 가 0×0
// 으로 init 안 됨. 첫 activateTab 호출 시 컨테이너 hide → 다음 activate 때 resize().
const eegView = createEegView(eegContainer);
const ppgView = createPpgView(ppgContainer);
const accView = createAccView(accContainer);

const views: Record<TabId, { resize: () => void }> = {
  eeg: eegView,
  ppg: ppgView,
  acc: accView,
};

function activateTab(id: TabId): void {
  for (const [k, el] of Object.entries(containers) as Array<[TabId, HTMLElement]>) {
    el.style.display = k === id ? "" : "none";
  }
  // 활성화 직후 ECharts 가 새 컨테이너 size 로 다시 measure — 비활성 탭 시점에
  // 0×0 으로 init 된 케이스 복구.
  views[id].resize();
}
```

### Handler dispatch 패턴

각 sensor 의 BLE notify 이벤트는 `makeHandler(sensor)` factory 로 wrap 된다.
factory 는 `event.target.value` 에서 `Uint8Array` 를 추출한 뒤 sensor 별 dispatch
table 로 라우팅한다.

**`src/main.ts` (L176-198)**

```typescript
const dispatch: Record<Sensor, (data: Uint8Array) => void> = {
  eeg: onEegBytes,
  ppg: onPpgBytes,
  acc: onAccBytes,
  bat: onBatBytes,
};

function makeHandler(sensor: Sensor): (event: Event) => void {
  return (event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    if (!target.value) return;
    const data = new Uint8Array(
      target.value.buffer,
      target.value.byteOffset,
      target.value.byteLength,
    );
    try {
      dispatch[sensor](data);
    } catch (err) {
      console.warn(`${sensor} parse failed`, err);
    }
  };
}
```

각 `onXxxBytes` 함수는 `parser.parseXxx(data)` 호출 → 해당 view 의 `onBatch`
호출 → footer message counter bump 의 3-step 흐름 (line 152-174).

### BLE 활성화 순서

spec §5.1 의 순서를 그대로 따른다: **Battery notify 먼저** → **EEG `start`
write** → **1 초 대기** → EEG / ACC / PPG notify 구독. EEG `start` 가 펌웨어 측
EEG 스트리밍을 깨우는 트리거이고, 1 초 대기는 펌웨어 internal queue 가 ready
상태가 되도록 마진을 주는 것 (Kotlin SDK `BleManager.kt` 와 동일).

**`src/main.ts` (L220-246)**

```typescript
// spec §5.1 활성화 순서: Battery 먼저 → EEG start write → 1s 대기 → EEG/ACC/PPG.
const batSvc = await server.getPrimaryService(BATTERY_SERVICE);
const batCh = await batSvc.getCharacteristic(BATTERY_NOTIFY);
await batCh.startNotifications();
batCh.addEventListener("characteristicvaluechanged", makeHandler("bat"));

const eegSvc = await server.getPrimaryService(EEG_SERVICE);
const eegWriteCh = await eegSvc.getCharacteristic(EEG_WRITE);
await eegWriteCh.writeValueWithResponse(new TextEncoder().encode("start"));
await new Promise((r) => setTimeout(r, 1000));

const eegNotifyCh = await eegSvc.getCharacteristic(EEG_NOTIFY);
await eegNotifyCh.startNotifications();
eegNotifyCh.addEventListener("characteristicvaluechanged", makeHandler("eeg"));

const accSvc = await server.getPrimaryService(ACC_SERVICE);
const accNotifyCh = await accSvc.getCharacteristic(ACC_NOTIFY);
await accNotifyCh.startNotifications();
accNotifyCh.addEventListener("characteristicvaluechanged", makeHandler("acc"));

const ppgSvc = await server.getPrimaryService(PPG_SERVICE);
const ppgNotifyCh = await ppgSvc.getCharacteristic(PPG_NOTIFY);
await ppgNotifyCh.startNotifications();
ppgNotifyCh.addEventListener("characteristicvaluechanged", makeHandler("ppg"));

setStatus(`streaming from ${device.name ?? "?"}`);
```

`gattserverdisconnected` 이벤트는 parser 의 timestamp 보간 상태도 함께 reset
한다 (line 213-218) — 재연결 시 헤더 timestamp 가 다시 baseline 이 되도록.

### Replay 모드 (dev 전용)

디바이스 없이도 동작 검증이 가능하도록, fixture txt 파일을 `fetch` 로 받아 같은
`onXxxBytes` 핸들러에 흘려넣는 replay 경로가 있다. live BLE 와 정확히 동일한
파이프라인을 통과 — parser → view → footer.

**`src/main.ts` (L250-272)**

```typescript
async function replayStream(
  url: string,
  handler: (data: Uint8Array) => void,
  cadenceMs: number,
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const txt = await res.text();
  const lines = txt.split("\n").filter((l) => l.length > 0);
  for (const line of lines) {
    const hex = line.split("\t")[1];
    if (!hex) continue;
    const matches = hex.match(/.{2}/g);
    if (!matches) continue;
    const bytes = Uint8Array.from(matches.map((b) => parseInt(b, 16)));
    try {
      handler(bytes);
    } catch (err) {
      console.warn(`replay handler failed for ${url}`, err);
    }
    await new Promise((r) => setTimeout(r, cadenceMs));
  }
}
```

cadence (50 / 560 / 1200 ms) 는 spec §7-§9 의 sensor 별 packet 주기와 일치 —
EEG 50ms, PPG 560ms, ACC 1200ms.

---

## 2. 데이터 처리 폴더 — `src/linkband/`

### 2.1 `models.ts` — 데이터 모델

BLE 패킷 1개 = batch 1개. sample 단위 객체가 아닌 **typed array 묶음** 으로 묶어
GC 압력을 회피한다. EEG 는 500Hz 라 50ms 마다 25 sample — sample 단위 object
allocation 을 피해야 한다.

상수는 sensor 별 nominal sample rate (`EEG_FS=500`, `PPG_FS=50`, `ACC_FS=25`) 와
ACC raw int16 → g 변환 상수 (`ACC_LSB_PER_G=16384` — ±2g 모드의 16-bit LE).
모두 spec §7-§9 와 §17 Q1/Q7 의 실측 확정값.

**`src/linkband/models.ts` (L44-61)**

```typescript
export interface EegBatch {
  /** Device boot-relative epoch sec — 패킷 헤더 timestamp / 32768 (spec §6.1, §17 Q6). */
  tDevice: number;
  /** Wall-clock 패킷 도착 시각 (sec, `Date.now() / 1000`). */
  tRecv: number;
  /** 항상 500 — 실측 잠금 (spec §17 Q7). */
  fs: typeof EEG_FS;
  /** μV 변환값. length = 25. */
  ch1Uv: Float64Array;
  ch2Uv: Float64Array;
  /** 24-bit signed raw ADC 카운트. length = 25. */
  ch1Raw: Int32Array;
  ch2Raw: Int32Array;
  /** Kotlin parity: `leadOffRaw[i] > 0`. length = 25. */
  leadOff: boolean[];
  /** uint8 원본 — 비트마스크 보존 (spec §17 Q2). length = 25. */
  leadOffRaw: Uint8Array;
}
```

`PpgBatch` 는 28 sample / 560ms (red, ir 둘 다 24-bit unsigned), `AccBatch` 는
30 sample / 1200ms (x/y/z 모두 16-bit LE signed), `BatteryStatus` 는 1-byte 퍼센트
+ wall-clock 만 들고 있다 (헤더 없음).

### 2.2 `parser.ts` — BLE 패킷 파서

입력은 `Uint8Array` (BLE 패킷 raw bytes), 출력은 sensor 별 Batch 인터페이스
(typed array 묶음). 인스턴스 상태로 sensor 별 마지막 sample 시각을 기억해서, 다음
패킷의 첫 sample 시각을 `lastT + 1/fs` 로 보간한다 (spec §13 Q1.4 — Kotlin
`lastEegSampleTimestampMillis` 패턴).

핵심 함수: `parser.parseEeg(data) → EegBatch`, `parsePpg(data) → PpgBatch`,
`parseAcc(data) → AccBatch`, 그리고 stateless `parseBattery(data) → BatteryStatus`.

#### Header timestamp + 보간

패킷의 첫 4 bytes 는 LE u32 device tick 카운트. `tick / 32768` 로 epoch sec
변환. 이후 sample 들은 헤더 timestamp 가 아니라 직전 batch 의 마지막 sample 시각
+ 1/fs 로 균일 보간.

**`src/linkband/parser.ts` (L181-185)**

```typescript
/** spec §13 Q1.4 보간 — 직전 마지막 샘플 + 1/fs, 없으면 헤더 사용. */
private firstSampleTime(lastT: number | null, headerT: number, fs: number): number {
  return lastT === null ? headerT : lastT + 1.0 / fs;
}
```

#### EEG 24-bit 부호 확장 + μV 변환

EEG 는 24-bit two's complement (BE). JavaScript number 는 32-bit signed 까지
다루기 좋으므로, MSB (`u & 0x800000`) 가 1 이면 `0x1000000` 을 빼서 부호 확장.
μV 변환은 spec §7.2 의 식: `raw × 4.033 / 12 / 8388607 × 1e6 ≈ 0.0401 μV/LSB`.

**`src/linkband/parser.ts` (L24-51)**

```typescript
// spec §7.2 — μV 변환식 상수.
const EEG_VREF = 4.033;
const EEG_GAIN = 12.0;
const EEG_RES = 8388607.0; // 2^23 - 1
const EEG_UV_FACTOR = (EEG_VREF / EEG_GAIN / EEG_RES) * 1e6; // ≈ 0.040064 μV/LSB
...
/** 24-bit big-endian signed → number. 24-bit two's complement 부호확장 (spec §7.1). */
function decodeBeS24(view: DataView, offset: number): number {
  const u = (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);
  return u & 0x800000 ? u - 0x1000000 : u;
}
```

#### ACC sample loop

ACC 는 6-byte sample (각 축 2-byte LE signed). Kotlin SDK 가 LSB(인덱스 0/2/4)를
누락한 버그를 회피한 16-bit LE 정정 디코더.

**`src/linkband/parser.ts` (L161-179)**

```typescript
/** 184-byte ACC 패킷 → 30-샘플 AccBatch (fs=25). spec §9, §17 Q1. */
parseAcc(data: Uint8Array): AccBatch {
  const view = viewOf(data);
  const n = Math.floor((data.byteLength - HEADER_SIZE) / ACC_SAMPLE_SIZE);
  const firstT = this.firstSampleTime(this.lastAccT, headerSeconds(view), ACC_FS);

  const x = new Int16Array(n);
  const y = new Int16Array(n);
  const z = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const off = HEADER_SIZE + i * ACC_SAMPLE_SIZE;
    x[i] = view.getInt16(off, true);
    y[i] = view.getInt16(off + 2, true);
    z[i] = view.getInt16(off + 4, true);
  }

  this.lastAccT = firstT + (n - 1) / ACC_FS;
  return { tDevice: firstT, tRecv: nowSec(), fs: ACC_FS, x, y, z };
}
```

### 2.3 `dsp.ts` — DSP 핵심

가장 긴 파일. 4 sub-section 으로 나눈다.

#### 2.3.1 Biquad primitives

RBJ cookbook 산식의 notch / highpass / lowpass / bandpass 4 종 계수 함수와,
direct-form II transposed 한 sample 처리 함수. 모두 stateless (계수) 또는
in-place state 갱신 (processBiquad).

**`src/linkband/dsp.ts` (L110-123) — `processBiquad`**

```typescript
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
```

**`src/linkband/dsp.ts` (L81-94) — `bandpassCoefs`**

```typescript
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
```

linkband 호환 Q 산식 (`calcLinkbandBandpassQ`, `calcLinkbandNotchQ`) 도 같이
정의되어, deployed sdk.linkband 의 numerical 결과와 일치하도록 한다.

#### 2.3.2 EEG filter cascade + SQI + spectrum + band power + indices

##### Filter cascade

샘플 1개 단위로 notch (60Hz, Q=2) → highpass (1Hz Butterworth) → lowpass (45Hz
Butterworth) 의 3-stage cascade. 첫 1 초 (`EEG_TRANSIENT_SAMPLES = 500`) 는
filter settling 으로 0 반환.

**`src/linkband/dsp.ts` (L150-161)**

```typescript
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
```

##### SQI (Signal Quality Index)

70% amplitude + 30% frequency-variance 가중 평균 (sdk.linkband 정확). 0.5초 윈도우
(`EEG_SQI_WINDOW = 250`) 마다 local mean 을 빼고, |x − mean| ≤ 150μV 면 1, 초과분은
비례 감점. variance 는 `1 - var/1000` 로 cap.

**`src/linkband/dsp.ts` (L390-425)** (핵심 부분 발췌)

```typescript
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
    ...
  }
  return ampSqi.map((a, i) => (0.7 * a + 0.3 * freqSqi[i]) * 100);
}
```

##### Spectrum (DFT)

Spectrum 은 1초 윈도우 (`DFT_WINDOW = 500`) 의 마지막 sample 에서 DC 제거 (mean
subtraction) 후, 정수 Hz 범위 (`kMin..kMax` 기본 1..45) 에서 Goertzel-style
DFT 를 dB 로.

**`src/linkband/dsp.ts` (L191-202) — `dftPowerDb`**

```typescript
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
```

##### Band power (Morlet wavelet)

Morlet wavelet 을 쓰는 이유는 시간-주파수 동시 해상도 — Δ (0.5-4Hz) 처럼 저주파
band 는 긴 wavelet 이, γ (30-50Hz) 처럼 고주파 band 는 짧은 wavelet 이 자동으로
잡힌다. linkband-style filter (notch + 1-50Hz bandpass) 통과한 raw EEG 의 마지막
2초 윈도우 (`BAND_POWER_WINDOW_RAW = 1000`) 에 대해 band 안 정수 Hz 별로 wavelet
power 를 구해 dB 로 합산.

**`src/linkband/dsp.ts` (L313-339) — `computeBandPower`**

```typescript
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
  const lo = Math.max(1, Math.ceil(fMin));
  const hi = Math.min(45, Math.floor(fMax - 1e-9));
  let dbSum = 0;
  for (let freq = lo; freq <= hi; freq++) {
    dbSum += morletPowerDb(filtered, freq);
  }
  return { linear: dbSum, db: dbSum };
}
```

##### EEG Indices (7개)

Band power 결과를 EEG literature 의 표준 비율식으로 조합. `safeRatio` 로 모든
0-나누기 가드. `hemisphericBalance` 만 ch1/ch2 alpha 양쪽 사용 — 나머지는 ch1
single-channel.

**`src/linkband/dsp.ts` (L775-813) — `computeEegIndices`** (핵심 부분)

```typescript
export function computeEegIndices(power: ComputedEegPower): EegIndices {
  const b = power.bands;
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
  ...
}
```

각 index 의 의미 (한 줄):

| Index | 산식 | 의미 |
|---|---|---|
| `focusIndex` | β / (α + θ) | β 가 α/θ 대비 강하면 집중 상태 |
| `relaxationIndex` | α / (α + β) | α 가 β 대비 강하면 이완 상태 |
| `stressIndex` | (β + γ) / (α + θ) | 고주파 활동이 강하면 스트레스 |
| `cognitiveLoad` | θ / α | θ 가 α 대비 강하면 인지 부하 |
| `hemisphericBalance` | (αL − αR) / (αL + αR) | + 면 좌뇌 (logical), − 면 우뇌 (creative) 우세 |
| `emotionalStability` | (α + θ) / γ | 저주파가 γ 대비 강하면 정서 안정 |
| `totalPower` | δ + θ + α + β + γ | 전체 신경 활동 수준 |

#### 2.3.3 PPG filter cascade + SQI + peak + HRV/HR

##### Filter

PPG 는 단일 bandpass 1-5Hz @ 50Hz (deployed `applySimpleFilter` 동일). 1-5Hz 가
심박 펄스 대역. 3 초 transient (≈ 0.5Hz HP biquad τ ≈ 0.32s 의 3 time
constants). `PPG_TRANSIENT_SAMPLES = 150` (3s @ 50Hz).

**`src/linkband/dsp.ts` (L480-489)**

```typescript
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
```

##### SQI

EEG 와 같은 amplitude-based SQI 지만 윈도우 25 sample, threshold 250 (PPG 신호
스케일이 다름).

**`src/linkband/dsp.ts` (L498-522)** (핵심 발췌)

```typescript
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
      if (amp <= PPG_SQI_AMP_THRESHOLD) sum += 1;
      else {
        const excess = Math.min((amp - PPG_SQI_AMP_THRESHOLD) / PPG_SQI_AMP_THRESHOLD, 1);
        sum += Math.max(0, 1 - excess);
      }
    }
    ...
  }
  return result;
}
```

##### Peak detection (filtered, local adaptive)

`detectPpgPeaks` 는 0.5초 양쪽 윈도우의 local max/mean 으로 동적 threshold =
mean + (max-mean)·0.6 산정. **local 이라 baseline drift 에 강건** — global mean
threshold 면 천천히 떠오르는 baseline 위로 peak 가 묻혀버린다. 5-point peak
shape (data[i] > data[i±1] AND > data[i±2]) + min interval 0.4s (= 150 BPM
상한) 으로 false positive 억제.

**`src/linkband/dsp.ts` (L533-565)** (핵심 부분)

```typescript
export function detectPpgPeaks(filtered: number[], fs: number): number[] {
  const peaks: number[] = [];
  const n = filtered.length;
  const windowSize = Math.floor(fs * 0.5); // 0.5s 한쪽 윈도우
  const minPeakDistance = Math.floor(fs * 0.4); // 0.4s = 150 BPM 상한
  if (n < 2 * windowSize + 1) return peaks;

  for (let i = windowSize; i < n - windowSize; i++) {
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
```

##### Peak detection (raw IR, HRV 전용)

`detectPpgPeaksForHrv` 는 raw IR (필터 X) 직접 사용. **raw 이유는 LF/HF
0.04-0.4Hz 보존** — 1Hz HP filter 를 통과시키면 그 대역이 잘려나가서 HRV LF/HF
분석이 불가능하다. global mean subtract → max·0.5 threshold + 3-point peak
shape.

##### RR → HRV / HR

`peaksToRrSeconds(peaks, fs)` → `computeHrvMetrics(rrMs)` 로 6 표준 HRV metric
산출.

**`src/linkband/dsp.ts` (L637-678)** (산식 발췌)

```typescript
export function computeHrvMetrics(rrIntervalsMs: number[]): HrvMetrics {
  const n = rrIntervalsMs.length;
  if (n === 0) return { avnn: 0, sdnn: 0, rmssd: 0, sdsd: 0, pnn50: 0, pnn20: 0 };

  let sum = 0;
  for (const rr of rrIntervalsMs) sum += rr;
  const avnn = sum / n;

  let varSum = 0;
  for (const rr of rrIntervalsMs) varSum += (rr - avnn) ** 2;
  const sdnn = Math.sqrt(varSum / n);
  ...
  // Successive differences (NN[i+1] - NN[i]).
  const m = n - 1;
  const diffs: number[] = new Array(m);
  for (let i = 0; i < m; i++) diffs[i] = rrIntervalsMs[i + 1] - rrIntervalsMs[i];

  let sqSum = 0;
  for (const d of diffs) sqSum += d * d;
  const rmssd = Math.sqrt(sqSum / m);
  ...
}
```

##### `computeHeartRate` vs `computeHeartRateValidated`

두 BPM 함수의 차이: 전자는 단순 평균 (`60000 / mean(RR)` + min/max RR 기반
hrMax/hrMin). 후자는 deployed PPGSignalProcessor 의 4-stage validated 산출 —
**물리학적 범위 [300, 1500]ms 필터링 → IQR 1.5× outlier 제거 → 선형 가중 평균
(최근 RR 가중) → BPM ∉ [40, 200] 거부 + CV > 0.5 면 0.9× 감쇠**. trend chart 처럼
robust 한 단일 BPM 이 필요할 때 후자, hrMax/hrMin 까지 필요한 metric card 갱신엔
전자.

**`src/linkband/dsp.ts` (L703-743) — `computeHeartRateValidated`** (핵심 발췌)

```typescript
export function computeHeartRateValidated(rrIntervalsMs: number[]): number {
  // 1. 생리학적 범위 필터.
  const valid = rrIntervalsMs.filter((rr) => rr >= 300 && rr <= 1500);
  if (valid.length === 0) return 0;
  ...
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
    const varRR = filtered.reduce((s, v) => s + (v - meanRR) ** 2, 0) / filtered.length;
    const cv = Math.sqrt(varRR) / meanRR;
    if (cv > 0.5) return Math.round(bpm * 0.9);
  }
  return Math.round(bpm);
}
```

#### 2.3.4 단위 변환 / 상수 요약

| 상수 | 값 | 의미 |
|---|---|---|
| `EEG_FS` | 500 | EEG sample rate (Hz) |
| `PPG_FS` | 50 | PPG sample rate (Hz) |
| `ACC_FS` | 25 | ACC sample rate (Hz) |
| `ACC_LSB_PER_G` | 16384 | int16 → g 변환 (±2g 모드) |
| `EEG_UV_FACTOR` | ≈ 0.0401 | 24-bit raw → μV (`Vref / GAIN / 2^23-1 × 1e6`) |
| `EEG_TRANSIENT_SAMPLES` | 500 | EEG filter settling = 1s @ 500Hz |
| `PPG_TRANSIENT_SAMPLES` | 150 | PPG filter settling = 3s @ 50Hz |
| `EEG_SQI_WINDOW` | 250 | SQI 윈도우 = 0.5s @ 500Hz |
| `BAND_POWER_WINDOW_RAW` | 1000 | Morlet wavelet 윈도우 = 2s @ 500Hz |
| `DFT_WINDOW` | 500 | DFT 윈도우 = 1s @ 500Hz |

### 2.4 `thresholds.ts` — 임계값 메타데이터

각 metric/index 에 대해 사람이 읽는 displayName / description / formula /
reference / normalRange + threshold level 분류 + 색상을 담는 정적 metadata.
EEG/PPG/ACC 각각 record 로.

**`src/linkband/thresholds.ts` (L11-29) — 타입**

```typescript
export type ThresholdColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";

export interface ThresholdLevel {
  min: number;
  max: number;
  label: string;
  color: ThresholdColor;
}

export interface IndexThreshold {
  key: string;
  displayName: string;
  unit?: string;
  formula?: string;
  description?: string;
  reference?: string;
  normalRange: [number, number];
  levels: ThresholdLevel[];
}
```

**`src/linkband/thresholds.ts` (L35-48) — `focusIndex` entry 예시**

```typescript
focusIndex: {
  key: "focusIndex",
  displayName: "Focus",
  description:
    "Represents cognitive focus level. Higher values indicate deep focus, lower values indicate attention distraction.",
  formula: "Focus = β / (α + θ)",
  reference: "Klimesch, W. (1999). Brain Research Reviews, 29(2-3), 169-195",
  normalRange: [1.8, 2.4],
  levels: [
    { min: NEG_INF, max: 1.8, label: "Attention deficit or drowsiness", color: "yellow" },
    { min: 1.8, max: 2.4, label: "Normal focus", color: "green" },
    { min: 2.4, max: POS_INF, label: "Excessive focus or stress", color: "red" },
  ],
},
```

이 entry 는 EEG index card 의 hover tooltip 에 그대로 흘러간다 — formula 줄,
normal range 줄, 그리고 levels 가 "1.8–2.4: Normal focus" 형태의 interpretation
list 로 출력된다 (자세한 건 §3.3 의 `eeg-index-card.ts` 참조).

`classifyIndex(value, threshold)` 는 `levels` 를 순회하며 `value ∈ [min, max)` 인
첫 level 을 반환 → 카드의 dot 색 + status 라벨이 갱신된다.

색상 토큰 (`text-red-400` 같은 Tailwind 클래스 이름)을 직접 hex/rgba 문자열로
반환하는 helper (`getThresholdTextClass` 등) 도 같은 파일에 — vanilla TS +
inline-style 환경에 맞춤.

---

## 3. UI 폴더 — `src/ui/`

### 3.1 `layout.ts` — Header / Tabs / VisualizerHeader / Footer

sensor-dashboard `App.tsx` 의 sticky 탭 시스템과 `Header.tsx` / `Footer.tsx` /
`VisualizerHeader.tsx` 를 vanilla TS DOM 으로 미러링. 단일 파일에 4 헬퍼:

- `createHeader(container, opts) → HeaderHandle` — 좌측 brand + 우측 status pill
  / battery pill + Connect / Replay 버튼.
- `createTabs(container, tabs, onChange) → TabsHandle` — 3-탭 위젯, active 토글.
- `createVisualizerHeader(container) → VisualizerHeaderHandle` — Streaming /
  SignalQuality 배지.
- `createFooter(container) → FooterHandle` — Messages 카운트 + Rate (msg/s) +
  Status + 버전 라벨.

`shadcn` / Radix / Tailwind 의존성 없이 순수 inline style. footer 는 setInterval
로 1 초 주기로 rate 갱신.

### 3.2 `chart.ts` — ECharts wrapper

ECharts 의 tree-shake 가능한 `echarts/core` + 필요 모듈 (LineChart, Grid /
Tooltip / Legend Component, CanvasRenderer) 만 등록. `createChart(host, option)`
이 init + window resize 자동 핸들러까지 묶어 `ChartHandle` 로 반환.

**`src/ui/chart.ts` (L32-44)**

```typescript
export function createChart(container: HTMLElement, option: EChartsOption): ChartHandle {
  const chart = echarts.init(container);
  chart.setOption(option);
  const onResize = (): void => chart.resize();
  window.addEventListener("resize", onResize);
  return {
    chart,
    dispose() {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    },
  };
}
```

option builder 두 종: `buildRealtimeLineOption(opts)` 는 단일 라인 + 고정 y 범위
(EEG ch1/ch2, PPG SQI 등 단일 channel 차트 용도). `buildMultiLineOption(opts)`
는 다중 라인 + legend (PPG IR/Red, ACC X/Y/Z 같은 multi-channel 용도). 둘 다
`tooltipFormatter` 콜백을 받아 view 별 문구 ("t = 2.13s | ch1: -25.3 μV") 를
만들 수 있다.

### 3.3 `metric-card.ts` / `eeg-index-card.ts` / `band-power-card.ts`

#### `metric-card.ts` — 단순 metric 카드

PPG metrics 패널이 17 인스턴스를 만들어 사용. 시각 구조: dot + label + 큰 숫자 +
status 라인. `update(value)` 로 숫자 갱신 (`null` 이면 "—" + "No data"). threshold
분류는 없음 — DSP 가 산출한 raw 값만 표시.

#### `eeg-index-card.ts` — Index 카드 + hover tooltip

7 EEG index 카드가 사용. metric-card 와 같은 시각 구조에 더해 카드 위로 떠 있는
absolute-positioned tooltip 을 추가로 그린다. `update(value)` 시 `classifyIndex`
로 threshold level 을 찾아 dot 색 + status 라벨을 갱신.

Tooltip DOM 구조: title (displayName) + description + formula (mono) + normal
range + interpretation list (각 level 의 "min−max: label") + reference (italic).
`mouseenter` / `mouseleave` 로 opacity + visibility 토글.

**`src/ui/eeg-index-card.ts` (L243-273)** (hover 토글 + update 핵심)

```typescript
card.addEventListener("mouseenter", () => {
  tooltip.style.opacity = "1";
  tooltip.style.visibility = "visible";
});
card.addEventListener("mouseleave", () => {
  tooltip.style.opacity = "0";
  tooltip.style.visibility = "hidden";
});

container.appendChild(card);

return {
  element: card,
  update(value: number | null | undefined): void {
    if (isValidNumber(value)) {
      const level = classifyIndex(value, threshold);
      valueEl.textContent = value.toFixed(2);
      statusEl.textContent = level.label;
      const dotColor = getThresholdDotClass(level.color);
      const textColor = getThresholdTextClass(level.color);
      dot.style.background = dotColor;
      statusEl.style.color = textColor;
    } else {
      valueEl.textContent = "--";
      statusEl.textContent = "No data";
      dot.style.background = NO_DATA_DOT;
      statusEl.style.color = NO_DATA_TEXT;
    }
  },
};
```

#### `band-power-card.ts` — Band power 카드 (vertical Total / Ch1 / Ch2)

각 EEG band (Δ/θ/α/β/γ) 마다 1 카드. 시각 구조는 vertical bar 3개 (Total 큰 막대
2rem, Ch1 / Ch2 작은 막대 1.5rem each). **Ch1 = 파랑 (`#3b82f6`), Ch2 = 빨강
(`#ef4444`)** — band 색상이 아니라 channel 색상 고정 (sensor-dashboard 미러).
하단에 band name + range·description + L/R diff (cyan).

**Cross-band global 정규화**: caller (eeg-view) 가 모든 band 의 ch1/ch2 max 를
한 번 계산해서 `update({ ch1Db, ch2Db, maxPower })` 로 넘겨준다. 카드는
`(v / maxPower) × 100` 로 막대 height % 산출. maxPower ≤ 0 면 (음수 dB 영역)
모두 0%.

**`src/ui/band-power-card.ts` (L226-260)** (update 핵심)

```typescript
update(values: BandPowerCardUpdate | null): void {
  if (
    values === null ||
    !Number.isFinite(values.ch1Db) ||
    !Number.isFinite(values.ch2Db)
  ) {
    if (total.bar.overlay) total.bar.overlay.textContent = "—";
    ch1Value.textContent = "—";
    ch2Value.textContent = "—";
    diffEl.textContent = "L/R diff: —";
    total.bar.fill.style.height = "0%";
    ch1.bar.fill.style.height = "0%";
    ch2.bar.fill.style.height = "0%";
    return;
  }
  const { ch1Db, ch2Db, maxPower } = values;
  const combined = (ch1Db + ch2Db) / 2;

  // Cross-band global 정규화 — sensor-dashboard 와 동일.
  // maxPower ≤ 0 면 전부 0% (음수 dB 영역 — div explosion 회피).
  const norm = (v: number): number =>
    maxPower > 0 ? Math.max(0, Math.min(100, (v / maxPower) * 100)) : 0;
  const pctTotal = norm(combined);
  const pctCh1 = norm(ch1Db);
  const pctCh2 = norm(ch2Db);

  total.bar.fill.style.height = `${pctTotal}%`;
  ch1.bar.fill.style.height = `${pctCh1}%`;
  ch2.bar.fill.style.height = `${pctCh2}%`;
  ...
},
```

### 3.4 Sensor view (`eeg-view.ts` / `ppg-view.ts` / `acc-view.ts`)

#### 3.4.1 `eeg-view.ts`

##### 레이아웃

5 row (sensor-dashboard `EEGVisualizer.tsx` 미러):

1. Hero card (제목 + 설명).
2. 2-col: Ch1 Filtered (FP1) | Ch2 Filtered (FP2). 각 카드 안 LeadOff /
   Saturated banner + filtered chart.
3. 2-col: Ch1 SQI | Ch2 SQI (0-100% 라인 차트).
4. 2-col: Power Spectrum (DFT, 5-band markArea overlay) | Band Power 5 cards.
5. Full-width: 7 EEG Analysis Indices.

##### onBatch 처리 흐름

매 batch 마다:

1. 25 sample loop 으로 ch1/ch2 filter cascade 통과 (`processEegSample`) → raw +
   filtered 모두 buffer 에 push.
2. LeadOff banner / Saturated banner 토글.
3. Ch1/Ch2 filtered 차트 즉시 갱신.
4. `batchCount++` 후 throttle 분기로 무거운 DSP 호출.

##### 차트 갱신 cadence (왜 throttle 하나)

EEG batch 는 50ms 마다 (= 20 Hz). `computeEegPower` 는 Morlet wavelet × 5 bands ×
2 ch ≈ 7M ops/call. 매 batch 호출 시 ~140M ops/sec → 브라우저 stall.

| 작업 | cadence | 사유 |
|---|---|---|
| Filtered 차트 | 매 batch (50ms) | 가볍고 시각 즉시 반응 필요 |
| SQI / spectrum | 매 5 batches (250ms) | DFT/SQI 둘 다 ~1M ops × 2 ch |
| Band power / indices | 매 10 batches (500ms) | Morlet 가장 무거움 |

**`src/ui/eeg-view.ts` (L499-512)** (throttle 정의)

```typescript
// EEG batch 는 50ms 마다 (20 Hz). 무거운 DSP (computeEegPower 7M ops, calculateEegSqi
// 1M ops × 2 ch) 를 매 batch 호출하면 ~160M ops/sec → 브라우저 stall. counter 로 throttle:
//   - filtered 차트: 매 batch (가볍고 시각 즉시 반응 필요)
//   - SQI / spectrum: 매 5 batches (= 250ms 갱신)
//   - band power / indices: 매 10 batches (= 500ms 갱신, Morlet 무거움)
let batchCount = 0;
const SQI_INTERVAL = 5;
const SPECTRUM_INTERVAL = 5;
const POWER_INTERVAL = 10;

function pushAndTrim(buf: number[], v: number): void {
  buf.push(v);
  if (buf.length > EEG_BUFFER_SIZE) buf.splice(0, buf.length - EEG_BUFFER_SIZE);
}
```

**`src/ui/eeg-view.ts` (L597-625)** (band power + indices 분기)

```typescript
// Band power + Indices: 매 10 batches (500ms). Morlet wavelet × 5 bands × 2 ch
// ≈ 7M ops/call — 가장 무거움. 매 batch (20Hz) 호출 시 ~140M ops/sec 로 stall.
if (batchCount % POWER_INTERVAL === 0) {
  const power = computeEegPower(ch1RawBuf, ch2RawBuf, fs);
  if (power) {
    let maxPower = 0;
    for (const band of EEG_BANDS) {
      const b = power.bands[band.key];
      if (b.ch1Db > maxPower) maxPower = b.ch1Db;
      if (b.ch2Db > maxPower) maxPower = b.ch2Db;
    }
    for (const band of EEG_BANDS) {
      const b = power.bands[band.key];
      bandCards[band.key].update({
        ch1Db: b.ch1Db,
        ch2Db: b.ch2Db,
        maxPower,
      });
    }
    const idx = computeEegIndices(power);
    indexCards.focusIndex.update(idx.focusIndex);
    indexCards.relaxationIndex.update(idx.relaxationIndex);
    indexCards.stressIndex.update(idx.stressIndex);
    indexCards.cognitiveLoad.update(idx.cognitiveLoad);
    indexCards.hemisphericBalance.update(idx.hemisphericBalance);
    indexCards.emotionalStability.update(idx.emotionalStability);
    indexCards.totalPower.update(idx.totalPower);
  }
}
```

#### 3.4.2 `ppg-view.ts`

##### 레이아웃

4 row:

1. Hero card.
2. 2-col: Filtered PPG (IR + Red multi-line) | PPG SQI 차트.
3. Full-width: BPM Trend (~60s 윈도우 라인 차트).
4. Full-width: HRV Metrics 17 카드 (9 active + 8 placeholder).

9 active: BPM, HR Max, HR Min, AVNN, SDNN, RMSSD, SDSD, PNN50, PNN20.
8 placeholder: SpO₂, LF / HF / LF-HF, Stress Index, Stability, Intensity, Total
Power.

##### onBatch 처리 흐름

매 batch (560ms 마다):

1. 28 sample loop 으로 ir/red filter 통과 → filtered buffer 에 push.
2. Filtered chart + SQI chart 즉시 갱신 (PPG 는 batch 주기 자체가 길어 throttle
   불필요).
3. `detectPpgPeaks(irBuf, fs)` → `peaksToRrSeconds` → ms 변환.
4. RR ≥ 1 일 때 `computeHeartRate` + `computeHrvMetrics` 호출 → 9 active 카드 +
   BPM trend buffer 갱신.

**`src/ui/ppg-view.ts` (L340-370)** (peak → RR → HRV/HR 흐름)

```typescript
// Peak detection on filtered IR → RR seconds → HRV/HR.
const peaks = detectPpgPeaks(irBuf, fs);
const rrSeconds = peaksToRrSeconds(peaks, fs);
const rrMs = rrSeconds.map((s) => s * 1000);

// 9 active metric cards 갱신 — RR ≥ 1 일 때 의미 있는 값.
if (rrMs.length >= 1) {
  const hr = computeHeartRate(rrMs);
  const hrv = computeHrvMetrics(rrMs);
  m.bpm.update(hr.bpm);
  m.hrMax.update(hr.hrMax);
  m.hrMin.update(hr.hrMin);
  m.avnn.update(hrv.avnn);
  m.sdnn.update(hrv.sdnn);
  m.rmssd.update(hrv.rmssd);
  m.sdsd.update(hrv.sdsd);
  m.pnn50.update(hrv.pnn50);
  m.pnn20.update(hrv.pnn20);

  // BPM trend buffer — 1 entry per batch.
  pushAndTrim(bpmHistoryBuf, hr.bpm, BPM_HISTORY_SIZE);
  const bpmLast = Math.max(bpmHistoryBuf.length - 1, 0);
  const bpmData: Array<[number, number]> = bpmHistoryBuf.map((v, i) => {
    const dt = (i - bpmLast) * (PPG_BUFFER_SIZE / fs / batch.ir.length);
    return [dt, v];
  });
  bpmTrendChart.chart.setOption({
    xAxis: { min: -BPM_WINDOW_SEC, max: 0 },
    series: [{ data: bpmData }],
  });
}
```

#### 3.4.3 `acc-view.ts`

##### 레이아웃

4 row:

1. Hero card + 3 InfoBadge ("3-axis", "25Hz sampling", "Unit: g").
2. Full-width: 3-Axis Acceleration Waveform (X/Y/Z multi-line, ±2g 범위).
3. Full-width: Magnitude (√(x²+y²+z²) area chart, 0..3g).
4. Full-width: Movement Analysis placeholder (DSP 미구현).

##### onBatch 처리 흐름

ACC 는 DSP 가 없다 — 단순 산술. 매 batch (1200ms 마다):

1. 30 sample loop 으로 raw int16 → g 변환 (`raw / ACC_LSB_PER_G`).
2. 동시에 per-sample magnitude `√(x²+y²+z²)` 계산.
3. waveform chart (X/Y/Z 3 series) + magnitude chart 갱신.

throttle 없음 — batch 주기 자체가 1.2s 라 충분히 여유.

**`src/ui/acc-view.ts` (L234-266)**

```typescript
onBatch(batch: AccBatch): void {
  // raw int16 → g 변환 (1g = ACC_LSB_PER_G LSB, spec §9). per-sample magnitude
  // 도 g 단위로 누적 — 정지 시 magnitude ≈ 1g (중력 벡터).
  for (let i = 0; i < batch.x.length; i++) {
    const x = batch.x[i] / ACC_LSB_PER_G;
    const y = batch.y[i] / ACC_LSB_PER_G;
    const z = batch.z[i] / ACC_LSB_PER_G;
    pushAndTrim(xBuf, x);
    pushAndTrim(yBuf, y);
    pushAndTrim(zBuf, z);
    pushAndTrim(magBuf, Math.sqrt(x * x + y * y + z * z));
  }

  const fs = batch.fs;
  const xLast = Math.max(xBuf.length - 1, 0);
  const yLast = Math.max(yBuf.length - 1, 0);
  const zLast = Math.max(zBuf.length - 1, 0);
  const magLast = Math.max(magBuf.length - 1, 0);

  const xData: Array<[number, number]> = xBuf.map((v, i) => [(i - xLast) / fs, v]);
  const yData: Array<[number, number]> = yBuf.map((v, i) => [(i - yLast) / fs, v]);
  const zData: Array<[number, number]> = zBuf.map((v, i) => [(i - zLast) / fs, v]);
  const magData: Array<[number, number]> = magBuf.map((v, i) => [(i - magLast) / fs, v]);

  waveChart.chart.setOption({
    xAxis: { min: -ACC_WINDOW_SEC, max: 0 },
    series: [{ data: xData }, { data: yData }, { data: zData }],
  });
  magChart.chart.setOption({
    xAxis: { min: -ACC_WINDOW_SEC, max: 0 },
    series: [{ data: magData }],
  });
},
```

---

## 4. 센서별 처리 흐름 요약

| 항목 | EEG | PPG | ACC |
|---|---|---|---|
| Sample rate | 500 Hz | 50 Hz | 25 Hz |
| 패킷 크기 | 179 bytes (25 sample × 7 + 4 header) | 172 bytes (28 sample × 6 + 4 header) | 184 bytes (30 sample × 6 + 4 header) |
| 패킷 주기 | 50 ms | 560 ms | 1200 ms |
| Filter chain | notch 60Hz Q=2 → HP 1Hz Q=1/√2 → LP 45Hz Q=1/√2 (cascade); band power 용 별도 linkband-style notch + 1-50Hz bandpass | bandpass 1-5Hz (linkband Q ≈ 0.559) 단일 biquad | (없음) |
| Transient | 1s = 500 sample | 3s = 150 sample | 0 |
| 분석 산출물 | SQI (70% amp + 30% var, 0.5s 윈도우), Spectrum (DFT 1..45Hz), Band power (Morlet 5 bands), 7 Indices (focus/relax/stress 등) | SQI (amp, 25-sample 윈도우), Peaks (local adaptive 5-pt), HRV 6 metrics, HR 2종 (단순 vs validated), BPM trend | per-sample magnitude `√(x²+y²+z²)` |
| View 카드/차트 | 5 row: hero + 2 filtered chart + 2 SQI chart + spectrum chart + 5 band cards + 7 index cards | 4 row: hero + filtered chart + SQI chart + BPM trend chart + 17 metric cards (9 active) | 4 row: hero + waveform (X/Y/Z) chart + magnitude chart + placeholder |
| Throttle | 매 5 / 5 / 10 batch 분기 (250 / 250 / 500 ms 갱신) | 매 batch (560ms 자체가 충분히 여유) | 매 batch (1200ms 자체가 충분히 여유) |

---

## 5. 외부 reference

코드의 numerical 정답지가 어디인지 정리. spec (`docs/01-protocol-spec.md`)
은 이 source 들에서 추출한 snapshot이다.

| # | Source | 역할 |
|---|---|---|
| 1 | https://github.com/LooxidLabs/SDK-Android (`develop`) | Primary Kotlin reference. `SensorDataParser.kt` (parsing), `BleManager.kt` (UUIDs, GATT 시퀀스), `SensorConfiguration.kt` (magic numbers), `SensorData.kt` (data model). 가장 깨끗하고 작은 reference — spec 의 1차 출처. |
| 2 | https://github.com/LooxidLabs/link_band_sdk | Cross-validation Python reference (`python_core/app/core/{device,signal_processing}.py`). 파싱 edge case 비교 + DSP 산출물 numerical 검증. |
| 3 | https://github.com/donghyeon99/sensor-dashboard | 선행 repo (mock-data 기반 React dashboard). `src/lib/dsp/` (biquad, eegPipeline, ppgPipeline, spectrum), `src/lib/sensors/`, `src/components/{eeg,ppg}/`, `src/lib/thresholds/` — 본 repo 의 dsp.ts / view 들의 직접 출처. |
| 4 | `../sensor-dashboard/.tmp_kotlin/` (local sibling, gitignored) | source #1 의 offline cache. 4개 핵심 Kotlin 파일 (`BleManager.kt`, `SensorDataParser.kt`, `SensorConfiguration.kt`, `LinkBandSdk.kt`). |

규칙:

- 프로토콜 ambiguity: source #1 (Kotlin) 이 canonical. 단, fixture 실측이 Kotlin
  과 disagree 하면 (500 Hz EEG, 16-bit LE ACC) 실측 우선.
- DSP / metric 의 numerical 정답: source #2 (Python) 또는 source #3 (TS deployed).
- BLE GATT 시퀀스 / UUID: source #1 `BleManager.kt`.
- DSP TS 코드 직접 출처: source #3 `src/lib/dsp/{biquad,eegPipeline,ppgPipeline,spectrum}.ts`.
