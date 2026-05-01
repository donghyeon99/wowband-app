/**
 * Link Band BLE 패킷 파서 (TS port of reference-py/linkband/parser.py).
 *
 * Python 정답지: `reference-py/linkband/parser.py` (15/15 GREEN at commit be16261).
 * TS 측 포팅 검증: `tests/parser.test.ts` 13 의미 케이스 (Python 의 부분집합).
 *
 * 인스턴스 상태는 spec §13 보간 규칙용 — 마지막 샘플 시각을 센서별로 기억해서
 * 패킷 사이 균일한 1/fs 간격을 유지한다 (Kotlin `lastEegSampleTimestampMillis` 미러).
 *
 * 원전 비교 (`SDK-Android/SensorDataParser.kt`):
 * - 헤더 LE u32 + 32.768kHz 분주: line 78–80, 그대로 미러.
 * - EEG 24-bit BE + 부호확장 + μV: line 91–96, 그대로 미러.
 * - PPG 24-bit BE: line 144–145 의 `& 0xFF` 누락 버그 회피 — TS bitwise 는 본디
 *   32-bit signed 연산이지만 `getUint8 << 16` 등 마스크된 입력으로 비음수 보장 (spec §8.1).
 * - ACC: line 187–189 가 LSB(인덱스 0/2/4) 를 누락하는 버그가 있어 우리는 16-bit LE
 *   로 정정 (spec §9.1, §17 Q1, 2026-05-01 실측 확정).
 */
import type { AccBatch, BatteryStatus, EegBatch, PpgBatch } from "./models";
import { ACC_FS, EEG_FS, PPG_FS } from "./models";

// spec §6.1 — 32.768 kHz 펌웨어 RTC 분주.
const TICKS_PER_SEC = 32768.0;

// spec §7.2 — μV 변환식 상수.
const EEG_VREF = 4.033;
const EEG_GAIN = 12.0;
const EEG_RES = 8388607.0; // 2^23 - 1
const EEG_UV_FACTOR = (EEG_VREF / EEG_GAIN / EEG_RES) * 1e6; // ≈ 0.040064 μV/LSB

const HEADER_SIZE = 4;
const EEG_SAMPLE_SIZE = 7; // leadOff(1) + ch1_be_s24(3) + ch2_be_s24(3)
const PPG_SAMPLE_SIZE = 6; // red_be_u24(3) + ir_be_u24(3)
const ACC_SAMPLE_SIZE = 6; // x_le_s16(2) + y_le_s16(2) + z_le_s16(2)

function nowSec(): number {
  return Date.now() / 1000;
}

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function headerSeconds(view: DataView): number {
  return view.getUint32(0, true) / TICKS_PER_SEC;
}

/** 24-bit big-endian signed → number. 24-bit two's complement 부호확장 (spec §7.1). */
function decodeBeS24(view: DataView, offset: number): number {
  const u = (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);
  return u & 0x800000 ? u - 0x1000000 : u;
}

/** 24-bit big-endian unsigned → number. Python 의 `int.from_bytes(..., signed=False)` 에 대응 (spec §8.1). */
function decodeBeU24(view: DataView, offset: number): number {
  return (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);
}

/**
 * 6-byte ACC 샘플 → (x, y, z) 16-bit signed Little-Endian (spec §9.1, §17 Q1).
 *
 * 각 축 2 bytes LE. Kotlin SDK 의 LSB 누락 버그 (인덱스 0/2/4 무시) 를 회피한 정정 디코더.
 */
export function _decodeAccSample(buf: Uint8Array): [number, number, number] {
  const v = viewOf(buf);
  return [v.getInt16(0, true), v.getInt16(2, true), v.getInt16(4, true)];
}

/**
 * 1-byte 퍼센트 → BatteryStatus (spec §11). 헤더 없음, stateless.
 *
 * 빈 payload 면 throw — 호출 측이 적절한 BLE 알림인지 확인 후 호출.
 */
export function parseBattery(data: Uint8Array): BatteryStatus {
  if (data.length === 0) throw new Error("empty battery payload");
  return { tRecv: nowSec(), level: data[0] };
}

/**
 * 헤드밴드 패킷 → EegBatch / PpgBatch / AccBatch.
 * 인스턴스 상태로 센서별 마지막 샘플 시각을 보간한다.
 *
 * Use:
 *     const parser = new Parser();
 *     const eeg = parser.parseEeg(packetBytes);   // EegBatch
 *     // BLE 재연결/센서 재시작 시 보간 시각 리셋
 *     parser.resetEegTimestamps();
 */
export class Parser {
  private lastEegT: number | null = null;
  private lastPpgT: number | null = null;
  private lastAccT: number | null = null;

  resetEegTimestamps(): void {
    this.lastEegT = null;
  }
  resetPpgTimestamps(): void {
    this.lastPpgT = null;
  }
  resetAccTimestamps(): void {
    this.lastAccT = null;
  }

  /** 179-byte EEG 패킷 → 25-샘플 EegBatch (fs=500). spec §7. */
  parseEeg(data: Uint8Array): EegBatch {
    const view = viewOf(data);
    const n = Math.floor((data.byteLength - HEADER_SIZE) / EEG_SAMPLE_SIZE);
    const firstT = this.firstSampleTime(this.lastEegT, headerSeconds(view), EEG_FS);

    const ch1Raw = new Int32Array(n);
    const ch2Raw = new Int32Array(n);
    const leadOffRaw = new Uint8Array(n);
    const leadOff: boolean[] = new Array(n);
    const ch1Uv = new Float64Array(n);
    const ch2Uv = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      const off = HEADER_SIZE + i * EEG_SAMPLE_SIZE;
      const lo = view.getUint8(off);
      leadOffRaw[i] = lo;
      leadOff[i] = lo > 0;
      const c1 = decodeBeS24(view, off + 1);
      const c2 = decodeBeS24(view, off + 4);
      ch1Raw[i] = c1;
      ch2Raw[i] = c2;
      ch1Uv[i] = c1 * EEG_UV_FACTOR;
      ch2Uv[i] = c2 * EEG_UV_FACTOR;
    }

    this.lastEegT = firstT + (n - 1) / EEG_FS;
    return {
      tDevice: firstT,
      tRecv: nowSec(),
      fs: EEG_FS,
      ch1Uv,
      ch2Uv,
      ch1Raw,
      ch2Raw,
      leadOff,
      leadOffRaw,
    };
  }

  /** 172-byte PPG 패킷 → 28-샘플 PpgBatch (fs=50). spec §8. */
  parsePpg(data: Uint8Array): PpgBatch {
    const view = viewOf(data);
    const n = Math.floor((data.byteLength - HEADER_SIZE) / PPG_SAMPLE_SIZE);
    const firstT = this.firstSampleTime(this.lastPpgT, headerSeconds(view), PPG_FS);

    const red = new Int32Array(n);
    const ir = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const off = HEADER_SIZE + i * PPG_SAMPLE_SIZE;
      red[i] = decodeBeU24(view, off);
      ir[i] = decodeBeU24(view, off + 3);
    }

    this.lastPpgT = firstT + (n - 1) / PPG_FS;
    return { tDevice: firstT, tRecv: nowSec(), fs: PPG_FS, red, ir };
  }

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

  /** spec §13 Q1.4 보간 — 직전 마지막 샘플 + 1/fs, 없으면 헤더 사용. */
  private firstSampleTime(lastT: number | null, headerT: number, fs: number): number {
    return lastT === null ? headerT : lastT + 1.0 / fs;
  }
}
