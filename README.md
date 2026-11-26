# OBD Scanner (v1)

A Torque / Car Scanner-style OBD-II app that runs in **Chrome on Android** and talks to a
**Bluetooth LE ELM327-style dongle** over Web Bluetooth. Plain HTML/JS/CSS with no build step, installable as a PWA.

## Use
1. Open the site in Chrome on the phone (it has to be HTTPS for Web Bluetooth). Allow Bluetooth and Nearby devices.
2. Close Torque / Car Scanner. A BLE dongle only talks to one app at a time.
3. **Connect** tab, then **Connect dongle**, then pick `OBDII`. If it isn't listed, use **Show all Bluetooth devices**.
4. **Live**: pick a profile and tap Start live. **Record** saves a session (the screen stays awake while it records).
5. **Logs**: view the charts or export a session to CSV (or Share it to Gmail, Drive or Sheets).
6. **Codes**: read stored, pending and permanent codes, view the freeze frame, and clear codes (it asks you to confirm first).
7. **Console**: shows the raw TX/RX traffic and lets you type manual commands. Use **Copy log** to send it for debugging.
8. **Demo mode** runs against a simulated ELM327 and car, so no hardware is needed.

If live data stalls on a real car, turn off *Multi-PID requests* and *Fast response* in Settings and reconnect.

## Architecture
| File | Role |
|---|---|
| `js/elm.js` | Pure ELM327 response parsing: cleans prompt, echo and `SEARCHING...`, detects errors, handles ISO-TP multi-frame (`014` / `0:` `1:`), multi-PID and multi-ECU responses, supported-PID bitmasks, and VIN. |
| `js/pids.js` | Mode 01 PID library (formulas, units, ranges, categories), imperial/metric conversion, preset profiles. |
| `js/dtc.js` | DTC decoding for modes 03/07/0A (CAN count byte and legacy padded formats), MIL status, short descriptions. |
| `js/transport.js` | `BleTransport` (Web Bluetooth: tries the known BLE-serial services FFF0, FFE0, 18F0, E7810A71 (Vlink), Nordic UART, AE30, FF00 and FFB0, then auto-picks any notify+write pair), `MockTransport` (simulated ELM and car), `ElmSession` (serialized command queue that waits for the `>` prompt, with timeouts). |
| `js/obd.js` | High-level operations: init (`ATZ ATE0 ATL0 ATS0 ATH0 ATAT1 ATSPx 0100 ATDPN ATRV`), supported PIDs, VIN (0902), DTCs, clear (04), batched PID polling with automatic fallback, freeze frame (mode 02). |
| `js/storage.js` | Settings and profiles in localStorage. Recorded sessions in IndexedDB (`sessions` + `rows`), flushed every 2 s while recording. |
| `js/chart.js` | Dependency-free canvas line chart. |
| `js/app.js` | UI controller (tabs, live tiles, recording, logs, profile editor, codes, console). |
| `sw.js`, `manifest.webmanifest` | PWA. Network-first, so it updates when online and still works offline. |

Recorded values are stored in metric. Unit conversion happens at display and CSV-export time.

## Adding a PID
Add one entry to `DEFS` in `js/pids.js`:
```js
{ pid: '5C', name: 'Engine oil temperature', short: 'Oil temp', bytes: 1, unit: '°C', kind: 'temp',
  min: -40, max: 160, cat: 'Temperatures', f: function (A) { return A - 40; } },
```
`bytes` must match what the ECU returns, because multi-PID responses are split using it. `kind` picks the imperial conversion
(`temp`, `speed`, `pressure`, `flow`, `distance`, `volume_rate`, `none`). The PID then shows up in the profile editor
automatically. Add a mock value in `MockTransport.prototype._pidData` (and to `MockTransport.SUPPORTED`) to see it in Demo mode.
Manufacturer mode 21/22 PIDs would need a new request path in `obd.js`. That isn't in v1.

## Tests
```
node --test tests/core.test.js          # parsing, PID formulas, DTCs, queue, full mock-dongle session
npm i --no-save puppeteer-core && node tests/e2e-mock.js [url]   # headless Chrome run in Demo mode
```

## Run locally
`python3 -m http.server 8080`, then open http://localhost:8080. localhost counts as a secure context, so Web Bluetooth works on desktop Chrome too.
