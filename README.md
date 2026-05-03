# wowband-app

Link Band BLE SDK — browser app (TypeScript + Web Bluetooth API), deployable as a
single static SPA.

Educational tool: students access via URL on Chromium-based browsers (Chrome / Edge),
click Connect, and stream EEG / PPG / accelerometer data from the headband directly
to the browser. No backend server.

## Status

- Protocol spec is locked in `docs/01-protocol-spec.md`, reverse-engineered from
  the official [SDK-Android](https://github.com/LooxidLabs/SDK-Android) (Kotlin)
  and [link_band_sdk](https://github.com/LooxidLabs/link_band_sdk) (Python+Electron)
  repos, plus on-device verification.
- TypeScript implementation: BLE GATT scan/connect, packet parser
  (15 parser tests + 67 DSP tests, all GREEN), DSP (EEG filter cascade, PPG
  bandpass, EEG/PPG SQI, FFT spectrum, Morlet wavelet band power, EEG indices,
  HRV/HR with IQR+weighted+gated BPM), and visualization (EEG / PPG / ACC views
  with rich threshold-aware cards and hover tooltips matching the
  [sdk.linkband.store](https://sdk.linkband.store) reference).
- Numerical results reconciled against the deployed reference on 2026-05-02 —
  see the `[FIX] [PROGRESS]` entry in `docs/02-progress-log.md` (DSP formulas /
  visualization / ACC unit fix).
- Deployable as a Vercel static SPA. Web Bluetooth requires Chromium (Chrome /
  Edge), HTTPS or localhost, and a user gesture (button click) to call
  `requestDevice()`.

For implementation history and decision log, see `docs/02-progress-log.md`.
For an implementation tour with code excerpts, see `docs/03-code-walkthrough.md`.

## Architecture

```
[Link Band headband] ──BLE (Web Bluetooth)──> [Browser TS app]
                                              · GATT scan / connect
                                              · packet parse (parser.ts)
                                              · DSP (filters, SQI, spectrum, indices)
                                              · ECharts visualization
                                              · Real-time throttled update loop
```

UI is vanilla TypeScript + ECharts (no React). Charts are throttled by frame
counter — filtered traces tick every batch (50 ms), heavy DSP (band power /
indices / Morlet wavelet) every 10 batches (500 ms) — to keep the main thread
responsive.

## Repo layout

```
wowband-app/
├── docs/
│   ├── 01-protocol-spec.md      ← BLE protocol (locked)
│   ├── 02-progress-log.md       ← decision/progress log (newest entry on top)
│   └── 03-code-walkthrough.md   ← implementation tour with code excerpts
├── src/
│   ├── linkband/                ← models, parser, dsp, thresholds
│   ├── ui/                      ← chart wrapper, layout, eeg/ppg/acc views, *-card
│   ├── uuids.ts
│   └── main.ts                  ← entry: mount layout, wire BLE/Replay handlers
├── tests/                       ← vitest (parser + DSP)
├── public/
│   └── fixtures/                ← BLE byte-dump replay fixtures (dev-only, gitignored)
├── package.json                 ← single source of truth for version
├── vite.config.ts               ← injects __APP_VERSION__ from package.json
├── tsconfig.json
└── index.html
```

## Setup

```bash
npm install
npm run dev        # vite dev server (Chromium browser)
npm run build      # production build → dist/
npm run test:run   # vitest (parser + DSP suites)
```

## Versioning

The `package.json` `version` field is the single source of truth. Vite injects it
into the bundle as `__APP_VERSION__`, and the UI shows it as a small badge in the
header. Bumps happen on the **last commit of a release-worthy batch** and are
followed by a matching `git tag v0.X.Y`.

## License

TBD
