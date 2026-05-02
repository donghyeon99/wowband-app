/**
 * IndexCard — sensor-dashboard `components/eeg/IndexCards.tsx` + `IndexTooltip.tsx`
 * + `components/ppg/PPGMetricsCards.tsx` 의 단일 카드 구조를 vanilla TS DOM 으로
 * 통합한 generic threshold-driven 카드.
 *
 * 시각 구조 (sensor-dashboard 미러):
 *   - 카드 컨테이너 (position: relative)
 *     - 헤더 행: status 색깔 dot + display name
 *     - 큰 값 (2xl bold, monospace) + 단위 (옵션)
 *     - status 라벨 (small, status 색상)
 *     - 호버 시 표시되는 tooltip (position: absolute)
 *
 * Tooltip 구조:
 *   - Display name (bold)
 *   - Description
 *   - Formula (mono)
 *   - Normal range
 *   - Interpretation list (각 level: "min−max: label")
 *   - Reference (italic)
 *
 * Tooltip 은 카드 위에 절대 위치 (centered). `pointer-events: none` 이라 hover 영역
 * 자체는 카드 — mouseenter/leave 로 opacity + visibility toggle.
 *
 * EEG Indices, PPG HRV Metrics 모두 동일 카드. threshold metadata 가 산식 / 정상
 * 범위 / 해석 / 학술 reference 까지 포함하므로 카드 자체는 sensor-별 분기 없음.
 *
 * 외부 인터페이스:
 *     const handle = createIndexCard(container, {
 *       threshold: ppgIndexThresholds.bpm,
 *       decimals: 0,
 *       requirePositive: true,
 *     })
 *     handle.update(72)        // 값 + status 색상 갱신
 *     handle.update(null)      // "--" + "No data"
 */
import {
  classifyIndex,
  getThresholdDotClass,
  getThresholdTextClass,
  type IndexThreshold,
} from "../linkband/thresholds";
import { uiColors } from "./theme";

export interface IndexCardOptions {
  /** 카드가 표현할 metric 의 threshold metadata. */
  threshold: IndexThreshold;
  /** 값 표시 소수점 자릿수. 기본 2. BPM 같은 정수 metric 은 0. */
  decimals?: number;
  /** true 면 양수가 아닌 값(0, 음수)도 "No data" 로 표시. BPM 같은 metric 에서 사용. */
  requirePositive?: boolean;
}

export interface IndexCardHandle {
  readonly element: HTMLElement;
  update(value: number | null | undefined): void;
}

const NO_DATA_DOT = "#6b7280"; // gray-500
const NO_DATA_TEXT = uiColors.textMuted;

function isValidNumber(v: number | null | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

function formatBound(v: number): string {
  if (v === Number.NEGATIVE_INFINITY) return "−∞";
  if (v === Number.POSITIVE_INFINITY) return "+∞";
  return v.toString();
}

function buildTooltip(threshold: IndexThreshold): HTMLElement {
  const tip = document.createElement("div");
  tip.className = "index-tooltip";
  tip.style.cssText = `
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-bottom: 8px;
    min-width: 280px;
    max-width: 360px;
    padding: 0.75rem;
    border-radius: 8px;
    background: ${uiColors.bgBase};
    border: 1px solid ${uiColors.border};
    box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.15s ease, visibility 0.15s ease;
    z-index: 50;
    text-align: left;
    color: ${uiColors.textSecondary};
    font-size: 11px;
    line-height: 1.5;
  `;

  const title = document.createElement("div");
  title.textContent = threshold.displayName;
  title.style.cssText = `font-size: 13px; font-weight: 700; color: ${uiColors.textPrimary}; margin-bottom: 4px;`;
  tip.appendChild(title);

  if (threshold.description) {
    const desc = document.createElement("p");
    desc.textContent = threshold.description;
    desc.style.cssText = `margin: 0 0 8px 0; font-size: 11px; color: ${uiColors.textSecondary}; line-height: 1.5;`;
    tip.appendChild(desc);
  }

  if (threshold.formula) {
    const formula = document.createElement("div");
    formula.style.cssText = `font-size: 11px; margin-bottom: 4px; font-family: ui-monospace, "SF Mono", Consolas, monospace; color: ${uiColors.textSecondary};`;
    const label = document.createElement("span");
    label.textContent = "Formula: ";
    label.style.color = uiColors.textMuted;
    formula.appendChild(label);
    formula.appendChild(document.createTextNode(threshold.formula));
    tip.appendChild(formula);
  }

  const unitSuffix = threshold.unit ? ` ${threshold.unit}` : "";
  const range = document.createElement("div");
  range.style.cssText = `font-size: 11px; margin-bottom: 8px; color: ${uiColors.textSecondary};`;
  const rangeLabel = document.createElement("span");
  rangeLabel.textContent = "Normal range: ";
  rangeLabel.style.color = uiColors.textMuted;
  range.appendChild(rangeLabel);
  range.appendChild(
    document.createTextNode(
      `${threshold.normalRange[0]}–${threshold.normalRange[1]}${unitSuffix}`,
    ),
  );
  tip.appendChild(range);

  const interp = document.createElement("div");
  interp.style.cssText = `font-size: 11px; margin-bottom: 8px; color: ${uiColors.textSecondary};`;
  const interpHeader = document.createElement("div");
  interpHeader.textContent = "Interpretation:";
  interpHeader.style.cssText = `color: ${uiColors.textMuted}; margin-bottom: 4px;`;
  interp.appendChild(interpHeader);
  const ul = document.createElement("ul");
  ul.style.cssText = "margin: 0; padding-left: 4px; list-style: none;";
  for (const level of threshold.levels) {
    const li = document.createElement("li");
    li.style.cssText = "margin-bottom: 2px; line-height: 1.5;";
    const boundsSpan = document.createElement("span");
    boundsSpan.textContent = `${formatBound(level.min)}–${formatBound(level.max)}: `;
    boundsSpan.style.color = uiColors.textMuted;
    li.appendChild(boundsSpan);
    const labelSpan = document.createElement("span");
    labelSpan.textContent = level.label;
    li.appendChild(labelSpan);
    ul.appendChild(li);
  }
  interp.appendChild(ul);
  tip.appendChild(interp);

  if (threshold.reference) {
    const ref = document.createElement("div");
    ref.textContent = threshold.reference;
    ref.style.cssText = `font-size: 10px; font-style: italic; color: ${uiColors.textMuted}; border-top: 1px solid ${uiColors.border}; padding-top: 8px; margin-top: 8px;`;
    tip.appendChild(ref);
  }

  return tip;
}

export function createIndexCard(
  container: HTMLElement,
  opts: IndexCardOptions,
): IndexCardHandle {
  const { threshold, decimals = 2, requirePositive = false } = opts;

  const card = document.createElement("div");
  card.className = "index-card";
  card.style.cssText = `
    position: relative;
    background: ${uiColors.bgElevated};
    border: 1px solid ${uiColors.border};
    border-radius: 8px;
    padding: 1rem;
    transition: background 0.15s ease;
    overflow: visible;
  `;

  card.addEventListener("mouseenter", () => {
    card.style.background = "#23232f";
  });
  card.addEventListener("mouseleave", () => {
    card.style.background = uiColors.bgElevated;
  });

  const head = document.createElement("div");
  head.style.cssText =
    "display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;";

  const dot = document.createElement("span");
  dot.style.cssText = `
    width: 0.75rem; height: 0.75rem; border-radius: 50%;
    background: ${NO_DATA_DOT};
    flex-shrink: 0;
  `;
  head.appendChild(dot);

  const labelEl = document.createElement("span");
  labelEl.textContent = threshold.displayName;
  labelEl.style.cssText = `font-size: 0.85rem; font-weight: 600; color: ${uiColors.textPrimary};`;
  head.appendChild(labelEl);

  card.appendChild(head);

  const valueRow = document.createElement("div");
  valueRow.style.cssText = `
    font-size: 1.5rem;
    font-weight: 700;
    color: ${uiColors.textPrimary};
    font-family: ui-monospace, "SF Mono", Consolas, monospace;
    line-height: 1.2;
    margin-bottom: 0.25rem;
    display: flex;
    align-items: baseline;
    gap: 0.3rem;
  `;
  const valueEl = document.createElement("span");
  valueEl.textContent = "--";
  valueRow.appendChild(valueEl);

  if (threshold.unit) {
    const unitEl = document.createElement("span");
    unitEl.textContent = threshold.unit;
    unitEl.style.cssText = `font-size: 0.75rem; color: ${uiColors.textMuted}; font-weight: 400;`;
    valueRow.appendChild(unitEl);
  }
  card.appendChild(valueRow);

  const statusEl = document.createElement("div");
  statusEl.textContent = "No data";
  statusEl.style.cssText = `font-size: 0.7rem; font-weight: 500; color: ${NO_DATA_TEXT};`;
  card.appendChild(statusEl);

  const tooltip = buildTooltip(threshold);
  card.appendChild(tooltip);

  card.addEventListener("mouseenter", () => {
    tooltip.style.opacity = "1";
    tooltip.style.visibility = "visible";
  });
  card.addEventListener("mouseleave", () => {
    tooltip.style.opacity = "0";
    tooltip.style.visibility = "hidden";
  });

  container.appendChild(card);

  return {
    element: card,
    update(value: number | null | undefined): void {
      const valid = isValidNumber(value) && (!requirePositive || value > 0);
      if (valid) {
        const level = classifyIndex(value, threshold);
        valueEl.textContent = value.toFixed(decimals);
        statusEl.textContent = level.label;
        const dotColor = getThresholdDotClass(level.color);
        const textColor = getThresholdTextClass(level.color);
        dot.style.background = dotColor;
        statusEl.style.color = textColor;
      } else {
        valueEl.textContent = "--";
        statusEl.textContent = "No data";
        dot.style.background = NO_DATA_DOT;
        statusEl.style.color = NO_DATA_TEXT;
      }
    },
  };
}
