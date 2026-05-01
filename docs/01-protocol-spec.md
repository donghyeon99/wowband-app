# Link Band BLE Protocol & SDK Spec

본 문서는 새 `linkband-app` 레포에서 Python으로 구현할 Link Band SDK의 **참조 사양서**다.
LooxidLabs의 공식 [SDK-Android](https://github.com/LooxidLabs/SDK-Android) (Kotlin, `develop` 브랜치)
및 [link_band_sdk](https://github.com/LooxidLabs/link_band_sdk) (Python+Electron) 코드베이스를
역분석해 정리했다. 모든 항목은 출처 파일을 명시한다.

> **상태**: 사양 분석 완료, 구현 미시작.
> **다음 단계**: 본 사양에 따라 새 레포에서 `linkband/` Python 패키지 구현.

---

## 1. 시스템 개요

```
[Link Band 헤드밴드] ──BLE──→ [Python 서버] ──WebSocket──→ [React 뷰어]
                              · BLE 연결 (bleak)
                              · 패킷 파싱
                              · DSP 필터
                              · 메트릭 산출 (BPM, HRV, 밴드파워 등)
```

**책임 분담** (학생용 교육 도구로서의 결정):
- **Python**: BLE → 파싱 → DSP → 메트릭 → WebSocket 송신
- **React**: WebSocket 수신 → 차트 렌더링만 (비즈니스 로직 X)

**최종 사용자**: 학생. 단 SDK 자체의 구현 주체는 우리. 학생은 결과물(Python 패키지 + 노트북)을 사용·확장한다.

---

## 2. BLE 디바이스 발견 규칙

| 항목 | 값 | 비고 |
|---|---|---|
| 광고 이름 prefix | `LXB-` | `BleManager.kt:118` 의 `scanCallback` |
| 스캔 필터 방식 | name prefix 매칭 | UUID 필터 아님 — 광고에 service UUID가 안 실릴 수 있음 |

**Python 구현 메모**: `bleak.BleakScanner.discover()` 결과에서 `device.name.startswith("LXB-")` 로 필터.

---

## 3. GATT 서비스 / 특성 UUID

출처: `BleManager.kt:32–47`

| 용도 | Service UUID | Characteristic UUID | 동작 모드 |
|---|---|---|---|
| EEG (수신) | `df7b5d95-3afe-00a1-084c-b50895ef4f95` | `00ab4d15-66b4-0d8a-824f-8d6f8966c6e5` | Notify |
| **EEG (제어)** | 〃 | `0065cacb-9e52-21bf-a849-99a80d83830e` | **Write** |
| PPG (수신) | `1cc50ec0-6967-9d84-a243-c2267f924d1f` | `6c739642-23ba-818b-2045-bfe8970263f6` | Notify |
| ACC (수신) | `75c276c3-8f97-20bc-a143-b354244886d4` | `d3d46a35-4394-e9aa-5a43-e7921120aaed` | Notify |
| Battery | `0000180f-…` (BLE 표준) | `00002a19-…` (BLE 표준) | Notify/Read |

**CCCD UUID** (Notify 활성화에 필요한 표준 descriptor): `00002902-0000-1000-8000-00805f9b34fb`

---

## 4. 연결 & 초기화 시퀀스

출처: `BleManager.kt:206–269` (`onConnectionStateChange`, `onMtuChanged`, `onServicesDiscovered`)

```
1. connectGatt()
2. ↓ STATE_CONNECTED
3. requestMtu(247)              ← BLE 최대 MTU 협상 (대용량 패킷 필요)
4. ↓ onMtuChanged
5. wait 1000 ms
6. discoverServices()
7. ↓ onServicesDiscovered
8. wait 500 ms
9. startNotifications()         ← 각 센서 CCCD enable
10. wait 2000 ms                 ← servicesReady = true
```

**Python(bleak) 매핑 메모**: bleak은 자동으로 service discovery·MTU 협상을 처리하지만,
플랫폼에 따라 MTU 강제가 가능/불가능. Linux/macOS는 자동, Windows는 OS 레벨 제어. 패킷 수신 후
ATT_MTU 부족이 의심되면 패킷 분할 흔적(예: 184 byte ACC가 끊겨 도착)으로 판단.

---

## 5. 센서 활성화 / 중지 프로토콜

출처: `BleManager.kt:735–854` (`startSelectedSensors`, `stopSelectedSensors`, `setNotifyValue`)

### 5.1 시작 시퀀스 (`startSelectedSensors`)

```
1. 모든 센서 Notification 비활성화 (펌웨어 데이터 전송 중단)
2. wait 1200 ms
3. Battery Notification CCCD enable     ← 항상 먼저 (PPG 단독 동작 안정성)
4. EEG가 선택됐다면: Write "start" → EEG_WRITE_CHAR (5 bytes UTF-8)
5. 활성화 큐: [EEG, ACC, PPG] 순서
6. wait 1000~2000 ms
7. 큐의 각 센서를 순차로 Notification CCCD enable
   - 각 활성화 사이에 펌웨어 응답 대기 후 다음 진행
```

**핵심 디테일**:
- EEG는 **CCCD enable만으로는 안 켜진다** — 반드시 `EEG_WRITE_CHAR_UUID`에 `b"start"` 를 써야 함.
- PPG·ACC는 CCCD enable만으로 시작.
- 활성화 순서 EEG → ACC → PPG 는 펌웨어 안정성을 위한 시퀀스로 추정.

### 5.2 중지 시퀀스

각 센서 CCCD disable + 추가로 EEG는 `EEG_WRITE_CHAR_UUID`에 `b"stop"` (4 bytes UTF-8) 작성.

### 5.3 명령 페이로드 표

| 명령 | 대상 | 페이로드 | bytes |
|---|---|---|---|
| EEG start | `EEG_WRITE_CHAR_UUID` | `"start"` UTF-8 | `73 74 61 72 74` |
| EEG stop  | `EEG_WRITE_CHAR_UUID` | `"stop"`  UTF-8 | `73 74 6F 70` |

PPG/ACC에는 별도 시작/정지 명령 없음.

---

## 6. 패킷 포맷 (공통)

모든 센서 패킷은 다음 구조:

```
[ 4-byte header ][ N × sample_size bytes ]
       ↑                  ↑
   timestamp          연속 샘플
   (LE uint32)
```

### 6.1 패킷 헤더 — 타임스탬프

출처: `SensorDataParser.kt:78–80`, `SensorConfiguration.kt:13`

```
timestamp_raw  = u32_le(header[0..4])         # 32-bit little-endian unsigned
timestamp_sec  = timestamp_raw / 32768.0       # 32.768 kHz 클럭 틱
```

`timestampDivisor=32.768`, `millisecondsToSeconds=1000.0` 의 두 값을 나누는 것은
실제로 `/ 32.768 / 1000 = / 32768` 과 동일. 펌웨어 RTC가 32.768kHz 크리스털 기반이라는 의미.

**중요**: 이 timestamp는 **패킷 단위**로만 의미가 있고, 같은 패킷 안의 N 샘플은
샘플레이트로 보간한다. Kotlin 파서는 `lastSampleTimestampMillis` 를 들고 있어
패킷 간 끊김도 균일 간격으로 이어붙인다 — 실시간 표시에는 좋고, 절대 시각이 필요한
경우엔 wall-clock과 불일치할 수 있음.

---

## 7. EEG 패킷 사양

출처: `SensorDataParser.kt:64–113`, `SensorConfiguration.kt:17–23`

| 항목 | 값 |
|---|---|
| 샘플레이트 | **250 Hz** |
| 패킷 크기 | **179 bytes** |
| 헤더 | 4 bytes (timestamp) |
| 샘플 크기 | **7 bytes** |
| 샘플 수 / 패킷 | (179 − 4) / 7 = **25 samples** |
| 1 패킷 시간 | 25 / 250 = **100 ms** |

### 7.1 샘플 바이트 레이아웃 (7 bytes)

```
offset  0       1   2   3       4   5   6
        ┌─────┬─────────────┬─────────────┐
bytes   │ LO  │  CH1 (24b)  │  CH2 (24b)  │
        └─────┴─────────────┴─────────────┘
LO  = leadOff: u8 (0=정상 접촉, >0=접촉 불량)
CH1 = 24-bit signed big-endian (raw)
CH2 = 24-bit signed big-endian (raw)
```

**부호 처리** (`SensorDataParser.kt:91–94`):
```python
ch_raw = (b1 << 16) | (b2 << 8) | b3
if ch_raw & 0x800000:        # 음수 처리 (24-bit two's complement)
    ch_raw -= 0x1000000
```

### 7.2 μV 변환식

출처: `SensorDataParser.kt:95–96`, `SensorConfiguration.kt:20–23`

```
μV = raw × Vref / Gain / Resolution × 1e6
   = raw × 4.033 / 12 / 8388607 × 1e6
   ≈ raw × 0.04004 μV / LSB
```

| 상수 | 값 | 의미 |
|---|---|---|
| `Vref` | 4.033 V | 기준 전압 |
| `Gain` | 12 | 전치증폭기 게인 |
| `Resolution` | 8388607 = 2²³ − 1 | 24-bit signed full-scale |
| `μV multiplier` | 1e6 | V → μV |

### 7.3 leadOff 의미

`leadOff > 0` 이면 전극 접촉 불량. 값이 비트마스크인지(채널별 표시) 단순 플래그인지는 펌웨어
스펙 미확인. 일단 boolean 으로 취급. **시각화 시 신호 신뢰성 표시에 그대로 활용 가능**.

---

## 8. PPG 패킷 사양

출처: `SensorDataParser.kt:120–158`, `SensorConfiguration.kt:26–28`

| 항목 | 값 |
|---|---|
| 샘플레이트 | **50 Hz** |
| 패킷 크기 | **172 bytes** |
| 헤더 | 4 bytes |
| 샘플 크기 | **6 bytes** |
| 샘플 수 / 패킷 | (172 − 4) / 6 = **28 samples** |
| 1 패킷 시간 | 28 / 50 = **560 ms** |

### 8.1 샘플 바이트 레이아웃 (6 bytes)

```
offset  0   1   2       3   4   5
        ┌─────────────┬─────────────┐
bytes   │  RED (24b)  │  IR  (24b)  │
        └─────────────┴─────────────┘
RED = 24-bit big-endian (변환 없음, raw int)
IR  = 24-bit big-endian (변환 없음, raw int)
```

**Python 구현 메모 — Kotlin 파서의 잠재 버그**:
- Kotlin 파서(`SensorDataParser.kt:144–145`)가 `(data[i].toInt() shl 16) or ...` 를 쓰는데
  `& 0xFF` 를 누락. Kotlin `Byte → Int` 변환은 부호 확장이 일어나므로
  최상위 바이트가 `0x80` 이상이면 결과가 음수가 됨.
- Python 구현에서는 반드시 `int.from_bytes(b, "big", signed=False)` 또는 비트마스킹 사용.
  `red = (b[0] << 16) | (b[1] << 8) | b[2]` (Python int는 부호 확장 안 일어남, 안전).

### 8.2 변환

PPG는 raw 값 그대로 사용. 단위 없음. BPM/HRV는 DSP 단계에서 산출.

---

## 9. ACC 패킷 사양

출처: `SensorDataParser.kt:165–203`, `SensorConfiguration.kt:31–33`

| 항목 | 값 |
|---|---|
| 샘플레이트 | **25 Hz** |
| 패킷 크기 | **184 bytes** |
| 헤더 | 4 bytes |
| 샘플 크기 | **6 bytes** |
| 샘플 수 / 패킷 | (184 − 4) / 6 = **30 samples** |
| 1 패킷 시간 | 30 / 25 = **1200 ms** |

### 9.1 ⚠️ 샘플 바이트 레이아웃 — 검증 필요

`SensorData.kt:18–22` 의 데이터클래스 주석은 x/y/z 가 **16-bit signed Short** 라고 명시.
하지만 Kotlin 파서(`SensorDataParser.kt:187–189`)는 한 바이트씩만 읽음:

```kotlin
val x = (data[baseInFullPacket + 1].toInt()).toShort()
val y = (data[baseInFullPacket + 3].toInt()).toShort()
val z = (data[baseInFullPacket + 5].toInt()).toShort()
```

→ **인덱스 1, 3, 5 만 읽고 0, 2, 4 는 무시**. 결과는 부호확장된 8-bit signed 값.

가능한 해석:
1. **펌웨어가 8-bit per axis + 1 byte filler 형태로 전송** (가장 가능성 높음, 6/3 = 2 bytes per axis 중 1 byte만 실제 데이터)
2. **펌웨어는 16-bit LE 로 보내는데 Kotlin 파서가 LSB만 읽는 버그** → 정확한 값은
   `(data[i] | (data[i+1] << 8))` 로 16-bit signed LE 처리해야 함

**Python 구현 시 액션**:
1. 일단 Kotlin 동작 그대로(인덱스 1·3·5만 8-bit signed) 미러링
2. 실 디바이스 연결되면 raw 패킷 hexdump 후 두 해석 결과를 비교하여 확정
3. 결정 후 본 문서 업데이트

샘플 코드 (검증용):
```python
# Hypothesis A — Kotlin 그대로 (8-bit, odd bytes)
x_a = int.from_bytes(buf[1:2], "big", signed=True)
# Hypothesis B — 16-bit LE
x_b = int.from_bytes(buf[0:2], "little", signed=True)
```

### 9.2 단위

raw 값. ±1g 정도 범위에서 데이터시트 확인 필요. 보통 LSM6 계열 IMU는 16-bit LE±2g 모드에서
약 16384 LSB/g. 샘플레이트 25Hz는 IMU의 ODR 설정으로, 펌웨어에서 다운샘플 후 송신.

---

## 10. 가속도 모드 (RAW vs MOTION)

출처: `BleManager.kt:608–656`, `SensorData.kt:33–43`

```python
# RAW: 가공 없음 (중력 포함)
processed = (x, y, z)

# MOTION: 1차 IIR 저역통과로 중력 추정 후 빼기
# alpha = 0.1 (gravityFilterFactor)
gravity_x = (1 - 0.1) * gravity_x + 0.1 * x  # = 0.9·g + 0.1·x
gravity_y = (1 - 0.1) * gravity_y + 0.1 * y
gravity_z = (1 - 0.1) * gravity_z + 0.1 * z
processed = (x - gravity_x, y - gravity_y, z - gravity_z)
```

첫 샘플은 그대로 초기값으로 사용 (`isGravityInitialized` 플래그). ACC fs=25Hz, α=0.1
이면 cutoff 약 0.4 Hz — 충분히 느린 중력 변화만 추정한다.

**구현 위치**: `linkband/dsp.py` (BLE 레이어가 아닌 신호처리 레이어).

---

## 11. Battery 패킷

출처: `SensorDataParser.kt:213–220`

표준 BLE Battery Service (`0x180F` / `0x2A19`). 첫 바이트가 0~100 (퍼센트).

```python
level = data[0] & 0xFF  # 0..100
```

알림 빈도: 펌웨어 결정 (보통 변경 시 또는 분 단위).

---

## 12. 공개 API 표면 (LinkBandSdk.kt 미러링)

출처: `LinkBandSdk.kt`

Kotlin SDK가 노출하는 공개 메서드 → Python 패키지 매핑.

### 12.1 연결 관리
| Kotlin | Python (제안) |
|---|---|
| `startScan()` / `stopScan()` | `LinkBand.scan()` (async generator), `LinkBand.stop_scan()` |
| `connectToDevice(device)` | `await LinkBand.connect(address)` |
| `disconnect()` | `await LinkBand.disconnect()` |
| `enable/disableAutoReconnect()` | `LinkBand.auto_reconnect = True/False` |

### 12.2 센서 관리
| Kotlin | Python (제안) |
|---|---|
| `selectSensor(s)` / `deselectSensor(s)` | `LinkBand.select(SensorType.EEG)` |
| `startSelectedSensors()` | `await LinkBand.start()` |
| `stopSelectedSensors()` | `await LinkBand.stop()` |
| `setAccelerometerMode(mode)` | `LinkBand.acc_mode = AccMode.MOTION` |

### 12.3 데이터 스트림 (StateFlow → AsyncIterator/Callback)

Kotlin은 `StateFlow<List<EegData>>` 형태로 노출. Python에서는 두 가지 옵션:
- **(A) Async iterator**: `async for batch in linkband.eeg_stream(): ...` — 학생 친화적
- **(B) Callback**: `linkband.on_eeg(callback)` — 콜백 등록형

권장: **A안(async iterator) 메인 + B안(콜백) 보조 제공**. 노트북 실습에서 async 컨텍스트 매니저로
사용성 좋음.

### 12.4 우리가 빼는 것 / 단순화

Kotlin SDK에 있지만 우리는 **삭제** 또는 **이후 단계로**:
- `SensorDataRecorder` (CSV/JSON 저장) — 학생이 numpy로 직접 저장하면 됨, 굳이 SDK가 안 가짐
- `TimeBatchManager` 의 SAMPLE_COUNT/SECONDS/MINUTES 모드 — 복잡. 일단 고정 배치 사이즈 하나로 시작
- `SensorBatchConfiguration` UI 텍스트 필드 — UI 전용, 무시

---

## 13. 데이터 모델 (Python) — **묶음 1 잠금 (2026-05-01)**

`linkband/models.py`. **샘플 단위가 아닌 numpy 배치** (250Hz 객체 폭증 방지).

**확정 결정**:
- Q1.1 → 시각은 `t_device`(헤더 기반) + `t_recv`(wall-clock) 둘 다 보관
- Q1.2 → EEG는 raw 와 μV 둘 다 보관 (학생이 변환식 추적 가능)
- Q1.3 → `float` epoch sec (numpy/pandas 친화)
- Q1.4 → 패킷 간 균일 간격 강제 (Kotlin 방식 미러링, 끊김 시 reset)
- Q1.5 → ACC dtype int16 통일, parser에 `_decode_acc_sample()` 함수로 디코더 분리해 가설 A↔B 한 줄 교체 가능하게

```python
from dataclasses import dataclass
import numpy as np

@dataclass
class EegBatch:
    t_device: float          # epoch sec, 헤더 timestamp 기반 첫 샘플 시각 (보간된 균일 간격의 시작점)
    t_recv: float            # 패킷 도착 wall-clock (time.time())
    fs: int = 250
    ch1_uv: np.ndarray       # float64, shape (N,) — μV 변환값
    ch2_uv: np.ndarray
    ch1_raw: np.ndarray      # int32, shape (N,) — 24-bit two's complement raw
    ch2_raw: np.ndarray
    lead_off: np.ndarray     # bool,  shape (N,) — Kotlin parity (leadOffRaw > 0)
    lead_off_raw: np.ndarray # uint8, shape (N,) — 비트마스크 보존 (학생 탐구용, Q2)

@dataclass
class PpgBatch:
    t_device: float
    t_recv: float
    fs: int = 50
    red: np.ndarray          # int32, shape (N,)
    ir:  np.ndarray

@dataclass
class AccBatch:
    t_device: float
    t_recv: float
    fs: int = 25
    x: np.ndarray            # int16, shape (N,)  (가설 A/B 모두 수용)
    y: np.ndarray
    z: np.ndarray

@dataclass
class BatteryStatus:
    t_recv: float
    level: int               # 0..100
```

**보간 규칙** (Q1.4):
- 첫 패킷: `sample_t[0] = t_device_from_header`, 이후 `sample_t[i] = sample_t[i-1] + 1/fs`
- 두 번째 패킷부터: 직전 패킷의 마지막 샘플 시각 + `1/fs` 를 첫 샘플 시각으로 사용 (Kotlin `lastEegSampleTimestampMillis`)
- 연결 끊김/재연결 시 `lastSampleTimestampMillis` 리셋 → 다음 패킷 헤더 기반으로 재초기화
- 패킷 헤더 timestamp 점프(예: 펌웨어 재시작)는 휴리스틱으로 감지 후 재초기화 (구현 시 임계값 결정)

---

## 14. WebSocket 메시지 포맷 (server → web)

JSON. numpy 배열은 list로 직렬화. 배치 단위 송신.

```json
{"type": "eeg",     "t": 1714521600.123, "fs": 250,
 "ch1_uv": [...], "ch2_uv": [...], "lead_off": [...]}

{"type": "ppg",     "t": 1714521600.124, "fs": 50,
 "red": [...], "ir": [...]}

{"type": "acc",     "t": 1714521600.125, "fs": 25,
 "x": [...], "y": [...], "z": [...]}

{"type": "battery", "t": ..., "level": 87}

{"type": "status",  "t": ..., "connected": true, "device": "LXB-XXXX"}
```

DSP·메트릭 단계에서 추가 메시지 (예시):
```json
{"type": "metric", "t": ..., "name": "bpm", "value": 72.3}
{"type": "metric", "t": ..., "name": "alpha_power_ch1", "value": 12.4}
```

---

## 15. 제안 패키지 구조

```
linkband-app/
├── pyproject.toml
├── linkband/
│   ├── __init__.py            # public API (LinkBand, SensorType, AccMode, ...)
│   ├── models.py              # EegBatch, PpgBatch, AccBatch, BatteryStatus
│   ├── ble.py                 # bleak 기반 BLE 매니저 (BleManager.kt 포팅)
│   ├── parser.py              # 패킷 → batch (SensorDataParser.kt 포팅)
│   ├── dsp.py                 # 필터, AccMode MOTION 처리
│   ├── metrics.py             # BPM, HRV, 밴드파워
│   └── server.py              # FastAPI + WebSocket
├── notebooks/
│   ├── 01_connect.ipynb
│   ├── 02_explore_eeg.ipynb
│   └── 03_compute_bpm.ipynb
├── tests/
│   ├── test_parser.py         # 합성 패킷으로 byte → batch 검증
│   └── test_dsp.py
└── web/                       # Vite + React (시각화 전용)
```

---

## 16. 구현 우선순위 (MVP 순서)

| 우선순위 | 모듈 | 내용 |
|---|---|---|
| P0 | `models.py` | dataclass 정의, 단위 테스트 없이도 가능 |
| P0 | `parser.py` | 합성 패킷으로 단위 테스트 가능 (실 디바이스 불필요) |
| P0 | `ble.py` | 실 디바이스 필요. 스캔 → 연결 → 시작 → 패킷 수신까지 |
| P1 | `server.py` | WebSocket 단방향 송신 (가장 단순한 형태부터) |
| P1 | `web/` | Vite + React 시각화 (현재 sensor-dashboard에서 차트 발췌 이식) |
| P2 | `dsp.py` | band-pass, notch, AccMode MOTION |
| P2 | `metrics.py` | BPM, HRV, 밴드파워 |
| P3 | 자동 재연결, 배치 모드 다양화, 노트북 |

**P0 단계에서 실 디바이스 없이 검증 가능한 것**:
1. `parser.py` ← 합성 바이트 패킷으로 충분
2. 모델 직렬화/역직렬화

**실 디바이스가 필요한 것**:
1. `ble.py` 의 연결 시퀀스 검증
2. ACC 6-byte 레이아웃 가설 A vs B 검증 (§9.1)
3. EEG `start`/`stop` 명령에 대한 펌웨어 응답 확인

---

## 17. 미해결 / 검증 필요 항목 — **묶음 2 잠금 (2026-05-01)**

설계 결정은 묶음 1·2에서 모두 잠금. 아래는 **실 디바이스 검증** 항목으로 결정 영향 없음.

| # | 항목 | 위치 | 처리 전략 | 결정 영향 |
|---|---|---|---|---|
| Q1 | ACC 샘플 6-byte 레이아웃 — 8-bit×3+filler vs 16-bit LE | §9.1 | `_decode_acc_sample()` 함수 분리해 가설 A로 시작, 실측 후 한 줄 교체 | 없음 (Q1.5 처리됨) |
| Q2 | leadOff 비트마스크 의미 분석 | §7.3 | `lead_off_raw: uint8` 도 함께 저장해서 학생/우리가 사후 분석 가능 | 없음 (필드만 추가됨) |
| Q3 | PPG raw → 단위 변환 | §8.2 | MVP에서 변환 없음. BPM은 DSP envelope+peak detection 사용 | 없음 |
| Q4 | Battery notification 빈도 | §11 | 알림 받는 그대로 송신, 별도 처리 X | 없음 |
| Q5 | 추가 펌웨어 명령 | §5.3 | MVP 범위 밖, 필요 시 추후 추가 | 없음 |
| Q6 | 패킷 헤더 timestamp 의미 (절대/상대) | §6.1 | `t_device` + `t_recv` 둘 다 보관 → 어느 쪽이든 OK | 없음 (Q1.1 처리됨) |

**검증 시점**: 실 디바이스 첫 연결 (P0 단계의 `ble.py` 완료 직후) hexdump 1세트 + 30분 작업.

---

## 18. 참조 파일 인덱스

| 파일 | 역할 | 본 문서에서 인용된 위치 |
|---|---|---|
| `SDK-Android/src/main/java/com/looxidlabs/sdkandroid/BleManager.kt` | BLE 연결/제어 | §3, §4, §5 |
| 〃 `SensorDataParser.kt` | 패킷 파싱 로직 | §6, §7, §8, §9, §11 |
| 〃 `SensorConfiguration.kt` | 모든 magic number | §6.1, §7.2, §8, §9 |
| 〃 `SensorData.kt` | 데이터 모델 정의 | §9.1, §13 |
| 〃 `LinkBandSdk.kt` | 공개 API 표면 | §12 |
| `link_band_sdk/python_core/` | Python 참조 구현 (교차검증용) | 파싱 검증 시 활용 |

---

**문서 마지막 갱신**: 2026-05-01 — 초기 작성, P0 구현 착수 전 사양 잠금.
