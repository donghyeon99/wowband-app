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
