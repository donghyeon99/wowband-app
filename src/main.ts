// Link Band frontend — scan/connect via Web Bluetooth, parse incoming BLE
// notifications via `linkband/parser.ts`, and render decoded values per sensor.
//
// Activation sequence mirrors spec §5.1: Battery notify first → EEG `start`
// write → 1s wait → EEG/ACC/PPG notify in queue order. Same as the Python
// `reference-py/linkband/spike_dump.py` reference.
//
// `on{Eeg,Ppg,Acc,Bat}Bytes` are the single processing path — both live BLE
// handlers and (next milestone) replay funnel through them, so any logic
// lives once and works for both sources.

import { Parser, parseBattery } from "./linkband/parser";
import {
  ACC_NOTIFY,
  ACC_SERVICE,
  BATTERY_NOTIFY,
  BATTERY_SERVICE,
  EEG_NOTIFY,
  EEG_SERVICE,
  EEG_WRITE,
  PPG_NOTIFY,
  PPG_SERVICE,
} from "./uuids";

type Sensor = "eeg" | "ppg" | "acc" | "bat";

const counters: Record<Sensor, { packets: number; bytes: number }> = {
  eeg: { packets: 0, bytes: 0 },
  ppg: { packets: 0, bytes: 0 },
  acc: { packets: 0, bytes: 0 },
  bat: { packets: 0, bytes: 0 },
};

const parser = new Parser();

function setStatus(text: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

function bumpCounter(sensor: Sensor, byteLength: number): void {
  counters[sensor].packets += 1;
  counters[sensor].bytes += byteLength;
  const row = document.getElementById(`row-${sensor}`);
  if (!row) return;
  row.querySelector(".pkt")!.textContent = String(counters[sensor].packets);
  row.querySelector(".byt")!.textContent = String(counters[sensor].bytes);
}

function setDetail(sensor: Sensor, text: string): void {
  const el = document.querySelector(`#row-${sensor} .detail`);
  if (el) el.textContent = text;
}

// ─── EEG ch1 ring buffer + canvas ──────────────────────────────────────────
// 마지막 EEG_BUFFER_MAX 샘플(=4s @ 500Hz) 만 유지하는 가벼운 ring buffer.
// requestAnimationFrame 루프에서 폴리라인 한 줄로 그린다. 차트 라이브러리 X.
const EEG_BUFFER_MAX = 2000;
const EEG_Y_MIN = -300; // μV
const EEG_Y_MAX = 300;
const eegBuffer: number[] = [];

function pushEegSamples(samples: Float64Array): void {
  for (const v of samples) eegBuffer.push(v);
  if (eegBuffer.length > EEG_BUFFER_MAX) {
    eegBuffer.splice(0, eegBuffer.length - EEG_BUFFER_MAX);
  }
}

function drawEeg(): void {
  const canvas = document.getElementById("eeg-chart") as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const yRange = EEG_Y_MAX - EEG_Y_MIN;

  ctx.clearRect(0, 0, w, h);

  // 0 μV reference line.
  ctx.strokeStyle = "#ddd";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const yMid = h - ((0 - EEG_Y_MIN) / yRange) * h;
  ctx.moveTo(0, yMid);
  ctx.lineTo(w, yMid);
  ctx.stroke();

  if (eegBuffer.length === 0) return;

  ctx.strokeStyle = "#0070f3";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < eegBuffer.length; i++) {
    const x = (i / EEG_BUFFER_MAX) * w;
    // saturated 샘플(±336,083 μV)이 캔버스 밖으로 나가 안 보이는 걸 막기 위해 clamp.
    const clamped = Math.max(EEG_Y_MIN, Math.min(EEG_Y_MAX, eegBuffer[i]));
    const y = h - ((clamped - EEG_Y_MIN) / yRange) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function chartLoop(): void {
  drawEeg();
  requestAnimationFrame(chartLoop);
}
requestAnimationFrame(chartLoop);

function onEegBytes(data: Uint8Array): void {
  bumpCounter("eeg", data.byteLength);
  const batch = parser.parseEeg(data);
  pushEegSamples(batch.ch1Uv);
  const last = batch.ch1Uv.length - 1;
  if (last < 0) return;
  setDetail(
    "eeg",
    `ch1=${batch.ch1Uv[last].toFixed(1)}μV  ch2=${batch.ch2Uv[last].toFixed(1)}μV  leadOff=${
      batch.leadOff[last] ? "Y" : "N"
    }  t=${batch.tDevice.toFixed(2)}s`,
  );
}

function onPpgBytes(data: Uint8Array): void {
  bumpCounter("ppg", data.byteLength);
  const batch = parser.parsePpg(data);
  const last = batch.red.length - 1;
  if (last < 0) return;
  setDetail("ppg", `RED=${batch.red[last]}  IR=${batch.ir[last]}`);
}

function onAccBytes(data: Uint8Array): void {
  bumpCounter("acc", data.byteLength);
  const batch = parser.parseAcc(data);
  const last = batch.x.length - 1;
  if (last < 0) return;
  setDetail("acc", `x=${batch.x[last]}  y=${batch.y[last]}  z=${batch.z[last]}`);
}

function onBatBytes(data: Uint8Array): void {
  bumpCounter("bat", data.byteLength);
  const status = parseBattery(data);
  setDetail("bat", `level=${status.level}%`);
}

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

async function connect(): Promise<void> {
  setStatus("requesting device …");
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: "LXB-" }],
    optionalServices: [EEG_SERVICE, PPG_SERVICE, ACC_SERVICE, BATTERY_SERVICE],
  });

  setStatus(`connecting to ${device.name ?? "?"} …`);
  if (!device.gatt) throw new Error("no GATT server on device");
  const server = await device.gatt.connect();

  device.addEventListener("gattserverdisconnected", () => {
    setStatus("disconnected");
    // BLE 재연결 시 보간 시각 리셋 (spec §13).
    parser.resetEegTimestamps();
    parser.resetPpgTimestamps();
    parser.resetAccTimestamps();
  });

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
}

document.getElementById("connect")?.addEventListener("click", () => {
  connect().catch((err: unknown) => {
    console.error(err);
    setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
  });
});

// ─── Replay (디바이스 없이 동작 검증) ─────────────────────────────────────
// reference-py/tests/fixtures/real{1,}/{eeg,ppg,acc}.txt 의 dump 를 fetch 후
// on*Bytes 파이프라인에 흘려보낸다 — 라이브 BLE 와 같은 경로.

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

async function probeFixtureRoot(): Promise<string | null> {
  // 사용자 spec: real1/ 우선, 없으면 real/. 둘 다 없으면 null.
  for (const root of [
    "/reference-py/tests/fixtures/real1",
    "/reference-py/tests/fixtures/real",
  ]) {
    const probe = await fetch(`${root}/eeg.txt`).catch(() => null);
    if (probe?.ok) return root;
  }
  return null;
}

async function replay(): Promise<void> {
  setStatus("locating fixtures …");
  const root = await probeFixtureRoot();
  if (!root) {
    setStatus("error: fixture root not reachable (try `npm run dev`)");
    return;
  }
  setStatus(`replaying from ${root} …`);
  // EEG/PPG/ACC 동시 — 각자 자기 cadence 로. Promise.all 로 모두 끝나면 done.
  await Promise.all([
    replayStream(`${root}/eeg.txt`, onEegBytes, 50),
    replayStream(`${root}/ppg.txt`, onPpgBytes, 560),
    replayStream(`${root}/acc.txt`, onAccBytes, 1200),
  ]);
  setStatus("replay done");
}

document.getElementById("replay")?.addEventListener("click", () => {
  replay().catch((err: unknown) => {
    console.error(err);
    setStatus(`replay error: ${err instanceof Error ? err.message : String(err)}`);
  });
});
