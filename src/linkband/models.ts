/**
 * Link Band 센서 배치 데이터 모델 (TS 포팅).
 *
 * BLE 패킷 1개 = 인스턴스 1개. 샘플당 객체가 아닌 typed array 묶음.
 * EEG 는 500Hz 라 50ms 마다 25 샘플 — 객체 단위 표현은 GC 압력만 키움.
 *
 * Python reference (numerical 정답지): reference-py/linkband/models.py.
 * 필드 의미·dtype·raw/변환값 동시 보관 결정은 spec §13 잠금 사항. 임의 확장 X.
 *
 * Python ↔ TS 필드 매핑 (의미 동일, 표기만 camelCase):
 *   t_device → tDevice, t_recv → tRecv, ch1_uv → ch1Uv, lead_off_raw → leadOffRaw 등.
 *
 * dtype 매핑:
 *   np.float64 → Float64Array
 *   np.int32   → Int32Array
 *   np.int16   → Int16Array
 *   np.uint8   → Uint8Array
 *   np.bool    → boolean[]   (JS 에 Bool typed array 없음 — 25개 boxed bool 의 GC 비용은 무시할 수준)
 */

/** EEG nominal sample rate. 실측 확정 (spec §7, §17 Q7) — Kotlin SDK 의 250 은 오류. */
export const EEG_FS = 500;
/** PPG nominal sample rate (spec §8). */
export const PPG_FS = 50;
/** ACC nominal sample rate (spec §9). */
export const ACC_FS = 25;

/**
 * EEG BLE 패킷 1개 — 25 samples / 50ms @ 500Hz (spec §7).
 *
 * `ch{1,2}Raw` 는 24-bit two's complement ADC 카운트, `ch{1,2}Uv` 는 μV 변환값:
 *   μV = raw × 4.033 / 12 / 8388607 × 1e6   (≈ 0.04004 μV/LSB, spec §7.2)
 *
 * `leadOff` 는 bool (Kotlin parity: `leadOffRaw > 0`).
 * `leadOffRaw` 는 원래 uint8 — 펌웨어가 채널별 비트마스크로 쓰는지 추후 확인 (§17 Q2).
 */
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

/**
 * PPG BLE 패킷 1개 — 28 samples / 560ms @ 50Hz (spec §8).
 *
 * 24-bit unsigned raw 만 보관. PPG 단위 변환은 문서화 안 됨;
 * BPM/HRV 는 dsp/metrics 단계에서 산출.
 */
export interface PpgBatch {
  tDevice: number;
  tRecv: number;
  fs: typeof PPG_FS;
  /** length = 28. */
  red: Int32Array;
  ir: Int32Array;
}

/**
 * ACC BLE 패킷 1개 — 30 samples / 1200ms @ 25Hz (spec §9).
 *
 * 각 축 16-bit signed Little-Endian — 실측 확정 (spec §9.1, §17 Q1).
 * Kotlin SDK 가 LSB(인덱스 0/2/4) 를 누락하던 버그였음.
 */
export interface AccBatch {
  tDevice: number;
  tRecv: number;
  fs: typeof ACC_FS;
  /** length = 30. */
  x: Int16Array;
  y: Int16Array;
  z: Int16Array;
}

/**
 * 표준 BLE Battery Service 알림 (spec §11).
 *
 * `tDevice` 없음 — 헤더 timestamp 없이 1-byte 퍼센트만 실려옴.
 */
export interface BatteryStatus {
  tRecv: number;
  /** 0..100 */
  level: number;
}
