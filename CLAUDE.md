# linkband-app — Project Context

## What this is

Educational sensor analysis tool, deployable as a **single static SPA on Vercel**.
The browser implements the full **Link Band BLE SDK** in TypeScript (Web Bluetooth
API for connection + packet parsing + DSP + metric computation + visualization).
No backend server.

End users are **students**. They access via a Vercel URL (Chromium-based browser
required for Web Bluetooth). Implementation is by the repo owner (donghyeon99).

**Python is preserved as reference implementation only** — see `linkband/` directory.
The Python parser produces validation outputs against which the TS parser is checked
(byte-for-byte and value-for-value). Python code is no longer actively developed
beyond reference parity.

## Status

- **Protocol spec is locked**: `docs/01-protocol-spec.md` (533 lines, reverse-engineered
  from [LooxidLabs/SDK-Android](https://github.com/LooxidLabs/SDK-Android) Kotlin SDK
  and [LooxidLabs/link_band_sdk](https://github.com/LooxidLabs/link_band_sdk) Python core).
- **Progress & decision log**: `docs/02-progress-log.md` — chronological record of
  everything since repo init. **Read this first** to know current state, then add an
  entry whenever meaningful work happens (commit, decision, verification, issue).
- **Bundle 1 (data model)** and **Bundle 2 (open questions strategy)** decisions are
  LOCKED — see §13 and §17 of the spec. Do not re-debate these unless explicitly flagged.
- **Bundle 3 (API surface for student DX)** and **Bundle 4 (WebSocket format / repo
  layout / MVP order)** are deferred — to be revisited once code skeleton exists.
- For current implementation state, see `docs/02-progress-log.md`. Do not duplicate
  status here — keep this section pointing at the log.

## Architecture

```
[Link Band headband] ──BLE (Web Bluetooth API)──> [Browser TS app]
                                                  · scan / connect / GATT
                                                  · packet parse
                                                  · DSP filters
                                                  · metrics (BPM, HRV, band power)
                                                  · React/Canvas visualization
```

Constraints: Web Bluetooth requires Chromium (Chrome/Edge), HTTPS or localhost,
and a user gesture (button click) to call `requestDevice()`. Vercel auto-provisions
HTTPS so production is fine.

## Immediate next step

Scaffold **`web/`** — Vite + TypeScript (strict). First milestone: scan → connect →
CCCD enable → EEG `start` write → display per-sensor packet counts. No parsing yet,
no charts. This is the TS analogue of the Python `spike_dump.py` and validates the
Web Bluetooth path before building higher layers.

After scaffold: `web/src/linkband/models.ts` (port from `linkband/models.py`),
`web/src/linkband/parser.ts` (port from `linkband/parser.py`), `web/src/linkband/ble.ts`,
then visualization.

See progress-log for detailed P0 sequence.

## Working style preferences

### TypeScript (primary, in `web/`)

- **Strict mode** TS (`tsconfig.json` with `"strict": true`).
- Use `Uint8Array` / `DataView` for binary parsing. Mirror Python's `int.from_bytes`
  semantics carefully (note `DataView.getUint32(0, true)` for LE uint32).
- Keep parser stateless or with explicit state object — no globals. Mirror the
  Python `Parser` class API where it makes sense.
- Vite + TS for build. `vitest` for unit tests. ESLint + Prettier.
- Vanilla TS for first milestone; adopt React when entering visualization phase.
- Type sensor batches as plain objects with `Float64Array` / `Int32Array` /
  `Int16Array` typed arrays — TS analogue of numpy ndarrays for performance.
- Comments only for the **WHY** (24-bit sign extension, μV conversion, byte order).

### Python (reference, in `linkband/`)

- Frozen at commit `be16261` (parser 15/15 GREEN). Touch only when fixing
  reference-parity bugs that affect TS validation.
- `uv` for dep mgmt; `ruff` for lint; `pytest` for tests.

### Cross-validation discipline

- Same fixture hex bytes (`tests/fixtures/real*/`) feed both Python and TS parser
  tests. Outputs (per-sample values, μV conversions, timestamps) must match
  byte-for-byte / float-equality.
- When a discrepancy emerges, Python's output is the reference UNLESS the divergence
  is documented in spec/progress-log (e.g., the §8 PPG sign-extension fix).

## Logging discipline (mandatory)

For every meaningful unit of work — a commit, a locked decision, an empirical
verification, an issue/blocker, a fix — **add one entry at the top of `docs/02-progress-log.md`**.
This is non-negotiable: it's how the supervisor session and any future session
reconstruct what happened and why.

Entry tags: `[DECISION]`, `[PROGRESS]`, `[VERIFIED]`, `[ISSUE]`, `[FIX]`. Body should
state *what*, *result/decision*, *next step*, *references* (spec §, commit hash, file).
If a decision changes the spec, update `01-protocol-spec.md` in the same commit and
note the section in the log entry. See the file's "사용 규칙" header for full format.

When starting a new session, **read `docs/02-progress-log.md` first** before doing
anything — that is the source of truth for current state, not CLAUDE.md.

## Locked decisions (do NOT re-litigate)

From spec §13 (Bundle 1):
- Timestamps: `t_device` (header) + `t_recv` (wall-clock) both stored
- EEG: raw int + μV float both stored
- `t_start` as float epoch sec
- Sample timestamps interpolated uniformly from packet header (Kotlin parity)
- ACC dtype: `int16`; decoder isolated as `_decode_acc_sample()` for hypothesis A/B swap
- `lead_off: bool` (Kotlin parity) + `lead_off_raw: uint8` (bitmask preservation)

From spec §17 (Bundle 2): the six open questions Q1–Q6 are documented as
**verification-only**, with strategies in place that don't depend on resolution.
They get answered when a real device is first connected.

## Cross-references for data-processing implementation

The spec in `docs/01-protocol-spec.md` is **a snapshot derived from these sources**.
For any data-processing code (`parser.py`, `dsp.py`, `metrics.py`, packet handling
in `ble.py`), consult the original sources directly — the spec is convenient but
authority lives in the upstream code.

### Authoritative upstream sources

| # | Source | Role | Specific files to read |
|---|---|---|---|
| 1 | https://github.com/LooxidLabs/SDK-Android (`develop` branch) | **Primary** Kotlin reference. Cleanest, smallest. The whole spec is derived from these 7 files. | `src/main/java/com/looxidlabs/sdkandroid/SensorDataParser.kt` (parsing), `BleManager.kt` (UUIDs, GATT sequence), `SensorConfiguration.kt` (magic numbers), `SensorData.kt` (data model) |
| 2 | https://github.com/LooxidLabs/link_band_sdk | **Cross-validation** Python reference (~80 files). Compare parsing edge cases against ours. | `python_core/app/core/device.py`, `python_core/app/core/signal_processing.py`, `python_core/device.py` |
| 3 | https://github.com/donghyeon99/sensor-dashboard | **Predecessor repo** (mock-data based React dashboard). Has DSP filters, chart components, EEG/PPG metric implementations that may be reusable when we get to P1/P2. | `src/lib/dsp/` (biquad, eegPipeline, ppgPipeline, spectrum), `src/lib/sensors/` (adapters, types), `src/lib/thresholds/`, `src/components/eeg/`, `src/components/ppg/` (PPGBpmTrendChart etc.), `src/stores/slices/` (eegStore, ppgStore) |
| 4 | `../sensor-dashboard/.tmp_kotlin/` (local sibling, gitignored) | Offline cache of source #1. Same content, no network required. | `BleManager.kt`, `SensorDataParser.kt`, `SensorConfiguration.kt`, `LinkBandSdk.kt` |

### When to cross-reference (not optional)

- **Writing `parser.ts`**: cross-reference both `linkband/parser.py` (this repo,
  reference impl, GREEN) AND source #1 `SensorDataParser.kt`. The Python is the
  authoritative numerical reference. Any divergence from Python must produce
  identical numerical outputs on shared fixtures.
- **Writing `ble.ts`**: read source #1 `BleManager.kt` for GATT sequence,
  CCCD enable order, EEG `start`/`stop` write payload. Web Bluetooth API differs
  from Android `BluetoothGatt` — check `linkband/spike_dump.py` for the bleak
  variant. spec §4–§5 is summary only.
- **Writing DSP / metrics in TS**: source #3 `sensor-dashboard/src/lib/dsp/`
  is **TypeScript already** — port directly with minimal translation. This is a
  major win of the TS pivot: existing biquad/eegPipeline/ppgPipeline/spectrum
  code can be reused.
- **Resolving any ambiguity in spec**: source #1 (Kotlin) is canonical for
  protocol. Empirical findings in `tests/fixtures/real*/` override Kotlin where
  they disagree (e.g., 500 Hz EEG, 16-bit LE ACC — Kotlin had bugs). Python
  parser is canonical for numerical conversion (μV, timestamps).

### How to access

- Online (any session): `WebFetch` for the GitHub URLs; or `curl https://raw.githubusercontent.com/{repo}/{branch}/{path}`.
- Offline: source #4 (`../sensor-dashboard/.tmp_kotlin/`) for the four core Kotlin
  files. Source #3 also lives locally at `../sensor-dashboard/`.

## Conversation history

This repo was scaffolded on 2026-05-01 in a Claude Code session whose cwd was the
sibling repo `../sensor-dashboard/` (the previous mock-data based dashboard). The
spec was developed and locked in that session. Subsequent work continues in this
repo. The previous session's work is archived in
`../sensor-dashboard/docs/linkband-sdk-spec/01-protocol-spec.md` (identical to
this repo's `docs/01-protocol-spec.md`).
