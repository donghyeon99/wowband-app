/**
 * src/linkband/parser.ts 단위 테스트 — Python reference (`reference-py/tests/test_parser.py`,
 * 15/15 GREEN at commit be16261) 의 13 의미 케이스를 그대로 포팅.
 *
 * 작성 시점에 parser.ts 미존재 → import 실패로 collection RED. 본체 작성 후 GREEN 으로 전환.
 */
import { describe, expect, it } from "vitest";

import type { AccBatch, BatteryStatus, EegBatch, PpgBatch } from "../src/linkband/models";
import { Parser, _decodeAccSample, parseBattery } from "../src/linkband/parser";

// ─── Synthetic packet builders (spec §6 헤더 LE u32 + 센서별 샘플) ──────────

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function leU32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function beU24(value: number): number[] {
  if (value < 0) value += 0x1000000;
  return [(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function eegPacket(timeRaw: number, samples: Array<[number, number, number]>): Uint8Array {
  const bytes: number[] = [...leU32(timeRaw)];
  for (const [leadOff, ch1, ch2] of samples) {
    bytes.push(leadOff & 0xff, ...beU24(ch1), ...beU24(ch2));
  }
  return new Uint8Array(bytes);
}

function ppgPacket(timeRaw: number, samples: Array<[number, number]>): Uint8Array {
  const bytes: number[] = [...leU32(timeRaw)];
  for (const [red, ir] of samples) bytes.push(...beU24(red), ...beU24(ir));
  return new Uint8Array(bytes);
}

function accPacket(timeRaw: number, samples: Array<[number, number, number]>): Uint8Array {
  const out = new Uint8Array(4 + samples.length * 6);
  out.set(leU32(timeRaw), 0);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const [x, y, z] = samples[i];
    view.setInt16(4 + i * 6, x, true);
    view.setInt16(4 + i * 6 + 2, y, true);
    view.setInt16(4 + i * 6 + 4, z, true);
  }
  return out;
}

const EEG_LSB_UV = (1.0 * 4.033) / 12.0 / 8388607.0 * 1e6;

// ─── Real-device fixtures (line 1 from reference-py/tests/fixtures/real/) ──
// 동일한 hex 가 reference-py/tests/test_parser.py 에도 박혀 있고, byte-exact 일치 확인됨.
const EEG_REAL_LINE1 = hexToBytes("95200700" + "007fffff7fffff".repeat(25));
const PPG_REAL_LINE1 = hexToBytes(
  "fda607000041060060320056b300602f0056b70060350056ae0060300056ad00602e0056b200602f" +
  "0056b20060280056b30060260056bf00602a0056cf0060360056eb0060450056fe00605800570d00" +
  "606900572200607400572000606900571b00605a00571700605200571900606100571c0060570057" +
  "2c0060690057800060be00580400614200584f00619600582600617b0057c400613d005770006108" +
  "00571f0060c10056d9006071",
);
const ACC_REAL_LINE1 = hexToBytes(
  "a5b607000039000700e00037000500e10037000700db0037000600dd0036000500dc0036000400db" +
  "0036000500de0036000200e1003b000000e1003c00ff00e10039000000e80039000100e5003c0000" +
  "00e60039000100e40039000300e3003a000200e2003c000200e1003d000100e0003a000200e3003d" +
  "000200e1003b000100e3003b000000e1003b000200e30038000300e3003a000300e50038000200e6" +
  "003c000200e5003c000100e6003b000100e4003e00ff00e3",
);

// ─── 1. Header timestamp (spec §6.1) ───────────────────────────────────────

describe("header timestamp (spec §6.1)", () => {
  it("timeRaw=32768 → tDevice == 1.0 sec exact", () => {
    const parser = new Parser();
    const batch: EegBatch = parser.parseEeg(eegPacket(32768, [[0, 0, 0]]));
    expect(batch.tDevice).toBeCloseTo(1.0, 12);
  });

  it("timeRaw=0 → tDevice == 0.0 sec", () => {
    const parser = new Parser();
    const batch: EegBatch = parser.parseEeg(eegPacket(0, [[0, 0, 0]]));
    expect(batch.tDevice).toBeCloseTo(0.0, 12);
  });
});

// ─── 2. EEG conversion (spec §7.1, §7.2) ──────────────────────────────────

describe("EEG conversion (spec §7.1, §7.2)", () => {
  it("ch1=1 → ch1Uv ≈ 0.04004 μV (LSB)", () => {
    const parser = new Parser();
    const batch = parser.parseEeg(eegPacket(0, [[0, 1, 0]]));
    expect(batch.ch1Raw[0]).toBe(1);
    expect(batch.ch1Uv[0]).toBeCloseTo(EEG_LSB_UV, 12);
    expect(batch.ch1Uv[0]).toBeCloseTo(0.04004, 3);
  });

  it("ch1=0x7FFFFF (max+) → ch1Uv ≈ +336,083 μV", () => {
    const parser = new Parser();
    const batch = parser.parseEeg(eegPacket(0, [[0, 0x7fffff, 0]]));
    expect(batch.ch1Raw[0]).toBe(0x7fffff);
    const expected = (0x7fffff * 4.033) / 12.0 / 8388607.0 * 1e6;
    expect(batch.ch1Uv[0]).toBeCloseTo(expected, 9);
  });

  it("0x80 0x00 0x00 → sign-extends to -8388608, ch1Uv < 0", () => {
    const parser = new Parser();
    const batch = parser.parseEeg(eegPacket(0, [[0, -8388608, 0]]));
    expect(batch.ch1Raw[0]).toBe(-8388608);
    const expected = (-8388608 * 4.033) / 12.0 / 8388607.0 * 1e6;
    expect(batch.ch1Uv[0]).toBeCloseTo(expected, 9);
    expect(batch.ch1Uv[0]).toBeLessThan(0);
  });

  it("leadOff=1 → leadOff[0]=true, leadOffRaw[0]=1, dtype Uint8Array", () => {
    const parser = new Parser();
    const batch = parser.parseEeg(eegPacket(0, [[1, 0, 0]]));
    expect(batch.leadOff[0]).toBe(true);
    expect(batch.leadOffRaw[0]).toBe(1);
    expect(batch.leadOffRaw).toBeInstanceOf(Uint8Array);
  });

  it("real EEG packet (179 B, 25 saturated samples)", () => {
    const parser = new Parser();
    expect(EEG_REAL_LINE1.byteLength).toBe(179);
    const batch = parser.parseEeg(EEG_REAL_LINE1);
    expect(batch.fs).toBe(500);
    expect(batch.ch1Raw.length).toBe(25);
    expect(batch.ch2Raw.length).toBe(25);
    expect(batch.leadOff.length).toBe(25);
    for (let i = 0; i < 25; i++) {
      expect(batch.ch1Raw[i]).toBe(0x7fffff);
      expect(batch.ch2Raw[i]).toBe(0x7fffff);
      expect(batch.leadOff[i]).toBe(false);
    }
    expect(batch.tDevice).toBeCloseTo(0x00072095 / 32768.0, 12);
  });
});

// ─── 3. PPG sign-extension trap (spec §8.1) ───────────────────────────────

describe("PPG sign-extension trap (spec §8.1)", () => {
  it("RED first byte ≥ 0x80 stays unsigned", () => {
    const batch1: PpgBatch = new Parser().parsePpg(ppgPacket(0, [[0xffffff, 0]]));
    expect(batch1.red[0]).toBe(0xffffff);
    expect(batch1.red[0]).toBeGreaterThanOrEqual(0);

    const batch2 = new Parser().parsePpg(ppgPacket(0, [[0x800000, 0]]));
    expect(batch2.red[0]).toBe(0x800000);
    expect(batch2.red[0]).toBeGreaterThanOrEqual(0);
  });

  it("real PPG packet (172 B, 28 samples, all non-negative)", () => {
    const parser = new Parser();
    expect(PPG_REAL_LINE1.byteLength).toBe(172);
    const batch = parser.parsePpg(PPG_REAL_LINE1);
    expect(batch.fs).toBe(50);
    expect(batch.red.length).toBe(28);
    expect(batch.ir.length).toBe(28);
    expect(batch.red[0]).toBe(0x004106);
    expect(batch.ir[0]).toBe(0x006032);
    for (const v of batch.red) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of batch.ir) expect(v).toBeGreaterThanOrEqual(0);
    expect(batch.tDevice).toBeCloseTo(0x0007a6fd / 32768.0, 12);
  });
});

// ─── 4. ACC 16-bit LE decoder (spec §9.1, §17 Q1) ──────────────────────────

describe("ACC 16-bit LE decoder (spec §9.1, §17 Q1)", () => {
  it("decodes per-axis 16-bit LE signed (LSB+MSB)", () => {
    const sample = new Uint8Array([0x10, 0x00, 0xff, 0xff, 0x00, 0x80]);
    const [x, y, z] = _decodeAccSample(sample);
    expect([x, y, z]).toEqual([16, -1, -32768]);
  });

  it("byte 0 (LSB) and byte 1 (MSB) both contribute (Kotlin LSB-skip regression guard)", () => {
    const sLsb = new Uint8Array([0x42, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const sMsb = new Uint8Array([0x00, 0x42, 0x00, 0x00, 0x00, 0x00]);
    expect(_decodeAccSample(sLsb)[0]).toBe(0x42); // 66
    expect(_decodeAccSample(sMsb)[0]).toBe(0x4200); // 16896
  });

  it("real ACC packet (184 B, 30 samples, ~1g magnitude)", () => {
    const parser = new Parser();
    expect(ACC_REAL_LINE1.byteLength).toBe(184);
    const batch: AccBatch = parser.parseAcc(ACC_REAL_LINE1);
    expect(batch.fs).toBe(25);
    expect(batch.x.length).toBe(30);
    expect(batch.x).toBeInstanceOf(Int16Array);
    expect(batch.y).toBeInstanceOf(Int16Array);
    expect(batch.z).toBeInstanceOf(Int16Array);
    expect(batch.x[0]).toBe(14592);
    expect(batch.y[0]).toBe(1792);
    expect(batch.z[0]).toBe(-8192);
    const mag = Math.sqrt(batch.x[0] ** 2 + batch.y[0] ** 2 + batch.z[0] ** 2);
    expect(mag).toBeGreaterThan(15000);
    expect(mag).toBeLessThan(18000);
    expect(batch.tDevice).toBeCloseTo(0x0007b6a5 / 32768.0, 12);
  });
});

// ─── 5. Battery (spec §11) ─────────────────────────────────────────────────

describe("Battery (spec §11)", () => {
  it("0x57 → level=87, tRecv ≈ now", () => {
    const before = Date.now() / 1000;
    const status: BatteryStatus = parseBattery(new Uint8Array([0x57]));
    const after = Date.now() / 1000;
    expect(status.level).toBe(87);
    expect(status.tRecv).toBeGreaterThanOrEqual(before);
    expect(status.tRecv).toBeLessThanOrEqual(after);
  });
});

// ─── 6. EEG timestamp continuity (spec §13) ────────────────────────────────

describe("EEG timestamp continuity (spec §13)", () => {
  it("packet2.tDevice == packet1.last + 1/500 = 25/500", () => {
    const parser = new Parser();
    const samples1: Array<[number, number, number]> = [];
    for (let i = 0; i < 25; i++) samples1.push([0, i, 0]);
    const batch1 = parser.parseEeg(eegPacket(0, samples1));
    expect(batch1.tDevice).toBeCloseTo(0.0, 12);

    const samples2: Array<[number, number, number]> = [];
    for (let i = 0; i < 25; i++) samples2.push([0, i, 0]);
    const batch2 = parser.parseEeg(eegPacket(99999, samples2));
    expect(batch2.tDevice).toBeCloseTo(25.0 / 500.0, 9);
  });

  it("resetEegTimestamps re-initializes from header", () => {
    const parser = new Parser();
    const samples: Array<[number, number, number]> = [];
    for (let i = 0; i < 25; i++) samples.push([0, 0, 0]);
    parser.parseEeg(eegPacket(0, samples));
    parser.resetEegTimestamps();
    const batch = parser.parseEeg(eegPacket(32768, samples));
    expect(batch.tDevice).toBeCloseTo(1.0, 12);
  });
});
