/**
 * EEG view — sensor-dashboard `EEGVisualizer.tsx` 의 전체 레이아웃을 vanilla TS 로 미러링.
 *
 * 구조 (sensor-dashboard 동일, DSP wired):
 *   1. Hero card        — "🧠 EEG Brain Wave Analysis" + 설명
 *   2. 2-col Row        — Ch1 Filtered (FP1) | Ch2 Filtered (FP2). 각 카드 안:
 *                          h3 + 설명 + LeadOff banner + Saturated banner + Filtered chart
 *   3. 2-col Row        — Ch1 SQI | Ch2 SQI (SQI 0-100% 라인 차트)
 *   4. 2-col Row        — Power Spectrum (DFT) | Band Power cards (Δ/θ/α/β/γ)
 *   5. Full-width       — EEG Analysis Indices (7 cards: focus/relaxation/stress 등)
 *
 * Filter chain: notch 60Hz → HP 1Hz → LP 45Hz (sensor-dashboard `eegPipeline.ts` 와 동일,
 * fs=500Hz 로 갱신). 1초 transient 동안 차트 0 표시.
 *
 * 외부 인터페이스:
 *     const view = createEegView(container)
 *     view.onBatch(eegBatch)
 *     view.resize()
 *     view.dispose()
 */
import {
  type EegChannelFilter,
  EEG_BANDS,
  calculateEegSqi,
  computeEegIndices,
  computeEegPower,
  computeSpectrum,
  createEegChannelFilter,
  processEegSample,
} from "../linkband/dsp";
import { EEG_FS, type EegBatch } from "../linkband/models";
import {
  type ChartHandle,
  buildMultiLineOption,
  buildRealtimeLineOption,
  createChart,
} from "./chart";
import { createMetricCard, type MetricCardHandle } from "./metric-card";
import { axisLabelStyle, chartColors, splitLineStyle, uiColors } from "./theme";

const EEG_BUFFER_SIZE = 2000; // ~4s @ 500Hz
const EEG_WINDOW_SEC = EEG_BUFFER_SIZE / EEG_FS; // = 4
const SATURATION_THRESHOLD_UV = 300_000;
const STYLE_ID = "eeg-view-style";

export interface EegViewHandle {
  onBatch(batch: EegBatch): void;
  resize(): void;
  dispose(): void;
}

// ─── Style injection ──────────────────────────────────────────────────────
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    .eeg-grid-2col {
      display: grid;
      grid-template-columns: 1fr;
      gap: 1.25rem;
      margin-bottom: 1.5rem;
    }
    @media (min-width: 1024px) {
      .eeg-grid-2col { grid-template-columns: 1fr 1fr; }
    }
    .eeg-card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 0.6rem;
    }
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

interface ChannelCard {
  card: HTMLElement;
  chartHost: HTMLElement;
  leadOffBanner: HTMLElement;
  saturatedBanner: HTMLElement;
}

function makeChannelCard(title: string, desc: string): ChannelCard {
  const card = makeCard();
  card.appendChild(makeCardTitle(title));
  card.appendChild(makeCardDesc(desc));
  const leadOffBanner = makeBanner(
    "⚠ Electrode contact issue (lead-off detected) — signal quality may be degraded",
  );
  const saturatedBanner = makeBanner(
    "⚠ Electrodes appear floating — saturated to reference voltage. Place band on head to see real EEG.",
  );
  card.appendChild(leadOffBanner);
  card.appendChild(saturatedBanner);
  const chartHost = document.createElement("div");
  chartHost.style.cssText = "width: 100%; height: 220px;";
  card.appendChild(chartHost);
  return { card, chartHost, leadOffBanner, saturatedBanner };
}

function buildFilteredChart(host: HTMLElement, color: string, label: string): ChartHandle {
  return createChart(
    host,
    buildRealtimeLineOption({
      color,
      yName: "μV",
      yMin: -150,
      yMax: 150,
      yNameGap: 50,
      tooltipFormatter: (params: unknown) => {
        const arr = params as Array<{ value: [number, number] }>;
        if (!Array.isArray(arr) || arr.length === 0) return "";
        const t = arr[0]?.value?.[0] ?? 0;
        const v = arr[0]?.value?.[1] ?? 0;
        return `t = ${t.toFixed(2)}s<br/>${label}: ${v.toFixed(2)} μV`;
      },
    }),
  );
}

function buildSqiChart(host: HTMLElement, label: string): ChartHandle {
  return createChart(
    host,
    buildRealtimeLineOption({
      color: chartColors.magnitude, // 노란색 — sensor-dashboard SQI 와 비슷한 톤
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
        return `t = ${t.toFixed(2)}s<br/>${label}: ${v.toFixed(0)}%`;
      },
    }),
  );
}

function buildSpectrumChart(host: HTMLElement): ChartHandle {
  const handle = createChart(
    host,
    buildMultiLineOption({
      series: [
        { name: "Ch1", color: chartColors.ch1Filtered, smooth: true },
        { name: "Ch2", color: chartColors.ch2Filtered, smooth: true },
      ],
      yName: "dB",
      yMin: -40,
      yMax: 60,
      yNameGap: 40,
      tooltipFormatter: (params: unknown) => {
        const arr = params as Array<{ seriesName: string; value: [number, number] }>;
        if (!Array.isArray(arr) || arr.length === 0) return "";
        const f = arr[0]?.value?.[0] ?? 0;
        const lines = [`${f}Hz`];
        for (const p of arr) lines.push(`${p.seriesName}: ${p.value[1].toFixed(1)} dB`);
        return lines.join("<br/>");
      },
    }),
  );
  // x-axis 를 시간 (s) → 주파수 (Hz) 로 override.
  handle.chart.setOption({
    xAxis: {
      type: "value",
      name: "Hz",
      nameLocation: "middle",
      nameGap: 25,
      min: 1,
      max: 45,
      axisLabel: { ...axisLabelStyle, formatter: (v: number) => `${v}` },
      splitLine: splitLineStyle,
    },
  });
  return handle;
}

// ─── createEegView ─────────────────────────────────────────────────────────

export function createEegView(container: HTMLElement): EegViewHandle {
  ensureStyles();

  const root = document.createElement("section");
  root.className = "eeg-view-root";

  // (1) Hero.
  const hero = makeCard();
  hero.appendChild(makeCardTitle("🧠 EEG Brain Wave Analysis", 2));
  const heroSub = document.createElement("p");
  heroSub.textContent = "Real-time EEG signal processing and analysis visualization.";
  heroSub.style.cssText = `margin: 0; font-size: 0.9rem; color: ${uiColors.textSecondary};`;
  hero.appendChild(heroSub);
  hero.style.marginBottom = "1.5rem";
  root.appendChild(hero);

  // (2) Ch1/Ch2 Filtered 2-col row.
  const row1 = document.createElement("div");
  row1.className = "eeg-grid-2col";
  const ch1 = makeChannelCard(
    "🔧 Ch1 Filtered EEG Signal (FP1)",
    "Channel 1 (FP1) — 60Hz notch + 1-45Hz bandpass filter (DSP active).",
  );
  const ch2 = makeChannelCard(
    "🔧 Ch2 Filtered EEG Signal (FP2)",
    "Channel 2 (FP2) — 60Hz notch + 1-45Hz bandpass filter (DSP active).",
  );
  row1.appendChild(ch1.card);
  row1.appendChild(ch2.card);
  root.appendChild(row1);

  // (3) SQI 2-col row (DSP active).
  const row2 = document.createElement("div");
  row2.className = "eeg-grid-2col";
  const sqi1Card = makeCard();
  sqi1Card.appendChild(makeCardTitle("📈 Ch1 Signal Quality Index (SQI)"));
  sqi1Card.appendChild(
    makeCardDesc(
      "70% amplitude + 30% frequency-variance score on filtered Ch1 (window 0.5s, threshold 150μV).",
    ),
  );
  const sqi1Host = document.createElement("div");
  sqi1Host.style.cssText = "width: 100%; height: 180px;";
  sqi1Card.appendChild(sqi1Host);
  row2.appendChild(sqi1Card);

  const sqi2Card = makeCard();
  sqi2Card.appendChild(makeCardTitle("📈 Ch2 Signal Quality Index (SQI)"));
  sqi2Card.appendChild(
    makeCardDesc(
      "70% amplitude + 30% frequency-variance score on filtered Ch2 (window 0.5s, threshold 150μV).",
    ),
  );
  const sqi2Host = document.createElement("div");
  sqi2Host.style.cssText = "width: 100%; height: 180px;";
  sqi2Card.appendChild(sqi2Host);
  row2.appendChild(sqi2Card);
  root.appendChild(row2);

  // (4) Power Spectrum + Band Power 2-col row.
  const row3 = document.createElement("div");
  row3.className = "eeg-grid-2col";
  const spectrumCard = makeCard();
  spectrumCard.appendChild(makeCardTitle("🌈 Power Spectrum (1-45Hz)"));
  spectrumCard.appendChild(
    makeCardDesc("Ch1, Ch2 frequency-domain EEG signal analysis (DFT, DC-removed)."),
  );
  const spectrumHost = document.createElement("div");
  spectrumHost.style.cssText = "width: 100%; height: 220px;";
  spectrumCard.appendChild(spectrumHost);
  row3.appendChild(spectrumCard);

  const bandCard = makeCard();
  bandCard.appendChild(makeCardTitle("🎯 Frequency Band Power"));
  bandCard.appendChild(
    makeCardDesc(
      "Real-time band-level power (Morlet wavelet on linkband-style filtered EEG, dB).",
    ),
  );
  const bandGrid = document.createElement("div");
  bandGrid.className = "eeg-card-grid";
  bandCard.appendChild(bandGrid);
  row3.appendChild(bandCard);
  root.appendChild(row3);

  // (5) Full-width Indices.
  const idxCard = makeCard();
  idxCard.appendChild(makeCardTitle("🧠 EEG Analysis Indices"));
  idxCard.appendChild(
    makeCardDesc(
      "Real-time EEG analysis — focus/relaxation/stress + 4 more (own derivation from band power; spec §17 미해결 — sensor-dashboard 의 외부 SDK 값과 numerical 차이 가능).",
    ),
  );
  const idxGrid = document.createElement("div");
  idxGrid.className = "eeg-card-grid";
  idxCard.appendChild(idxGrid);
  root.appendChild(idxCard);

  container.appendChild(root);

  // ─── Charts ──────────────────────────────────────────────────────────────
  const chart1 = buildFilteredChart(ch1.chartHost, chartColors.ch1Filtered, "Ch1 (FP1)");
  const chart2 = buildFilteredChart(ch2.chartHost, chartColors.ch2Filtered, "Ch2 (FP2)");
  const sqi1Chart = buildSqiChart(sqi1Host, "Ch1 SQI");
  const sqi2Chart = buildSqiChart(sqi2Host, "Ch2 SQI");
  const spectrumChart = buildSpectrumChart(spectrumHost);

  // ─── Band power + Indices cards ─────────────────────────────────────────
  const BAND_COLORS: Record<(typeof EEG_BANDS)[number]["key"], string> = {
    delta: "#8B4513",
    theta: "#FF8C00",
    alpha: "#32CD32",
    beta: "#1E90FF",
    gamma: "#9400D3",
  };
  const bandCards: Record<(typeof EEG_BANDS)[number]["key"], MetricCardHandle> = {
    delta: createMetricCard(bandGrid, { label: "Delta (1-4Hz)", unit: "dB", dotColor: BAND_COLORS.delta, decimals: 1 }),
    theta: createMetricCard(bandGrid, { label: "Theta (4-8Hz)", unit: "dB", dotColor: BAND_COLORS.theta, decimals: 1 }),
    alpha: createMetricCard(bandGrid, { label: "Alpha (8-13Hz)", unit: "dB", dotColor: BAND_COLORS.alpha, decimals: 1 }),
    beta: createMetricCard(bandGrid, { label: "Beta (13-30Hz)", unit: "dB", dotColor: BAND_COLORS.beta, decimals: 1 }),
    gamma: createMetricCard(bandGrid, { label: "Gamma (30-45Hz)", unit: "dB", dotColor: BAND_COLORS.gamma, decimals: 1 }),
  };

  const indexCards = {
    focusIndex: createMetricCard(idxGrid, { label: "Focus", unit: "dB", dotColor: "#3b82f6", decimals: 2 }),
    relaxationIndex: createMetricCard(idxGrid, { label: "Relaxation", unit: "dB", dotColor: "#10b981", decimals: 2 }),
    stressIndex: createMetricCard(idxGrid, { label: "Stress", unit: "dB", dotColor: "#ef4444", decimals: 2 }),
    cognitiveLoad: createMetricCard(idxGrid, { label: "Cognitive Load", unit: "dB", dotColor: "#a855f7", decimals: 2 }),
    hemisphericBalance: createMetricCard(idxGrid, { label: "Hemispheric Bal.", unit: "dB", dotColor: "#f59e0b", decimals: 2 }),
    emotionalStability: createMetricCard(idxGrid, { label: "Emotional Stab.", unit: "dB", dotColor: "#14b8a6", decimals: 2 }),
    totalPower: createMetricCard(idxGrid, { label: "Total Power", unit: "dB", dotColor: "#6b6b7e", decimals: 1 }),
  };

  // ─── State (filter + buffers) ────────────────────────────────────────────
  const filter1: EegChannelFilter = createEegChannelFilter();
  const filter2: EegChannelFilter = createEegChannelFilter();

  // ch1Buf / ch2Buf: filtered (chart + SQI 입력).
  // ch1RawBuf / ch2RawBuf: raw μV (spectrum + band power 입력 — sensor-dashboard 와 동일).
  const ch1Buf: number[] = [];
  const ch2Buf: number[] = [];
  const ch1RawBuf: number[] = [];
  const ch2RawBuf: number[] = [];
  const ch1SqiBuf: number[] = [];
  const ch2SqiBuf: number[] = [];

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

  return {
    onBatch(batch: EegBatch): void {
      // 샘플 별 filter cascade 적용 — raw 와 filtered 모두 buffer 에 push.
      const filtered1: number[] = new Array(batch.ch1Uv.length);
      const filtered2: number[] = new Array(batch.ch2Uv.length);
      for (let i = 0; i < batch.ch1Uv.length; i++) {
        const f1 = processEegSample(filter1, batch.ch1Uv[i]);
        const f2 = processEegSample(filter2, batch.ch2Uv[i]);
        filtered1[i] = f1;
        filtered2[i] = f2;
        pushAndTrim(ch1Buf, f1);
        pushAndTrim(ch2Buf, f2);
        pushAndTrim(ch1RawBuf, batch.ch1Uv[i]);
        pushAndTrim(ch2RawBuf, batch.ch2Uv[i]);
      }

      const fs = batch.fs;
      const ch1Last = Math.max(ch1Buf.length - 1, 0);
      const ch2Last = Math.max(ch2Buf.length - 1, 0);

      // LeadOff (parser 가 채널별 분리 정보 없음 — 양쪽 동일).
      const anyLeadOff = batch.leadOff.some((v) => v);
      ch1.leadOffBanner.style.display = anyLeadOff ? "block" : "none";
      ch2.leadOffBanner.style.display = anyLeadOff ? "block" : "none";

      // Saturated: filtered 신호 기준 — DSP 후 saturated raw 는 ~0 이라 자연 false.
      const ch1Sat = filtered1.every((v) => Math.abs(v) > SATURATION_THRESHOLD_UV);
      const ch2Sat = filtered2.every((v) => Math.abs(v) > SATURATION_THRESHOLD_UV);
      ch1.saturatedBanner.style.display = ch1Sat ? "block" : "none";
      ch2.saturatedBanner.style.display = ch2Sat ? "block" : "none";

      // Ch1/Ch2 filtered 차트 갱신.
      const ch1Data: Array<[number, number]> = ch1Buf.map((v, i) => [(i - ch1Last) / fs, v]);
      const ch2Data: Array<[number, number]> = ch2Buf.map((v, i) => [(i - ch2Last) / fs, v]);
      chart1.chart.setOption({
        xAxis: { min: -EEG_WINDOW_SEC, max: 0 },
        series: [{ data: ch1Data }],
      });
      chart2.chart.setOption({
        xAxis: { min: -EEG_WINDOW_SEC, max: 0 },
        series: [{ data: ch2Data }],
      });

      batchCount++;

      // SQI: 매 5 batches (250ms). 호출당 ~1M ops × 2 ch.
      if (batchCount % SQI_INTERVAL === 0) {
        const sqi1 = calculateEegSqi(ch1Buf);
        const sqi2 = calculateEegSqi(ch2Buf);
        // 누락 보정: throttle 동안의 batch (= newCount × SQI_INTERVAL) 개를 한꺼번에 append.
        const append = batch.ch1Uv.length * SQI_INTERVAL;
        for (const v of sqi1.slice(-append)) pushAndTrim(ch1SqiBuf, v);
        for (const v of sqi2.slice(-append)) pushAndTrim(ch2SqiBuf, v);
        const sqi1Last = Math.max(ch1SqiBuf.length - 1, 0);
        const sqi2Last = Math.max(ch2SqiBuf.length - 1, 0);
        const sqi1Data: Array<[number, number]> = ch1SqiBuf.map((v, i) => [(i - sqi1Last) / fs, v]);
        const sqi2Data: Array<[number, number]> = ch2SqiBuf.map((v, i) => [(i - sqi2Last) / fs, v]);
        sqi1Chart.chart.setOption({
          xAxis: { min: -EEG_WINDOW_SEC, max: 0 },
          series: [{ data: sqi1Data }],
        });
        sqi2Chart.chart.setOption({
          xAxis: { min: -EEG_WINDOW_SEC, max: 0 },
          series: [{ data: sqi2Data }],
        });
      }

      // Power spectrum: 매 5 batches (250ms). DFT 호출당 ~45k ops × 2 ch (가벼우나 그래도 throttle).
      if (batchCount % SPECTRUM_INTERVAL === 0) {
        const ch1Spec = computeSpectrum(ch1RawBuf, fs, 1, 45);
        const ch2Spec = computeSpectrum(ch2RawBuf, fs, 1, 45);
        if (ch1Spec.length > 0 || ch2Spec.length > 0) {
          spectrumChart.chart.setOption({
            series: [{ data: ch1Spec }, { data: ch2Spec }],
          });
        }
      }

      // Band power + Indices: 매 10 batches (500ms). Morlet wavelet × 5 bands × 2 ch
      // ≈ 7M ops/call — 가장 무거움. 매 batch (20Hz) 호출 시 ~140M ops/sec 로 stall.
      if (batchCount % POWER_INTERVAL === 0) {
        const power = computeEegPower(ch1RawBuf, ch2RawBuf, fs);
        if (power) {
          for (const band of EEG_BANDS) {
            const avg = (power.bands[band.key].ch1Db + power.bands[band.key].ch2Db) / 2;
            bandCards[band.key].update(avg);
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
    },
    resize(): void {
      chart1.chart.resize();
      chart2.chart.resize();
      sqi1Chart.chart.resize();
      sqi2Chart.chart.resize();
      spectrumChart.chart.resize();
    },
    dispose(): void {
      chart1.dispose();
      chart2.dispose();
      sqi1Chart.dispose();
      sqi2Chart.dispose();
      spectrumChart.dispose();
      root.remove();
    },
  };
}
