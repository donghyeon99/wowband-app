/**
 * Threshold definitions — sensor-dashboard `src/lib/thresholds/indexThresholds.ts`
 * 의 verbatim 포팅. 과학적 근거 (논문 reference) 그대로 보존.
 *
 * 차이점: wowband-app 은 vanilla TS + inline-style 환경이라 Tailwind 클래스
 * (`text-red-400`, `bg-red-500/10` 등) 대신 hex / rgba 문자열을 직접 반환.
 * 헬퍼 함수 시그니처는 그대로 유지 — 호출 측에선 색상 문자열을 그대로
 * `style.color` / `style.background` 등에 꽂으면 된다.
 */

export type ThresholdColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";

export interface ThresholdLevel {
  min: number;
  max: number;
  label: string;
  color: ThresholdColor;
}

export interface IndexThreshold {
  key: string;
  displayName: string;
  unit?: string;
  formula?: string;
  description?: string;
  reference?: string;
  normalRange: [number, number];
  levels: ThresholdLevel[];
}

const NEG_INF = Number.NEGATIVE_INFINITY;
const POS_INF = Number.POSITIVE_INFINITY;

export const eegIndexThresholds: Record<string, IndexThreshold> = {
  focusIndex: {
    key: "focusIndex",
    displayName: "Focus",
    description:
      "Represents cognitive focus level. Higher values indicate deep focus, lower values indicate attention distraction.",
    formula: "Focus = β / (α + θ)",
    reference: "Klimesch, W. (1999). Brain Research Reviews, 29(2-3), 169-195",
    normalRange: [1.8, 2.4],
    levels: [
      { min: NEG_INF, max: 1.8, label: "Attention deficit or drowsiness", color: "yellow" },
      { min: 1.8, max: 2.4, label: "Normal focus", color: "green" },
      { min: 2.4, max: POS_INF, label: "Excessive focus or stress", color: "red" },
    ],
  },
  relaxationIndex: {
    key: "relaxationIndex",
    displayName: "Arousal",
    description:
      "Measures mental arousal and relaxation based on relative alpha-wave activity. Higher = more relaxed, lower = more tense.",
    formula: "Relaxation = α / (α + β)",
    reference: "Bazanova & Vernon (2014). Neurosci. & Biobehav. Rev., 44, 94-110",
    normalRange: [0.18, 0.22],
    levels: [
      { min: NEG_INF, max: 0.18, label: "Tense / stressed", color: "orange" },
      { min: 0.18, max: 0.22, label: "Normal tension", color: "green" },
      { min: 0.22, max: POS_INF, label: "Over-relaxed", color: "yellow" },
    ],
  },
  stressIndex: {
    key: "stressIndex",
    displayName: "Stress",
    description:
      "Reflects mental stress and arousal. Rises with increased high-frequency (beta, gamma) activity.",
    formula: "Stress = (β + γ) / (α + θ)",
    reference: "Ahn, J. W., et al. (2019). Sensors, 19(21), 4644",
    normalRange: [3.0, 4.0],
    levels: [
      { min: NEG_INF, max: 2.0, label: "Very low stress", color: "blue" },
      { min: 2.0, max: 3.0, label: "Low stress", color: "green" },
      { min: 3.0, max: 4.0, label: "Normal range", color: "green" },
      { min: 4.0, max: 5.0, label: "High stress", color: "orange" },
      { min: 5.0, max: POS_INF, label: "Severe stress", color: "red" },
    ],
  },
  hemisphericBalance: {
    key: "hemisphericBalance",
    displayName: "Hemispheric Balance",
    description:
      "Balance of alpha-wave activity between left and right brain hemispheres. Reflects emotional and cognitive bias.",
    formula: "(αL − αR) / (αL + αR)",
    reference: "Davidson, R. J. (2004). Biological Psychology, 67(1-2), 219-234",
    normalRange: [-0.1, 0.1],
    levels: [
      { min: NEG_INF, max: -0.1, label: "Creative (right-brain dominant)", color: "blue" },
      { min: -0.1, max: 0.1, label: "Balanced", color: "green" },
      { min: 0.1, max: POS_INF, label: "Logical (left-brain dominant)", color: "purple" },
    ],
  },
  cognitiveLoad: {
    key: "cognitiveLoad",
    displayName: "Cognitive Load",
    description: "Reflects mental workload and effort based on theta/alpha ratio.",
    formula: "Cognitive Load = θ / α",
    reference: "Gevins & Smith (2003). Theoretical Issues in Ergonomics Science, 4(1-2), 113-131",
    normalRange: [0.3, 0.8],
    levels: [
      { min: NEG_INF, max: 0.3, label: "Low engagement", color: "yellow" },
      { min: 0.3, max: 0.8, label: "Optimal load", color: "green" },
      { min: 0.8, max: 1.2, label: "High cognitive load", color: "orange" },
      { min: 1.2, max: POS_INF, label: "Overload", color: "red" },
    ],
  },
  emotionalStability: {
    key: "emotionalStability",
    displayName: "Emotional Stability",
    description:
      "Measures emotional regulation based on ratio of low-frequency bands to gamma power.",
    formula: "Emotional Stability = (α + θ) / γ",
    reference: "Knyazev, G. G. (2007). Neurosci. & Biobehav. Rev., 31(3), 377-395",
    normalRange: [0.4, 0.8],
    levels: [
      { min: NEG_INF, max: 0.4, label: "Emotionally unstable (over-arousal)", color: "red" },
      { min: 0.4, max: 0.8, label: "Normal range", color: "green" },
      { min: 0.8, max: POS_INF, label: "Emotionally blunted (over-suppression)", color: "yellow" },
    ],
  },
  totalPower: {
    key: "totalPower",
    displayName: "Total Power",
    unit: "μV²",
    description: "Sum of all EEG band powers, representing overall neural activity level.",
    formula: "δ + θ + α + β + γ",
    reference: "Klimesch, W. (1999). Brain Research Reviews, 29(2-3), 169-195",
    normalRange: [850, 1150],
    levels: [
      { min: NEG_INF, max: 850, label: "Suppressed neural activity (drowsy)", color: "orange" },
      { min: 850, max: 1150, label: "Normal neural activity", color: "green" },
      { min: 1150, max: POS_INF, label: "Excessive neural activity (hyperarousal)", color: "red" },
    ],
  },
};

export const ppgIndexThresholds: Record<string, IndexThreshold> = {
  bpm: {
    key: "bpm",
    displayName: "Heart Rate",
    unit: "BPM",
    description:
      "Heart rate — beats per minute. Fundamental cardiovascular health indicator, affected by exercise, stress, medication.",
    formula: "Calculated from PPG peak interval analysis",
    reference: "American Heart Association Guidelines",
    normalRange: [60, 100],
    levels: [
      { min: NEG_INF, max: 60, label: "Bradycardia (low heart rate)", color: "orange" },
      { min: 60, max: 100, label: "Normal range", color: "green" },
      { min: 100, max: POS_INF, label: "Tachycardia (high heart rate)", color: "orange" },
    ],
  },
  spo2: {
    key: "spo2",
    displayName: "SpO2",
    unit: "%",
    description:
      "Blood oxygen saturation. Evaluates respiratory and circulatory function. Accuracy limited vs medical devices.",
    formula: "Red/IR absorption ratio (Beer-Lambert law)",
    reference: "Pulse Oximetry Principles, IEEE TBME",
    normalRange: [95, 100],
    levels: [
      { min: NEG_INF, max: 90, label: "Severe hypoxemia (seek medical advice)", color: "red" },
      { min: 90, max: 95, label: "Mild hypoxemia", color: "orange" },
      { min: 95, max: 98, label: "Normal (lower bound)", color: "green" },
      { min: 98, max: 101, label: "Normal oxygen saturation", color: "green" },
    ],
  },
  hrMax: {
    key: "hrMax",
    displayName: "HR Max",
    unit: "BPM",
    description:
      "Maximum BPM over the last 2 minutes. Useful for stress response or activity intensity assessment.",
    formula: "max(BPM) over moving 120-sample queue",
    reference: "Heart Rate Variability Analysis Guidelines",
    normalRange: [80, 150],
    levels: [
      { min: NEG_INF, max: 80, label: "Low maximum heart rate", color: "blue" },
      { min: 80, max: 150, label: "Normal maximum heart rate", color: "green" },
      { min: 150, max: POS_INF, label: "High maximum heart rate", color: "orange" },
    ],
  },
  hrMin: {
    key: "hrMin",
    displayName: "HR Min",
    unit: "BPM",
    description:
      "Minimum BPM over the last 2 minutes. Useful for resting cardiovascular efficiency or recovery assessment.",
    formula: "min(BPM) over moving 120-sample queue",
    reference: "Heart Rate Variability Analysis Guidelines",
    normalRange: [50, 80],
    levels: [
      { min: NEG_INF, max: 50, label: "Low minimum heart rate", color: "blue" },
      { min: 50, max: 80, label: "Normal minimum heart rate", color: "green" },
      { min: 80, max: POS_INF, label: "High minimum heart rate", color: "orange" },
    ],
  },
  ppgStressIndex: {
    key: "ppgStressIndex",
    displayName: "Stress Index",
    description:
      "Normalized stress level (0.0–1.0) based on HRV metrics. Low = relaxed, high = stressed or fatigued.",
    formula: "0.4·SDNNnorm + 0.4·RMSSDnorm + 0.2·HRstress",
    reference: "HRV Analysis Methods, Frontiers in Physiology",
    normalRange: [0.30, 0.70],
    levels: [
      { min: NEG_INF, max: 0.30, label: "Very low stress (over-relaxed)", color: "blue" },
      { min: 0.30, max: 0.70, label: "Normal range (balanced)", color: "green" },
      { min: 0.70, max: 0.90, label: "High stress (tense)", color: "orange" },
      { min: 0.90, max: POS_INF, label: "Very high stress (severe tension)", color: "red" },
    ],
  },
  sdnn: {
    key: "sdnn",
    displayName: "SDNN",
    unit: "ms",
    description:
      "Standard deviation of NN intervals — overall HRV level. Low = poor recovery, high = good recovery.",
    formula: "SDNN = √(Σ(RRᵢ − R̄R)² / (N−1))",
    reference: "Task Force of ESC/NASPE, 1996",
    normalRange: [30, 100],
    levels: [
      { min: NEG_INF, max: 30, label: "Rigid heart rhythm (stress/fatigue)", color: "orange" },
      { min: 30, max: 100, label: "Normal range", color: "green" },
      { min: 100, max: POS_INF, label: "Flexible heart rhythm (very healthy)", color: "blue" },
    ],
  },
  rmssd: {
    key: "rmssd",
    displayName: "RMSSD",
    unit: "ms",
    description:
      "Root mean square of successive RR differences. Reflects parasympathetic activity.",
    formula: "RMSSD = √(Σ(RRᵢ₊₁ − RRᵢ)² / (N−1))",
    reference: "Task Force of ESC/NASPE, 1996",
    normalRange: [20, 50],
    levels: [
      { min: NEG_INF, max: 20, label: "Tense state (rest needed)", color: "orange" },
      { min: 20, max: 50, label: "Normal range", color: "green" },
      { min: 50, max: POS_INF, label: "Deeply relaxed state", color: "blue" },
    ],
  },
  sdsd: {
    key: "sdsd",
    displayName: "SDSD",
    unit: "ms",
    description:
      "Standard deviation of successive differences. Similar to RMSSD but different calculation. Higher = better stress recovery.",
    formula: "SDSD = √(Σ((ΔRR) − mean_Δ)² / (N−1))",
    reference: "Heart Rate Variability Analysis Methods",
    normalRange: [15, 40],
    levels: [
      { min: NEG_INF, max: 15, label: "Low variation (stress/fatigue)", color: "orange" },
      { min: 15, max: 40, label: "Normal variation", color: "green" },
      { min: 40, max: POS_INF, label: "Active variation (good recovery)", color: "blue" },
    ],
  },
  pnn50: {
    key: "pnn50",
    displayName: "PNN50",
    unit: "%",
    description:
      "Percentage of successive NN intervals differing by >50ms. Parasympathetic activity indicator.",
    formula: "PNN50 = count(|ΔRR| > 50ms) / N × 100",
    reference: "Task Force of ESC/NASPE, 1996",
    normalRange: [10, 30],
    levels: [
      { min: NEG_INF, max: 10, label: "Regular rhythm (tense/fatigued)", color: "orange" },
      { min: 10, max: 30, label: "Normal range", color: "green" },
      { min: 30, max: POS_INF, label: "Flexible rhythm (healthy)", color: "blue" },
    ],
  },
  pnn20: {
    key: "pnn20",
    displayName: "PNN20",
    unit: "%",
    description:
      "Percentage of successive NN intervals differing by >20ms. More sensitive than PNN50 — detects subtle stress/recovery states.",
    formula: "PNN20 = count(|ΔRR| > 20ms) / N × 100",
    reference: "HRV Analysis Methods, IEEE TBME",
    normalRange: [20, 60],
    levels: [
      { min: NEG_INF, max: 20, label: "Rigid rhythm (tense/fatigued)", color: "orange" },
      { min: 20, max: 60, label: "Normal range", color: "green" },
      { min: 60, max: POS_INF, label: "Flexible rhythm (healthy)", color: "blue" },
    ],
  },
  avnn: {
    key: "avnn",
    displayName: "AVNN",
    unit: "ms",
    description:
      "Average heart period. Fast HR → small AVNN, slow HR → large AVNN. Reflects baseline cardiac state.",
    formula: "AVNN = Σ(RRᵢ) / N",
    reference: "Task Force of ESC/NASPE, 1996",
    normalRange: [600, 1000],
    levels: [
      { min: NEG_INF, max: 600, label: "Fast heart rate (active/tense)", color: "orange" },
      { min: 600, max: 1000, label: "Stable heart rhythm", color: "green" },
      { min: 1000, max: POS_INF, label: "Slow heart rate (rest/athletic)", color: "blue" },
    ],
  },
  lfPower: {
    key: "lfPower",
    displayName: "LF Power",
    unit: "ms²",
    description: "Low-frequency power (0.04–0.15 Hz) — sympathetic nervous activity indicator.",
    formula: "Welch periodogram PSD over RR intervals",
    reference: "Task Force of ESC/NASPE, 1996; Shaffer & Ginsberg, 2017",
    normalRange: [200, 1200],
    levels: [
      { min: NEG_INF, max: 200, label: "Low sympathetic activity (excessive rest)", color: "blue" },
      { min: 200, max: 1200, label: "Normal sympathetic activity", color: "green" },
      { min: 1200, max: POS_INF, label: "High sympathetic activity (stress/tension)", color: "red" },
    ],
  },
  hfPower: {
    key: "hfPower",
    displayName: "HF Power",
    unit: "ms²",
    description: "High-frequency power (0.15–0.4 Hz) — parasympathetic nervous activity indicator.",
    formula: "Welch periodogram PSD over RR intervals",
    reference: "Task Force of ESC/NASPE, 1996; Shaffer & Ginsberg, 2017",
    normalRange: [80, 4000],
    levels: [
      { min: NEG_INF, max: 80, label: "Low parasympathetic activity (stress/fatigue)", color: "orange" },
      { min: 80, max: 4000, label: "Normal parasympathetic activity", color: "green" },
      { min: 4000, max: POS_INF, label: "High parasympathetic activity (deep rest)", color: "blue" },
    ],
  },
  lfHfRatio: {
    key: "lfHfRatio",
    displayName: "LF/HF Ratio",
    description:
      "Autonomic balance. Low = parasympathetic dominant, high = sympathetic dominant (stress).",
    formula: "LF / HF",
    reference: "Task Force of ESC/NASPE, 1996; Shaffer & Ginsberg, 2017",
    normalRange: [1.5, 2.5],
    levels: [
      { min: NEG_INF, max: 1.0, label: "Parasympathetic dominant (very relaxed)", color: "blue" },
      { min: 1.0, max: 1.5, label: "Mild parasympathetic", color: "green" },
      { min: 1.5, max: 2.5, label: "Ideal balance", color: "green" },
      { min: 2.5, max: 10.0, label: "Sympathetic dominant (active/tense)", color: "orange" },
      { min: 10.0, max: POS_INF, label: "Severe stress", color: "red" },
    ],
  },
};

export const accIndexThresholds: Record<string, IndexThreshold> = {
  stability: {
    key: "stability",
    displayName: "Stability",
    unit: "%",
    description: "Postural stability derived from accelerometer variance",
    normalRange: [70, 100],
    levels: [
      { min: NEG_INF, max: 30, label: "Very unstable", color: "red" },
      { min: 30, max: 50, label: "Unstable", color: "orange" },
      { min: 50, max: 70, label: "Moderate stability", color: "yellow" },
      { min: 70, max: POS_INF, label: "Stable", color: "green" },
    ],
  },
  intensity: {
    key: "intensity",
    displayName: "Intensity",
    unit: "%",
    description: "Movement intensity level",
    normalRange: [25, 50],
    levels: [
      { min: NEG_INF, max: 25, label: "Sedentary", color: "green" },
      { min: 25, max: 50, label: "Light activity", color: "green" },
      { min: 50, max: 75, label: "Moderate activity", color: "green" },
      { min: 75, max: POS_INF, label: "Vigorous activity", color: "green" },
    ],
  },
};

export function classifyIndex(value: number, threshold: IndexThreshold): ThresholdLevel {
  for (const level of threshold.levels) {
    if (value >= level.min && value < level.max) {
      return level;
    }
  }
  return threshold.levels[threshold.levels.length - 1];
}

// ─── Color maps (Tailwind 클래스 → hex/rgba 문자열) ────────────────────────
// vanilla TS + inline-style 환경용. 호출 측은 반환값을
// `style.color = getThresholdTextClass(c)` 같은 식으로 그대로 쓴다.

const textColorMap: Record<ThresholdColor, string> = {
  red: "#f87171",
  orange: "#fb923c",
  yellow: "#facc15",
  green: "#4ade80",
  blue: "#60a5fa",
  purple: "#c084fc",
};

const bgColorMap: Record<ThresholdColor, string> = {
  red: "rgba(239, 68, 68, 0.1)",
  orange: "rgba(249, 115, 22, 0.1)",
  yellow: "rgba(234, 179, 8, 0.1)",
  green: "rgba(34, 197, 94, 0.1)",
  blue: "rgba(59, 130, 246, 0.1)",
  purple: "rgba(168, 85, 247, 0.1)",
};

const borderColorMap: Record<ThresholdColor, string> = {
  red: "rgba(239, 68, 68, 0.3)",
  orange: "rgba(249, 115, 22, 0.3)",
  yellow: "rgba(234, 179, 8, 0.3)",
  green: "rgba(34, 197, 94, 0.3)",
  blue: "rgba(59, 130, 246, 0.3)",
  purple: "rgba(168, 85, 247, 0.3)",
};

const dotColorMap: Record<ThresholdColor, string> = {
  red: "#ef4444",
  orange: "#f97316",
  yellow: "#eab308",
  green: "#22c55e",
  blue: "#3b82f6",
  purple: "#a855f7",
};

export function getThresholdTextClass(color: ThresholdColor): string {
  return textColorMap[color];
}

export function getThresholdBgClass(color: ThresholdColor): string {
  return bgColorMap[color];
}

export function getThresholdBorderClass(color: ThresholdColor): string {
  return borderColorMap[color];
}

export function getThresholdDotClass(color: ThresholdColor): string {
  return dotColorMap[color];
}
