/**
 * ACC view — sensor-dashboard `ACCVisualizer.tsx` + `MotionCards.tsx` 의 4-row 레이아웃 미러링.
 *
 * 구조 (sensor-dashboard 동일):
 *   1. Hero card        — "📐 ACC Acceleration Analysis" + 설명 + 3 InfoBadge
 *   2. Full-width       — "3-Axis Acceleration Waveform" (X/Y/Z multi-line)
 *   3. Full-width       — "Magnitude" (√(x²+y²+z²) per-sample, area chart)
 *   4. Full-width       — "📐 Movement Analysis" cards
 *                         - Row A (4-col): X / Y / Z / Magnitude raw value cards
 *                         - Row B (3-col): Activity State / Stability / Intensity
 *
 * Magnitude 는 DSP 가 아닌 단순 산술 (3D 벡터 norm) — view 안에서 계산.
 * Stability / Intensity / activityState 는 `computeAccAnalysis` (dsp.ts) — 본
 * 산식은 approximate baseline (sensor-dashboard 가 server-side 라 client formula
 * 부재 → linkband-app 자체 정의, 실 디바이스 검증 후 조정).
 *
 * 외부 인터페이스:
 *     const view = createAccView(container)
 *     view.onBatch(accBatch)
 *     view.dispose()
 */
import { computeAccAnalysis } from "../linkband/dsp";
import { ACC_FS, ACC_LSB_PER_G, type AccBatch } from "../linkband/models";
import { accIndexThresholds } from "../linkband/thresholds";
import {
  type ChartHandle,
  buildMultiLineOption,
  buildRealtimeLineOption,
  createChart,
} from "./chart";
import { createIndexCard, type IndexCardHandle } from "./index-card";
import { chartColors, rgba, uiColors } from "./theme";

const ACC_BUFFER_SIZE = 200; // ~8s @ 25Hz
const ACC_WINDOW_SEC = ACC_BUFFER_SIZE / ACC_FS; // = 8 — xAxis 고정 윈도우
const STYLE_ID = "acc-view-style";

// Activity State dot colors — sensor-dashboard `MotionCards.tsx` 의 teal/coral.
const ACTIVITY_STATIONARY_COLOR = "#14b8a6"; // teal-500
const ACTIVITY_MOVING_COLOR = "#f87171"; // coral / red-400

export interface AccViewHandle {
  onBatch(batch: AccBatch): void;
  /** 컨테이너 가시화 직후 호출 — hidden tab init 케이스에서 ECharts 가 0×0 으로
   *  measure 된 걸 정상 사이즈로 다시 잡아준다. */
  resize(): void;
  dispose(): void;
}

// ─── Style injection ──────────────────────────────────────────────────────
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    .acc-cards-grid-4 {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.6rem;
      margin-bottom: 0.6rem;
    }
    @media (min-width: 768px) {
      .acc-cards-grid-4 { grid-template-columns: repeat(4, 1fr); }
    }
    .acc-cards-grid-3 {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0.6rem;
    }
    @media (min-width: 768px) {
      .acc-cards-grid-3 { grid-template-columns: repeat(3, 1fr); }
    }
  `;
  document.head.appendChild(s);
}

// ─── DOM helpers (eeg/ppg-view.ts 와 동일 패턴) ───────────────────────────
function makeCard(): HTMLElement {
  const card = document.createElement("div");
  card.style.cssText = `
    background: ${uiColors.bgSection};
    border: 1px solid ${uiColors.border};
    border-radius: 8px;
    padding: 1.25rem;
    margin-bottom: 1.5rem;
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

function makeCardDesc(html: string): HTMLElement {
  const p = document.createElement("p");
  p.innerHTML = html;
  p.style.cssText = `margin: 0 0 0.85rem 0; font-size: 0.85rem; color: ${uiColors.textSecondary}; line-height: 1.5;`;
  return p;
}

/**
 * sensor-dashboard `components/ui/InfoBadge.tsx` 의 단순 미러 — 색 컬러키 + 텍스트.
 * shadcn Badge 의존성 없이 inline span + style. accent color 는 yellow 고정.
 */
function makeInfoBadge(text: string): HTMLElement {
  const badge = document.createElement("span");
  badge.textContent = text;
  badge.style.cssText = `
    display: inline-block;
    padding: 0.25rem 0.7rem;
    border-radius: 9999px;
    font-size: 0.72rem;
    font-weight: 500;
    background: ${rgba(chartColors.magnitude, 0.15)};
    color: ${chartColors.magnitude};
    border: 1px solid ${rgba(chartColors.magnitude, 0.35)};
    margin-right: 0.4rem;
  `;
  return badge;
}

// ─── Raw value card (no threshold, no tooltip) ─────────────────────────────
//
// X/Y/Z/Magnitude 는 단순 raw 값 표시 — sensor-dashboard `MotionCards.tsx` 의
// 첫 번째 4개 카드. metric-card.ts 는 status 라벨 강제 ("live" / "No data") 라
// 시각이 살짝 다름 → 이 view 전용 mini-card 로.

interface RawValueCardHandle {
  readonly element: HTMLElement;
  update(value: number): void;
}

function createRawValueCard(
  container: HTMLElement,
  label: string,
  dotColor: string,
  unit: string,
): RawValueCardHandle {
  const card = document.createElement("div");
  card.style.cssText = `
    background: ${uiColors.bgElevated};
    border: 1px solid ${uiColors.border};
    border-radius: 8px;
    padding: 0.75rem 1rem;
    min-width: 0;
  `;

  const head = document.createElement("div");
  head.style.cssText = "display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem;";
  const dot = document.createElement("span");
  dot.style.cssText = `
    width: 0.6rem; height: 0.6rem; border-radius: 50%;
    background: ${dotColor};
    flex-shrink: 0;
  `;
  head.appendChild(dot);
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  labelEl.style.cssText = `font-size: 0.8rem; font-weight: 600; color: ${uiColors.textSecondary};`;
  head.appendChild(labelEl);
  card.appendChild(head);

  const valueRow = document.createElement("div");
  valueRow.style.cssText = `
    font-size: 1.4rem;
    font-weight: 700;
    color: ${uiColors.textPrimary};
    font-family: ui-monospace, "SF Mono", Consolas, monospace;
    line-height: 1.2;
    display: flex;
    align-items: baseline;
    gap: 0.3rem;
  `;
  const valueEl = document.createElement("span");
  valueEl.textContent = "—";
  valueRow.appendChild(valueEl);
  const unitEl = document.createElement("span");
  unitEl.textContent = unit;
  unitEl.style.cssText = `font-size: 0.7rem; color: ${uiColors.textMuted}; font-weight: 400;`;
  valueRow.appendChild(unitEl);
  card.appendChild(valueRow);

  container.appendChild(card);

  return {
    element: card,
    update(value: number): void {
      valueEl.textContent = value.toFixed(3);
    },
  };
}

// ─── Activity State card (text 표시, threshold 없음) ───────────────────────
interface ActivityStateCardHandle {
  readonly element: HTMLElement;
  update(state: "stationary" | "moving"): void;
}

function createActivityStateCard(container: HTMLElement): ActivityStateCardHandle {
  const card = document.createElement("div");
  card.style.cssText = `
    position: relative;
    background: ${uiColors.bgElevated};
    border: 1px solid ${uiColors.border};
    border-radius: 8px;
    padding: 1rem;
    overflow: visible;
  `;

  const head = document.createElement("div");
  head.style.cssText = "display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;";
  const dot = document.createElement("span");
  dot.style.cssText = `
    width: 0.75rem; height: 0.75rem; border-radius: 50%;
    background: ${ACTIVITY_STATIONARY_COLOR};
    flex-shrink: 0;
  `;
  head.appendChild(dot);
  const labelEl = document.createElement("span");
  labelEl.textContent = "Activity State";
  labelEl.style.cssText = `font-size: 0.85rem; font-weight: 600; color: ${uiColors.textPrimary};`;
  head.appendChild(labelEl);
  card.appendChild(head);

  const valueEl = document.createElement("div");
  valueEl.textContent = "—";
  valueEl.style.cssText = `
    font-size: 1.5rem;
    font-weight: 700;
    color: ${uiColors.textPrimary};
    font-family: ui-monospace, "SF Mono", Consolas, monospace;
    line-height: 1.2;
    margin-bottom: 0.25rem;
  `;
  card.appendChild(valueEl);

  // index-card 와 시각 일관성을 위해 status 슬롯 비워둠 (placeholder).
  const statusEl = document.createElement("div");
  statusEl.textContent = "Awaiting data";
  statusEl.style.cssText = `font-size: 0.7rem; font-weight: 500; color: ${uiColors.textMuted};`;
  card.appendChild(statusEl);

  container.appendChild(card);

  return {
    element: card,
    update(state: "stationary" | "moving"): void {
      valueEl.textContent = state;
      if (state === "stationary") {
        dot.style.background = ACTIVITY_STATIONARY_COLOR;
        statusEl.textContent = "At rest";
        statusEl.style.color = ACTIVITY_STATIONARY_COLOR;
      } else {
        dot.style.background = ACTIVITY_MOVING_COLOR;
        statusEl.textContent = "In motion";
        statusEl.style.color = ACTIVITY_MOVING_COLOR;
      }
    },
  };
}

// ─── createAccView ────────────────────────────────────────────────────────

export function createAccView(container: HTMLElement): AccViewHandle {
  ensureStyles();

  const root = document.createElement("section");
  root.className = "acc-view-root";

  // (1) Hero card.
  const hero = makeCard();
  hero.appendChild(makeCardTitle("📐 ACC Acceleration Analysis", 2));
  // sensor-dashboard 의 X/Y/Z 색 강조 inline 구문 미러.
  hero.appendChild(
    makeCardDesc(
      `The accelerometer measures the movement and tilt of the headset.
       <strong style="color:${chartColors.accX}"> X-axis</strong> (left/right),
       <strong style="color:${chartColors.accY}"> Y-axis</strong> (front/back),
       <strong style="color:${chartColors.accZ}"> Z-axis</strong> (up/down) —
       acceleration is measured along all three axes in units of g.`,
    ),
  );
  const badgeRow = document.createElement("div");
  badgeRow.style.cssText = "display: flex; flex-wrap: wrap; gap: 0.25rem; margin-top: 0.25rem;";
  badgeRow.appendChild(makeInfoBadge("3-axis (X, Y, Z)"));
  badgeRow.appendChild(makeInfoBadge("25Hz sampling"));
  badgeRow.appendChild(makeInfoBadge("Unit: g (gravitational acceleration)"));
  hero.appendChild(badgeRow);
  root.appendChild(hero);

  // (2) 3-Axis waveform card.
  const waveCard = makeCard();
  waveCard.appendChild(makeCardTitle("3-Axis Acceleration Waveform"));
  waveCard.appendChild(
    makeCardDesc(
      "When stationary, Z-axis ≈ -1g (gravity), X/Y ≈ 0. Each axis value changes as you move your head.",
    ),
  );
  const waveHost = document.createElement("div");
  waveHost.style.cssText = "width: 100%; height: 240px;";
  waveCard.appendChild(waveHost);
  root.appendChild(waveCard);

  // (3) Magnitude card.
  const magCard = makeCard();
  magCard.appendChild(makeCardTitle("Magnitude"));
  magCard.appendChild(
    makeCardDesc(
      "√(x² + y² + z²) — combines movement from all directions into a single value. About 1g at rest, varies with movement.",
    ),
  );
  const magHost = document.createElement("div");
  magHost.style.cssText = "width: 100%; height: 200px;";
  magCard.appendChild(magHost);
  root.appendChild(magCard);

  // (4) Movement Analysis cards (sensor-dashboard `MotionCards.tsx` 미러).
  const motionCard = makeCard();
  motionCard.appendChild(makeCardTitle("📐 Movement Analysis"));
  motionCard.appendChild(
    makeCardDesc(
      "Real-time acceleration summary and activity state (stationary/moving) analysis.",
    ),
  );

  // Row A — 4-col raw value cards (X / Y / Z / Magnitude).
  const rawGrid = document.createElement("div");
  rawGrid.className = "acc-cards-grid-4";
  motionCard.appendChild(rawGrid);
  const xCard = createRawValueCard(rawGrid, "X-axis", chartColors.accX, "g");
  const yCard = createRawValueCard(rawGrid, "Y-axis", chartColors.accY, "g");
  const zCard = createRawValueCard(rawGrid, "Z-axis", chartColors.accZ, "g");
  const magValueCard = createRawValueCard(rawGrid, "Magnitude", chartColors.magnitude, "g");

  // Row B — 3-col analysis (Activity State / Stability / Intensity).
  const analysisGrid = document.createElement("div");
  analysisGrid.className = "acc-cards-grid-3";
  motionCard.appendChild(analysisGrid);
  const activityCard = createActivityStateCard(analysisGrid);
  const stabilityCard: IndexCardHandle = createIndexCard(analysisGrid, {
    threshold: accIndexThresholds.stability,
    decimals: 0,
  });
  const intensityCard: IndexCardHandle = createIndexCard(analysisGrid, {
    threshold: accIndexThresholds.intensity,
    decimals: 0,
  });

  root.appendChild(motionCard);
  container.appendChild(root);

  // ─── Charts ──────────────────────────────────────────────────────────────
  const waveChart: ChartHandle = createChart(
    waveHost,
    buildMultiLineOption({
      series: [
        { name: "X", color: chartColors.accX },
        { name: "Y", color: chartColors.accY },
        { name: "Z", color: chartColors.accZ },
      ],
      yName: "g",
      yMin: -2,
      yMax: 2,
      yNameGap: 40,
      tooltipFormatter: (params: unknown) => {
        const arr = params as Array<{ seriesName: string; value: [number, number] }>;
        if (!Array.isArray(arr) || arr.length === 0) return "";
        const t = arr[0]?.value?.[0] ?? 0;
        const lines = [`t = ${t.toFixed(2)}s`];
        for (const p of arr) lines.push(`${p.seriesName}: ${p.value[1].toFixed(3)} g`);
        return lines.join("<br/>");
      },
    }),
  );

  // Magnitude — g 단위 (정지 시 ≈ 1g, 이동 시 그 이상). 0..3g 윈도우 — 운동 시
  // 일시적 spike 가 ±2g 를 벗어날 수 있어 여유 두고 3.
  const magChart: ChartHandle = createChart(
    magHost,
    buildRealtimeLineOption({
      color: chartColors.magnitude,
      yName: "g",
      yMin: 0,
      yMax: 3,
      yNameGap: 40,
      area: true,
      smooth: true,
      tooltipFormatter: (params: unknown) => {
        const arr = params as Array<{ value: [number, number] }>;
        if (!Array.isArray(arr) || arr.length === 0) return "";
        const t = arr[0]?.value?.[0] ?? 0;
        const v = arr[0]?.value?.[1] ?? 0;
        return `t = ${t.toFixed(2)}s<br/>magnitude: ${v.toFixed(3)} g`;
      },
    }),
  );

  // ─── Buffers + onBatch ──────────────────────────────────────────────────
  const xBuf: number[] = [];
  const yBuf: number[] = [];
  const zBuf: number[] = [];
  const magBuf: number[] = [];

  function pushAndTrim(buf: number[], value: number): void {
    buf.push(value);
    if (buf.length > ACC_BUFFER_SIZE) buf.splice(0, buf.length - ACC_BUFFER_SIZE);
  }

  return {
    onBatch(batch: AccBatch): void {
      // raw int16 → g 변환 (1g = ACC_LSB_PER_G LSB, spec §9). per-sample magnitude
      // 도 g 단위로 누적 — 정지 시 magnitude ≈ 1g (중력 벡터).
      for (let i = 0; i < batch.x.length; i++) {
        const x = batch.x[i] / ACC_LSB_PER_G;
        const y = batch.y[i] / ACC_LSB_PER_G;
        const z = batch.z[i] / ACC_LSB_PER_G;
        pushAndTrim(xBuf, x);
        pushAndTrim(yBuf, y);
        pushAndTrim(zBuf, z);
        pushAndTrim(magBuf, Math.sqrt(x * x + y * y + z * z));
      }

      const fs = batch.fs;
      const xLast = Math.max(xBuf.length - 1, 0);
      const yLast = Math.max(yBuf.length - 1, 0);
      const zLast = Math.max(zBuf.length - 1, 0);
      const magLast = Math.max(magBuf.length - 1, 0);

      // xAxis 는 ACC_WINDOW_SEC 고정 → buffer 차오를수록 라인이 좌측으로 grow.
      const xData: Array<[number, number]> = xBuf.map((v, i) => [(i - xLast) / fs, v]);
      const yData: Array<[number, number]> = yBuf.map((v, i) => [(i - yLast) / fs, v]);
      const zData: Array<[number, number]> = zBuf.map((v, i) => [(i - zLast) / fs, v]);
      const magData: Array<[number, number]> = magBuf.map((v, i) => [(i - magLast) / fs, v]);

      waveChart.chart.setOption({
        xAxis: { min: -ACC_WINDOW_SEC, max: 0 },
        series: [{ data: xData }, { data: yData }, { data: zData }],
      });
      magChart.chart.setOption({
        xAxis: { min: -ACC_WINDOW_SEC, max: 0 },
        series: [{ data: magData }],
      });

      // ─── Movement Analysis cards 갱신 ─────────────────────────────────────
      // 매 batch 갱신 — magBuf 가 작고(200 samples) computeAccAnalysis 가 가벼움
      // (mean + std O(N)). raw value 카드는 latest 1 sample.
      const xLastVal = xBuf[xBuf.length - 1] ?? 0;
      const yLastVal = yBuf[yBuf.length - 1] ?? 0;
      const zLastVal = zBuf[zBuf.length - 1] ?? 0;
      const magLastVal = magBuf[magBuf.length - 1] ?? 0;
      xCard.update(xLastVal);
      yCard.update(yLastVal);
      zCard.update(zLastVal);
      magValueCard.update(magLastVal);

      const analysis = computeAccAnalysis(magBuf, ACC_FS);
      activityCard.update(analysis.activityState);
      stabilityCard.update(analysis.stability);
      intensityCard.update(analysis.intensity);
    },
    resize(): void {
      waveChart.chart.resize();
      magChart.chart.resize();
    },
    dispose(): void {
      waveChart.dispose();
      magChart.dispose();
      root.remove();
    },
  };
}
