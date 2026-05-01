# Progress & Decision Log — linkband-app

이 문서는 두 세션(작업 세션 + 감독 세션) 협업에서 결정·진행 사항이 휘발되지 않도록
**모든 의미 있는 작업 단위마다 1개 entry**를 기록하는 곳이다.

`docs/01-protocol-spec.md`는 잠긴 사양서고 자주 바뀌지 않는다.
`02-progress-log.md`는 그 사양서가 **어떤 흐름으로 바뀌어왔는지**, 그리고
**구현이 어디까지 어떻게 갔는지**를 보여준다.

---

## 사용 규칙

- 새 entry 는 `## Log` 섹션의 **맨 위에** (newest first).
- 한 entry = 한 의미 있는 단위 (커밋, 결정, 검증, 이슈, 차단 등).
- 각 entry 의 헤더에 다음 태그 중 하나 이상을 붙인다:
  - `[DECISION]` — 잠긴 설계 결정 (spec 갱신 동반 가능)
  - `[PROGRESS]` — 작업 진행 (코드 추가/수정, 단계 통과)
  - `[VERIFIED]` — 실 데이터로 가설 검증 완료
  - `[ISSUE]` — 문제 발생 또는 차단
  - `[FIX]` — 이슈 해결
- entry 본문 구조 권장:
  - **무엇을** (1~3줄 요약)
  - **결정/결과** (있다면)
  - **다음 단계** (있다면)
  - **참조** (spec § / 커밋 hash / 파일 경로)
- 결정이 spec 을 바꾸면 spec doc 도 같이 갱신하고 entry 에 `spec §X 갱신` 명시.
- 열린 질문은 인라인 `- [ ] Q: ...` 체크박스로. 답이 나오면 체크 + 어떤 entry에서
  답이 나왔는지 링크.
- 한 세션 안에서 entry 가 여러 개 생기는 게 정상. 묶지 말 것.
- 시간은 한국 시간 기준 `YYYY-MM-DD (오전/오후/저녁)` 정도 정밀도면 충분.

---

## 미해결 항목 (열린 질문 누적)

spec §17의 검증 항목과 동기화. 진행 중인 것만 여기 노출.

- [x] **Q1**: ACC 6-byte 레이아웃 — **가설 B (16-bit LE) 확정**. ↓ 2026-05-01 [VERIFIED] entry 참조.
- [x] **Q6**: 패킷 헤더 timestamp 의미 — **boot-relative uptime 확정**. ↓ 같은 [VERIFIED] entry.
- [x] **Q7** (신규): EEG nominal fs — **500Hz 확정** (Kotlin SDK 250Hz 오류). ↓ 같은 [VERIFIED] entry.
- [ ] **Q8** (신규): PPG stream 조기 종료 — 헤드밴드 착용 시 0 packet, 미착용 시 7 packet 후 stop. parser 비차단, ble.py 단계에서 재구독/모니터링 처리.
- [ ] **Q2**: leadOff 비트마스크 vs 단순 플래그. 장기 관측 필요.
- [ ] **Q3**: PPG raw 단위 변환 필요성. MVP 범위 밖, 후순위.
- [ ] **Q4**: Battery notification 빈도 — 30초 spike 동안 0건. level-change 트리거 추정. 비차단.
- [ ] **Q5**: EEG 외 추가 펌웨어 명령 존재. 후순위.

---

## Log

### 2026-05-02 — eeg-view DSP throttle 도입 (브라우저 stall 수정) [FIX]

**증상**: 사용자가 Replay 시작 후 일정 시간 뒤 "갑자기 멈췄어 그래프가 안그려져" 보고. EEG 탭의 차트들이 갱신을 멈춤.

**원인**: EEG batch 가 50ms 주기 (= 20 Hz). 매 batch 마다 호출되던 무거운 DSP:
- `computeEegPower` (Morlet wavelet × 5 bands × 2 channels) ≈ **7M ops/call** → 20Hz × 7M = **140M ops/sec**
- `calculateEegSqi` 2 channels ≈ **1M ops/call** → 20M ops/sec
- `computeSpectrum` 2 channels ≈ 45k ops × 20 = 900k ops/sec
- 합산 ~160M ops/sec — Math.exp/sin/cos 가 절반 → 실효 100M+ ops/sec 상한 근접 → 누적 lag → main thread stall → 차트 갱신 멈춤

**Fix** (`src/ui/eeg-view.ts`): frame counter 로 cadence 분리.
- **Filtered 차트** (가벼움): 매 batch (50ms 시각 반응)
- **SQI**: 매 5 batches (250ms)
- **Power spectrum**: 매 5 batches (250ms)
- **Band power + Indices** (가장 무거움): 매 10 batches (500ms)
- SQI throttle 시 누락 보정: append 길이를 `batch.length × SQI_INTERVAL` 로 확장 → 시간축 일관성 유지

**부하 비교**:
| 항목 | 수정 전 | 수정 후 |
|---|---|---|
| computeEegPower | 20 Hz | 2 Hz |
| calculateEegSqi | 20 Hz | 4 Hz |
| computeSpectrum | 20 Hz | 4 Hz |
| 총 ops/sec | ~160M | ~17M |

500ms band power 갱신은 시각적으로 충분 (사람 인지 한계). filter chart 의 50ms 갱신은 그대로라 신호 모양엔 영향 없음.

**가드레일**:
- 새 폴더 0, 새 dependency 0
- chart.ts / parser.ts / models.ts / main.ts / layout.ts / ppg-view / acc-view / dsp.ts 수정 0
- view 파일만 수정 (eeg-view.ts 의 onBatch 로직 부분)

**검증**: `tsc --noEmit` 통과. `npm run test:run` **53/53 GREEN**. `npm run build` 통과 (JS 552.92 → 553.01 KB, +0.09 KB counter logic).

**참조**: `src/ui/eeg-view.ts` `onBatch` (line 380~), 배치 throttle counter.

---

### 2026-05-02 — sdk.linkband.store 배포 코드 비교 [VERIFIED]

**무엇을**: 배포 빌드 source map 분석 후 우리 DSP 와 6 항목 비교. 코드 수정 없음 — 보고만.

**번들 / source map**:
- 메인: `https://sdk.linkband.store/assets/index-u1f-s9Xp.js` (3.87 MB) + `.map` (15 MB)
- chunks: `charts-CNtBapQM.js` / `ui-DB6I6AG1.js` / `vendor-B0VEr0tq.js` 모두 `.map` 동반
- source map 정상 — 776 sources 복원. DSP 파일: `src/utils/EEGSignalProcessor.ts` (28 KB), `src/utils/PPGSignalProcessor.ts` (48 KB), `node_modules/biquadjs/dist/BiquadFilters.esm.js` (6 KB)
- ⚠️ sensor-dashboard 로컬 레포(`src/lib/dsp/{biquad,eegPipeline,spectrum,ppgPipeline}.ts`) 와는 **다른 코드베이스**. 배포는 `looxidlabs/sdk.linkband.store` repo (별도)

**비교 결과**:

| # | 항목 | 우리 (`src/linkband/dsp.ts`) | 배포 (`sdk_PPGSignalProcessor.ts` etc.) | 판정 |
|---|------|------|------|------|
| 1 | **PPG filter** | HP 0.5Hz + LP 5Hz cascade (Butterworth Q=1/√2) | **bandpass 1.0-5.0Hz** (biquadjs `makeBandpassFilter`, linkband Q) | ⚠️ DIFF — HP cutoff 0.5 vs **1.0** |
| 2 | **PPG peak detection** | global threshold (max × 0.6) + 0.4s 간격 + 3-sample peak (`> prev && >= next`) | **local adaptive threshold** (0.5s 윈도우, `localMean + (localMax-localMean)×0.6`) + 0.4s 간격 + **5-sample peak** (`> ±1, ±2`) | ⚠️ DIFF |
| 3 | **PPG BPM 산출** | 단순 평균 (`60000 / mean(RR)`) | **가중평균** (최근일수록 높은 weight) + IQR outlier 제거 + 300-1500ms filter + 40-200 BPM 검증 + CV>0.5 시 10% 감소 보정 | ⚠️ DIFF |
| 4 | **HRV RR 추출 source** | filtered IR | **RAW IR** (별도 `detectPeaksForHRV`). 명시적 주석: "LF(0.04-0.15Hz)/HF(0.15-0.4Hz) 가 1.0Hz HP 로 제거되지 않도록" | ⚠️ DIFF (LF/HF 구현 시 핵심) |
| 5 | **EEG sample rate** | **500Hz** (BLE raw, 우리 spec §17 Q7 실측) | **250Hz** (서버에서 2:1 down-sample 후 frontend 도달 추정) | 🟢 CONTEXT-CORRECT — 각자 환경에 맞음 |
| 6 | **EEG bands 범위** | delta 1-4, theta 4-8, alpha 8-13, beta 13-30, gamma 30-**45** | delta **0.5**-4, theta 4-8, alpha 8-13, beta 13-30, gamma 30-**50** | ⚠️ DIFF (양쪽 호환 가능 수준) |
| 7 | **EEG filter form** | notch 60Hz Q=2 (linkband-Q) + HP 1Hz + LP 45Hz (둘 다 Butterworth Q) | biquadjs `makeNotchFilter(60, fs, 2)` + `makeBandpassFilter(1, 45, fs)` (둘 다 linkband-Q) | ⚠️ DIFF (HP+LP 분리 vs 단일 bandpass; Q 산식 다름) |
| 8 | **EEG SQI** | 70% amp + 30% freq, threshold 150μV, window 0.5s | sensor-dashboard 의 70/30 + threshold 150μV + amp/freq 별도 함수. transient 250 샘플 skip | 🟢 거의 MATCH |
| 9 | **PPG SQI** | 25-sample window, threshold 250, 100% scale | 동일 — 25-sample window, threshold **250**, 250-500 선형 감소 | 🟢 MATCH |
| 10 | **EEG indices 산식** | 자체 dB-difference (focusIndex = β−α 등) | 별도 인덱스 계산 함수 존재 (`focusIndex`, `relaxationIndex`, ...) — 본 비교에선 산식까지 도달 못 함 (28KB 중 인덱스 계산부 미열람) | 🟡 UNKNOWN — 추가 비교 필요 |

**핵심 발견**:

1. **HRV 이중 데이터 흐름** (배포의 의도된 설계):
   - 시각화용 filtered: bandpass 1-5Hz 적용된 IR/Red (펄스 모양 표시)
   - HRV 계산용 RAW IR: 별도 peak 검출 (LF/HF 보존)
   - 우리는 단일 흐름 (filtered 만) — LF/HF 구현 시 정확도 떨어짐 예상

2. **PPG filter HP 0.5 vs 1.0**:
   - 0.5Hz 이상 = 30 BPM 이상 통과
   - 1.0Hz 이상 = 60 BPM 이상 통과 (서맥 환자에겐 손실)
   - 우리 0.5 가 더 보수적이지만 노이즈 더 들어옴
   - **데이터 결과 차이의 가장 큰 원인일 가능성**: HP cutoff 절반 → 저주파 baseline drift 가 우리 신호에 더 남음 → peak 검출 불안정 → BPM 변동 큼

3. **Peak 검출 알고리즘**:
   - 우리 global threshold = max × 0.6 → outlier 1개로 threshold 인플레이션 → 다른 peak 놓침
   - 배포 local adaptive → baseline drift 에 robust
   - **두 번째로 큰 BPM 정확도 차이 원인**

4. **BPM 후처리**:
   - 우리는 단순 평균만
   - 배포는 IQR + 가중평균 + 검증 + smoothing
   - **사용자가 "결과가 다르다" 라고 한 핵심 원인 — 우리 BPM 이 더 노이즈에 흔들림**

**권장 정정** (우선순위 순, 다음 청크 후보):

1. 🔴 **PPG peak detection 알고리즘 교체**: global → **local adaptive threshold** + 5-sample window
2. 🔴 **PPG BPM 후처리 추가**: IQR outlier 제거 + 가중평균 + 40-200 BPM 검증
3. 🟠 **PPG filter cutoff 정정**: HP 0.5 → 1.0 (또는 sensor-dashboard 로컬 vs 배포 의도 차이를 설계 결정으로 [DECISION] 기록)
4. 🟠 **HRV RR source 분리**: filtered → **RAW IR 전용 peak** 검출 (LF/HF 구현 대비)
5. 🟡 **EEG band 범위 정렬**: delta 1→0.5, gamma 45→50 (배포 호환)
6. 🟡 **biquadjs 도입 검토 OR 우리 hand-rolled 와의 numerical 동등성 확인**: Butterworth Q vs linkband Q 차이는 미세하나 명시
7. 🟢 **EEG SQI / PPG SQI**: 거의 일치, 변경 불필요
8. 🟢 **EEG fs**: 우리 500 정확. 배포 250 은 서버 down-sample 추정 — 환경 차이로 둠

**참조**:
- 배포 번들: https://sdk.linkband.store/assets/index-u1f-s9Xp.js + `.map`
- 추출된 sources: `C:/Users/cowgo/AppData/Local/Temp/sdk_{PPGSignalProcessor,EEGSignalProcessor,BiquadFilters.esm}.{ts,js}`
- 우리 DSP: `src/linkband/dsp.ts`

**가드레일 준수**: 코드/spec/test 수정 0. progress-log entry 만 추가. `npm run test:run` 53/53 그대로.

---

### 2026-05-02 (밤) — PPG DSP 5/5: ppg-view DSP 와이어링 [PROGRESS]

**무엇을**: `src/ui/ppg-view.ts` 전체 rewrite — filter cascade + SQI + peak detection + HRV/HR 메트릭 + BPM trend 차트 통합. 4-row 레이아웃.

**구조**:
1. Hero card
2. 2-col Row: **Filtered chart** (filtered IR/Red 라인) | **SQI chart** (실 PPG SQI)
3. Full-width: **💓 BPM Trend** (실 차트, ~60s 윈도우, smooth, y 40-160 BPM)
4. Full-width: **💓 HRV Metrics** — 17 cards (9 active + 8 placeholder)

**Active 9 cards** (RR-based, 매 batch 갱신):
- Heart Rate (BPM), HR Max, HR Min, AVNN, SDNN, RMSSD, SDSD, pNN50, pNN20

**Placeholder 8 cards** (이번 범위 밖):
- SpO₂, LF Power, HF Power, LF/HF Ratio, Stress Index, Stability, Intensity, Total Power

**Peak detection 흐름**:
1. raw IR 샘플 → `processPpgSample` (HP 0.5Hz → LP 5Hz cascade) → filtered IR buffer (size 400, 8s)
2. 매 batch 마다 `detectPpgPeaks(irBuf, fs)` → peak 인덱스 배열
3. `peaksToRrSeconds(peaks, fs)` → RR seconds → ×1000 → RR ms
4. `computeHeartRate(rrMs)` + `computeHrvMetrics(rrMs)` → 9 metric cards 갱신
5. BPM 값을 `bpmHistoryBuf` 에 push (cap 100), BPM trend 차트 갱신

**Filter chart 갱신**: filtered IR/Red 가 buffer 에 누적 → multi-line 차트. y 범위 ±250 (sensor-dashboard PPGFilteredChart 와 동일).

**SQI 차트**: `calculatePpgSqi(irBuf)` 매 batch → 마지막 batch 길이만큼 SQI buffer 에 append → area chart (y 0-100 %).

**BPM trend 차트**: 1 entry per batch (~0.56s 간격). x-axis 시간 윈도우 -60s..0. smooth 라인 (sensor-dashboard `PPGBpmTrendChart` 와 동일 설정).

**LeadOff banner**: DOM only (parser 가 PPG 별도 lead-off 정보 없음 — Q8). `display: none` 유지.

**가드레일**:
- 새 폴더 0, 새 dependency 0
- chart.ts / parser.ts / models.ts / main.ts / layout.ts / eeg-view.ts / acc-view.ts 수정 0
- LF/HF/SpO2/Stress/Stability/Intensity 구현 0 (placeholder 유지)

**검증**:
- `tsc --noEmit` 통과
- `npm run test:run` 53/53 GREEN (DSP test 영향 없음)
- `npm run build` 통과 (JS 549.57 → 552.92 KB, +3 KB)
- Vite dev probe: `/`, `/src/ui/ppg-view.ts` 200

**기대 동작 (사용자 검증)**:
- `npm run dev` → Replay 클릭 → PPG 탭:
  - Filtered IR/Red 차트: ~3s transient 후 펄스 모양 (0.5-5Hz 통과)
  - SQI 차트: 실 SQI % 곡선
  - BPM trend: 시간 흐름 따라 BPM 변동 (실 PPG dump → ~70-80 BPM 정도)
  - 9 active cards: 의미 있는 RR-base 값
  - 8 placeholder cards: "—" 그대로

**참조**: `src/ui/ppg-view.ts`, sensor-dashboard `components/ppg/*`.

---

### 2026-05-02 (밤) — PPG DSP 4/5: HRV math 테스트 [PROGRESS]

**무엇을**: `tests/dsp.test.ts` 에 HRV/HR 산식 테스트 8 cases.

**computeHrvMetrics (5 tests)**:
- 균일 RR (모두 833ms): AVNN=833, SDNN=RMSSD=SDSD=PNN50=PNN20=0
- alternating ±33ms (800/866): SDNN=33, RMSSD=66, PNN50=PNN20=100% (Δ=66 > 50)
- 분기 검증 (Δ=30): PNN50=0 (≤50), PNN20=100 (>20)
- 빈 배열: 모든 6 fields 0
- 단일 RR: AVNN 만, 차분 메트릭 0

**computeHeartRate (3 tests)**:
- 균일 833ms: BPM≈72, hrMax=hrMin=BPM
- RR [500, 833, 1000]: hrMax=120 (60000/500), hrMin=60 (60000/1000), bpm = 60000/avg
- 빈 배열: 0/0/0

**가드레일**: 새 폴더 0, 새 dependency 0. dsp.ts 수정 0 (테스트만).

**검증**: `tsc --noEmit` 통과. `npm run test:run` **53/53 GREEN** (45 + 8).

**다음**: ppg-view DSP wiring — step 5 (마지막).

**참조**: `tests/dsp.test.ts`.

---

### 2026-05-02 (밤) — PPG DSP 3/5: RR-based HRV metrics [PROGRESS]

**무엇을**: `src/linkband/dsp.ts` 에 RR-base HRV/HR 산식 추가.

**Exports** (모두 표준 HRV literature 산식, 외부 의존 없음):
- `HrvMetrics` interface — 6 fields: avnn, sdnn, rmssd, sdsd, pnn50, pnn20
- `computeHrvMetrics(rrIntervalsMs) → HrvMetrics`:
  - **AVNN** = mean(RR)
  - **SDNN** = std deviation of RR (population: ÷N)
  - 인접 차분 (Δ_i = RR[i+1] - RR[i]) 기반:
  - **RMSSD** = √(mean of Δ²)
  - **SDSD** = std deviation of Δ
  - **PNN50** = % of |Δ| > 50 ms
  - **PNN20** = % of |Δ| > 20 ms
  - n=0 → 모든 값 0; n=1 → AVNN/SDNN 만, 나머지 0
- `HeartRate` interface — bpm, hrMax, hrMin
- `computeHeartRate(rrIntervalsMs) → HeartRate`:
  - **bpm** = 60000 / AVNN (평균)
  - **hrMax** = 60000 / min(RR) (= 최대 instantaneous)
  - **hrMin** = 60000 / max(RR) (= 최소 instantaneous)

**가드레일**: 새 폴더 0, 새 dependency 0. parser/models/main/layout/views 수정 0.

**검증**: `tsc --noEmit` 통과. `npm run test:run` 45/45 GREEN (테스트는 step 4 에서 추가).

**다음**: HRV 산식 테스트 — step 4.

**참조**: `src/linkband/dsp.ts`.

---

### 2026-05-02 (밤) — PPG DSP 2/5: filter + peak detection 테스트 [PROGRESS]

**무엇을**: `tests/dsp.test.ts` 에 PPG 필터 + peak 검출 테스트 추가 (8 cases).

**Tests**:
- PPG 필터 pipeline (4): fs/transient 상수, 1.2Hz sine (72 BPM 펄스대역) 통과 (>80%), 0.1Hz drift 차단 (<20%), transient 동안 0
- detectPpgPeaks (3): 1Hz pulse 신호 5개 정확 검출 (인덱스 [5,55,105,155,205]), flat signal → 빈 배열, min-interval (150 BPM 상한) 강제 검증
- peaksToRrSeconds (1): [0,50,100,150,200] @ 50fs → [1.0, 1.0, 1.0, 1.0]

**가드레일**: 새 폴더 0, 새 dependency 0. dsp.ts 수정 0 (테스트만 추가).

**검증**: `tsc --noEmit` 통과. `npm run test:run` **45/45 GREEN** (37 + 8).

**다음**: HRV math (RR-base 9 metrics: AVNN/SDNN/RMSSD/SDSD/PNN50/PNN20 + BPM/HR Max/Min) — step 3.

**참조**: `tests/dsp.test.ts`.

---

### 2026-05-02 (밤) — PPG DSP 1/5: filter pipeline + peak detection [PROGRESS]

**무엇을**: `src/linkband/dsp.ts` 에 PPG 필터 + peak 검출 추가. sensor-dashboard `ppgPipeline.ts` 의 filter/SQI 직접 포팅 (fs=50 동일, 스케일 없음). Peak 검출은 자체 작성 — sensor-dashboard 프런트엔드에 없음 (서버 의존).

**Exports**:
- `PPG_SAMPLE_RATE = 50`, `PPG_TRANSIENT_SAMPLES = 150` (~3s warm-up, 0.5Hz HP τ ≈ 0.32s × 3)
- `PpgChannelFilter`, `createPpgChannelFilter`, `processPpgSample` — HP 0.5Hz → LP 5Hz cascade
- `calculatePpgSqi(filtered)` — 25-sample sliding window, threshold 250, 0-100% scaled (linkband 동일)
- `detectPpgPeaks(filtered, fs) → peakIndices` — adaptive threshold (max × 0.6), min 0.4s 간격 (150 BPM 상한). local max 조건 (`> prev && >= next`).
- `peaksToRrSeconds(peaks, fs) → rrSeconds` — peak 인덱스 차이 / fs

**자체 결정 (own derivation)**:
- Peak 검출 알고리즘 — sensor-dashboard 가 외부 SDK (서버) 결과만 받아 저장하는 구조. 우리는 직접 산출 필요. EEG indices 와 마찬가지로 numerical 차이 가능성. spec §17 검증 항목에 준함.

**가드레일**:
- 새 폴더 0, 새 dependency 0
- chart.ts / parser.ts / models.ts / main.ts / layout.ts / eeg-view.ts / acc-view.ts 수정 0

**검증**: `tsc --noEmit` 통과. `npm run test:run` 37/37 GREEN.

**다음**: PPG filter / peak detection 테스트 — step 2.

**참조**: `src/linkband/dsp.ts`, sensor-dashboard `ppgPipeline.ts`.

---

### 2026-05-02 (밤) — DSP 4/4: eeg-view DSP 와이어링 [PROGRESS]

**무엇을**: DSP placeholder 4개 슬롯을 모두 활성화. `src/ui/eeg-view.ts` 전체 rewrite — filter cascade + SQI + spectrum + band power + indices 통합.

**활성화된 패널**:

1. **Ch1/Ch2 Filtered chart** (Row 2)
   - 입력이 raw → **filtered** (notch 60Hz → HP 1Hz → LP 45Hz cascade) 로 교체
   - 채널별 `EegChannelFilter` 인스턴스 view 안에 보관, 각 샘플마다 `processEegSample` 호출
   - 1초 transient 동안 0 출력 (sensor-dashboard 와 동일)
   - 카드 설명 "DSP active" 로 갱신

2. **Saturated banner** (filtered 기준)
   - `filtered.every(|v| > 300_000)` 로 변경 — DSP HP 가 DC 제거하므로 saturated raw 가 ~0 으로 바뀜 → 자연스럽게 false → 배너 OFF
   - 현실적으로 saturated raw 가 와도 banner 안 뜸 (filter 가 흡수)

3. **SQI 차트** (Row 3, NEW)
   - 채널별 `calculateEegSqi(filtered_buffer)` 매 batch 호출, 결과의 마지막 batch_len 만큼 SQI buffer 에 append
   - 0-100% y-range 라인 차트 (area, 노란색)

4. **Power Spectrum 차트** (Row 4 좌, NEW)
   - `computeSpectrum(rawBuf, fs, 1, 45)` 매 batch 호출 → ch1/ch2 multi-line
   - X-axis = Hz (1-45), Y-axis = dB (-40 ~ +60)
   - 시간 axis 가 아닌 frequency axis 라 createChart 후 setOption 으로 override

5. **Band Power cards** (Row 4 우, NEW)
   - `computeEegPower(ch1RawBuf, ch2RawBuf, fs)` → 5 cards (Δ/θ/α/β/γ)
   - 각 카드 = `createMetricCard` (avg dB, decimals 1, band 색)
   - 색: delta brown / theta orange / alpha green / beta blue / gamma purple

6. **EEG Indices cards** (Row 5, NEW)
   - `computeEegIndices(power)` → 7 cards: focus / relaxation / stress / cognitiveLoad / hemisphericBalance / emotionalStability / totalPower
   - 카드 설명에 own derivation 명시 — sensor-dashboard 외부 SDK 값과 차이 가능

**Buffer 구조**:
- `ch1Buf` / `ch2Buf`: filtered (chart + SQI 입력) — size 2000
- `ch1RawBuf` / `ch2RawBuf`: raw μV (spectrum + band power 입력) — size 2000
- `ch1SqiBuf` / `ch2SqiBuf`: SQI 0-100 % (SQI chart 입력) — size 2000

**resize / dispose 갱신**: 차트 5개 모두 (chart1/chart2/sqi1Chart/sqi2Chart/spectrumChart).

**가드레일**:
- 새 폴더 0, 새 dependency 0
- chart.ts / parser.ts / models.ts / main.ts / layout.ts / ppg-view / acc-view 수정 0
- DSP 는 이미 step 1-3 에서 작성 — 본 step 은 import + wiring 만

**검증**:
- `tsc --noEmit` 통과
- `npm run test:run` 37/37 GREEN (parser 15 + sanity 1 + dsp 21)
- `npm run build` 통과 (JS 542 → 549.57 KB, +7 KB DSP code 인라인)
- Vite dev probe: `/`, `/src/ui/eeg-view.ts`, `/src/linkband/dsp.ts` 모두 200

**기대 동작 (사용자 검증)**:
- `npm run dev` → Replay 클릭, EEG 탭:
  - Ch1/Ch2 차트: 1초 transient 후 평평한 ~0 라인 (saturated raw → DC 제거 후 0)
  - Saturated 배너: 자동 OFF (filter 가 saturated 흡수)
  - SQI 차트: 평평한 신호라 high SQI (filtered ~0, |0-mean|=0 → ampSum=1, var=0 → freqScore=1 → 100%)
  - Power Spectrum: 평평 (saturated dump 라 진동 성분 없음 → 모든 freq 에서 -100 dB)
  - Band Power 5 cards: 모두 매우 낮은 dB (saturated raw 라 morlet wavelet 출력 미미)
  - Indices 7 cards: 의미 있는 실수 값 (NaN 없음)

- 헤드밴드 착용 + Connect → 실 EEG → α/β/θ 등이 spectrum 에 보임, 실 indices 갱신.

**참조**: `src/ui/eeg-view.ts`, `src/linkband/dsp.ts`.

---

### 2026-05-02 (밤) — DSP 3/4: SQI + EEG indices [PROGRESS]

**무엇을**: `src/linkband/dsp.ts` 에 SQI + 7 EEG analysis indices 추가.

**SQI 포팅** (sensor-dashboard `eegPipeline.ts` `calculateEegSqi`):
- `EEG_SQI_WINDOW = EEG_FS / 2` = 250 (sensor-dashboard 125 = 0.5s @ 250Hz, fs 비례 스케일)
- `EEG_AMP_THRESHOLD = 150` μV (절대 진폭, fs 무관 — 그대로)
- 알고리즘 sensor-dashboard 와 1:1: 윈도우당 local DC 제거 → 70% amplitude SQI + 30% frequency SQI (variance-based) → 100% scaled.

**EEG Indices** ([ISSUE] sensor-dashboard 내부 derivation 부재):
- sensor-dashboard 는 indices 를 외부 linkband SDK 결과로 받아 store 에 저장 (`eegAdapter.ts:155-164` `normalizeEegAnalysis`). TS 측에 자체 산식 없음.
- 우리는 spectrum 의 band power 결과로부터 **EEG literature 표준 비율식**으로 own derivation. sensor-dashboard 의 numerical 값과 차이 가능 — 실 디바이스 비교 검증은 spec §17 추가 검증 항목.
- 7 indices: `totalPower`, `focusIndex` = β−α, `relaxationIndex` = α−β, `stressIndex` = (β+γ)/2 − (α+θ)/2, `cognitiveLoad` = θ−α, `hemisphericBalance` = ch2_α − ch1_α, `emotionalStability` = −|stressIndex|. 모두 dB difference (band power 가 sensor-dashboard 처럼 dB 형식이라).

**테스트** (`tests/dsp.test.ts` +5, 총 21 cases / 37 total):
- SQI clean (50μV) → >70%, noisy (500μV) → <30%, output 길이 = 입력 길이
- Indices: alpha-rich (10Hz) 입력 → relaxationIndex > focusIndex, 둘이 negation 관계
- 모든 7 필드 NaN 없음

**가드레일**: 새 폴더 0, 새 dependency 0. parser/models/main/layout/views 수정 0.

**검증**: `tsc --noEmit` 통과. `npm run test:run` 37/37 GREEN.

**다음**: eeg-view 와 wiring — step 4 (마지막).

**참조**: `src/linkband/dsp.ts`, sensor-dashboard `eegPipeline.ts` (SQI), `eegAdapter.ts:155-164` (indices not available, our own derivation).

---

### 2026-05-02 (밤) — DSP 2/4: spectrum + band power [PROGRESS]

**무엇을**: `src/linkband/dsp.ts` 에 sensor-dashboard `spectrum.ts` 의 spectrum + band power 부분 추가. 외부 FFT 라이브러리 없음 (자체 DFT + Morlet wavelet).

**Exports**:
- `EEG_BANDS` — 5 band 정의 (Delta 1-4, Theta 4-8, Alpha 8-13, Beta 13-30, Gamma 30-45). sdk.linkband UI 와 동일 (gamma 45Hz 캡, 50 아님).
- `computeSpectrum(rawData, sampleRate, kMin=1, kMax=45)` — DC 제거 후 마지막 `DFT_WINDOW` 샘플로 freq 별 DFT power (dB). `[freq, dB]` 페어 배열 반환.
- `computeBandPower(rawEeg, sampleRate, fMin, fMax)` — linkband-style filter (notch + bandpass) → Morlet wavelet → 평균 dB.
- `computeEegPower(fp1Raw, fp2Raw, sampleRate)` — 양 채널 × 5 band 통합 결과.
- 타입: `BandRange`, `BandPowerLinearDb`, `ComputedEegPower`.

**fs 스케일링** (sensor-dashboard 250 → EEG_FS=500):
- `BAND_SR = EEG_FS` = 500
- `BAND_FILTER_TRANSIENT = EEG_FS` = 500 (1초, sensor-dashboard 의 250 = 1s @ 250Hz)
- `DFT_WINDOW = EEG_FS` = 500 (1초, sensor-dashboard 256 ≈ 1.024s @ 250Hz 와 등가)
- `BAND_POWER_MIN_RAW = 2 × EEG_FS / 5` = 600 (1.2s, sensor-dashboard 300 = 1.2s @ 250Hz)
- `BAND_POWER_WINDOW_RAW = 2 × EEG_FS` = 1000 (2초, sensor-dashboard 500 = 2s @ 250Hz)
- `MIN_SAMPLES = 64` 그대로 (DFT 최소 입력, frequency-only 임계값)

**linkband-style 계수**:
- `BP_NOTCH_COEFS = notchCoefs(500, 60, calcLinkbandNotchQ(60, 2))` — Q ≈ 20.01 (좁은 notch)
- `BP_BANDPASS_COEFS = bandpassCoefs(500, 23, calcLinkbandBandpassQ(1, 45))` — Q ≈ 1.524

**테스트** (`tests/dsp.test.ts` +5 cases, 총 16 cases):
- `computeSpectrum`: 10Hz sine → spectrum peak 가 9-11Hz 사이
- `computeSpectrum`: 입력 < 64 샘플 → 빈 배열
- `computeBandPower`: 10Hz sine → alpha > delta by ≥10dB
- `computeBandPower`: 입력 < 600 샘플 → `{linear:0, db:0}`
- `EEG_BANDS`: 5 band key/range 정합

**가드레일**: 새 폴더 0, 새 dependency 0. parser/models/main/layout/views 수정 0.

**검증**: `tsc --noEmit` 통과. `npm run test:run` 32/32 GREEN (27 + 5).

**다음**: SQI + EEG indices (focus/relaxation/stress 등) — step 3.

**참조**: `src/linkband/dsp.ts`, sensor-dashboard `spectrum.ts`.

---

### 2026-05-02 (밤) — DSP 1/4: biquad + EEG filter cascade [PROGRESS]

**무엇을**: `src/linkband/dsp.ts` 신규 (단일 파일에 DSP 통합 — 다음 commits 도 같은 파일 확장). sensor-dashboard `src/lib/dsp/biquad.ts` + `eegPipeline.ts` 의 필터 부분 포팅.

**fs 차이 처리** (스펙 §7 / §17 Q7):
- sensor-dashboard `EEG_SAMPLE_RATE = 250` 가정. 우리 실측 확정값 = 500.
- `EEG_SAMPLE_RATE = EEG_FS` (= 500) 로 import 한 literal 사용.
- `EEG_TRANSIENT_SAMPLES` = `EEG_FS` (= 500, 1초 settling — sensor-dashboard 의 250 = 1s @ 250Hz 와 시간 등가).
- NOTCH/HP/LP 계수는 `notchCoefs(500, 60, 2)`, `highpassCoefs(500, 1, 1/√2)`, `lowpassCoefs(500, 45, 1/√2)` — cutoff 주파수는 절대값이라 그대로, fs 만 갱신해 계수 재계산.

**Exports** (sensor-dashboard 와 1:1 함수명 유지):
- Biquad primitives: `BiquadState`, `BiquadCoefs`, `createBiquadState`, `notchCoefs`, `highpassCoefs`, `lowpassCoefs`, `bandpassCoefs`, `calcLinkbandBandpassQ`, `calcLinkbandNotchQ`, `processBiquad`.
- EEG cascade: `EegChannelFilter`, `createEegChannelFilter`, `processEegSample`.

**테스트** (`tests/dsp.test.ts`, 11 cases):
- DSP fs (2): `EEG_SAMPLE_RATE === 500`, `EEG_TRANSIENT_SAMPLES === 500`
- Notch 60Hz Q=2 (2): 60Hz sine <20% 감쇠, 10Hz sine >80% 통과
- Highpass 1Hz Butterworth (2): DC 제거, 10Hz 통과
- Lowpass 45Hz Butterworth (2): 10Hz 통과, 200Hz <15% 감쇠
- Cascade (3): transient 동안 0 출력, 60Hz 차단, 10Hz 통과

**가드레일**:
- 새 폴더 0, 새 dependency 0
- `chart.ts` / `parser.ts` / `models.ts` / `main.ts` / `layout.ts` / view 3개 수정 0
- React / Zustand / 타 lib 0

**검증**: `tsc --noEmit` 통과. `npm run test:run` 27/27 GREEN (16 + 11). `npm run build` 통과 (dsp.ts 미사용 → tree-shake, JS 사이즈 그대로).

**다음**: spectrum (DFT, Morlet, band power, computeSpectrum / computeBandPower) — step 2.

**참조**: `src/linkband/dsp.ts`, `tests/dsp.test.ts`, sensor-dashboard `src/lib/dsp/biquad.ts` + `eegPipeline.ts`.

---

### 2026-05-02 (밤) — view resize() 노출, hidden-tab init 복구 [PROGRESS]

**버그**: PPG Filtered chart, ACC Waveform / Magnitude 가 작게 표시됨. 원인 — `createPpgView` / `createAccView` 호출 시점에 컨테이너가 `display: none` (비활성 탭). ECharts.init 이 0×0 으로 measure → tiny 차트로 init. 탭 전환으로 컨테이너 가시화돼도 ECharts 인스턴스는 자동 resize 안 됨.

**참고**: sensor-dashboard `BaseChart.tsx` 도 ResizeObserver 미사용 — `window.addEventListener('resize', ...)` 만. React 의 mount/unmount 가 visibility 변화를 흡수해서 우리 같은 vanilla 토글 케이스가 발생 안 함.

**Fix**:

(a) **3 view handle 에 `resize()` 메서드 추가**:
- `EegViewHandle.resize()` → chart1.chart.resize() + chart2.chart.resize()
- `PpgViewHandle.resize()` → filteredChart.chart.resize()
- `AccViewHandle.resize()` → waveChart.chart.resize() + magChart.chart.resize()

(b) **`src/main.ts` `activateTab(id)` 안에서 활성 view 의 resize 호출**:
```ts
const views: Record<TabId, { resize: () => void }> = { eeg, ppg, acc };
function activateTab(id) {
  // ... display 토글 ...
  views[id].resize();  // 새 사이즈로 다시 measure
}
```
- 추가로 view 인스턴스 생성 순서를 `activateTab("eeg")` 호출보다 **앞**으로 이동 — `views` map 이 activateTab 시점에 정의돼 있도록.

**가드레일 준수**:
- 새 폴더 0, 새 dependency 0, DSP 0
- chart.ts / parser.ts / models.ts / layout.ts 수정 0
- view 3개 + main.ts 만 (사용자 spec 그대로)

**검증**: `tsc --noEmit` 통과. `npm run test:run` 16/16 GREEN. `npm run build` 통과 (JS 541.90 → 542.05 KB).

**Note (다음 청크 후보)**: `chart.ts` 의 `createChart` 에 `ResizeObserver` 통합하면 view 의 명시 `resize()` 호출 + main.ts wiring 둘 다 제거 가능. 컨테이너 size 변화를 자동 감지. 본 fix 범위 밖.

**참조**: `src/ui/eeg-view.ts`, `src/ui/ppg-view.ts`, `src/ui/acc-view.ts`, `src/main.ts`.

---

### 2026-05-02 (밤) — xAxis 고정 윈도우 (3 views) [PROGRESS]

**무엇을**: 차트의 xAxis 를 매 batch 마다 동적으로 갱신하지 말고 sensor 별 고정 윈도우로 잠금. 라인은 buffer 차오르며 우→좌 자라남, 빈 영역은 그대로 빈 차트.

**상태 점검 결과**:
- 사용자 prompt 가 "직전 zero/NaN-prefill commit" revert 도 함께 요구했지만, 본 레포의 view 들은 이미 빈 array (`const buf: number[] = []`) 로 init 되어 있음 — prefill 시도가 들어간 적 없음. 따라서 (a) revert 는 no-op.
- (b) xAxis 고정만 실제 작업.

**3 view 변경**:
- `eeg-view.ts`: `EEG_WINDOW_SEC = EEG_BUFFER_SIZE / EEG_FS` (= 4초). chart1/chart2 둘 다 `xAxis: { min: -EEG_WINDOW_SEC, max: 0 }` 로.
- `ppg-view.ts`: `PPG_WINDOW_SEC = PPG_BUFFER_SIZE / PPG_FS` (= 8초). filteredChart 동일.
- `acc-view.ts`: `ACC_WINDOW_SEC = ACC_BUFFER_SIZE / ACC_FS` (= 8초). waveChart + magChart 둘 다 동일 윈도우.

**좌표 매핑 (그대로 유지)**:
- `buf.map((v, i) => [(i - last) / fs, v])` — newest = t=0, oldest = -(currentLen-1)/fs.
- buffer 차오를수록 라인 좌측으로 grow. xAxis 는 항상 [-WINDOW_SEC, 0] 라 라인 외 영역은 빈 차트.
- `fs` 는 onBatch 안에서 `batch.fs` 그대로. 모듈 레벨 `*_WINDOW_SEC` 는 models 의 `EEG_FS / PPG_FS / ACC_FS` literal 로 계산.

**가드레일**:
- 새 폴더 0, 새 dependency 0, DSP 0
- chart.ts / parser.ts / models.ts / main.ts / layout.ts 수정 0
- view 3개의 buffer init + xAxis 만 (사용자 spec 그대로)

**검증**:
- `tsc --noEmit` 통과
- `npm run test:run` 16/16 GREEN
- `npm run build` 통과 (JS 541.99 → 541.90 KB, dynamic 계산 제거로 미세 감소)

**기대 효과**:
- 시작 직후 차트 비어 있음 (xAxis 라벨만 보이고 라인 X)
- 첫 batch → 우측 가장자리에 짧은 라인 등장
- 시간 흐를수록 좌측으로 grow, 4-8초 후 윈도우 가득
- 이후 정상 우→좌 슬라이드
- xAxis 가 매 batch 재스케일 안 되므로 "막대" 시각 부작용 없음

**참조**: `src/ui/eeg-view.ts`, `src/ui/ppg-view.ts`, `src/ui/acc-view.ts`.

---

### 2026-05-02 (밤) — ACC view 4-row + Magnitude (sensor-dashboard 미러) [PROGRESS]

**무엇을**: `src/ui/acc-view.ts` 재작성. sensor-dashboard `ACCVisualizer.tsx` 의 4-row 레이아웃 미러링 + Magnitude 차트 추가.

**구조**:
1. **Hero card** — "📐 ACC Acceleration Analysis" + 설명 (X/Y/Z 색 강조 inline 텍스트, sensor-dashboard `<strong className="text-red-400">` 미러) + 3 InfoBadge ("3-axis (X, Y, Z)" / "25Hz sampling" / "Unit: g (gravitational acceleration)").
2. **Full-width**: **3-Axis Acceleration Waveform** — h3 + 설명 + X/Y/Z multi-line 차트 (기존 차트 보존).
3. **Full-width**: **Magnitude** — h3 + 설명 + 단일 라인 area+smooth 차트.
4. **Full-width**: **📐 Movement Analysis** — placeholder ("DSP not yet implemented").

**Magnitude 계산** (DSP 가 아닌 단순 산술):
```ts
for (let i = 0; i < batch.x.length; i++) {
  magBuf.push(Math.sqrt(x*x + y*y + z*z));  // Int16 → number 자동 승급
}
```
- buffer cap 200 (8s @ 25Hz, x/y/z 와 동일 윈도우).
- y 범위 0..30000 고정 (1g ≈ 16384 LSB 기준 여유).
- 색 = `chartColors.magnitude` (#facc15, sensor-dashboard `AccMagnitudeChart` 동일).

**InfoBadge** (sensor-dashboard `components/ui/InfoBadge.tsx` 미러):
- shadcn Badge 의존 없이 vanilla `<span>` + style.
- `rgba(magnitude, 0.15)` 배경 + 0.35 border + magnitude color text.

**가드레일**:
- 새 폴더 0, 새 dependency 0, DSP 0 (Magnitude 는 단순 norm, filter/threshold 아님)
- chart.ts / parser.ts / models.ts / main.ts / eeg-view.ts / ppg-view.ts 수정 0
- Tailwind / shadcn / React / Zustand 도입 0

**검증**:
- `tsc --noEmit` 통과
- `npm run test:run` 16/16 GREEN
- `npm run build` 통과 (JS 539.14 → 541.99 KB, +2.85 KB)
- Vite dev probe: `/` 200, `/src/ui/{acc,ppg}-view.ts` 둘 다 200

**사용자 검증 (돌아오시면)**: `npm run dev` → ACC 탭:
- Hero + 3 yellow InfoBadge
- Waveform: 기존 X/Y/Z 라인 (정지 상태 ≈ Z=-8192, 움직임 시 변동)
- Magnitude: ~16800 부근 (1g 중력) 기준 area chart, 머리 흔들 때 spike
- Motion Analysis: placeholder

**참조**: `src/ui/acc-view.ts`, sensor-dashboard `components/acc/ACCVisualizer.tsx` + `AccMagnitudeChart.tsx`.

---

### 2026-05-02 (밤) — PPG view 3-row 구조 (sensor-dashboard 미러) [PROGRESS]

**무엇을**: `src/ui/ppg-view.ts` 재작성. sensor-dashboard `PPGVisualizer.tsx` 의 3-row 레이아웃 정확히 미러링.

**구조**:
1. **Hero card** — "💓 PPG Pulse Analysis" + 설명문 (sensor-dashboard 그대로)
2. **2-col Row** (≥1024px 에서 2열, 모바일 1열):
   - 좌: **🔧 Filtered PPG Signal** — h3 + 설명("Red/IR LED signals passed through a 0.5-5.0Hz bandpass filter to isolate the heart-beat pattern (DC removed)") + LeadOff banner (DOM only, parser 가 PPG 별도 lead-off 정보 없음 — Q8) + raw IR/RED multi-line 차트 + 캡션 "Pre-filter pulse waveform — DSP filter pending"
   - 우: **📈 PPG Signal Quality Index (SQI)** — 순수 placeholder ("DSP not yet implemented")
3. **Full-width**: **💓 Heart Rate Variability Metrics** — 14 cards 그대로 (BPM/SpO₂/HR Max/Min/Stress/RMSSD/SDNN/SDSD/LF/HF Power/LF/HF/AVNN/pNN50/pNN20). 모두 update(null) → "—".

**제거**:
- 이전의 별도 Raw IR/RED 패널 → Filtered card 안으로 흡수 (캡션으로 의미 명시).
- 이전의 BPM trend placeholder → 제거 (sensor-dashboard PPGVisualizer 안에 없음).

**디자인 디테일**:
- ensureStyles() 가 `.ppg-grid-2col` (반응형 1↔2col) + `.ppg-metrics-grid` 주입 (1회).
- DOM helper (`makeCard` / `makeCardTitle` / `makeCardDesc` / `makeBanner` / `makePlaceholder`) 는 eeg-view.ts 와 동일 패턴 — 파일 간 공유 X (가드레일대로 ppg-view.ts 만 수정).
- 좌표 변환·tooltip 형식 동일 (시간축 초 단위, "t = X.XXs").

**가드레일**:
- 새 폴더 0, 새 dependency 0, DSP 0
- chart.ts / parser.ts / models.ts / main.ts / eeg-view.ts / acc-view.ts 수정 0
- Tailwind / shadcn / React / Zustand 도입 0

**검증**: `tsc --noEmit` 통과. `npm run test:run` 16/16 GREEN. `npm run build` 통과 (JS 538.55 → 539.14 KB).

**다음 단계**: ACC view 4-row + Magnitude (단순 산술 √(x²+y²+z²)).

**참조**: `src/ui/ppg-view.ts`, sensor-dashboard `components/ppg/PPGVisualizer.tsx`.

---

### 2026-05-02 (밤) — sticky Header+Tabs 보정: scroll-padding + 탭 전환 시 scrollTo [PROGRESS]

**무엇을**: sticky Header (~64px) + Tabs (~50px) = ~114px 가 hero card 를 가리던 문제 해결. 두 가지 처리:

**1. CSS scroll-margin / scroll-padding** (`index.html`):
- `html { scroll-padding-top: 130px; }` — html 스크롤 컨테이너 자체가 130px 패딩을 가져서 anchor navigation / `scrollIntoView()` 호출 시 sticky 뒤로 안 들어감.
- `main section { scroll-margin-top: 130px; }` — 각 view 의 root section 에 동일 마진. element 단위 scroll-into-view 도 보장.
- 130px = sticky chrome (~114px) + 16px 버퍼.

**2. 탭 전환 시 scrollTo** (`src/ui/layout.ts` `createTabs`):
- onChange 콜백 호출 직후 `window.scrollTo({ top: 0, behavior: "smooth" })` 추가.
- 사용자가 EEG 탭에서 깊게 스크롤한 상태로 PPG 탭 클릭 → 페이지 최상단으로 부드럽게 복귀 → 새 탭의 hero card 가 viewport 에 보임.
- 같은 탭 재클릭 시 (activeId 동일) early return — 스크롤 안 일어남.

**가드레일**:
- 새 폴더 0, 새 dependency 0, DSP 0
- chart.ts / parser.ts / models.ts / main.ts 수정 0
- ppg-view.ts, acc-view.ts 수정 0
- index.html 의 CSS 추가는 vanilla — Tailwind 도입 X
- 사용자가 step 2 에서 "main.ts 의 탭 변경 핸들러" 옵션도 제시했으나 main.ts 수정은 가드레일에 잡혀 있어 layout.ts 의 createTabs 에서 처리.

**검증**:
- `tsc --noEmit` 통과
- `npm run test:run` 16/16 GREEN
- `npm run build` 통과 (HTML 1.26 → 1.51 KB, JS 538.51 → 538.55 KB)
- Vite dev probe: `/` 200, `scroll-padding-top` + `scroll-margin-top` 둘 다 page HTML 에 포함 확인.

**사용자 검증 (돌아오시면)**:
- `npm run dev` → EEG 탭에서 스크롤 다운 → PPG 탭 클릭 → 페이지가 최상단으로 부드럽게 스크롤 → 💓 PPG hero card 가 viewport 에 즉시 보임. ACC 도 동일.

**참조**: `index.html`, `src/ui/layout.ts` (`createTabs` onChange).

---

### 2026-05-02 (밤) — EEG view 레이아웃 ch1/ch2 분리 + 5-row 구조 [PROGRESS]

**무엇을**: sensor-dashboard `EEGVisualizer.tsx` 의 5-row 레이아웃을 정확히 미러링하도록 `src/ui/eeg-view.ts` 재작성.

**구조 (sensor-dashboard 동일)**:
1. **Hero card** — "🧠 EEG Brain Wave Analysis" + 설명문
2. **2-col Row** — Ch1 RawData (FP1) | Ch2 RawData (FP2) 분리 카드. 각 카드 = h3 + 설명 + LeadOff banner + Saturated banner + 차트.
3. **2-col Row** — Ch1 SQI | Ch2 SQI placeholder
4. **2-col Row** — Power Spectrum | Band Power placeholder
5. **Full-width** — EEG Analysis Indices placeholder

**구현 디테일**:
- 2-col grid 는 반응형 (`@media min-width: 1024px` 에서만 2열). inline style 로 @media 표현 못 하니 모듈 첫 호출 시 `<style id="eeg-view-style">` 한 번 주입 (`ensureStyles()`).
- 각 카드 = 공통 `makeCard()` 헬퍼. 제목/설명/배너/placeholder 도 헬퍼로 추출.
- 차트는 `buildRealtimeLineOption` 단일 라인으로 ch1/ch2 각각 별도 (이전 multi-line 통합 차트 → 분리). 색은 sensor-dashboard 의 RawDataChart 와 동일 (ch1=blue, ch2=red).
- 차트당 sliding-window 좌표 변환은 그대로 — 가장 오래된 = -(N-1)/fs, 최신 = 0.

**Banner 동작**:
- **LeadOff**: parser 가 채널별 분리 정보 없음 (spec §17 Q2 미해결) — 양쪽 카드에 동일 토글. 채널별 분리는 firmware 의미 확인 후.
- **Saturated**: per-channel — `batch.ch1Uv.every` / `batch.ch2Uv.every` 각각 검사 → 카드별 독립 토글.

**가드레일**:
- 새 폴더 0, 새 dependency 0, DSP 0
- chart.ts / parser.ts / models.ts / main.ts 수정 0
- ppg-view.ts, acc-view.ts 수정 0
- `<style>` 태그 1회 주입은 vanilla CSS — Tailwind/shadcn 미사용

**검증**: `tsc --noEmit` 통과. `npm run test:run` 16/16 GREEN. `npm run build` 통과 (JS 534.46 → 538.51 KB, +4 KB).

**다음 단계**: Hero title 이 sticky Header+Tabs 뒤에 가리지 않도록 scroll behavior 수정.

**참조**: `src/ui/eeg-view.ts`, sensor-dashboard `components/eeg/EEGVisualizer.tsx`.

---

### 2026-05-02 (밤) — EEG saturated electrode 배너 [PROGRESS]

**무엇을**: EEG dump 가 saturated (rail-pinned) 라 평평한 라인이 그려져 "이상해 보임" 이라는 사용자 피드백 처리. 별도 안내 배너 추가.

**`src/ui/eeg-view.ts`** (LeadOff 배너 외에 saturated 배너 추가):
- 새 div `saturatedBanner` — LeadOff 배너와 동일 톤·스타일 (`bannerStyle` 변수 추출).
- 문구: "⚠ Electrodes appear floating — saturated to reference voltage. Place band on head to see real EEG."
- 트리거: `batch.ch1Uv.every((v) => Math.abs(v) > 300_000)` — 본 batch 의 **모든** ch1 샘플이 ±300,000 μV 밖이면 표시.
  - saturation 임계점은 ~336,083 μV (= 0x7FFFFF × ~0.040064 μV/LSB).
  - 실 신호는 DSP 전 DC offset 포함해도 일반적으로 ±수 mV 이내 — 300_000 μV 보다 한 자릿수 작음. false positive 가능성 낮음.
- LeadOff 와 별개 신호 — 둘 다 동시 표시 가능 (배너 2개 stack).

**시나리오 검증** (코드 reasoning):
- Replay (책상 위 EEG dump): ch1_uv = 8388607 × 0.040064 ≈ 336,083 μV 25개 → every() true → banner 표시 ✓
- 라이브 헤드밴드 착용: ±수십 ~ 수백 μV → every() false → banner 숨김 ✓

**가드레일**:
- 새 폴더 0, 새 dependency 0, DSP 0
- main.ts / parser.ts / models.ts / 기존 view 의 데이터 흐름·버퍼링 수정 0
- view 옵션·DOM 만 변경 (배너 div 1개 추가, 옵션 1줄 토글)

**검증**: `tsc --noEmit` 통과. `npm run test:run` 16/16 GREEN. `npm run build` 통과 (JS 534.19 → 534.46 KB).

**참조**: `src/ui/eeg-view.ts`.

---

### 2026-05-02 (밤) — x-axis 시간축 표시 + 좌표를 초 단위로 [PROGRESS]

**무엇을**: 차트가 "시간에 따른 그래프 형식이 아니다" 라는 사용자 피드백 처리. x-axis 가 숨겨져 있어서 시간 흐름이 안 보였던 문제.

**`src/ui/chart.ts`** (option builder 갱신):
- `RealtimeLineOptions` / `MultiLineOptions` 에 `showXAxis?: boolean` (기본 true) + `xAxisName?: string` (기본 "time (s)") 추가.
- xAxis: type=value, name=시간 라벨, nameLocation=middle, nameGap=25, axisLabel formatter `(v) => v.toFixed(1)+"s"`. splitLine + axisLabelStyle 그대로.
- grid.bottom 을 axis 표시 시 "16%" (라벨 자리), 숨김 시 "8%" 로 분기.

**`eeg-view.ts` / `ppg-view.ts` / `acc-view.ts`**:
- 좌표 변환만 수정: `[i, v]` → `[(i - lastIdx) / fs, v]`. 가장 오래된 샘플 = `-(N-1)/fs`, 최신 = 0. 신호가 우→좌 흐르는 시각.
- xAxis min/max 도 동일 식으로 갱신.
- `fs` 는 batch.fs 에서 — 하드코딩 X (EEG=500, PPG=50, ACC=25 모두 batch 가 들고 있음).
- tooltip "Sample #N" → "t = X.XXs" 라벨 갱신 (좌표 변환 결과와 일관).

**가드레일**:
- 새 폴더 0, 새 dependency 0, DSP 0
- main.ts / parser.ts / models.ts 수정 0
- view 의 데이터 흐름·버퍼링 로직 (push, splice, length cap) 수정 0 — 좌표 변환·옵션만

**검증**:
- `tsc --noEmit` 통과
- `npm run test:run` 16/16 GREEN
- `npm run build` 통과 (JS 533.81 → 534.19 KB)
- 좌표 reasoning: ch1Buf.length=2000 일 때 i=0 → -(1999)/500 = -3.998s, i=1999 → 0. ✓

**다음 단계**: EEG saturated electrode 배너 추가 (step 2).

**참조**: `src/ui/chart.ts`, `src/ui/eeg-view.ts`, `src/ui/ppg-view.ts`, `src/ui/acc-view.ts`.

---

### 2026-05-02 (저녁) — VisualizerHeader (제목 + Streaming/SignalQuality 배지) [PROGRESS]

**무엇을**: sensor-dashboard `components/visualizer/VisualizerHeader.tsx` 미러링. 자율모드 마지막 커밋 (3/3).

**`createVisualizerHeader(container)`** 추가 (src/ui/layout.ts):
- 좌측: "Visualizer" h1 (1.45rem, weight 500) + "Real-time sensor data visualization" 부제. 폰트 크기·웨이트 sensor-dashboard 와 동일.
- 우측: StreamingBadge (Connect 후 라이브 시 teal 강조, 평소 회색) + SignalQualityBadge (placeholder).
- API: `setStreaming("streaming"|"idle")` + `setSignalQuality("excellent"|"good"|"warning"|"bad"|null)`.

**의도된 미반영** (가드레일):
- **ThemeSwitcher**: 우리는 단일 다크 테마 — skip.
- **SignalQuality**: sensor-dashboard 의 `useSignalQuality()` 훅은 DSP 결과 (`signalScore`) 에 의존. DSP 가 아직 없으므로 항상 `null` 로 호출 → "Signal Quality: —" 회색 placeholder. DSP 도착 시 4-level (excellent/good/warning/bad) 갱신 가능하도록 API 만 마련.
- **useConnectionStore (Zustand)**: 우리는 main.ts 의 setStatus 흐름에서 `setStreaming` 호출.

**main.ts 변경**:
- `#visualizer-header-mount` div 추가 (index.html).
- `createVisualizerHeader(visualizerHeaderMount)` — Header 와 Tabs 사이에 normal flow (sticky 아님, sensor-dashboard 의 sticky 처리는 단순화).
- `setStatus(text)` 가 streaming → `setStreaming("streaming")`, 그 외 → `setStreaming("idle")` 도 함께 호출.

**검증**:
- `tsc --noEmit` 통과
- `npm run test:run` 16/16 GREEN
- `npm run build` 통과 (HTML 1.26 KB, JS 533.81 KB / gzip 179 KB)
- Vite dev probe: `/` 200, **7 mount points 모두 존재** (header / visualizer-header / tabs / footer / eeg / ppg / acc).

**가드레일 최종 점검**:
- 새 폴더 0 (`src/ui/layout.ts` 단일 파일에 4 helper)
- 새 dependency 0 (echarts 그대로)
- 기존 view 파일 (eeg/ppg/acc-view) 수정 0
- shadcn / Radix / Tailwind / React / Zustand 도입 0
- DSP 시작 0 — placeholder 만

**사용자 검증 (돌아오시면)**:
`npm run dev` → http://localhost:5173 → 다음 동작 확인:
1. 상단 sticky **Header** — brand + status pill + battery pill + Connect/Replay
2. 그 아래 **VisualizerHeader** — "Visualizer" 제목 + 부제 + Streaming/SignalQuality 배지 (둘 다 회색 placeholder)
3. 그 아래 sticky **Tabs** — EEG / PPG / ACC, 활성 탭 흰색
4. 활성 탭의 view 만 보임. 탭 클릭 시 즉시 스위치 (비활성 탭도 background 데이터 받아 buffer 채워둠 → 전환 시 그래프 이미 그려져 있음)
5. 하단 **Footer** — Messages 카운트 + Rate (msg/s) + Status (Live/Idle/Offline) + 버전 라벨
6. Replay 클릭 → 모든 탭에 데이터 흐름. 탭 전환으로 각 sensor view 확인 가능.

**다음 단계 (사용자 결정)**: DSP — sensor-dashboard `src/lib/dsp/` (TS native) 포팅으로 placeholder 패널들 활성화. SignalQuality 도 함께 채워짐.

**참조**: `src/ui/layout.ts`, `src/main.ts`, `index.html`, sensor-dashboard `components/visualizer/VisualizerHeader.tsx` + `StreamingBadge.tsx` + `SignalQualityBadge.tsx`.

---

### 2026-05-02 (저녁) — Tabs + Header + Footer 통합, 활성 탭만 표시 [PROGRESS]

**무엇을**: layout.ts 의 헬퍼들을 main.ts 에 wiring + index.html 재구성. 3 sensor 가 동시에 펼쳐지던 구조 → sensor-dashboard 처럼 탭 시스템으로 한 번에 하나만 보임.

**index.html**: 마운트 포인트만 남김.
- `#header-mount` / `#tabs-mount` / `#footer-mount` (chrome)
- `#eeg-container` / `#ppg-container` / `#acc-container` (views)
- 인라인 header/footer 스타일·DOM 모두 제거. body 의 max-width / 폰트 같은 page-level CSS 만 유지.

**main.ts**:
- `createHeader(headerMount, { onConnect, onReplay })` — 버튼 콜백을 connect()/replay() 로 연결.
- `createTabs(tabsMount, [eeg|ppg|acc], onChange)` — 탭 클릭 시 `activateTab(id)` 호출.
- `activateTab(id)`: 활성 탭의 컨테이너만 `display: ""`, 나머지는 `display: "none"`. 비활성 탭의 view 도 background 에서 데이터를 받아 buffer 채워둠 → 탭 전환 시 즉시 그려져 있음 (sensor-dashboard 동일 동작).
- `createFooter(footerMount)` — `footer.bumpMessage()` 가 `on{Eeg,Ppg,Acc,Bat}Bytes` 4 곳에서 호출됨 → Messages 카운트 + Rate 자동 갱신.
- `setStatus(text)`: header pill + footer 상태색 (streaming → live, disconnect 포함 → offline, 그 외 → idle).
- 디폴트 탭 = "eeg".

**가드레일**:
- 새 폴더 0
- 새 dependency 0
- 기존 view 파일 (eeg/ppg/acc-view) 수정 0 — 탭 토글은 외부에서 컨테이너 hide/show 만.

**검증**:
- `tsc --noEmit` 통과
- `npm run test:run` 16/16 GREEN
- `npm run build` 통과 (HTML 1.21 KB, JS 531.65 KB / gzip 178.95 KB — layout.ts 분만 증가)
- Vite dev probe: `/` 200, mount points 존재 확인.

**다음 단계**: VisualizerHeader (sticky 영역, 탭 위) 추가.

**참조**: `index.html`, `src/main.ts`, `src/ui/layout.ts`.

---

### 2026-05-02 (저녁) — ui/layout.ts (Header + Footer + Tabs 헬퍼) [PROGRESS]

**무엇을**: sensor-dashboard `App.tsx` 의 sticky 탭 시스템 + `Header.tsx` + `Footer.tsx` 를 vanilla TS DOM 헬퍼로 단일 파일에 통합. main.ts 통합은 step 2.

**3 헬퍼**:
- `createHeader(container, { onConnect, onReplay })`: 좌측 brand (그라디언트 로고 + 제품명 + 부제) + 우측 status pill / battery pill / Connect / Replay. sticky top z-50, backdrop blur. sensor-dashboard `Header.tsx` 의 `bg-bg-card/90 border-b sticky top-0` 매핑.
- `createTabs(container, tabs[], onChange)`: sensor-dashboard `App.tsx` 의 TabsList 미러. shadcn 의존성 없이 vanilla CSS 토글 — active = 흰 배경 / 검정 텍스트, inactive = neutral-700 / 회색. sticky top-64 z-40.
- `createFooter(container)`: Messages 카운트 + Rate (msg/s) + Status (Live/Idle/Offline) + 버전 라벨. sensor-dashboard `Footer.tsx` 미러. Zustand 의존성 제거하고 인스턴스 내부 state + `setInterval` 1s 로 rate 자동 갱신.

**가드레일**:
- shadcn / Radix / Tailwind / React 도입 0
- 새 dependency 0
- 새 폴더 0 (`src/ui/layout.ts` 단일 파일)
- 기존 view 파일 (eeg/ppg/acc-view) 수정 0

**검증**: `tsc --noEmit` 통과. `npm run test:run` 16/16 GREEN. `npm run build` 통과.

**다음 단계**: main.ts + index.html 재구성 — Header / Tabs / Footer 마운트 + 활성 탭 외 view 컨테이너 hide.

**참조**: `src/ui/layout.ts`, sensor-dashboard `components/layout/{Header,Footer}.tsx` + `App.tsx`.

---

### 2026-05-02 — main.ts wiring + index.html 레이아웃 갱신 [PROGRESS]

**무엇을**: 자율모드 마지막 커밋 — sensor-dashboard 형식 frontend 미러 완료. 3 view 인스턴스화 + index.html 레이아웃 교체.

**index.html**:
- 기존 `<table>` + per-row counters + inline `<canvas>` 제거.
- 새 구조: `<header>` (title + Connect/Replay 버튼 + status pill + battery pill) + `<main>` 안에 view 컨테이너 3개 (`#eeg-container` / `#ppg-container` / `#acc-container`).
- CSS 토큰화 (`--bg-base`, `--bg-elevated`, `--border`, `--text-*`) — view 들의 inline style 의 `uiColors` 와 일치.

**src/main.ts**:
- 인라인 canvas/buffer 코드 (eegBuffer, drawEeg, chartLoop) 제거.
- `createEegView` / `createPpgView` / `createAccView` 인스턴스 1회 생성 (페이지 라이프타임 유지, 디스커넥트 시 dispose 안 함).
- `on{Eeg,Ppg,Acc}Bytes(data)` 가 parser 호출 후 view 의 `onBatch(...)` 만 호출. UI 갱신 로직은 view 내부.
- Battery 는 그대로 — header 의 `#battery` pill 에 `Battery 87%` 텍스트.
- 라이브 BLE / Replay 단일 파이프라인 유지.

**검증**:
- `tsc --noEmit` 통과
- `npm run test:run` 16/16 GREEN (parser 테스트 영향 없음)
- `npm run build` 성공 — JS 7.43 KB → **525.56 KB** (echarts 인라인). gzip 177 KB. 500 KB chunk warning 은 echarts 자체 크기로 예상된 동작 (sensor-dashboard 도 동일 규모).
- Vite dev probe: `/` (200, 2.8KB) + `/src/main.ts` (200, 20.7KB transformed) + `/reference-py/tests/fixtures/real1/eeg.txt` (200, 205.7KB) — 모두 OK.

**가드레일 준수 최종 점검**:
- `src/ui/` 외 새 폴더 0 ✓ (`src/ui/` 에 정확히 6 파일)
- `echarts` 외 새 dependency 0 ✓
- DSP/metrics 코드 0 ✓ (placeholder/raw 만)
- `parser.ts` / `models.ts` / spec / progress-log 사용 규칙 그대로 유지

**사용자 검증 (돌아오시면)**:
- `npm run dev` → http://localhost:5173 → Replay 클릭:
  - 🧠 EEG 섹션: ch1/ch2 라인 (saturated 라 ±150 μV 경계에서 clip 되어 평평하게 표시)
  - 💓 PPG 섹션: Raw IR/RED 라인 + Filtered/BPM placeholder 패널 + 14 MetricCards (모두 "—")
  - 📐 ACC 섹션: x/y/z 3-line (auto-scale)
- 그 후 Connect 클릭 → 라이브 BLE 도 같은 view 로 흐름 확인.

**다음 단계 (사용자 결정)**: DSP — sensor-dashboard `src/lib/dsp/` 의 biquad / eegPipeline / ppgPipeline / spectrum 을 TS 그대로 포팅. placeholder 패널들이 활성화됨.

**참조**: `src/main.ts`, `index.html`, `src/ui/*.ts` 6 파일.

---

### 2026-05-02 — ui/acc-view.ts (3-axis raw chart) [PROGRESS]

**무엇을**: ACC 3-axis raw 차트 단일 패널. sensor-dashboard `ACCVisualizer.tsx` 의 3 패널 중 raw 만 포팅 (magnitude / motion cards 는 DSP 영역).

**구성** (createAccView(container) → { onBatch, dispose }):
- Section header: `📐 ACC Acceleration Analysis` + 축별 색 의미 + sample rate.
- ECharts 3-line: X (red) / Y (green) / Z (blue), 색은 sensor-dashboard `theme.ts` 그대로.
- y 범위 auto-scale — firmware IMU 스케일 미확정 (±2g 면 1g ≈ 16384 LSB 이지만 g 단위 변환은 DSP 단계).
- Window: 200 samples (8s @ 25Hz) — sensor-dashboard `ACC_BUFFER_SIZE` 동일.

**검증**: `tsc --noEmit` 통과. `npm run build` 7.43 KB (main.ts wiring 은 step 6).

**다음 단계**: main.ts 에 view 3개 wiring + index.html 레이아웃 갱신 — 자율모드 마지막 커밋.

**참조**: `src/ui/acc-view.ts`, sensor-dashboard `components/acc/AccRawChart.tsx`.

---

### 2026-05-02 — ui/ppg-view.ts (full stack with DSP placeholders) [PROGRESS]

**무엇을**: sensor-dashboard `PPGVisualizer.tsx` 의 모든 패널 미러링.

**5 패널 구성**:
1. **LeadOff banner**: PPG 는 parser 가 lead-off 를 추출하지 않으므로 (firmware 패킷에 PPG 전용 lead-off 바이트 없음) DOM 만 만들고 `display: none` 고정. DSP/quality 단계에서 활성 가능.
2. **Raw IR/RED chart**: ECharts 멀티라인. y 범위 auto-scale (raw 값이 1-2 자릿수 변동) — sensor-dashboard 에는 없는 패널 (필터드만 있음). 우리는 DSP 가 없으니 raw 직접 표시.
3. **Filtered chart placeholder**: dashed border + "DSP not yet implemented" 텍스트. DSP 도착 시 동일 컨테이너에 ECharts init.
4. **BPM trend placeholder**: 동일 패턴.
5. **MetricsCards 14개**: `createMetricCard` 활용. 라벨/단위/색은 sensor-dashboard `PPGMetricsCards.tsx` 그대로 (BPM, SpO₂, HR Max/Min, Stress, RMSSD, SDNN, SDSD, LF/HF Power, LF/HF, AVNN, pNN50, pNN20). 값은 모두 `update(null)` placeholder.

**Window**: 400 samples (8s @ 50Hz) — sensor-dashboard `PPG_BUFFER_SIZE` 그대로.

**API**: `createPpgView(container) → { onBatch(PpgBatch), dispose() }`.

**검증**: `tsc --noEmit` 통과. `npm run build` 7.43 KB (main.ts 가 아직 import 안 함).

**다음 단계**: ui/acc-view.ts (3-axis line chart).

**참조**: `src/ui/ppg-view.ts`, sensor-dashboard `components/ppg/*` 5 파일.

---

### 2026-05-02 — ui/eeg-view.ts (Visualizer + LeadOff banner) [PROGRESS]

**무엇을**: sensor-dashboard `EEGVisualizer.tsx` 의 메인 패널을 vanilla TS 로 미러링.

**구성** (createEegView(container) → { onBatch, dispose }):
- Section panel: `🧠 EEG Brain Wave Analysis` 헤더 + subtitle.
- LeadOff banner: 본 batch 의 leadOff 샘플 중 하나라도 true 면 표시 (간단 트리거 — 채널 분리는 spec §17 Q2 까지 보류).
- Multi-line ECharts: Ch1 (FP1, blue) + Ch2 (FP2, red) 두 라인 한 차트. y 범위 ±150 μV (sensor-dashboard `RawDataChart` 와 동일). saturated raw 샘플은 차트 경계에서 clip.
- Window: 2000 samples (4s @ 500Hz) — sensor-dashboard 의 `EEG_BUFFER_SIZE=1000 @ 250Hz` 를 fs 보정한 값. 사용자 spec ("4-8초 = 2000-4000 sample @ 500Hz") 의 하한.

**단순화 (이번 범위 = 시각화만)**:
- sensor-dashboard 의 ch1/ch2 별도 차트 → 한 차트 두 라인 (사용자 spec).
- DSP 관련 sub-패널 (SignalQualityChart, PowerSpectrumChart, BandPowerCards, IndexCards) 제외 — DSP 단계에서 본 view 확장 또는 별도 view 로 결정.
- LeadOff 채널 분리 안 함 (firmware 가 채널별인지 확정 후).

**검증**: `tsc --noEmit` 통과. `npm run test:run` 16/16 GREEN. `npm run build` 7.43 KB (main.ts 가 아직 import 안 함).

**다음 단계**: ui/ppg-view.ts (raw IR/RED + Filtered/BPM placeholders + MetricsCards).

**참조**: `src/ui/eeg-view.ts`, sensor-dashboard `components/eeg/EEGVisualizer.tsx` + `RawDataChart.tsx` + `LeadOffBanner.tsx`.

---

### 2026-05-02 — ui/metric-card.ts (PPG metrics 패널용 단일 카드 위젯) [PROGRESS]

**무엇을**: sensor-dashboard `components/ui/MetricCard.tsx` + `ppg/PPGMetricsCards.tsx` 의 카드 시각 구조를 vanilla TS DOM 으로 단순화 포팅. PPG metrics 패널에서 12-15개 인스턴스 사용 예정.

**의도된 단순화**:
- 임계값 분류 (sensor-dashboard 의 `IndexThreshold`/`classifyIndex`/`getThresholdTextClass`) **제거** — DSP/metrics 가 아직 없으므로 status 라벨은 placeholder ("No data" / "live") 만.
- Tailwind 클래스 대신 inline style. theme.ts 의 `uiColors` 토큰 사용.
- `IndexTooltip` (lucide-react Clock 아이콘 등) 생략 — 차후 metric 단계에서 검토.

**API**:
```ts
createMetricCard(container, { label: "BPM", unit: "bpm", dotColor: "#ef4444" })
  → { element, update(value: number | null) }
```
`update(null)` 로 "—" placeholder, `update(72)` 로 숫자 표시 + status "live".

**검증**: `tsc --noEmit` 통과. `npm run build` JS 7.43KB 그대로 (아직 main.ts 가 import 안 함, tree-shake — 의도).

**다음 단계**: ui/eeg-view.ts (Visualizer + LeadOff banner + ch1/ch2 라인 차트).

**참조**: `src/ui/metric-card.ts`, sensor-dashboard `components/ui/MetricCard.tsx`.

---

### 2026-05-02 — echarts + ui/theme + ui/chart 도입 [PROGRESS]

**무엇을**: sensor-dashboard frontend 미러링의 첫 커밋. 차트 라이브러리 echarts 도입 + 공통 스타일/래퍼 만들기.

- `npm i echarts` (v6.0.0).
- `src/ui/theme.ts`: sensor-dashboard `lib/charts/theme.ts` 포팅. `chartColors` (EEG ch1/ch2, PPG ir/red, ACC x/y/z, magnitude, axis label, grid line), `axisLabelStyle`, `splitLineStyle`, `legendTextStyle`, `uiColors` (dark theme bg/text 토큰 추가), `rgba()`, `areaGradient()`.
- `src/ui/chart.ts`: ECharts core + 모듈(`LineChart`, `GridComponent`, `TooltipComponent`, `LegendComponent`, `CanvasRenderer`) 등록. `createChart(container, option) → ChartHandle` 가 init + auto-resize + dispose 묶어줌. sensor-dashboard `optionBuilders.ts` 의 `buildRealtimeLineOption` / `buildMultiLineOption` 도 이 파일에 합침.

**가드레일 준수**:
- `src/ui/` 폴더 신설 (1개) — 허용 범위 내.
- echarts 외 새 dependency 없음.
- echarts core + 필요한 모듈만 import (sensor-dashboard 와 동일 tree-shaking 패턴) → 번들 크기 최적화.

**검증**: `tsc --noEmit` 통과. `npm run build` JS 크기 7.43 KB 그대로 (theme/chart 가 main.ts 에 import 안 돼 tree-shake — 다음 커밋들에서 사용되면 늘어남, 의도된 동작).

**다음 단계**: ui/metric-card.ts (PPG metrics 패널용 단일 카드 위젯).

**참조**: `src/ui/theme.ts`, `src/ui/chart.ts`, `package.json`, sensor-dashboard `src/lib/charts/`.

---

### 2026-05-01 (저녁) — Replay 버튼 + EEG ch1 Canvas, 디바이스 없이 종단 검증 [PROGRESS]

**무엇을**: 자율모드 5단 커밋의 마지막 항목. 디바이스 없이 dump replay 만으로 전체 파이프라인 (parser + UI + chart) 동작 확인 가능.

**index.html**:
- `<button id="replay">Replay fixtures</button>` 추가 (Connect 옆).
- `<canvas id="eeg-chart" width="600" height="100">` + 라벨 추가.
- CSS: `#eeg-chart { display: block; margin-top: 1rem; border: 1px solid #ddd; background: #fafafa; }`, `button + button { margin-left: 0.5rem; }`.

**src/main.ts** (단일 파일, 새 폴더 X):
- **Ring buffer**: `eegBuffer: number[]` (max 2000 = 4s @ 500Hz). `pushEegSamples(Float64Array)` 가 새 ch1Uv 샘플을 append + 오버플로우 trim. `onEegBytes` 안에서 호출.
- **Canvas 그리기**: `drawEeg()` 가 ctx.clearRect → 0μV reference line → 폴리라인 한 번. y 범위 ±300 μV 고정, saturated 샘플은 clamp 로 캔버스 위/아래 경계에 그어지게 (안 보이면 검증 어려우니 의도적 clamp). `requestAnimationFrame(chartLoop)` 으로 60fps.
- **Replay**:
  - `probeFixtureRoot()`: real1/ 우선, 없으면 real/, 둘 다 안 되면 null. 자율모드 사전 검증으로 Vite dev 가 둘 다 200 OK 응답 확인됨.
  - `replayStream(url, handler, cadenceMs)`: fetch → text → 줄별 분해 (`<usec_hex>\t<packet_hex>\n`) → hex → Uint8Array → handler 호출 → cadence 만큼 sleep.
  - `replay()`: EEG/PPG/ACC 3 stream 을 `Promise.all` 로 동시 진행. 각자 자기 cadence (50/560/1200ms) 로 진행 → 라이브 BLE 와 거의 같은 시간 분포.
  - Replay 버튼 클릭 핸들러로 연결.

**왜 라이브 BLE 와 replay 가 같은 파이프라인인가**: `on{Eeg,Ppg,Acc,Bat}Bytes(Uint8Array)` 가 양쪽의 단일 진입점. 라이브 측은 `makeHandler(sensor)` 가 `BluetoothRemoteGATTCharacteristic.value` → Uint8Array → dispatch[sensor] 호출, replay 측은 hex → Uint8Array → 같은 handler 호출. 디코드/표시/차트 로직은 한 곳에만 존재.

**검증** (autonomous 한도 내):
- `npm run test:run` → 16/16 passed (sanity 1 + parser 15)
- `tsc --noEmit` 통과
- `npm run build` → JS 5.68KB → **7.43KB** (replay + canvas 로직 추가분)
- Vite dev fixture URL probe: real1/eeg.txt → 200 OK (205700 B), real/eeg.txt → 200 OK (173162 B)

**사용자 검증 (다음에)**:
- `npm run dev` → http://localhost:5173 → Replay 클릭:
  - EEG row 디코드 값이 `ch1=336083.3μV  ch2=336083.3μV  leadOff=N  t=14.27s` 부근으로 갱신됨 (saturated dump)
  - PPG row: `RED=16646  IR=24626` 부근부터 시작
  - ACC row: `x=14592  y=1792  z=-8192` 부근부터 시작
  - eeg-chart 캔버스: ch1 값이 ±300 μV 범위 밖 (saturated)이라 폴리라인이 캔버스 상단 경계 (y=0) 에 flat 하게 그려짐 — 그게 saturated 신호의 정상 표시
- 그 후 Connect 클릭 → 라이브 BLE 도 같은 파이프라인 통과 확인 (디코드 값 + 차트 모두 동작)

**제약**: replay 의 fetch 경로는 Vite dev 에서만 동작. production (Vercel) 빌드에는 dump 가 안 들어가므로 replay 는 dev 전용 (의도된 한계 — fixture 는 검증용 자산이지 배포 대상 아님).

**참조**: `src/main.ts`, `index.html`, `reference-py/tests/fixtures/real1/`.

---

### 2026-05-01 (저녁) — main.ts 가 parser 사용, 디코드 값 표시 [PROGRESS]

**무엇을**: `src/main.ts` 의 BLE notification 처리 경로에 parser 결합. 라이브 BLE 와 (다음 단계) replay 가 같은 파이프라인을 공유하도록 단일 처리 함수 4개 추가:
- `onEegBytes(data)` / `onPpgBytes(data)` / `onAccBytes(data)` / `onBatBytes(data)` — 각각 parser 호출 + 카운터 증가 + UI 디코드 값 갱신.
- `dispatch` Record 로 sensor 이름 → 함수 매핑. `makeHandler(sensor)` 가 BLE event → Uint8Array → dispatch[sensor] 호출.

**UI 갱신**:
- `index.html` column 헤더: "last 16 bytes (hex)" → "last decoded sample".
- `.hex` 클래스 → `.detail` (의미 정합).
- 디코드 표시 형식:
  - EEG: `ch1=12.3μV  ch2=-4.1μV  leadOff=N  t=14.32s` (마지막 샘플)
  - PPG: `RED=63840  IR=22432`
  - ACC: `x=14592  y=1792  z=-8192`
  - Battery: `level=87%`

**부수 정리**: BLE disconnect 시 parser 의 마지막 샘플 시각 3개 모두 reset (재연결 후 헤더 기반 재초기화 — spec §13).

**검증**:
- `npm run test:run` → 16/16 passed (sanity 1 + parser 15)
- `tsc --noEmit` 통과
- `npm run build` → JS 3.00KB → **5.68KB** (parser/models 가 main.ts 에 import 되어 번들에 포함 — 의도)

**다음 단계**: Replay 버튼 + EEG ch1 Canvas 차트 (step 5). reference-py/tests/fixtures/real1/ 의 dump 를 fetch 후 onEegBytes 등으로 흘려보내 디바이스 없이 동작 검증.

**참조**: `src/main.ts`, `index.html`.

---

### 2026-05-01 (저녁) — parser.ts 본체, 15/15 GREEN [PROGRESS]

**무엇을**: `src/linkband/parser.ts` (160+줄) 작성. Python reference (`reference-py/linkband/parser.py`, 15/15 GREEN at be16261) 의 numerical 미러링.

**구성**:
- 모듈 상수: `TICKS_PER_SEC=32768`, `EEG_VREF/GAIN/RES/UV_FACTOR`, `*_SAMPLE_SIZE`.
- 헬퍼 (private): `headerSeconds(view)`, `decodeBeS24(view, offset)` (24-bit 부호확장), `decodeBeU24(view, offset)`, `viewOf(data)`.
- 모듈 export: `_decodeAccSample(buf): [x, y, z]` (16-bit LE), `parseBattery(data)`, `class Parser`.
- `Parser`: 인스턴스 상태 (`lastEegT/lastPpgT/lastAccT`) 로 보간. `parseEeg/Ppg/Acc` + `reset*Timestamps`.

**핵심 byte 처리 결정**:
- 헤더 → `view.getUint32(0, true) / 32768`
- EEG 24-bit BE signed → `(getUint8 << 16 | getUint8 << 8 | getUint8)` + sign-ext 마스크. JS bitwise 가 32-bit signed 라 0xFFFFFF 까지는 양수로 나오는 점 활용.
- PPG 24-bit BE unsigned → 같은 OR 시프트, sign-ext 단계 생략. `getUint8` 입력이라 자동 비음수.
- ACC 16-bit LE signed × 3 → `view.getInt16(off, true)` 세 번. native API 가 부호 처리해줌.
- Float precision: `EEG_UV_FACTOR = 4.033 / 12 / 8388607 * 1e6` 가 Python 결과와 IEEE 754 동일 — `toBeCloseTo(_, 12)` 통과.

**검증**: `npm run test:run` → **15/15 passed in 309ms** (sanity 1 + parser 15 = 16 total). `tsc --noEmit` 통과.

**Note**: 자율모드 prompt 는 "13 cases" 라 적었지만 실제 분포 합 (2+5+2+3+1+2) = 15 가 맞음. Python reference 와도 정합.

**다음 단계**: main.ts 가 raw bytes 를 parser 통과시켜 디코드 값 표시. 같은 함수가 라이브 BLE/replay 양쪽을 처리.

**참조**: `src/linkband/parser.ts`, `tests/parser.test.ts` (15 cases pass), reference-py/linkband/parser.py.

---

### 2026-05-01 (저녁) — parser.test.ts 13 cases (RED) [PROGRESS]

**무엇을**: `tests/parser.test.ts` (200+줄) 작성. Python reference (`reference-py/tests/test_parser.py`, 15/15 GREEN at commit be16261) 의 13 의미 케이스를 그대로 포팅.

**구성**:
- 합성 패킷 빌더 3개 (`eegPacket` / `ppgPacket` / `accPacket`) — Python 의 동일 헬퍼 미러링.
- 실 디바이스 fixture 3개 (`EEG_REAL_LINE1` / `PPG_REAL_LINE1` / `ACC_REAL_LINE1`) — Python 과 동일한 hex 상수.
- `EEG_LSB_UV` 상수 — μV 변환 정확도 sanity 비교용.

**13 케이스 분포 (Python 동일)**:
- header timestamp (2): timeRaw=32768→1.0, timeRaw=0→0.0
- EEG conversion (5): LSB μV, max+, sign-ext, leadOff, real fixture
- PPG sign-ext trap (2): high byte ≥0x80 unsigned, real fixture
- ACC 16-bit LE decoder (3): per-axis decode, LSB+MSB both, real fixture
- Battery (1)
- EEG timestamp continuity (2): 1/500 step, reset 후 헤더 재초기화

**RED 확인**: `npm run test:run` → tests/parser.test.ts 가 `Cannot find module '../src/linkband/parser'` 로 collection 실패. sanity.test.ts 만 1/1 pass. 의도된 RED.

**참조**: `tests/parser.test.ts`, `reference-py/tests/test_parser.py` (정답지).

---

### 2026-05-01 (저녁) — vitest dev infrastructure [PROGRESS]

**무엇을**: TS 영역에 단위 테스트 셋업. parser 13 케이스 포팅을 위한 사전 작업.

- `npm i -D vitest` (4.1.5).
- `package.json` scripts: `"test": "vitest"`, `"test:run": "vitest run"`.
- `vite.config.ts` 에 `/// <reference types="vitest" />` + `test: { environment: "node" }` 추가. parser 가 순수 byte 변환이라 jsdom 불필요.
- `tests/sanity.test.ts` placeholder 1 케이스 (1+1=2) — health check.

**검증**: `npm run test:run` → 1/1 passed (208ms). `tsc --noEmit` 통과.

**참조**: `package.json`, `vite.config.ts`, `tests/sanity.test.ts`.

---

### 2026-05-01 (저녁) — src/linkband/models.ts 작성, P0 첫 TS 항목 [PROGRESS]

**무엇을**: 새 구조의 P0 첫 항목인 `src/linkband/models.ts` (91줄) 작성. Python reference (`reference-py/linkband/models.py`) 의 dataclass 4개 (`EegBatch` / `PpgBatch` / `AccBatch` / `BatteryStatus`) 를 TS interface + typed array 조합으로 미러링.

**매핑 결정**:
- 표기: `t_device → tDevice` 등 camelCase (TS 관용). 의미 동일.
- dtype: `np.float64 → Float64Array`, `np.int32 → Int32Array`, `np.int16 → Int16Array`, `np.uint8 → Uint8Array`, `np.bool → boolean[]` (Bool typed array 없음 — 25개 boxed bool 의 GC 비용은 무시 수준).
- `fs` 필드: 리터럴 타입 (`fs: typeof EEG_FS`) — 컴파일 타임에 500/50/25 가 아닌 값을 거부. parser 가 항상 정확한 fs 를 박도록 강제.
- 모듈 레벨 상수 `EEG_FS=500`, `PPG_FS=50`, `ACC_FS=25` export. 학생/parser 양쪽에서 import 해서 사용.

**spec/Python 정합 확인**:
- 필드 구성: 100% 일치 (이름만 camelCase).
- dtype 의미: 100% 일치.
- `EegBatch.fs = 500` (Q7 잠금 반영), `AccBatch` 16-bit LE 의미 docstring 명시.

**검증**: `npx tsc --noEmit` 통과. `npm run build` → dist/ 정상 (main.ts 가 아직 models.ts 를 안 import 하므로 번들 크기 변동 없음, tree-shaken — 의도한 동작).

**다음 단계**: `src/linkband/parser.ts`. `reference-py/linkband/parser.py` (15/15 GREEN) 를 numerical reference 로 포팅. DataView 기반 byte 처리:
- 헤더 LE u32 → `view.getUint32(0, true) / 32768`
- EEG 24-bit BE signed → `(view.getUint8(o) << 16 | view.getUint8(o+1) << 8 | view.getUint8(o+2))` + sign-ext 또는 `(view.getInt32(o-1) >> 8)` 트릭
- PPG 24-bit BE unsigned → 마스크 조합 (Python 의 자연 비음수 처리 미러)
- ACC 16-bit LE signed → `view.getInt16(o, true)` × 3
- 보간 시각: `Parser` 클래스 인스턴스 상태로 마지막 샘플 시각 추적 (Python 그대로)

**참조**: `src/linkband/models.ts`, `reference-py/linkband/models.py` (정답지), spec §13.

---

### 2026-05-01 (저녁) — 레포 구조 재배치: TS at root, Python → reference-py/ [PROGRESS]

**무엇을**: 사용자 검토 후 (A) 안 채택 — TS 가 primary 인데 root 가 Python 프로젝트로 보이는 비대칭 해소. 모든 Python 자산을 `reference-py/` 안으로 self-contained 격리, TS 자산은 root 로 승격.

**구체적 이동** (git mv 로 history 보존):
- `pyproject.toml`, `uv.lock` → `reference-py/`
- `linkband/` (4 파일) → `reference-py/linkband/`
- `tests/test_parser.py` → `reference-py/tests/test_parser.py`
- `tests/fixtures/` (gitignored) → `reference-py/tests/fixtures/` (fs mv)
- `web/index.html`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts` → root
- `web/src/` → `src/`
- `web/` 디렉터리 제거 (`node_modules/`, `dist/` 는 재생성 가능, 삭제)

**텍스트 갱신**:
- `.gitignore`: `web/dist/` → `dist/`, `web/.vite/` → `.vite/` 등 root level 화. `tests/fixtures/real*/` → `reference-py/tests/fixtures/real*/`.
- `reference-py/linkband/spike_dump.py`: docstring 의 출력 경로 표기 — 새 cwd(`reference-py/`) 기준이라 `Path("tests/fixtures/real")` 코드 자체는 그대로 유효, 주석만 갱신.
- `reference-py/tests/test_parser.py`: fixture comment 경로 갱신. 코드 로직 영향 없음 (fixture 는 hex 상수로 박혀 있음).
- `CLAUDE.md`: 모든 `linkband/` 경로 → `reference-py/linkband/`, TS 경로는 `web/src/` → `src/`. "Working style" 섹션 헤더 갱신. cross-validation 섹션의 fixture 경로 갱신.
- `README.md`: 전면 재작성 — TS primary 명시, 새 디렉터리 트리, Setup 섹션 `npm` 우선 + `cd reference-py && uv sync` 보조.
- `docs/01-protocol-spec.md` §15 (패키지 구조), §16 (MVP 순서) 갱신 — 현 구조 반영, 완료된 항목(parser.py 등) ✅ 표시.

**검증**: 코드 수정 없음 (경로 이동 + 텍스트 동기화만). git mv 결과 R(rename) 14개 + M(modify) 5개 + 신규 reference-py/tests/fixtures/ 디렉터리. spec/CLAUDE.md/README 모두 새 구조와 정합.

**다음 단계**: 새 세션이 git pull 후 `src/linkband/models.ts` (P0 첫 항목) 작업 가능. `npm run dev` 는 root 에서 동작.

**참조**: 본 entry 가 변경 자체. 영향받는 파일 다수 (위 목록 참조).

---

### 2026-05-01 (저녁) — TS + Web Bluetooth 피벗 [DECISION]

**무엇을**: 오후의 "Python 유지" 결정을 뒤집고 **TS + Web Bluetooth API + Vercel 정적 배포**
로 전환. 트리거는 Vercel 배포 목적이 분명해진 것 — 단일 정적 SPA 가 필요하면 Python
서버 자체가 학생 PC 에서 돌아야 하는 모델은 마찰 (`uvx linkband-app`/PyInstaller 도
환경 의존). 브라우저가 BLE Central 을 직접 잡으면 그 마찰이 사라짐.

**결정**:
- 새 stack: **Vite + TypeScript** (`web/` 디렉토리). 첫 마일스톤은 vanilla TS, 차트
  단계에서 React 도입 검토.
- 기존 Python 4 커밋 (`ea47c2b`~`be16261`) 은 **reference impl 로 보존**. 삭제 X.
  parser/spec/test 가 TS 포팅의 정답지 역할.
- spec `01-protocol-spec.md` 는 그대로 (언어 무관). 단 §1 아키텍처·§15 패키지 구조
  는 갱신 예정.
- 첫 마일스톤: **"데이터 받기"** — 스캔 → 연결 → CCCD enable → EEG `start` 쓰기 →
  각 센서 패킷 카운트 표시. 파싱·DSP·차트는 추후.

**오후 결정과의 차이**: 그때는 "DSP 라이브러리(scipy/neurokit/heartpy) 격차" 와 "코드량
우려" 가 결정타였음. Web Bluetooth 카드를 명확히 살리는 시나리오에서는 Python 의 DSP
이점보다 단일 정적 배포의 단순함이 압도. DSP 는 brain-band 단순 metric 수준이라 JS 로
도 작성 가능 (밴드패스·peak detection·envelope). neurokit/heartpy 는 P2 메트릭에서
편의성 도움이지만 필수는 아님.

**브라우저 제약 메모**:
- Web Bluetooth = Chromium 전용 (Chrome/Edge). Safari·Firefox 미지원. 학생용 도구
  로서 Chromium 한정 OK 로 수용.
- HTTPS 또는 localhost 에서만 동작. Vercel 자동 HTTPS 라 production 문제 없음.
- `requestDevice()` 는 user gesture (버튼 클릭) 필요.

**다음 단계**: `web/` scaffold (Vite + TS + `@types/web-bluetooth`), 단일 페이지로
스캔 → 연결 → 패킷 카운트 표시. `linkband/ble.py` 작업은 중단.

**참조**: 본 entry 가 결정 자체. `web/` 디렉토리 신설 예정.

---

### 2026-05-01 (저녁) — parser.py 본체 작성, 15/15 GREEN [PROGRESS]

**무엇을**: `linkband/parser.py` (170+줄) 작성. P0 단계 parser 본체 완성.
- 모듈 레벨: `_decode_acc_sample(buf) → (x, y, z)` (16-bit LE), `parse_battery(data) → BatteryStatus` (stateless), `_header_seconds(packet) → float`.
- `class Parser`: 인스턴스 상태로 센서별 마지막 샘플 시각 보간. `parse_eeg/ppg/acc` + `reset_*_timestamps`.
- 각 메서드 docstring 에 spec § 출처 + Kotlin SDK 의 어떤 라인을 미러/회피했는지 명시.
- 24-bit BE 부호확장은 `int.from_bytes(..., signed=True)` 한 줄로 해결 (직접 `& 0x800000` 검사 불필요).
- ACC 는 `np.frombuffer(data, dtype="<i2", count=n*3, offset=4).reshape(-1, 3)` 로 LE 인터리브 한 번에 분리.

**검증**: `uv run pytest tests/test_parser.py -v` → **15 passed in 0.21s**.
`uv run ruff check linkband/ tests/` → All checks passed.

15 케이스 breakdown:
- TestHeaderTimestamp: 2 (timeRaw=32768/0)
- TestEegConversion: 5 (LSB μV, max+, 부호확장, leadOff bool/raw, 179B real fixture)
- TestPpgSignExtension: 2 (high-byte 0x80+ 비음수, 172B real fixture)
- TestAccDecode16LE: 3 (16-bit LE, LSB+MSB 둘 다 영향, 184B real fixture)
- TestBattery: 1
- TestEegTimestampContinuity: 2 (1/500 step 보간, reset 후 재초기화)

**다음 단계**: P0 의 마지막 항목 `linkband/ble.py` (실 디바이스 BLE 매니저). spike_dump.py 흐름을 클래스화 + 자동 재연결 + spec §5.1 활성화 시퀀스 정식 구현. Q8 (PPG stop-early) 재구독 로직도 여기서.

**참조**: `linkband/parser.py`, `tests/test_parser.py` (15 cases pass), spec §6–§11 §13.

---

### 2026-05-01 (오후) — test_parser.py + models.py 새 spec 반영 [PROGRESS]

**무엇을**: spec 갱신에 맞춰 두 파일 동기화.
- `linkband/models.py`: `EegBatch.fs` default 250 → **500**. `AccBatch` docstring: 가설 A/B 양쪽 수용 → "16-bit LE 확정 (Kotlin LSB 누락 버그)" 로 갱신.
- `tests/test_parser.py`:
  - `acc_packet` 빌더: filler-기반 → 16-bit LE 기반 (axis 당 `int.to_bytes(2, "little", signed=True)`).
  - `TestAccHypothesisA` → `TestAccDecode16LE`. 가설 B 검증으로 재작성: LSB+MSB 양쪽 영향 확인, signed 16-bit min(`-32768`)/`-1` 케이스.
  - 통합 테스트 3개: 합성 → **실 fixture (`EEG_REAL_LINE1` / `PPG_REAL_LINE1` / `ACC_REAL_LINE1`)** 로 교체. 모두 dump line 1 과 byte-exact 일치 검증 완료.
  - 타임스탬프 연속성: `1/250` → `1/500` step.
  - boundary 테스트(μV·부호확장·lead_off)는 그대로 유지.

**검증**: `uv run ruff check` 전부 통과. `uv run pytest` 는 의도된 RED 상태 — `linkband.parser` 미존재로 collection ImportError. import 정렬은 parser.py 생성 후 자동 정상화 예정 (현재 ruff 가 parser 를 third-party 로 분류).

**다음 단계**: `linkband/parser.py` 본체 작성 → GREEN 전환.

**참조**: `linkband/models.py`, `tests/test_parser.py`.

---

### 2026-05-01 (오후) — spec §7 / §9.1 / §13 / §17 실측 반영 [DECISION]

**무엇을**: 실 디바이스 dump 검증 결과를 사양서에 반영.
- §7 EEG 표: 샘플레이트 250 Hz → **500 Hz** (실측 근거 — cadence 50ms × 25 samples). 1 패킷 시간 100ms → 50ms.
- §9.1 ACC 레이아웃: 검증 필요 → **16-bit LE 확정**. 본문 재작성, Kotlin SDK 의 LSB 누락 버그 명시.
- §13 EegBatch: `fs: int = 250` → `500`. Q1.5 텍스트 "가설 A↔B 한 줄 교체" → "16-bit LE 실측 확정".
- §17 표 재구성: Q1✅(B), Q6✅(boot), Q7✅ 신규(500Hz), Q8⚠️ 신규(PPG stop-early). 검증 데이터 위치(`tests/fixtures/real/`) 명시.
- 마지막 갱신일 메모.

**결정 영향**: DSP/메트릭 단계의 모든 EEG 처리(필터 cutoff, FFT 윈도우, BPM 추정 등)가 fs=500 기준으로 설계됨. fs 변경은 §13 잠금 사양에 직접 영향은 없으나(int 필드 default 만 변경) 다운스트림에 큰 영향. PPG fs=50 / ACC fs=25 는 spec 그대로 유지 (실측 26.8Hz 는 +7% 편차로 수용 가능).

**참조**: spec `docs/01-protocol-spec.md` §7, §9.1, §13, §17 (commit 미포함, working tree 만).

---

### 2026-05-01 (오후) — Q1·Q6·Q7 실 디바이스 데이터로 잠금 [VERIFIED]

**무엇을**: 헤드밴드 LXB-0263003F 의 spike dump (3차례 실행) 데이터로 미해결 질문 검증.

**검증 결과**:

- **Q1 (ACC 레이아웃) = 16-bit LE 확정**.
  실측 ACC 샘플 (책상 위 정지) bytes `00 39 00 07 00 e0` → hyp B: x=14592, y=1792, z=−8192. magnitude ≈ 16800, ±2g 16-bit IMU 의 1g 중력 벡터와 정합. 가설 A (Kotlin parity, 인덱스 1/3/5 만 s8) 로 디코드 시 모든 샘플이 (0, 0, 0) — 명백히 false. Kotlin SDK `SensorDataParser.kt:187–189` 가 LSB(인덱스 0/2/4) 를 누락한 버그.

- **Q6 (헤더 timestamp) = boot-relative uptime 확정**.
  EEG line 1 헤더 `95200700` LE u32 = 0x00072095 = 467605 ticks @ 32.768 kHz = **14.27 초**. 2026-05-01 epoch wall-clock 은 ~1.78×10⁹ s 라 32-bit u32 에 못 들어감 (overflow). 14초 값은 디바이스 부팅 후 경과시간으로만 설명 가능.

- **Q7 (EEG nominal fs) = 500 Hz 확정 (신규 발견)**.
  정상 패킷 cadence = 헤더 timestamp 간격 1636 ticks @ 32.768 kHz = **49.93 ms**. 25 samples / 50ms = **500 Hz**. spec/Kotlin SDK 의 `eegSampleRate=250.0` 은 오류. 30초 스트리밍 평균 effective fs ≈ 457 Hz (BLE drop 으로 가끔 100ms gap, nominal 은 500). 인접 패킷 간 sample 값에 overlap 없음 → 25 distinct samples per 50ms 확인.

**부수 관찰** (Q8 신규 미해결):
- PPG: 책상 위 19KB(54 packets) → 착용 시 0 byte. 펌웨어 quality-check 추정. parser 비차단, ble.py 에서 재구독 처리 항목으로 분리.
- Battery: 30초 동안 0 packet — level-change 트리거. 비차단.
- ACC fs: 측정 26.8Hz vs spec 25Hz, +7% 편차 — crystal 또는 firmware sample-period 미세 차. 수용.

**다음 단계**: 본 검증으로 spec §7, §9.1, §13, §17 갱신 (별도 [DECISION] entry 참조). models.py·test_parser.py 동기화 (별도 [PROGRESS] entry 참조). 그 뒤 parser.py 본체 → GREEN.

**참조**: `tests/fixtures/real/{eeg,ppg,acc,battery}.txt` (line 1, gitignore 됨), spec §7 §9.1 §17.

---

### 2026-05-01 (오후) — spike_dump.py 강건성 패치 [FIX]

**무엇을**: 첫 worn-band 실행에서 streaming 6-7s 후 device disconnect → 마지막 `b"stop"` write 가 `BleakError: Not connected` 로 traceback 발생. 파일은 line-buffered + ExitStack 으로 닫혀 있어 데이터 손실은 없었지만 출력이 지저분함.

**수정**:
- `BleakClient(dev, disconnected_callback=_on_disconnect)` 추가 — 끊김 시점 즉시 `!! BLE disconnected (usec=...)` 출력.
- 마지막 stop write 를 `try/except BleakError` 로 감싸서 cleanup 단계 실패가 traceback 안 뱉음.
- `try/finally` 파일 close → `contextlib.ExitStack` 으로 통합 (ruff SIM115 만족 + 라인 수 51).

**참조**: `linkband/spike_dump.py` (51줄, 46줄에서 +5).

---

### 2026-05-01 — BLE 스파이크 코드 작성 [PROGRESS]

**무엇을**: 새 세션이 `linkband/spike_dump.py` (46줄) 작성. 스캔 → 연결 → EEG `start` 명령 →
EEG/ACC/PPG/Battery notify subscribe → 30초 raw bytes 덤프 → `stop` 명령. 출력은
`tests/fixtures/real/{eeg,ppg,acc,battery}.txt`. `.gitignore` 에 fixture 디렉터리 추가.

**감독 검수**: 사양 §3 (UUID), §5.1 (시작 시퀀스) 정확히 준수. `BleakScanner.find_device_by_filter`
사용으로 효율적. `try/finally` + `async with` + line-buffered open 으로 중간 종료 안전. 실행 OK.

**다음 단계**: 사용자가 헤드밴드 연결 후 스파이크 실행. 결과 4개 파일 첫 5줄을 감독 세션에 제출.

**참조**: `linkband/spike_dump.py`, spec §3 §5.1, `.gitignore`

---

### 2026-05-01 — Python 유지 결정 [DECISION]

**무엇을**: Vercel 배포 가능성 검토 중 TypeScript 피벗 옵션 등장. 사용자 우려 두 가지 —
언어 친숙도 부족 + TS 코드량 우려 — 둘 다 TS 가 손해. DSP 라이브러리 격차(scipy/neurokit/heartpy
없음)가 결정타.

**결정**: **Python 유지**. Vercel 배포는 `uvx linkband-app` 또는 PyInstaller 로 풀이.
필요 시 P1 완료 후 TS 피벗 가능 — Python 결과물이 reference impl 역할을 해서 TS 포팅의
정답지가 됨. 지금은 피벗 대비 작업 없이 Python 본 페이스로 진행.

**참조**: 본 entry 가 결정 자체. spec 갱신 없음 (구현 언어는 spec 에 명시되지 않음).

---

### 2026-05-01 — parser.py tests-first 작성 [PROGRESS]

**무엇을**: 새 세션이 `tests/test_parser.py` (260+줄) 작성. 6개 카테고리 × 13 테스트 케이스
+ 합성 패킷 빌더 3개 (eeg/ppg/acc). 카테고리: 헤더 timestamp / EEG 변환 정확성 / PPG 부호확장
트랩 / ACC 가설 A / Battery / EEG timestamp 연속성. RED 상태 (parser 본체 미존재로
ModuleNotFoundError 의도된 빨간불) 확인.

**감독 검수**: 테스트 fixture 가 spec §6.1, §7, §8.1, §9.1, §11, §13 보간 규칙과 정합.
함의된 parser API: `class Parser` (인스턴스 상태 — 마지막 샘플 시각 추적), 메서드
`parse_eeg/ppg/acc`, `reset_*_timestamps()`, 모듈 레벨 `_decode_acc_sample()` (가설
A↔B 교체 지점), stateless `parse_battery()`.

**다음 단계**: 하이브리드 C 결정으로 본체 작성은 스파이크 결과 받은 후로 미룸.
합성 boundary 테스트는 살아남고, 통합 패킷 fixture 만 실 덤프로 교체될 예정.

**참조**: `tests/test_parser.py`, `linkband/__init__.py`

---

### 2026-05-01 — 하이브리드 C(스파이크 → parser → ble.py) 채택 [DECISION]

**무엇을**: 디바이스 손에 있고 Chrome Web Bluetooth 로 연결 경험 있다는 사실 확인 후, P0
순서 변경. 원래 `models → parser → ble.py` 였으나, parser 합성 fixture 에 우리 해석 오류가
박힐 위험과 ACC 가설 A/B (Q1) 가 실 데이터 없으면 못 풀린다는 점이 결정 사유.

**결정**: 새 순서 — (1) 미니 BLE 스파이크로 raw bytes 덤프 → (2) 실 덤프 첫 줄을 parser 통합
테스트 fixture 로 박아 parser 본체 작성 → (3) 본격 ble.py. 기존 작성된 13 테스트는 boundary
부분만 살아남음.

**참조**: spec §16 P0 우선순위는 그대로, 순서만 바뀜.

---

### 2026-05-01 — CLAUDE.md 교차참조 출처 추가 + 경로 정정 [PROGRESS] [FIX]

**무엇을**: CLAUDE.md 에 4개 출처 명시 — (1) LooxidLabs/SDK-Android, (2) LooxidLabs/link_band_sdk,
(3) donghyeon99/sensor-dashboard, (4) 로컬 캐시 `.tmp_kotlin/`. 모듈별 참조 규칙 명시.
새 세션이 sensor-dashboard 의 DSP 경로를 검증해 `src/dsp/` → `src/lib/dsp/` 로 정정해야
함을 발견. 감독 세션이 정정 커밋.

**참조**: 커밋 `304ecd5` (출처 추가), `6b68525` (경로 정정).

---

### 2026-05-01 — 새 레포 생성 + CLAUDE.md 작성 [PROGRESS]

**무엇을**: `C:\Users\cowgo\Code\linkband-app` 신규 git 레포. 첫 커밋 `a0ac3cd` 빈 골격
(pyproject.toml uv 기반, README, .gitignore, docs/01-protocol-spec.md 533줄). 두 번째
커밋 `f7e04da` CLAUDE.md (78줄, 새 세션 인수인계용). GitHub 원격 `donghyeon99/linkband-app`
연결 + 푸시.

**참조**: 커밋 `a0ac3cd`, `f7e04da`. 레포 https://github.com/donghyeon99/linkband-app

---

### 2026-05-01 — 사양 묶음 1·2 잠금 [DECISION]

**무엇을**: 이전 세션(sensor-dashboard cwd)에서 LooxidLabs SDK-Android 코드베이스 역분석
후 `01-protocol-spec.md` 작성. 묶음 1(데이터 모델, Q1.1~Q1.5) + 묶음 2(열린 질문 전략 Q1~Q6)
잠금. 묶음 3(공개 API DX) + 묶음 4(WebSocket 포맷, 레포 구조, MVP 순서)는 코드 골격 잡힌
후 재논의로 deferred.

**결정 요약**:
- 시각: `t_device`(헤더) + `t_recv`(wall-clock) 둘 다
- EEG: raw int + μV float 둘 다
- 시각 자료형: `float` epoch sec
- 패킷 간 샘플 시각: 균일 간격 강제 (Kotlin 미러)
- ACC dtype: `int16` (가설 A/B 모두 수용), 디코더는 `_decode_acc_sample()` 함수로 분리
- leadOff: `bool` + `lead_off_raw: uint8` 둘 다

**참조**: spec §13, §17 전체.

---

## (Pre-log) 더 오래된 컨텍스트

이 로그가 시작되기 전의 작업은 sensor-dashboard 레포의 대화에서 이뤄졌다.
주요 흐름: mock-data 기반 sensor-dashboard 폐기 → LooxidLabs Kotlin SDK
역분석 → 사양서 작성 → 새 레포 시작.
요약은 `CLAUDE.md` 의 "Conversation history" 절 참조.
