/**
 * 페이지 chrome (Header / Footer / Tabs) 헬퍼 — sensor-dashboard
 * `components/layout/{Header,Footer}.tsx` + `App.tsx` 의 sticky 탭 시스템을
 * vanilla TS DOM 으로 미러링.
 *
 * 단일 파일 (`src/ui/layout.ts`) 안에 4 헬퍼:
 *   - createHeader(container, opts) — 브랜드 + 디바이스 status pill / battery pill +
 *     Connect / Replay 버튼.
 *   - createFooter(container) — Messages 카운트 + Rate (msg/s) + Status + 버전 라벨.
 *   - createTabs(container, tabs, onChange) — 3-탭 위젯, active 토글.
 *   - createVisualizerHeader(container) — step 3 에서 추가될 예정.
 *
 * shadcn / Radix / Tailwind 도입 없음 — vanilla TS 직접.
 */

import { uiColors } from "./theme";

// ─── Header ────────────────────────────────────────────────────────────────

export interface HeaderOptions {
  onConnect: () => void;
  onReplay: () => void;
}

export interface HeaderHandle {
  readonly element: HTMLElement;
  setStatus(text: string): void;
  setBattery(text: string): void;
}

export function createHeader(container: HTMLElement, opts: HeaderOptions): HeaderHandle {
  // sensor-dashboard Header.tsx 의 sticky top + 좌(brand) / 우(ConnectPanel) 구조 미러.
  const header = document.createElement("header");
  header.style.cssText = `
    position: sticky;
    top: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.85rem 1.5rem;
    background: rgba(10, 10, 14, 0.92);
    border-bottom: 1px solid ${uiColors.border};
    backdrop-filter: blur(8px);
    flex-wrap: wrap;
    gap: 0.75rem;
  `;

  // Brand 좌측: 로고(grad) + 제품명 + 부제.
  const brand = document.createElement("div");
  brand.style.cssText = "display: flex; align-items: center; gap: 0.85rem;";

  const logo = document.createElement("div");
  logo.style.cssText = `
    width: 2rem; height: 2rem;
    background: linear-gradient(135deg, #14b8a6, #a855f7);
    border-radius: 0.4rem;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    color: white;
    font-weight: 700;
    font-size: 0.9rem;
  `;
  logo.textContent = "LB";
  brand.appendChild(logo);

  const brandText = document.createElement("div");
  const brandTitle = document.createElement("div");
  brandTitle.textContent = "Link Band Dashboard";
  brandTitle.style.cssText = `font-size: 1rem; font-weight: 600; color: ${uiColors.textPrimary}; letter-spacing: -0.01em;`;
  const brandSub = document.createElement("div");
  brandSub.textContent = "Brain-Computer Interface Monitor";
  brandSub.style.cssText = `font-size: 0.72rem; color: ${uiColors.textSecondary}; margin-top: 1px;`;
  brandText.appendChild(brandTitle);
  brandText.appendChild(brandSub);
  brand.appendChild(brandText);

  header.appendChild(brand);

  // Right: Connect / Replay 버튼 + status / battery pills.
  const right = document.createElement("div");
  right.style.cssText = "display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;";

  const statusPill = document.createElement("span");
  statusPill.textContent = "Disconnected";
  statusPill.style.cssText = `
    padding: 0.3rem 0.7rem;
    background: ${uiColors.bgElevated};
    border: 1px solid ${uiColors.border};
    border-radius: 4px;
    color: ${uiColors.textSecondary};
    font-size: 0.78rem;
    font-family: ui-monospace, "SF Mono", Consolas, monospace;
  `;
  right.appendChild(statusPill);

  const batteryPill = document.createElement("span");
  batteryPill.textContent = "Battery —";
  batteryPill.style.cssText = statusPill.style.cssText;
  right.appendChild(batteryPill);

  const connectBtn = document.createElement("button");
  connectBtn.textContent = "Connect to LXB-…";
  connectBtn.style.cssText = `
    padding: 0.45rem 0.9rem;
    font-size: 0.85rem;
    background: ${uiColors.bgElevated};
    color: ${uiColors.textPrimary};
    border: 1px solid ${uiColors.border};
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
  `;
  connectBtn.addEventListener("click", () => opts.onConnect());
  right.appendChild(connectBtn);

  const replayBtn = document.createElement("button");
  replayBtn.textContent = "Replay";
  replayBtn.style.cssText = connectBtn.style.cssText;
  replayBtn.addEventListener("click", () => opts.onReplay());
  right.appendChild(replayBtn);

  header.appendChild(right);

  container.appendChild(header);

  return {
    element: header,
    setStatus(text: string): void {
      statusPill.textContent = text;
    },
    setBattery(text: string): void {
      batteryPill.textContent = text;
    },
  };
}

// ─── Tabs ──────────────────────────────────────────────────────────────────

export interface TabSpec {
  id: string;
  label: string;
}

export interface TabsHandle {
  readonly element: HTMLElement;
  setActive(id: string): void;
}

/**
 * 3-탭 위젯 (sensor-dashboard `App.tsx` TabsList 미러). active = 흰 배경 / 검정 텍스트,
 * inactive = neutral-700 배경 / 회색 텍스트. shadcn 의존성 없이 vanilla CSS 토글.
 */
export function createTabs(
  container: HTMLElement,
  tabs: TabSpec[],
  onChange: (id: string) => void,
): TabsHandle {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = `
    position: sticky;
    top: 64px;
    z-index: 40;
    background: rgba(10, 10, 14, 0.92);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid ${uiColors.border};
    padding: 0.6rem 1.5rem;
  `;

  const list = document.createElement("div");
  list.setAttribute("role", "tablist");
  list.style.cssText = `
    display: grid;
    grid-template-columns: repeat(${tabs.length}, 1fr);
    gap: 0.25rem;
    padding: 0.25rem;
    background: #2a2a36;
    border-radius: 0.5rem;
    max-width: 1100px;
    margin: 0 auto;
  `;

  const buttons = new Map<string, HTMLButtonElement>();
  let activeId = tabs[0]?.id ?? "";

  function applyActive(id: string): void {
    for (const [tabId, btn] of buttons) {
      const isActive = tabId === id;
      btn.dataset.active = String(isActive);
      btn.style.background = isActive ? "#ffffff" : "#3f3f4a";
      btn.style.color = isActive ? "#0a0a0e" : uiColors.textSecondary;
      btn.style.boxShadow = isActive ? "0 1px 2px rgba(0,0,0,0.2)" : "none";
      btn.setAttribute("aria-selected", String(isActive));
    }
  }

  for (const t of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.textContent = t.label;
    btn.style.cssText = `
      padding: 0.5rem 1rem;
      font-size: 0.88rem;
      font-weight: 500;
      border: 1px solid ${uiColors.border};
      border-radius: 0.4rem;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      font-family: inherit;
    `;
    btn.addEventListener("click", () => {
      if (activeId === t.id) return;
      activeId = t.id;
      applyActive(t.id);
      onChange(t.id);
    });
    buttons.set(t.id, btn);
    list.appendChild(btn);
  }

  applyActive(activeId);
  wrapper.appendChild(list);
  container.appendChild(wrapper);

  return {
    element: wrapper,
    setActive(id: string): void {
      if (!buttons.has(id) || activeId === id) return;
      activeId = id;
      applyActive(id);
    },
  };
}

// ─── Footer ────────────────────────────────────────────────────────────────

export type FooterStatusKind = "live" | "idle" | "offline";

export interface FooterHandle {
  readonly element: HTMLElement;
  /** 패킷 1개 수신마다 호출. messageCount + 1, rate 는 자동으로 1초마다 갱신. */
  bumpMessage(): void;
  /** "Live" / "Idle" / "Offline" 라벨 + 색 분기. */
  setStatus(kind: FooterStatusKind): void;
  /** GC 시 setInterval 정리. */
  dispose(): void;
}

const FOOTER_VERSION_LABEL = "Link Band v0.0.1";

/**
 * sensor-dashboard `Footer.tsx` 미러 — Messages 카운트 + Rate (msg/s) + Status +
 * 버전 라벨. Zustand 의존성 제거하고 인스턴스 내부 상태로 관리.
 */
export function createFooter(container: HTMLElement): FooterHandle {
  const footer = document.createElement("footer");
  footer.style.cssText = `
    padding: 0.75rem 1.5rem;
    border-top: 1px solid ${uiColors.border};
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: rgba(10, 10, 14, 0.6);
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 1rem;
  `;

  const left = document.createElement("div");
  left.style.cssText = "display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap;";

  function makeStat(label: string, valueText: string): { wrapper: HTMLElement; valueEl: HTMLElement } {
    const wrapper = document.createElement("div");
    wrapper.style.cssText = `
      display: flex; align-items: center; gap: 0.4rem;
      font-size: 0.75rem;
      font-family: ui-monospace, "SF Mono", Consolas, monospace;
      color: ${uiColors.textMuted};
    `;
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.textContent = valueText;
    valueEl.style.cssText = `color: ${uiColors.textSecondary}; font-weight: 600;`;
    wrapper.appendChild(labelEl);
    wrapper.appendChild(valueEl);
    return { wrapper, valueEl };
  }

  const messages = makeStat("Messages", "0");
  const rate = makeStat("Rate", "0 msg/s");
  const status = makeStat("Status", "Offline");

  left.appendChild(messages.wrapper);
  left.appendChild(rate.wrapper);
  left.appendChild(status.wrapper);
  footer.appendChild(left);

  const versionEl = document.createElement("div");
  versionEl.textContent = FOOTER_VERSION_LABEL;
  versionEl.style.cssText = `font-size: 0.7rem; color: ${uiColors.textMuted}; letter-spacing: 0.05em;`;
  footer.appendChild(versionEl);

  container.appendChild(footer);

  // ─── State + rate 타이머 ──────────────────────────────────────────────
  let messageCount = 0;
  let prevCount = 0;

  const interval = window.setInterval(() => {
    const current = messageCount;
    rate.valueEl.textContent = `${current - prevCount} msg/s`;
    prevCount = current;
  }, 1000);

  return {
    element: footer,
    bumpMessage(): void {
      messageCount += 1;
      messages.valueEl.textContent = messageCount.toLocaleString();
    },
    setStatus(kind: FooterStatusKind): void {
      const label = kind === "live" ? "Live" : kind === "idle" ? "Idle" : "Offline";
      status.valueEl.textContent = label;
      status.valueEl.style.color =
        kind === "live" ? "#14b8a6" : kind === "idle" ? "#f59e0b" : "#ef4444";
    },
    dispose(): void {
      window.clearInterval(interval);
      footer.remove();
    },
  };
}
