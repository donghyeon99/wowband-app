# linkband

Link Band BLE SDK + DSP toolkit (Python).

Educational tool — students consume the resulting Python package and notebooks; the SDK
itself is implemented here directly against the BLE protocol.

## Status

WIP. Protocol spec is locked in `docs/01-protocol-spec.md` based on reverse-engineering
the official [SDK-Android](https://github.com/LooxidLabs/SDK-Android) (Kotlin) and
[link_band_sdk](https://github.com/LooxidLabs/link_band_sdk) (Python+Electron) repos.

Implementation has not started. The first module to land will be `linkband/models.py`.

## Architecture

```
[Link Band headband] ──BLE──> [Python] ──WebSocket──> [React viewer]
                              · BLE connect (bleak)
                              · packet parse
                              · DSP filters
                              · metrics (BPM, HRV, band power)
```

Python owns BLE connection, parsing, DSP, and metric computation.
React side is a viewer only.

## Setup

```bash
uv sync
```

## License

TBD
