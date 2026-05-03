# wowband-app — Project Context

## What this is

Educational sensor analysis tool, deployable as a **single static SPA on Vercel**.
The browser implements the full **Link Band BLE SDK** in TypeScript (Web Bluetooth
API for connection + packet parsing + DSP + metric computation + visualization).
No backend server.

End users are **students**. They access via a Vercel URL (Chromium-based browser
required for Web Bluetooth). Implementation is by the repo owner (donghyeon99).

## Status

- **Protocol spec is locked**: `docs/01-protocol-spec.md` — reverse-engineered from
  the [LooxidLabs/SDK-Android](https://github.com/LooxidLabs/SDK-Android) Kotlin SDK
  and the [LooxidLabs/link_band_sdk](https://github.com/LooxidLabs/link_band_sdk)
  Python core, plus on-device verification.
- **Progress & decision log**: `docs/02-progress-log.md` — chronological record of
  everything since repo init. **Read this first** to know current state, then add
  an entry whenever meaningful work happens (commit, decision, verification, issue).
- **Code walkthrough**: `docs/03-code-walkthrough.md` — narrative tour of `main.ts`,
  the data-processing folder (`src/linkband/`), and the UI folder (`src/ui/`),
  with code excerpts for every major component.
- **Bundle 1 (data model)** and **Bundle 2 (open questions strategy)** decisions
  are LOCKED — see §13 and §17 of the spec. Do not re-debate these unless
  explicitly flagged.
- For current implementation state, see `docs/02-progress-log.md`. Do not duplicate
  status here — keep this section pointing at the log.

## Architecture

```
[Link Band headband] ──BLE (Web Bluetooth)──> [Browser TS app]
                                              · GATT scan / connect / activate
                                              · packet parse (parser.ts)
                                              · DSP (filters, SQI, spectrum, indices)
                                              · ECharts visualization
                                              · 50 ms / 250 ms / 500 ms throttled update loop
```

Vanilla TypeScript + ECharts (no React). Constraints: Web Bluetooth requires
Chromium (Chrome/Edge), HTTPS or localhost, and a user gesture (button click)
to call `requestDevice()`. Vercel auto-provisions HTTPS so production is fine.

Replay (dev-only) reads BLE byte-dump fixtures from `public/fixtures/real{,1}/`
through the same pipeline as live BLE.

## Working style preferences

- **Strict mode** TS (`tsconfig.json` with `"strict": true`).
- Use `Uint8Array` / `DataView` for binary parsing. Note `DataView.getUint32(0, true)`
  for LE uint32; sign-extend 24-bit BE manually (see `parser.ts`).
- Keep parser stateless or with explicit state object — no globals. Per-sensor
  last-sample timestamps are kept on the `Parser` instance for sub-packet
  interpolation.
- Vite + TS for build. `vitest` for unit tests.
- Vanilla TS DOM for views — no framework. ECharts for charts.
- Type sensor batches as plain objects with `Float64Array` / `Int32Array` /
  `Int16Array` typed arrays — minimal GC pressure at 25 samples × 20 Hz.
- Comments only for the **WHY** (24-bit sign extension, μV conversion, LE byte
  order, DSP throttle cadence rationale).
- Korean comments allowed (project convention).

## Versioning

- `package.json` `version` is the single source of truth. Vite injects it into
  the bundle as `__APP_VERSION__` (see `vite.config.ts`) and the UI shows it as
  a small badge in the header.
- Bump only on the **last commit of a release-worthy batch** (not every commit).
- Tag the bumped commit with `git tag v0.X.Y` for downstream traceability.
- Commit message of the bump may carry a `(v0.X.Y)` suffix.

## Logging discipline (mandatory)

For every meaningful unit of work — a commit, a locked decision, an empirical
verification, an issue/blocker, a fix — **add one entry at the top of
`docs/02-progress-log.md`**. This is non-negotiable: it's how the supervisor
session and any future session reconstruct what happened and why.

Entry tags: `[DECISION]`, `[PROGRESS]`, `[VERIFIED]`, `[ISSUE]`, `[FIX]`. Body
should state *what*, *result/decision*, *next step*, *references* (spec §,
commit hash, file). If a decision changes the spec, update `01-protocol-spec.md`
in the same commit and note the section in the log entry.

When starting a new session, **read `docs/02-progress-log.md` first** before
doing anything — that is the source of truth for current state, not CLAUDE.md.

## Locked decisions (do NOT re-litigate)

From spec §13 (Bundle 1):
- Timestamps: `tDevice` (header) + `tRecv` (wall-clock) both stored.
- EEG: raw int + μV float both stored.
- Sample timestamps interpolated uniformly from packet header (Kotlin parity).
- ACC dtype: `int16` (raw); g-conversion at view layer (`ACC_LSB_PER_G = 16384`).
- `leadOff: bool` (Kotlin parity) + `leadOffRaw: uint8` (bitmask preservation).

From spec §17 (Bundle 2): six open questions Q1–Q6, all documented as
**verification-only**. Q1 (ACC layout) / Q6 (header timestamp meaning) /
Q7 (EEG fs = 500) resolved by 2026-05-01 [VERIFIED] entry.

## Cross-references for data-processing implementation

The spec in `docs/01-protocol-spec.md` is **a snapshot derived from these sources**.
For any data-processing code (`parser.ts`, `dsp.ts`), consult the original sources
directly — the spec is convenient but authority lives in the upstream code.

### Authoritative upstream sources

| # | Source | Role |
|---|---|---|
| 1 | https://github.com/LooxidLabs/SDK-Android (`develop` branch) | **Primary** Kotlin reference. Files: `SensorDataParser.kt` (parsing), `BleManager.kt` (UUIDs, GATT sequence), `SensorConfiguration.kt` (magic numbers), `SensorData.kt` (data model). |
| 2 | https://sdk.linkband.store | **Numerical reference** for DSP. Source-mapped extractions in `C:\Users\cowgo\AppData\Local\Temp\sdk_*.{ts,tsx,js}`. EEG indices formulas, PPG peak/BPM algorithm, SQI scales were taken from here. |
| 3 | https://github.com/donghyeon99/sensor-dashboard | **Predecessor repo** (mock-data based React dashboard). Local sibling at `../sensor-dashboard/`. UI structure for `BandPowerCards.tsx`, `IndexTooltip.tsx`, `IndexCards.tsx` ported from here. |
| 4 | `../sensor-dashboard/.tmp_kotlin/` (local sibling, gitignored) | Offline cache of source #1. |

### When to cross-reference (not optional)

- **Writing `parser.ts`**: source #1 `SensorDataParser.kt` for protocol; empirical
  fixture in `public/fixtures/real*/` overrides Kotlin where they disagree (e.g.,
  500 Hz EEG, 16-bit LE ACC — Kotlin had bugs).
- **Writing `ble.ts` / activation in `main.ts`**: source #1 `BleManager.kt` for
  GATT sequence and EEG `start`/`stop` write payload. Web Bluetooth API differs
  from Android `BluetoothGatt`; spec §4–§5 is summary only.
- **Writing / changing DSP**: source #2 (`sdk.linkband.store` extracted files) is
  the canonical numerical reference. The 2026-05-02 [FIX] [PROGRESS] entry
  reconciled all DSP outputs (EEG indices, band power aggregation, PPG peak/BPM,
  SQI scales) against this reference. Re-check when adding new DSP.
- **Visualization**: source #3 (`sensor-dashboard/src/components/`) for vanilla
  layout structure (rich cards, tooltip CSS, chart option builders).

### How to access

- Online: `WebFetch` for the GitHub URLs; `curl https://raw.githubusercontent.com/{repo}/{branch}/{path}`.
- Offline: source #4 for the four core Kotlin files. Source #3 also lives locally
  at `../sensor-dashboard/`. Source #2 extracted files in
  `C:\Users\cowgo\AppData\Local\Temp\sdk_*` (extract via `extract_sources.py` from
  `index.map` if needed).

## Conversation history

This repo was scaffolded on 2026-05-01 in a Claude Code session whose cwd was the
sibling repo `../sensor-dashboard/` (the previous mock-data based dashboard). The
spec was developed and locked in that session. Subsequent work continues here.
The previous session's work is archived in
`../sensor-dashboard/docs/linkband-sdk-spec/01-protocol-spec.md` (identical to
this repo's `docs/01-protocol-spec.md`).
