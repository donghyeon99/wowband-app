# linkband-app — Project Context

## What this is

Educational sensor analysis tool. Python implements the full **Link Band BLE SDK**
(connection, packet parsing, DSP, metric computation). React side is a thin viewer
that consumes WebSocket messages — no business logic on the frontend.

End users are **students**. Implementation is by the repo owner (donghyeon99);
students consume the resulting Python package and notebooks rather than co-authoring.

## Status

- **Protocol spec is locked**: `docs/01-protocol-spec.md` (533 lines, reverse-engineered
  from [LooxidLabs/SDK-Android](https://github.com/LooxidLabs/SDK-Android) Kotlin SDK
  and [LooxidLabs/link_band_sdk](https://github.com/LooxidLabs/link_band_sdk) Python core).
- **Bundle 1 (data model)** and **Bundle 2 (open questions strategy)** decisions are
  LOCKED — see §13 and §17 of the spec. Do not re-debate these unless explicitly flagged.
- **Bundle 3 (API surface for student DX)** and **Bundle 4 (WebSocket format / repo
  layout / MVP order)** are deferred — to be revisited once code skeleton exists.
- **No code yet.** First commit (`a0ac3cd`) is empty scaffold.

## Architecture

```
[Link Band headband] ──BLE──> [Python] ──WebSocket──> [React viewer]
                              · BLE connect (bleak)
                              · packet parse
                              · DSP filters
                              · metrics (BPM, HRV, band power)
```

## Immediate next step (P0 from spec §16)

Implement **`linkband/models.py`** per spec §13.

- Method **가** (assistant drafts → owner reviews → commit) for this file.
- After this file the method may switch to **나** (owner writes → assistant reviews) —
  confirm at the time.
- After `models.py`: `linkband/parser.py` (testable with synthetic packets, no real
  device needed). Then `linkband/ble.py` (needs real device).

## Working style preferences

- Professional Python: type hints, dataclasses, numpy. Educational comments only for
  the **WHY** (e.g., 24-bit sign-extension, μV conversion formula).
- **numpy batch dataclasses**, not per-sample objects (250 Hz EEG would explode).
- `uv` for dependency management. `uv sync` to set up.
- Python **3.12**.
- Format/lint: `ruff` (configured in pyproject.toml).

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

- **Writing `parser.py`**: read source #1 `SensorDataParser.kt` line-by-line. If your
  Python diverges from Kotlin in any way (other than the documented Q1/Q2 strategy
  and the §8 PPG sign-extension fix), justify the divergence in code comment + spec.
- **Writing `ble.py`**: read source #1 `BleManager.kt` for the GATT sequence,
  CCCD enable order, and EEG `start`/`stop` write payload. The spec §4–§5 is a
  summary; the original has timing details (sleeps, retries) that matter.
- **Writing `dsp.py` or `metrics.py`**: check source #3 `sensor-dashboard` first —
  it likely already has band-pass filters, BPM detection, HRV. Reuse the algorithms
  (port to Python) rather than redesigning.
- **Resolving any ambiguity in spec**: source #1 is canonical. If source #1 and
  source #2 disagree, document the discrepancy in spec §17 and pick the safer
  interpretation with rationale.

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
