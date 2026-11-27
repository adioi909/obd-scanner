# OBD Scanner (v1.7.0)

A Torque / Car Scanner-style OBD-II app that runs in **Chrome on Android** and talks to a
**Bluetooth LE ELM327-style dongle** over Web Bluetooth. Plain HTML/JS/CSS with no build step, installable as a PWA.

**User manual and tips:** see [MANUAL.md](MANUAL.md) in this repo, or open **Help** in the app header
(https://adioi909.github.io/obd-scanner/manual.html). A printable PDF is built as
`OBD-Scanner-v1.7-User-Manual.pdf`. The manual covers every tab, what the app can and cannot change
on the vehicle (the only UI write is Mode 04 clear codes / reset MIL, which also resets readiness
monitors), diagnosis tips, Bluetooth troubleshooting, and a reference for the 2013 Mitsubishi test car.

## v1.7.0 safety, long drives, background recovery, enhanced PIDs
- **Service worker hygiene:** precache is the app shell plus `manual.html` only; `.md`, `.pdf`, `.zip` and `GROK_BUILD_BRIEF.md` are never precached or runtime-cached. Cache `obd-scanner-v1.7.0`.
- **Console interlock:** commands starting with `04`, `10`, `11`, `27`, `2E`, `2F`, `31`, `34`, `36`, `37` need an explicit confirm (Cancel is the default). `ELM.classifyCommand()` in `js/elm.js`.
- **Dirty adapter state:** manual `ATZ/ATD/ATE/ATH/ATS/ATSP/ATSH/ATCAF/ATCRA` marks the adapter dirty (`ELM.markDirty`), shows a banner with Re-run init, and Live calls `Obd.resync()` before polling.
- **Charts / storage:** `Chart.lttb()` downsamples sessions over 1,000 samples to 500-800 drawn points; `Chart.summary()` gives min/avg/max from the full data. `Store.createRowBuffer()` writes in batches (25 samples / 3 s) and force-flushes on stop, hidden, pagehide and beforeunload.
- **Background:** on return to visible the wake lock is re-acquired; a stale in-flight command is dropped with `ElmSession.abortPending()` (and `clearQueue()` no longer leaves the pump stuck); `[BACKGROUND GAP: Xs]` is logged and stored in `meta.gaps`.
- **Enhanced PIDs:** `PIDS.ENHANCED` entries carry `request`, `txHeader`, `rxFilter`, `byteIndex` and `decode(dataBytes)`. `Obd.queryPids` groups them by header, sends one request per header+request, only sends `ATSH`/`ATCRA` when the target changes (tracked in `obd.adapter`), always restores `ATSH7DF` + `ATCRA`, and marks a PID N/S after 3 consecutive failures. Experimental preset **Mitsubishi CVT (Experimental)**: `ATSH7E1`, `ATCRA7E9`, `2103`; N = data byte 13; main formula is the JF011E 5th-order polynomial, with N-55 and raw N alongside (sources and caveats in MANUAL.md section 17).
- BLE connect/retry state machine unchanged.

## v1.6.1 freeze frame empty state and Help
v1.6 already worked on the car. After a recorded Quick look session, Read codes and Freeze frame are
blocked with "Stop recording first" until you stop (a toast reports how many samples were saved).
Read codes found pending P0420 and 0 stored. Freeze frame is only stored with a confirmed (Mode 03)
code, so a pending-only P0420 usually has none — in v1.6 the "Reading freeze frame..." card could look
like nothing appeared. v1.6.1 shows a clear empty message: "No freeze frame stored (normal when there
are only pending codes)," plus a toast, and scrolls that card into view. A Help link in the header
opens the user manual.


## v1.6 live gauges and profile switching
v1.5 connected cleanly on the car, but live data only updated RPM. The poll loop captured the PID list once at "Start live" and never rebuilt it, so switching to Quick look or Air intake still polled the previous profile (the O2 / Catalyst supported subset: 0C, 15, 06, 07). Only RPM (0C) exists on those other screens, so every other tile stayed at "--". The replies themselves were fine (`410C0B0C`, `41151C80`, `410680`, `410781`, including one split `41151C8` + `1\r\r>`).

v1.6 rebuilds the poll list on every cycle from the selected profile (filtered to supported PIDs), so a mid-live profile change takes effect on the next request. Record stores a copy of every decoded value and grows the session PID list as new ones appear; CSV columns are the union of the session PIDs and every key actually recorded.

## v1.5 persistent connect (intermittent first-op hang)
On the real dongle (Realtek RTL8773BFR clone) the first GATT operation after discovery **hangs intermittently**, whichever characteristic is touched first (v1.3 got through on a later reconnect; v1.4 hung on ffea, fff1, ffea and a write in one run). A hung op wedges the whole link (even writes hang) until you disconnect, so channel order is not the fix. v1.5 instead keeps reconnecting and varies what it does:

- **Up to 10 attempts / ~90 s**, with a visible counter ("Connecting… attempt 4/10") and a **Cancel** button. Hang timeouts are ~4 s (a hang never recovers, so fail fast and reconnect fresh).
- **Ten variants**, cycled: which notify characteristic goes first (ffea/fff1), settle delay after connect before the first op (400 / 1500 / 3000 ms), discovery with `getPrimaryServices()` or directly `getPrimaryService('fff0')`, diagnostics (`getDescriptors` / `getDescriptor(0x2902)`) on or off, and one write-first variant. Wait after disconnect before reconnecting grows 1 s / 1.5 s / 2 s / 3 s so the dongle's own BLE stack can reset.
- If one notify characteristic subscribes and the next one hangs, the following attempt puts the one that worked first and keeps the other in reserve (init subscribes it only if no RX arrives).
- Every attempt logs its variant, settle, discovery mode, diagnostics on/off and the result. The **winning variant is stored in localStorage** (`obd.bleVariant`) and tried first next time.

## v1.4 live data and a faster connect
v1.3 connected on the real 2013 Mitsubishi (ELM327 v1.5, ISO 15765-4 CAN 11/500, 39 PIDs). The working BLE recipe is: subscribe **ffea first, then fff1**, and listen on **fff1** (writes go to fff2 with writeWithoutResponse). v1.4 does that on the first attempt instead of burning a 5s fff1 hang plus a 12s ATZ timeout on the wrong channel. Rotation and write-first stay as fallbacks. If a later subscribe hangs after an earlier one succeeded, the next reconnect retries only the characteristic that worked.

Live gauges showed "--" while the read counter climbed at about 0.5 Hz. Multi-PID requests (for example `010C0D05044211`) were waiting until the 1500ms command timeout and then **skipping** the single-PID fallback, so every tile stayed empty. v1.4 always falls back to single-PID requests (and drops the fast-response `1` suffix if that is the problem) when a multi-PID reply times out, returns NO DATA/?, or does not decode, and it logs every live request/response (for example `Live 010C0D05044211 -> TIMEOUT (no RX)`). Init also sends `ATAL` so long ISO-TP replies are allowed.

Pull-to-refresh is disabled (`overscroll-behavior: none`) so a swipe cannot reload the page and drop the GATT session. After an unexpected disconnect the previous GATT link is cleaned up and the app waits briefly before the next connect.

## v1.3 stuck-subscribe handling
Some dongles hang `startNotifications` (the CCCD write, which can also trigger bonding). v1.3 rotates strategies across up to 3 reconnects: (0) fff1 first, 5s; (1) **ffea first**, 10s; (2) fff1 first, 15s; (3) **write-first**: attach listeners, write `ATZ`, then startNotifications. The UI status says "possible pairing prompt - check phone" while it waits. Before each subscribe it logs full characteristic properties, descriptors (is there a CCCD 2902?) and readValue if the characteristic is readable. "Forget and re-pick device" (Connect tab) drops the browser's saved device permission so the picker starts clean.

## v1.2 Bluetooth reliability (Android GATT rules)
Android allows exactly **one** outstanding GATT operation per device. v1.1 subscribed to two notify characteristics in parallel, which made one fail instantly and the other hang, and the hung op then blocked every later write. v1.2:

- **One GATT queue.** Every GATT call (connect, discovery, startNotifications, writes) goes through a single serialized chain with a per-op timeout.
- **Sequential subscribe.** 400ms after connect, subscribe **fff1 first** (retry once after 500ms on failure). `ffea` is held in reserve and only subscribed if the adapter gives no RX at all, or fff1 cannot be enabled.
- **Hung op = poisoned link.** A timed-out GATT op is never followed by more GATT calls. The app disconnects, waits 1s, reconnects, rediscovers and resubscribes (max 2 attempts), then retries. If that fails the link is declared dead, the queue is aborted and the status shows "Bluetooth link failed". Init does not spray commands into a dead link.
- **"Already in progress" = busy.** Wait with backoff (150/300/600/1000/1500 ms) and retry the same op. It is never counted as no-RX and never switches write mode.
- **Write mode.** Prefers writeWithoutResponse. It switches (once, not per command) only if a write throws/hangs before any RX has ever arrived, after the reconnect, or once during init if the adapter is completely silent.
- **Settings:** BLE notify characteristic (Auto / fff1 only / ffea only) and write mode (Auto / with response / without response), applied on the next connect.

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
| `js/transport.js` | `BleTransport` (Web Bluetooth with the serialized GATT queue and reconnect logic described above; known services FFF0, FFE0, 18F0, E7810A71 (Vlink), Nordic UART, AE30, FF00, FFB0, then any notify+write pair), `MockTransport` (simulated ELM and car), `ElmSession` (serialized command queue that waits for the `>` prompt, with timeouts). |
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
Manufacturer mode 21/22 PIDs go in `ENHANCED` in `js/pids.js` (request, txHeader, rxFilter, decode). They are read-only.

## Tests
```
node --test tests/core.test.js tests/ble.test.js tests/v17.test.js   # parsing, PIDs, DTCs, queue, mock dongle, fake Android GATT stack (tests/fake-gatt.js)
npm i --no-save puppeteer-core && node tests/e2e-mock.js [url]   # headless Chrome run in Demo mode
```

## Run locally
`python3 -m http.server 8080`, then open http://localhost:8080. localhost counts as a secure context, so Web Bluetooth works on desktop Chrome too.
