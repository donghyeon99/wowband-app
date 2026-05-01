/**
 * PPG view — sensor-dashboard `PPGVisualizer.tsx` 의 모든 패널 미러링.
 *
 * 패널 구성:
 *   1. LeadOff banner (PPGLeadOffBanner)
 *   2. Raw IR/RED chart (sensor-dashboard 에 없음 — DSP 없는 우리 케이스용)
 *   3. Filtered chart placeholder (PPGFilteredChart — DSP 필요)
 *   4. BPM trend placeholder (PPGBpmTrendChart — DSP 필요)
 *   5. MetricsCards 14개 (PPGMetricsCards — 모두 placeholder 값)
 *
 * placeholder 패널들은 차트를 init 하지 않고 dashed border + 안내 텍스트.
 * DSP 단계에서 동일 컨테이너에 차트를 init 하면 됨.
 */
import type { PpgBatch } from "../linkband/models";
import { type ChartHandle, buildMultiLineOption, createChart } from "./chart";
import { createMetricCard, type MetricCardHandle } from "./metric-card";
import { chartColors, uiColors } from "./theme";

const PPG_BUFFER_SIZE = 400; // ~8s @ 50Hz (sensor-dashboard PPG_BUFFER_SIZE 동일)

export interface PpgViewHandle {
  onBatch(batch: PpgBatch): void;
  dispose(): void;
}

function makeSection(): HTMLElement {
  const s = document.createElement("section");
  s.style.cssText = `
    background: ${uiColors.bgSection};
    border: 1px solid ${uiColors.border};
    border-radius: 8px;
    padding: 1.25rem;
    margin-bottom: 1.5rem;
  `;
  return s;
}

function makeSubpanel(title: string, description: string): HTMLElement {
  const panel = document.createElement("div");
  panel.style.cssText = `
    background: ${uiColors.bgElevated};
    border: 1px solid ${uiColors.border};
    border-radius: 6px;
    padding: 1rem;
    margin-bottom: 1rem;
  `;
  const h3 = document.createElement("h3");
  h3.textContent = title;
  h3.style.cssText = `margin: 0 0 0.25rem 0; font-size: 1rem; font-weight: 600; color: ${uiColors.textPrimary};`;
  panel.appendChild(h3);
  const p = document.createElement("p");
  p.textContent = description;
  p.style.cssText = `margin: 0 0 0.75rem 0; font-size: 0.8rem; color: ${uiColors.textSecondary};`;
  panel.appendChild(p);
  return panel;
}

function makePlaceholder(label: string, height: string): HTMLElement {
  const ph = document.createElement("div");
  ph.style.cssText = `
    width: 100%;
    height: ${height};
    display: flex;
    align-items: center;
    justify-content: center;
    background: ${uiColors.bgBase};
    border: 1px dashed ${uiColors.border};
    border-radius: 6px;
    color: ${uiColors.textMuted};
    font-size: 0.85rem;
    text-align: center;
    padding: 0 1rem;
  `;
  ph.textContent = `${label} — DSP not yet implemented`;
  return ph;
}

export function createPpgView(container: HTMLElement): PpgViewHandle {
  const section = makeSection();

  // Section header.
  const title = document.createElement("h2");
  title.textContent = "💓 PPG Pulse Analysis";
  title.style.cssText = `margin: 0 0 0.25rem 0; font-size: 1.15rem; font-weight: 700; color: ${uiColors.textPrimary};`;
  section.appendChild(title);

  const subtitle = document.createElement("p");
  subtitle.textContent = "Photoplethysmography (Red/IR LED). Last ~8s @ 50Hz.";
  subtitle.style.cssText = `margin: 0 0 1rem 0; font-size: 0.85rem; color: ${uiColors.textSecondary};`;
  section.appendChild(subtitle);

  // (1) LeadOff banner. PPG 는 parser 가 lead-off 정보를 추출하지 않으므로
  // (firmware 패킷에 PPG 전용 lead-off 바이트 없음 — sensor-dashboard 의
  // `rawLeadOff: { ch1, ch2 }` 는 store 가 외부 신호로 채움) 본 view 는
  // banner DOM 만 만들고 display: none 으로 둔다. DSP/quality 단계에서
  // 신호 품질 판단 로직 추가 시 활성화 가능.
  const banner = document.createElement("div");
  banner.style.cssText = `
    display: none;
    background: ${chartColors.warnBg};
    border: 1px solid ${chartColors.warnBorder};
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.75rem;
    color: #fca5a5;
    font-size: 0.85rem;
  `;
  banner.textContent = "⚠ PPG sensor contact issue — signal quality may be degraded";
  section.appendChild(banner);

  // (2) Raw IR/RED chart.
  const rawPanel = makeSubpanel(
    "🔴 Raw IR / RED Channels",
    "Unfiltered 24-bit ADC counts straight from the firmware. DC offset and ambient pickup dominate; bandpass filter (0.5-5 Hz) will isolate the heartbeat — coming with DSP.",
  );
  const rawChartHost = document.createElement("div");
  rawChartHost.style.cssText = "width: 100%; height: 240px;";
  rawPanel.appendChild(rawChartHost);
  section.appendChild(rawPanel);

  // ECharts auto-scale (no fixed yMin/yMax) — raw values vary by ~1-2 orders of magnitude.
  const rawChart: ChartHandle = createChart(
    rawChartHost,
    buildMultiLineOption({
      series: [
        { name: "IR", color: chartColors.ir },
        { name: "Red", color: chartColors.red },
      ],
      yName: "ADC counts",
      yNameGap: 60,
      tooltipFormatter: (params: unknown) => {
        const arr = params as Array<{ seriesName: string; value: [number, number] }>;
        if (!Array.isArray(arr) || arr.length === 0) return "";
        const idx = arr[0]?.value?.[0] ?? 0;
        const lines = [`Sample #${idx}`];
        for (const p of arr) lines.push(`${p.seriesName}: ${p.value[1]}`);
        return lines.join("<br/>");
      },
    }),
  );

  // (3) Filtered chart placeholder.
  const filteredPanel = makeSubpanel(
    "🔧 Filtered PPG Signal",
    "Red/IR signals through a 0.5-5.0 Hz bandpass to isolate the heart-beat pattern (DC removed).",
  );
  filteredPanel.appendChild(makePlaceholder("Filtered chart", "200px"));
  section.appendChild(filteredPanel);

  // (4) BPM trend placeholder.
  const bpmPanel = makeSubpanel(
    "💓 BPM Trend",
    "Heart rate over time — derived from peak detection on the filtered PPG signal.",
  );
  bpmPanel.appendChild(makePlaceholder("BPM trend", "180px"));
  section.appendChild(bpmPanel);

  // (5) MetricsCards — labels mirrored from sensor-dashboard PPGMetricsCards.
  const metricsPanel = makeSubpanel(
    "📊 Heart Rate Variability Metrics",
    "Heart rate, HRV, stress, and 11 more indices. All placeholder until DSP/metrics land.",
  );
  const metricsGrid = document.createElement("div");
  metricsGrid.style.cssText = `
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 0.6rem;
  `;
  metricsPanel.appendChild(metricsGrid);
  section.appendChild(metricsPanel);

  // 14 cards in same order as sensor-dashboard `PPGMetricsCards.tsx`.
  const metricSpec: Array<{ label: string; unit?: string; dotColor?: string; decimals?: number }> = [
    { label: "BPM", unit: "bpm", dotColor: chartColors.bpm, decimals: 0 },
    { label: "SpO₂", unit: "%", dotColor: "#4ecdc4", decimals: 1 },
    { label: "HR Max", unit: "bpm", dotColor: chartColors.bpm, decimals: 0 },
    { label: "HR Min", unit: "bpm", dotColor: chartColors.bpm, decimals: 0 },
    { label: "Stress", dotColor: "#f59e0b", decimals: 2 },
    { label: "RMSSD", unit: "ms", dotColor: "#a855f7", decimals: 1 },
    { label: "SDNN", unit: "ms", dotColor: "#a855f7", decimals: 1 },
    { label: "SDSD", unit: "ms", dotColor: "#a855f7", decimals: 1 },
    { label: "LF Power", dotColor: "#3b82f6", decimals: 1 },
    { label: "HF Power", dotColor: "#10b981", decimals: 1 },
    { label: "LF/HF", dotColor: "#f59e0b", decimals: 2 },
    { label: "AVNN", unit: "ms", dotColor: "#a855f7", decimals: 1 },
    { label: "pNN50", unit: "%", dotColor: "#a855f7", decimals: 1 },
    { label: "pNN20", unit: "%", dotColor: "#a855f7", decimals: 1 },
  ];
  const cards: MetricCardHandle[] = metricSpec.map((spec) => createMetricCard(metricsGrid, spec));
  // 모두 placeholder. DSP 단계에서 actual values 로 update.
  for (const c of cards) c.update(null);

  container.appendChild(section);

  // ─── Buffers + onBatch ──────────────────────────────────────────────────
  const irBuf: number[] = [];
  const redBuf: number[] = [];

  function pushAndTrim(buf: number[], values: Int32Array): void {
    for (const v of values) buf.push(v);
    if (buf.length > PPG_BUFFER_SIZE) buf.splice(0, buf.length - PPG_BUFFER_SIZE);
  }

  return {
    onBatch(batch: PpgBatch): void {
      pushAndTrim(irBuf, batch.ir);
      pushAndTrim(redBuf, batch.red);

      const irData: Array<[number, number]> = irBuf.map((v, i) => [i, v]);
      const redData: Array<[number, number]> = redBuf.map((v, i) => [i, v]);
      const maxLen = Math.max(irBuf.length, redBuf.length, 1);
      rawChart.chart.setOption({
        xAxis: { min: 0, max: maxLen - 1 },
        series: [{ data: irData }, { data: redData }],
      });
    },
    dispose(): void {
      rawChart.dispose();
      section.remove();
    },
  };
}
