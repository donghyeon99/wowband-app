/**
 * PPG view — sensor-dashboard `PPGVisualizer.tsx` + `PPGMetricsCards.tsx` 의 레이아웃.
 *
 * 구조 (DSP active):
 *   1. Hero card        — "💓 PPG Pulse Analysis" + 설명
 *   2. 2-col Row        — Filtered PPG Signal | PPG SQI (실 차트)
 *   3. Full-width       — 💓 BPM Trend (실 차트, ~60s 윈도우)
 *   4. Full-width       — 💓 HRV Metrics (14 cards 4-4-3-3 grid, hover tooltip)
 *      활성 8: HR / HR Max / HR Min / SDNN / RMSSD / SDSD / AVNN / PNN50 / PNN20
 *              (PNN20 포함 9개지만 deployed grid 그대로 두고 분류)
 *      placeholder 6: SpO2 / Stress / LF / HF / LF/HF / (no DSP wire 아직)
 *
 * Filter chain: bandpass 1-5Hz @ 50Hz. Peak detection: local 0.5s adaptive +
 * 5-pt shape. RR-base HRV.
 *
 * 외부 인터페이스:
 *     const view = createPpgView(container)
 *     view.onBatch(ppgBatch)
 *     view.resize()
 *     view.dispose()
 */
import {
  type PpgChannelFilter,
  calculatePpgSqi,
  computeHeartRate,
  computeHrvMetrics,
  createPpgChannelFilter,
  detectPpgPeaks,
  peaksToRrSeconds,
  processPpgSample,
} from "../linkband/dsp";
import { PPG_FS, type PpgBatch } from "../linkband/models";
import { ppgIndexThresholds } from "../linkband/thresholds";
import {
  type ChartHandle,
  buildMultiLineOption,
  buildRealtimeLineOption,
  createChart,
} from "./chart";
import { createIndexCard, type IndexCardHandle } from "./index-card";
import { chartColors, uiColors } from "./theme";

const PPG_BUFFER_SIZE = 400; // ~8s @ 50Hz
const PPG_WINDOW_SEC = PPG_BUFFER_SIZE / PPG_FS; // = 8
const BPM_HISTORY_SIZE = 100; // ~56s @ 1 batch/0.56s
const BPM_WINDOW_SEC = 60;
const STYLE_ID = "ppg-view-style";

export interface PpgViewHandle {
  onBatch(batch: PpgBatch): void;
  resize(): void;
  dispose(): void;
}

// ─── Style injection ──────────────────────────────────────────────────────
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    .ppg-grid-2col {
      display: grid;
      grid-template-columns: 1fr;
      gap: 1.25rem;
      margin-bottom: 1.5rem;
    }
    @media (min-width: 1024px) {
      .ppg-grid-2col { grid-template-columns: 1fr 1fr; }
    }
    .ppg-metrics-grid-4 {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.85rem;
      margin-bottom: 0.85rem;
    }
    @media (min-width: 768px) {
      .ppg-metrics-grid-4 { grid-template-columns: repeat(4, 1fr); }
    }
    .ppg-metrics-grid-3 {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.85rem;
      margin-bottom: 0.85rem;
    }
    @media (min-width: 768px) {
      .ppg-metrics-grid-3 { grid-template-columns: repeat(3, 1fr); }
    }
    .ppg-metrics-grid-3:last-child { margin-bottom: 0; }
  `;
  document.head.appendChild(s);
}

// ─── DOM helpers ──────────────────────────────────────────────────────────
function makeCard(): HTMLElement {
  const card = document.createElement("div");
  card.style.cssText = `
    background: ${uiColors.bgSection};
    border: 1px solid ${uiColors.border};
    border-radius: 8px;
    padding: 1.25rem;
  `;
  return card;
}

function makeCardTitle(text: string, level: 2 | 3 = 3): HTMLElement {
  const h = document.createElement(level === 2 ? "h2" : "h3");
  h.textContent = text;
  h.style.cssText = `
    margin: 0 0 0.4rem 0;
    font-size: ${level === 2 ? "1.15rem" : "1rem"};
    font-weight: ${level === 2 ? "700" : "600"};
    color: ${uiColors.textPrimary};
  `;
  return h;
}

function makeCardDesc(text: string): HTMLElement {
  const p = document.createElement("p");
  p.textContent = text;
  p.style.cssText = `margin: 0 0 0.85rem 0; font-size: 0.85rem; color: ${uiColors.textSecondary};`;
  return p;
}

function makeBanner(text: string): HTMLElement {
  const b = document.createElement("div");
  b.style.cssText = `
    display: none;
    background: ${chartColors.warnBg};
    border: 1px solid ${chartColors.warnBorder};
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.75rem;
    color: #fca5a5;
    font-size: 0.85rem;
  `;
  b.textContent = text;
  return b;
}

// ─── createPpgView ────────────────────────────────────────────────────────

export function createPpgView(container: HTMLElement): PpgViewHandle {
  ensureStyles();

  const root = document.createElement("section");
  root.className = "ppg-view-root";

  // (1) Hero.
  const hero = makeCard();
  hero.appendChild(makeCardTitle("💓 PPG Pulse Analysis", 2));
  const heroSub = document.createElement("p");
  heroSub.textContent =
    "Real-time photoplethysmography signal processing and heart-rate variability visualization.";
  heroSub.style.cssText = `margin: 0; font-size: 0.9rem; color: ${uiColors.textSecondary};`;
  hero.appendChild(heroSub);
  hero.style.marginBottom = "1.5rem";
  root.appendChild(hero);

  // (2) 2-col row: Filtered | SQI.
  const row = document.createElement("div");
  row.className = "ppg-grid-2col";

  // ── Filtered card ───────────────────────────────────────────────────────
  const filteredCard = makeCard();
  filteredCard.appendChild(makeCardTitle("🔧 Filtered PPG Signal"));
  filteredCard.appendChild(
    makeCardDesc(
      "Red/IR LED signals through 0.5-5.0Hz bandpass (DC removed, heartbeat band).",
    ),
  );
  // PPG LeadOff banner — DOM only (parser 가 PPG 별도 lead-off 정보 없음).
  const leadOffBanner = makeBanner(
    "⚠ PPG sensor contact issue — signal quality may be degraded",
  );
  filteredCard.appendChild(leadOffBanner);
  const filteredHost = document.createElement("div");
  filteredHost.style.cssText = "width: 100%; height: 220px;";
  filteredCard.appendChild(filteredHost);
  row.appendChild(filteredCard);

  // ── SQI card (real chart) ───────────────────────────────────────────────
  const sqiCard = makeCard();
  sqiCard.appendChild(makeCardTitle("📈 PPG Signal Quality Index (SQI)"));
  sqiCard.appendChild(
    makeCardDesc(
      "Filtered PPG amplitude-based SQI (25-sample window, threshold 250).",
    ),
  );
  const sqiHost = document.createElement("div");
  sqiHost.style.cssText = "width: 100%; height: 220px;";
  sqiCard.appendChild(sqiHost);
  row.appendChild(sqiCard);

  root.appendChild(row);

  // (3) BPM Trend (full-width).
  const bpmTrendCard = makeCard();
  bpmTrendCard.appendChild(makeCardTitle("💓 BPM Trend"));
  bpmTrendCard.appendChild(
    makeCardDesc("Heart rate over time — derived from peak detection on filtered IR signal."),
  );
  const bpmTrendHost = document.createElement("div");
  bpmTrendHost.style.cssText = "width: 100%; height: 200px;";
  bpmTrendCard.appendChild(bpmTrendHost);
  bpmTrendCard.style.marginBottom = "1.5rem";
  root.appendChild(bpmTrendCard);

  // (4) HRV Metrics (full-width).
  const metricsCard = makeCard();
  metricsCard.appendChild(makeCardTitle("💓 Heart Rate Variability Metrics"));
  metricsCard.appendChild(
    makeCardDesc(
      "RR-based HRV + HR metrics. 카드 hover 시 산식 / 정상 범위 / 해석 / 학술 reference 표시. " +
        "SpO₂ / Stress / LF / HF / LF-HF 는 DSP 미구현 — placeholder (No data).",
    ),
  );
  // sensor-dashboard `PPGMetricsCards.tsx` 동일: 4-4-3-3 grid. 첫 두 행 4-col,
  // 마지막 두 행 3-col. 각 카드는 threshold-driven rich card + hover tooltip.
  const grid4a = document.createElement("div");
  grid4a.className = "ppg-metrics-grid-4";
  metricsCard.appendChild(grid4a);
  const grid4b = document.createElement("div");
  grid4b.className = "ppg-metrics-grid-4";
  metricsCard.appendChild(grid4b);
  const grid3a = document.createElement("div");
  grid3a.className = "ppg-metrics-grid-3";
  metricsCard.appendChild(grid3a);
  const grid3b = document.createElement("div");
  grid3b.className = "ppg-metrics-grid-3";
  metricsCard.appendChild(grid3b);
  root.appendChild(metricsCard);

  container.appendChild(root);

  // 14 metric cards (sensor-dashboard `PPGMetricsCards.tsx` 동일 순서).
  // 활성 (DSP wired): bpm, hrMax, hrMin, sdnn, rmssd, sdsd, avnn, pnn50, pnn20.
  // Placeholder (DSP 미구현 — null 유지): spo2, ppgStressIndex, lfPower, hfPower, lfHfRatio.
  const m = {
    // Row 1 (4-col): HR / SpO2 / HR Max / HR Min.
    bpm: createIndexCard(grid4a, { threshold: ppgIndexThresholds.bpm, decimals: 0, requirePositive: true }),
    spo2: createIndexCard(grid4a, { threshold: ppgIndexThresholds.spo2, decimals: 1 }),
    hrMax: createIndexCard(grid4a, { threshold: ppgIndexThresholds.hrMax, decimals: 0 }),
    hrMin: createIndexCard(grid4a, { threshold: ppgIndexThresholds.hrMin, decimals: 0 }),
    // Row 2 (4-col): Stress / RMSSD / SDNN / SDSD.
    ppgStressIndex: createIndexCard(grid4b, { threshold: ppgIndexThresholds.ppgStressIndex, decimals: 2 }),
    rmssd: createIndexCard(grid4b, { threshold: ppgIndexThresholds.rmssd, decimals: 1 }),
    sdnn: createIndexCard(grid4b, { threshold: ppgIndexThresholds.sdnn, decimals: 1 }),
    sdsd: createIndexCard(grid4b, { threshold: ppgIndexThresholds.sdsd, decimals: 1 }),
    // Row 3 (3-col): LF / HF / LF-HF.
    lfPower: createIndexCard(grid3a, { threshold: ppgIndexThresholds.lfPower, decimals: 1 }),
    hfPower: createIndexCard(grid3a, { threshold: ppgIndexThresholds.hfPower, decimals: 1 }),
    lfHfRatio: createIndexCard(grid3a, { threshold: ppgIndexThresholds.lfHfRatio, decimals: 2 }),
    // Row 4 (3-col): AVNN / PNN50 / PNN20.
    avnn: createIndexCard(grid3b, { threshold: ppgIndexThresholds.avnn, decimals: 1 }),
    pnn50: createIndexCard(grid3b, { threshold: ppgIndexThresholds.pnn50, decimals: 1 }),
    pnn20: createIndexCard(grid3b, { threshold: ppgIndexThresholds.pnn20, decimals: 1 }),
  } as const satisfies Record<string, IndexCardHandle>;
  for (const c of Object.values(m)) c.update(null);

  // ─── Charts ──────────────────────────────────────────────────────────────
  const filteredChart: ChartHandle = createChart(
    filteredHost,
    buildMultiLineOption({
      series: [
        { name: "IR", color: chartColors.ir },
        { name: "Red", color: chartColors.red },
      ],
      yName: "filtered",
      yMin: -250,
      yMax: 250,
      yNameGap: 50,
      tooltipFormatter: (params: unknown) => {
        const arr = params as Array<{ seriesName: string; value: [number, number] }>;
        if (!Array.isArray(arr) || arr.length === 0) return "";
        const t = arr[0]?.value?.[0] ?? 0;
        const lines = [`t = ${t.toFixed(2)}s`];
        for (const p of arr) lines.push(`${p.seriesName}: ${p.value[1].toFixed(1)}`);
        return lines.join("<br/>");
      },
    }),
  );

  const sqiChart: ChartHandle = createChart(
    sqiHost,
    buildRealtimeLineOption({
      color: chartColors.magnitude,
      yName: "SQI %",
      yMin: 0,
      yMax: 100,
      yNameGap: 40,
      area: true,
      tooltipFormatter: (params: unknown) => {
        const arr = params as Array<{ value: [number, number] }>;
        if (!Array.isArray(arr) || arr.length === 0) return "";
        const t = arr[0]?.value?.[0] ?? 0;
        const v = arr[0]?.value?.[1] ?? 0;
        return `t = ${t.toFixed(2)}s<br/>SQI: ${v.toFixed(0)}%`;
      },
    }),
  );

  const bpmTrendChart: ChartHandle = createChart(
    bpmTrendHost,
    buildRealtimeLineOption({
      color: chartColors.bpm,
      yName: "BPM",
      yMin: 40,
      yMax: 160,
      yNameGap: 40,
      smooth: true,
      tooltipFormatter: (params: unknown) => {
        const arr = params as Array<{ value: [number, number] }>;
        if (!Array.isArray(arr) || arr.length === 0) return "";
        const t = arr[0]?.value?.[0] ?? 0;
        const v = arr[0]?.value?.[1] ?? 0;
        return `t = ${t.toFixed(1)}s<br/>BPM: ${v.toFixed(0)}`;
      },
    }),
  );

  // ─── State (filters + buffers) ──────────────────────────────────────────
  const filterIr: PpgChannelFilter = createPpgChannelFilter();
  const filterRed: PpgChannelFilter = createPpgChannelFilter();

  const irBuf: number[] = []; // filtered IR
  const redBuf: number[] = []; // filtered Red
  const sqiBuf: number[] = []; // PPG SQI %
  const bpmHistoryBuf: number[] = []; // BPM trend (one entry per batch)

  function pushAndTrim<T>(buf: T[], v: T, max: number): void {
    buf.push(v);
    if (buf.length > max) buf.splice(0, buf.length - max);
  }

  return {
    onBatch(batch: PpgBatch): void {
      // 샘플별 filter cascade 적용 — filtered IR/Red 만 buffer 에 push.
      const filteredIr: number[] = new Array(batch.ir.length);
      const filteredRed: number[] = new Array(batch.red.length);
      for (let i = 0; i < batch.ir.length; i++) {
        const fi = processPpgSample(filterIr, batch.ir[i]);
        const fr = processPpgSample(filterRed, batch.red[i]);
        filteredIr[i] = fi;
        filteredRed[i] = fr;
        pushAndTrim(irBuf, fi, PPG_BUFFER_SIZE);
        pushAndTrim(redBuf, fr, PPG_BUFFER_SIZE);
      }

      const fs = batch.fs;
      const irLast = Math.max(irBuf.length - 1, 0);
      const redLast = Math.max(redBuf.length - 1, 0);

      // Filtered chart 갱신 (newest = t=0, fixed window).
      const irData: Array<[number, number]> = irBuf.map((v, i) => [(i - irLast) / fs, v]);
      const redData: Array<[number, number]> = redBuf.map((v, i) => [(i - redLast) / fs, v]);
      filteredChart.chart.setOption({
        xAxis: { min: -PPG_WINDOW_SEC, max: 0 },
        series: [{ data: irData }, { data: redData }],
      });

      // SQI: filtered IR 기준 (sensor-dashboard 와 동일). 마지막 batch 길이만큼 append.
      const sqi = calculatePpgSqi(irBuf);
      const newCount = batch.ir.length;
      for (const v of sqi.slice(-newCount)) pushAndTrim(sqiBuf, v, PPG_BUFFER_SIZE);
      const sqiLast = Math.max(sqiBuf.length - 1, 0);
      const sqiData: Array<[number, number]> = sqiBuf.map((v, i) => [(i - sqiLast) / fs, v]);
      sqiChart.chart.setOption({
        xAxis: { min: -PPG_WINDOW_SEC, max: 0 },
        series: [{ data: sqiData }],
      });

      // Peak detection on filtered IR → RR seconds → HRV/HR.
      const peaks = detectPpgPeaks(irBuf, fs);
      const rrSeconds = peaksToRrSeconds(peaks, fs);
      const rrMs = rrSeconds.map((s) => s * 1000);

      // 활성 9 metric cards 갱신 — RR ≥ 1 일 때 의미 있는 값.
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
        // 1 entry per ~0.56s — 시간축은 -BPM_WINDOW_SEC..0.
        const bpmData: Array<[number, number]> = bpmHistoryBuf.map((v, i) => {
          const dt = (i - bpmLast) * (PPG_BUFFER_SIZE / fs / batch.ir.length); // batch interval ≈ 0.56s
          return [dt, v];
        });
        bpmTrendChart.chart.setOption({
          xAxis: { min: -BPM_WINDOW_SEC, max: 0 },
          series: [{ data: bpmData }],
        });
      }
      // Placeholder cards — DSP 미구현 (spo2 / ppgStressIndex / lfPower /
      // hfPower / lfHfRatio). null 유지하면 카드는 "No data" 로 표시되고,
      // hover 시 산식 / 정상 범위 / 해석 tooltip 은 정상 노출.
    },
    resize(): void {
      filteredChart.chart.resize();
      sqiChart.chart.resize();
      bpmTrendChart.chart.resize();
    },
    dispose(): void {
      filteredChart.dispose();
      sqiChart.dispose();
      bpmTrendChart.dispose();
      root.remove();
    },
  };
}
