# OBD Scanner User Manual

**Version 1.7.1**  
Field OBD-II scanner for Chrome on Android and a Bluetooth LE ELM327-style dongle.

Live app: https://adioi909.github.io/obd-scanner/  
Source: https://github.com/adioi909/obd-scanner  
In the app, tap **Help** in the header to open this manual.

This manual describes what the app actually does. It does not invent features. Notes about the 2013 Mitsubishi test car come from real sessions, including a v1.6 screen recording on the vehicle.

---

## Contents

1. [What this app is](#1-what-this-app-is)
2. [Requirements](#2-requirements)
3. [Install on the phone (PWA)](#3-install-on-the-phone-pwa)
4. [Quick start](#4-quick-start)
5. [Connect tab](#5-connect-tab)
6. [Live tab](#6-live-tab)
7. [Record and Logs](#7-record-and-logs)
8. [Codes tab](#8-codes-tab)
9. [Profiles tab](#9-profiles-tab)
10. [Console tab](#10-console-tab)
11. [Capabilities and limits: what can it change on the vehicle?](#11-capabilities-and-limits-what-can-it-change-on-the-vehicle)
12. [Tips and tricks](#12-tips-and-tricks)
13. [Troubleshooting](#13-troubleshooting)
14. [This vehicle (2013 Mitsubishi reference)](#14-this-vehicle-2013-mitsubishi-reference)
15. [Updating the app](#15-updating-the-app)
16. [Built-in PID library](#16-built-in-pid-library)
17. [Mitsubishi CVT (Experimental)](#17-mitsubishi-cvt-experimental)
18. [CVT Probe (v1.7.1)](#18-cvt-probe-v1-7-1)
19. [What changed in v1.7.1](#19-what-changed-in-v1-7-1)
20. [What changed in v1.7.0](#20-what-changed-in-v1-7-0)

---

## 1. What this app is

OBD Scanner is a Torque / Car Scanner-style tool that runs in the browser. It talks to a generic Bluetooth LE ELM327-style adapter over **Web Bluetooth**, reads live sensor data (Mode 01), diagnostic trouble codes (Modes 03 / 07 / 0A), freeze frame (Mode 02), and VIN (Mode 09, PID 02). The only vehicle **write** action in the user interface is **Clear codes / reset MIL** (Mode 04).

It is plain HTML, CSS and JavaScript with no build step. It is a PWA, so you can add it to the Android home screen and it still works offline after it has been cached (network-first: it tries for a fresh copy when you are online).

It is **not** a dealer scan tool (MUT-III, Techstream, IDS, and so on). It cannot flash an ECU, program keys, run bidirectional actuator tests, bleed ABS, reset most manufacturer service lights, or do TPMS relearn. See [Capabilities and limits](#11-capabilities-and-limits-what-can-it-change-on-the-vehicle).

---

## 2. Requirements

- **Phone and browser:** Chrome on Android. Web Bluetooth is required for a real dongle. Firefox, Safari, and in-app browsers generally will not work for Bluetooth. Desktop Chrome can be used for Demo mode, and Web Bluetooth may work there over localhost or HTTPS if you have a compatible adapter, but the intended use is the phone.
- **URL:** The page must be served over **HTTPS** (or localhost). The hosted address is https://adioi909.github.io/obd-scanner/.
- **Permissions:** Allow Bluetooth. Android also needs Location / Nearby devices allowed for Bluetooth scanning.
- **Dongle:** A Bluetooth LE ELM327-style adapter. The test hardware advertises as **OBDII**, uses service **FFF0**, notify characteristics **FFEA** and **FFF1**, and write characteristic **FFF2** (writeWithoutResponse). The chip is a Realtek RTL8773BFR with an epoxy-COB ELM327 clone and a SIT1040 CAN transceiver. Firmware identified as **ELM327 v1.5**.
- **The app also recognizes** other common BLE OBD services if your dongle uses them: FFE0, 18F0, Vlink (E7810A71), Nordic UART, AE30, FF00, FFB0, or any service that exposes a notify + write pair.
- **Car:** Any vehicle that supports standard OBD-II (in the US, typically 1996 and newer). How many sensors you get depends on what that ECU actually supports.
- **Close other OBD apps first.** A BLE dongle talks to only one app at a time. Force-stop Torque, Car Scanner, and anything else that might be holding the adapter in the background.

If Web Bluetooth is not available, the Connect tab shows a warning. **Demo mode** still works (a simulated ELM327 and car, no hardware).

---

## 3. Install on the phone (PWA)

1. Open https://adioi909.github.io/obd-scanner/ in **Chrome on Android**.
2. Chrome menu (three dots) → **Add to Home screen** or **Install app**.
3. Open it from the home-screen icon. It runs in standalone mode (no Chrome address bar).

The service worker caches the app so it can still load in a shop with no signal. It is network-first, so when you do have signal it tries to fetch the latest files.

To confirm the version, look at the small version label next to the **OBD Scanner** title (currently **v1.7.0**).

---

## 4. Quick start

1. Plug the dongle into the OBD-II port (usually under the dash on the driver's side).
2. **Key ON.** Engine running is fine and is what you want for live data and charging voltage.
3. **Close Torque / Car Scanner** (and force-stop them if they work in the background).
4. Open OBD Scanner. Go to the **Connect** tab.
5. Tap **Connect dongle**. In the Bluetooth picker, choose the device named **OBDII**. If it is not listed, tap **Show all Bluetooth devices** and look again. Watch the phone for a pairing prompt the first time.
6. A **Connecting** card appears with an attempt counter (for example "Connecting… attempt 4/10") and a **Cancel** button. The dongle sometimes hangs its first Bluetooth operation, so the app keeps reconnecting with different timing, up to 10 attempts (about 90 seconds). When one variant works, that recipe is remembered and tried first next time.
7. When it is connected, the **Vehicle** card fills in: adapter version, BLE link, protocol, battery (ATRV), VIN, MIL / code count, and how many PIDs the ECU supports.
8. Go to **Live**, leave the profile on **Quick look**, tap **Start live**. Tiles should start updating. Tap **Record** if you want a log, then **Stop recording** when you are done. The session shows up under **Logs**.
9. To read codes, go to **Codes**. If you are still recording, stop first (see below). Tap **Read codes**.

---

## 5. Connect tab

### Buttons

- **Connect dongle:** Opens the Chrome Bluetooth picker, filtered toward typical OBD names when possible. Starts the persistent connect (up to 10 attempts).
- **Show all Bluetooth devices:** Same connect flow, but the picker is not filtered, so odd or generic names can be chosen.
- **Demo mode (simulated car):** Connects to a built-in mock adapter. Use this to learn the UI without a car. Demo sessions are marked "demo" in Logs.
- **Disconnect:** Drops the Bluetooth (or demo) session. Hidden until you are connected.
- **Forget and re-pick device:** Forgets the browser's saved Bluetooth permission for this device so the picker starts clean. Use this after a bad pairing or if the wrong device was remembered.
- **Re-run init:** Shown after a successful connect. Re-sends the ELM init sequence and re-reads vehicle info (adapter, protocol, voltage, VIN, monitor status, supported PIDs) without tearing down the BLE link.

### Connecting card

While a real connect is in progress you will see:

- Attempt number, out of 10
- A short hint that the dongle may hang the first Bluetooth operation
- **Cancel**, which stops the retry loop

If all attempts fail, a help card appears: force-stop other OBD apps, toggle Bluetooth off and on, unpair **OBDII** in Android Bluetooth settings if it is listed, tap **Forget and re-pick device**, then Connect again. Watch for a pairing prompt. Then open **Console** and **Copy log** if you need to debug.

### Vehicle card

After a successful init:

| Field | What it is |
|---|---|
| Adapter | ELM identification (ATI), for example ELM327 v1.5 |
| BLE link | Which notify / write characteristics were used |
| Protocol | What the adapter reports (ATDPN / ATDP), for example ISO 15765-4 CAN 11/500 |
| Battery (ATRV) | Adapter-measured battery / system voltage |
| VIN | Mode 09 PID 02, if the ECU returns it |
| MIL / codes | Check-engine light state and stored-code count from PID 0101 |
| Supported PIDs | How many standard Mode 01 PIDs the ECU claims, and how many of those are in this app's library |

### Settings

Defaults are listed. Changes are saved on the phone (localStorage).

| Setting | Default | Notes |
|---|---|---|
| Units | Imperial (°F, mph, psi) | Applies immediately to Live tiles, Logs charts, freeze frame, and CSV export. Recorded values are always stored in metric; conversion happens at display time. |
| Protocol | Auto (ATSP0) | Force a protocol only if Auto cannot find the bus. This car is CAN 11-bit 500k (ATSP6). Takes effect on the next init (Re-run init or a new connect). |
| Multi-PID requests (faster on CAN) | On | Asks for several PIDs in one request. If a multi-PID reply times out, returns NO DATA / ?, or does not decode, the app automatically falls back to one PID at a time (and will drop the fast-response suffix if that looks like the problem). Turn this off if live data is flaky. |
| Fast response (append "1") | On | Appends `1` to live requests so the adapter can return after one response. Turn off if replies look truncated or empty. |
| BLE write mode | Auto | Auto prefers writeWithoutResponse (correct for this dongle). "Without response" / "With response" lock the mode. **Applies on the next connect.** |
| BLE notify characteristic | Auto | Auto runs the persistent-retry variants (including ffea-then-fff1, which is the working recipe on this dongle). "fff1 only" / "ffea only" lock the notify characteristic. **Applies on the next connect.** |
| CVT timeout (hex, ATST) | FF | v1.7.1. How long the adapter waits for the transmission module (7E1) to answer, in 4 ms units: FF is about 1 second, 64 about 400 ms. Only used while the CVT preset talks to 7E1, then the normal 200 ms timing is restored. Values outside 20 to FF fall back to FF. |
| Command timeout (ms) | 2500 | How long the app waits for an ELM prompt before a command is considered failed. Range 500–10000. |

Pull-to-refresh is disabled in the app so a downward swipe cannot reload the page and drop the Bluetooth session.

---

## 6. Live tab

1. Pick a **profile** (a set of PIDs). Built-in presets are listed below; you can add your own under **Profiles**.
2. Tap **Start live**. The button becomes **Stop live**. The status bar shows approximate read rate (Hz), sample count, and elapsed time.
3. Each tile shows the current value, unit, and min / max for this live session.
4. Tap **Record** to start saving samples (see [Record and Logs](#7-record-and-logs)).

While live (including while recording) the app requests a **wake lock** so the phone is less likely to sleep and drop the link. Chrome drops that lock every time the app goes to the background or the screen locks; since v1.7.0 the app asks for it again automatically as soon as you come back. That is still not a guarantee; see Tips.

### Background gaps

Android throttles or pauses a background tab, so polling stops while you are in another app or the screen is off. When you come back during Live, v1.7.0:

- logs a line like `[BACKGROUND GAP: 42.5s]` in the Console,
- if a recording is running, stores the gap (start, end, seconds) with the session; the session view lists the gaps,
- abandons any command that was waiting for a reply when the tab was hidden (it would otherwise sit until its timeout), so polling resumes right away instead of stalling.

Recorded data has no samples inside a gap. That is honest: nothing was read then. Keep the app in the foreground for a complete log.

You can change profiles **while live is running**, including while recording. The next poll uses the new profile's supported PIDs.

### What "--" means

A tile shows **--** when there is no value yet. That happens in two normal cases:

- **Right after you start live, or right after you switch profiles.** The tiles are redrawn empty and fill in on the next successful poll. This can take a fraction of a second to a couple of seconds depending on how many PIDs are in the list. It is not a fault.
- **The live loop has not received a decoded value for that PID** (timeout, NO DATA, or a parse miss). If it stays on -- while other tiles update, that PID may not be coming back from the ECU, or a request is failing (check Console with "Show live traffic" on).

### What "N/S" means

**N/S** means **not supported**. During connect, the app reads the ECU's supported-PID bitmaps (0100, 0120, 0140, …). If a profile includes a PID the ECU did not advertise, the tile is shown greyed with **N/S** and is not polled.

This is normal and vehicle-specific. On the 2013 Mitsubishi test car, for example:

- **Cooling system:** OIL TEMP (PID 5C) is N/S. Coolant, intake air, and ambient are supported.
- **Fuel trims:** STFT B2, LTFT B2, and O2 B1S1 are N/S. STFT / LTFT B1 and O2 B1S2 are supported.
- **O2 / Catalyst:** Only O2 B1S2, STFT B1, LTFT B1, and RPM were supported from that preset. Upstream O2 B1S1, bank 2 O2 sensors, and catalyst temperature PIDs are N/S on this ECU.

An N/S tile will never get a number on that car. That does not mean the sensor is broken; it means it is not available as a standard OBD-II PID.

### Built-in live presets

| Preset | PIDs included |
|---|---|
| Quick look | RPM, Speed, Coolant, Engine load, Module voltage, Throttle |
| Cooling system | Coolant, Intake air, Ambient, Oil temp, RPM, Speed, Engine load, Module voltage |
| Fuel trims | STFT B1, LTFT B1, STFT B2, LTFT B2, O2 B1S1, O2 B1S2, MAF, RPM, Engine load, Coolant |
| Air intake | MAF, MAP, Intake air, Baro, Throttle, RPM, Engine load |
| O2 / Catalyst | O2 B1S1, O2 B1S2, O2 B2S1, O2 B2S2, Cat temp B1S1, Cat temp B1S2, STFT B1, LTFT B1, RPM |
| Charging / electrical | Module voltage, RPM, Engine load, Coolant |
| Mitsubishi CVT (Experimental) | CVT temp (Exp), CVT N-55 (Exp), CVT raw N (Exp), Coolant, RPM. Read-only Mode 21 request to the transmission module. See [section 17](#17-mitsubishi-cvt-experimental) |

Unsupported PIDs in a preset still appear as N/S so you can see what the profile asked for.

---

## 7. Record and Logs

**Record** (Live tab) starts a session. If live is not already running, it starts live for you. The button becomes **Stop recording**. While you record, you can still switch profiles; new PIDs are added to the session as they appear.

When you stop, a toast reports how many samples were saved, for example: **Saved 220 samples to Logs**.

Open the **Logs** tab to see recorded sessions: name, sample count, duration, average rate, and a "demo" tag if it was recorded in Demo mode.

- **View** opens stacked line charts, one graph per PID, with min / avg / max, in your current unit setting. (A recorded Quick look drive shows RPM, speed, coolant, load, module voltage, and throttle as separate graphs.)
- **CSV** (on the list) or **Export CSV** (in the session view) downloads a comma-separated file you can open in Excel or Google Sheets. Columns are `timestamp`, `elapsed_s`, then one column per PID (header includes the name, PID id, and unit). Values use your current unit setting. Empty cells mean that sample did not include that PID (for example after a mid-session profile switch, earlier rows will not have the later PIDs).
- **Share** appears in the session view when the browser supports the Web Share API. You can send the CSV to Gmail, Drive, Sheets, and similar apps.
- **✕** deletes the session, after a confirmation. This cannot be undone.
- **Back** returns to the session list.

Recorded data stays on the phone (IndexedDB). It is not uploaded anywhere.

**How samples are saved (v1.7.0).** Samples are buffered in memory and written in batches: every 25 samples or every 3 seconds, whichever comes first, in one database transaction each. The buffer is also written immediately when you tap Stop recording, when the app goes to the background (`visibilitychange` hidden), on `pagehide`, and before the page unloads, so the last few seconds are not lost. If a write fails, the rows are kept and retried on the next batch.

**Long drives (v1.7.0).** A session with more than 1,000 samples is downsampled **for drawing only**, using LTTB (Largest-Triangle-Three-Buckets) to roughly 500–800 points depending on the screen width. LTTB keeps the shape, including single-sample spikes and dips. The **min / avg / max** numbers above each chart and the **CSV export** always use every recorded sample. The session view says "charts downsampled for drawing" when that happens.

If you try to leave the page while a recording is in progress, the browser will warn you. Still, stop recording before you close the app.

---

## 8. Codes tab

Three actions:

- **Read codes** — stored (Mode 03), pending (Mode 07), and permanent (Mode 0A), plus MIL status from PID 0101.
- **Freeze frame** — Mode 02 snapshot, if the ECU has one.
- **Clear codes / reset MIL** — Mode 04. Asks for confirmation first.

### Stop recording first

**Read codes**, **Freeze frame**, and **Clear codes** are blocked while a recording is running. You will see a toast: **Stop recording first**.

This is intentional. Those commands would interrupt the live poll stream and punch holes in the log. Go to Live, tap **Stop recording** (you should see "Saved … samples to Logs"), then come back to Codes.

Live data that is **not** recording is paused automatically while a code or freeze-frame read runs, then resumed.

### What the three code lists mean

| List | Meaning |
|---|---|
| Stored (confirmed) | The ECU has seen the fault enough times to confirm it (typically two drive cycles). These are the codes that usually turn the MIL on and that usually have a freeze frame. Mode 03. |
| Pending | The fault failed once this drive cycle and is not yet confirmed. The MIL is often still off. Mode 07. |
| Permanent | Stored in non-volatile memory after a confirmed emissions-related fault. **You cannot clear these with Mode 04.** They clear themselves after the related monitor has run and passed. Mode 0A. |

Each code shows its number and, when the library has one, a short description. Tapping a code opens a Google search (if the VIN looks like this Mitsubishi, the search includes the make).

On the test car, a typical v1.6 read was: **pending P0420** (Catalyst system efficiency below threshold, bank 1), **0 stored**, MIL off.

### Freeze frame

A freeze frame is a snapshot of sensor values **at the moment a code was confirmed and stored**. It is meant to show what the engine was doing when the fault set (RPM, load, coolant, fuel trims, and so on).

**Pending-only codes usually have no freeze frame.** If Read codes shows a pending P0420 and zero stored codes, Freeze frame will almost always come back empty. That is normal, not a crash.

Tap **Freeze frame**. The freeze-frame card (under the code lists) first shows **Reading freeze frame…**. Then:

- If a frame exists, you get a table of PID values for the stored DTC.
- If none exists, v1.6.1 shows: **No freeze frame stored (normal when there are only pending codes).** A toast repeats the same message, and the card scrolls into view so it is not missed below the code lists.

(In v1.6 the empty result could look like "nothing happened" if you did not scroll down or notice the short "No freeze frame stored." line.)

### Clear codes / reset MIL — read this before you tap it

The button asks you to confirm. The dialog says this erases **stored and pending codes** and **freeze frame data**, and **resets all readiness monitors**. The car will show **"not ready" for emissions** until a complete drive cycle finishes and the monitors run again. The app also tells you: engine should be **OFF**, key **ON**.

Consequences, in plain language:

- The check-engine light (MIL) turns off if it was on for a code you just cleared.
- Stored and pending codes are erased. If the fault is still there, pending (and later stored) codes will come back.
- **Permanent codes are not erased** by this command. They self-clear after the monitor passes.
- Inspection / emissions testing often fails or is refused while readiness monitors are "not ready," even if the light is off. Do not clear codes just before a test.
- You lose the freeze frame, which is useful evidence of the conditions that set the code.

Clearing codes does not fix anything. It only erases the record.

---

## 9. Profiles tab

A profile is a named list of PIDs used on the Live tab.

- Built-in presets cannot be edited or deleted from this screen; they are always available.
- **New profile** opens an editor. Give it a name, tap PIDs to include (they are grouped by category: Engine, Fuel, Air, Temperatures, O2 / Catalyst, Emissions, Electrical, Status), then **Save**.
- Saved custom profiles can be **Edit**ed or deleted (with confirmation).
- Custom profiles are stored on the phone (localStorage).

Tips for building profiles are in [Tips and tricks](#12-tips-and-tricks). Keep lists reasonably short. Every extra PID slows the poll rate, especially when the app has fallen back to single-PID requests.

---

## 10. Console tab

The Console is a raw terminal to the ELM327.

- Type a command and tap **Send**, or tap a quick chip. The app trims it, uppercases it, and sends it as-is (timeout 8 seconds). Type the full command, for example `ATI` or `010C`.
- Quick chips: **ATI**, **ATRV**, **ATDPN**, **ATDP**, **0100**, **0101**, **010C**, **0105**, **0902**, **03**, **ATZ**.
- **Show live traffic** (on by default) also prints the TX/RX from Live polling and other app commands.
- **Copy log** copies the app version, a timestamp, the browser user-agent, and the log lines, so you can paste them into a message or a file.
- **Clear** clears the on-screen log (it does not reset the adapter).

The on-screen view shows recent lines; the copied log can include more (the app keeps a larger ring buffer).

**CVT Probe card (v1.7.1).** Below the log is a **Run CVT probe** button with a progress line, a summary and **Copy probe report**. It is a read-only diagnostic for the transmission module; section 18 explains it.

### Write interlock (v1.7.0)

Before the Console sends a command that can change the vehicle, it shows a warning and asks you to confirm. **Cancel is the default** (it has focus, and Back / Escape cancels). Nothing is sent unless you tap **Send anyway**. The interlock covers commands whose first byte is:

| First byte | Service |
|---|---|
| 04 | Mode 04: clear DTCs, freeze frame and readiness monitors |
| 10 | UDS DiagnosticSessionControl |
| 11 | UDS ECUReset |
| 27 | UDS SecurityAccess |
| 2E | UDS WriteDataByIdentifier |
| 2F | UDS InputOutputControlByIdentifier |
| 31 | UDS RoutineControl |
| 34 / 36 / 37 | UDS RequestDownload / TransferData / RequestTransferExit (reprogramming) |

Read requests (01, 02, 03, 07, 09, 0A, 21, 22 and AT commands) are sent without a prompt. The interlock is a speed bump, not a lock: it checks the first byte only, and a confirmed command goes out exactly as typed.

### Adapter-state warning (v1.7.0)

Some AT commands change how the adapter formats replies or which module it talks to: **ATZ, ATD, ATE, ATH, ATS (spaces), ATSP, ATSH, ATCAF, ATCRA** (and ATWS / ATTP). When you send one of these from the Console, the app marks the adapter as "dirty" and shows a yellow banner under the header naming the command, with a **Re-run init** button. Read-only AT commands (ATI, ATRV, ATDP, ATDPN) do not trigger it.

If you start Live while the adapter is dirty, Live first re-syncs the settings the parser depends on — `ATE0 ATL0 ATS0 ATH0 ATAL ATCAF1`, then `ATSH7DF` and `ATCRA` (plus `ATAT1` and your protocol after ATZ / ATD / ATSP) — and then polls. Re-run init does the full init and also clears the banner.

### Useful commands (cheat sheet)

| Command | What you get |
|---|---|
| ATI | Adapter identification (for example ELM327 v1.5) |
| ATRV | Adapter-measured voltage |
| ATDP / ATDPN | Protocol description / protocol number |
| ATZ | Reset the adapter (you will usually need to Re-run init afterward) |
| 0100 | Supported PIDs 01–20 (bitmask) |
| 0101 | Monitor status since DTCs cleared, including MIL and stored-code count |
| 010C | Engine RPM (raw; the Live tab decodes this for you) |
| 0105 | Coolant temperature (raw) |
| 0902 | VIN |
| 03 | Stored DTCs (raw) |
| 07 | Pending DTCs (raw) |
| 0A | Permanent DTCs (raw) |
| 04 | Clear DTCs — same write as the Clear codes button; same consequences. Asks for confirmation first (v1.7.0) |
| ATSH7E1, ATCRA7E9, 2103, ATSH7DF, ATCRA | The experimental CVT read by hand (see section 17). The ATSH / ATCRA lines will show the adapter-state banner; tap Re-run init afterwards |
| 06 | Mode 06 (on-board test results). **Not decoded in this app.** You can send it here; you will see raw hex only |

### Warning

The interlock asks before write-capable commands, but once you confirm, the Console will send whatever you typed. Do not paste commands you do not understand. See Capabilities and limits.

---

## 11. Capabilities and limits: what can it change on the vehicle?

Short answer: **with this app, a generic ELM327 clone, and standard OBD-II, the only button that changes the vehicle is Clear codes / reset MIL (Mode 04).** That also resets readiness monitors. Every other button, tab and preset is read-only, including the experimental Mitsubishi CVT preset (a Mode 21 read).

The one honest exception is the **raw Console**: it can send any command you type. Since v1.7.0, write-capable commands (Mode 04 and UDS 10, 11, 27, 2E, 2F, 31, 34, 36, 37) only go out after an explicit confirmation, with Cancel as the default. So writes other than the Clear codes button are possible **only** by typing them into the raw Console and confirming. The app does not build those commands for you, has no undo, and does not know whether a module will accept them (most need security access the app does not have).

### What the app can do today

| Action | Mode / command | In the UI? | Changes the vehicle? |
|---|---|---|---|
| Live sensor values | Mode 01 | Live tab, profiles | No (read) |
| Supported-PID map | 0100 / 0120 / 0140 / … | During connect | No (read) |
| MIL and monitor status | 0101 | Codes and Vehicle card | No (read) |
| Freeze frame | Mode 02 | Freeze frame button | No (read) |
| Stored / pending / permanent codes | Modes 03 / 07 / 0A | Read codes | No (read) |
| VIN | Mode 09 PID 02 | Vehicle card; Console chip 0902 | No (read) |
| Adapter ID, voltage, protocol | ATI, ATRV, ATDPN | Vehicle card and Console | No |
| Mitsubishi CVT fluid temperature (Experimental) | Mode 21, request 2103 on header 7E1 (reply filter 7E9) | Mitsubishi CVT (Experimental) preset | No (read). Header is restored to 7DF afterwards |
| Record a drive and export CSV | — | Live / Logs | No |
| **Clear codes / reset MIL** | **Mode 04** | **Clear codes button, and Console if you send 04 and confirm** | **Yes — erases codes and freeze frame, resets readiness** |
| Raw UDS / manufacturer commands | Anything typed in Console; 10/11/27/2E/2F/31/34/36/37 need confirmation | Console only | Possibly. Depends on the command and the module; usually rejected without security access |

Mode 09 in this app is **VIN only** (0902). Calibration ID, CVN, and other Mode 09 PIDs are not requested automatically. You can type them in Console (for example 0904) and you will see the raw reply; the app will not decode them.

**Mode 06** (on-board monitoring test results) is **not implemented** in the UI or the decoder. A raw `06` in Console may or may not return data, and it will not be translated.

### What this app cannot do (and why)

These need manufacturer software and usually better hardware (MUT-III for Mitsubishi, a J2534 pass-through, or a tool that speaks UDS with security access):

| Job | Why not |
|---|---|
| ECU coding / configuration | Uses manufacturer UDS writes (often 0x2E) after security access. Not in this app. |
| Key / immobilizer programming | Security-access routines, often a second CAN and a subscription tool. |
| ECU flashing / tuning | Reprogramming services, high-speed download, checksums. A generic ELM327 is the wrong hardware. |
| Bidirectional actuator tests (cycle a fan, injector, solenoid on command) | UDS routine control (0x31) or manufacturer bidirectional protocols. Not implemented. |
| TPMS relearn | Module-specific, often not on the OBD-II emissions bus in a useful way. |
| Service resets (oil light, SAS, battery registration, DPF regen start, and similar) | Manufacturer-specific. Not in the standard PID set. |
| ABS bleeding / ABS or SRS codes | Those modules are usually not reached by generic Mode 01–0A on this adapter. |
| General Mitsubishi enhanced PIDs (MUT / Mode 21 or 22) | v1.7.0 has a read-only framework for them (per-PID header, grouping, N/S fallback) but ships only one experimental PID set (CVT fluid temperature). Other enhanced values would need their request and byte offsets added to `js/pids.js`. There is no enhanced write path. |

### What might be possible later (read-only first)

- **More enhanced read PIDs** (UDS 0x22 or Mitsubishi Mode 21/22) for sensors that are not in standard Mode 01 — for example a better oil-temperature value — if the request format and byte offsets for that module are known. The framework added in v1.7.0 makes these a data-only change. They would still be read-only.
- **Mode 06** decoding, if a later version adds it, is also read-only and can help with pending catalyst or oxygen-sensor monitors.
- More **Mode 09** fields (calibration ID, which was already known for this car as 1860C0360001 from other tools).

None of those change the vehicle.

### Risks of the Console

Because Console sends raw commands:

- `04` clears codes and readiness, same as the button. It now asks for confirmation (v1.7.0).
- Adapter commands (ATSP, ATZ, ATH1, ATSH, ATCRA, and so on) can change how the ELM talks to the bus. The app shows the adapter-state banner; use **Re-run init**, or start Live and let it re-sync.
- Manufacturer **write** services (UDS 0x2E, 0x31, security-access 0x27, and similar) should not be sent unless you know exactly what you are doing. A wrong write can change coding, disable functions, or in the worst case brick a module. This app does not help you build those commands, and you should not experiment with them on a car you need.

---

## 12. Tips and tricks

### Diagnosing with live data

These are field rules of thumb, not official procedures. Always confirm against a service manual.

**Fuel trims (STFT / LTFT)**  
Short-term (STFT) moves quickly; long-term (LTFT) is the ECU's learned correction. Both are a percent. Roughly: around 0% is where the ECU wants to be. Sustained positive trims (for example +10% to +25%) mean the ECU is adding fuel (lean condition: vacuum leak, dirty MAF, low fuel pressure). Sustained negative trims mean it is taking fuel out (rich: leaking injector, high fuel pressure, dirty or biased MAF). Bank 2 trims are N/S on the 2013 Mitsubishi test car; use B1 only.

**Oxygen sensors and a pending P0420**  
P0420 is "catalyst system efficiency below threshold, bank 1." A healthy upstream (pre-cat) O2 or air-fuel sensor should switch or move with the mixture. A healthy downstream (post-cat) O2 should be comparatively steady if the catalytic converter is doing its job. On this car, **O2 B1S1 (upstream) is N/S** as a standard PID, and **O2 B1S2 (downstream) is supported**. You can still watch B1S2, STFT B1, LTFT B1, and RPM on the **O2 / Catalyst** profile. A lazy or widely swinging downstream sensor, together with a pending or stored P0420, is consistent with a catalyst that is not storing oxygen the way it should — but exhaust leaks, an aged downstream sensor, and incomplete warm-up can look similar. A pending P0420 that has not stored yet may come and go over drive cycles. Do not replace a converter on a pending code alone.

**Coolant warm-up**  
On a cold start, coolant should climb steadily toward the thermostat range (often around 180–220 °F / 80–105 °C, vehicle-specific) and then hold. A gauge that hangs low can be a thermostat stuck open; a rapid overshoot can be one stuck closed or a circulation problem. The **Cooling system** profile also includes intake air and ambient. Oil temp is N/S on this car.

**MAF rule of thumb**  
Mass air flow (g/s or lb/min) should rise and fall with RPM and load. A very common idle check is "about 1 gram/second per liter of displacement" at warm idle, plus or minus a bit — for example a 2.0 L engine often sits roughly in the 2–4 g/s range at idle and climbs clearly when you rev it. A MAF that reads too low for the RPM (and high positive fuel trims) is a classic dirty-MAF or intake-leak pattern. Use the **Air intake** profile (MAF, MAP, IAT, baro, throttle, RPM, load).

**Charging / electrical**  
Module voltage (PID 42) and ATRV should be roughly **13.5–14.7 V** with the engine running if the alternator is charging. Significantly under ~13 V running suggests a charging problem; a lot over ~15 V can indicate a regulator issue. On the v1.6 road test, the Charging / electrical profile showed about **13.5 V**, which is in the normal running range. Key-on, engine-off is typically mid-12s on a healthy battery.

### Building useful profiles

- Start with **Quick look** for a first drive (RPM, speed, coolant, load, voltage, throttle).
- Add a second custom profile for the job: trims + MAF for fueling, or O2 + trims + RPM for a catalyst watch.
- Leave out N/S PIDs when you make a custom profile so you are not staring at grey tiles. The presets keep them so you can see what the ECU does not support.
- Shorter lists poll faster, which matters when you are recording a transient (a tip-in, a misfire shudder, a run at highway load).

### Logging a drive cycle

1. Key on, connect, start live on the profile you care about, then **Record** before you start the drive.
2. Keep the phone awake (the app requests a wake lock; plugging in and leaving Chrome in the foreground is safer). Disable battery optimization for Chrome if the OS still sleeps it.
3. Drive the cycle you need (city, highway, the condition that sets the code).
4. **Stop recording** before you read codes or pull a freeze frame.
5. In Logs, View the stacked graphs, then Export CSV or Share into Sheets / Excel.

### Keeping the phone awake

The app requests a Screen Wake Lock while live data is running and releases it when you stop. Chrome drops the lock whenever the tab is hidden; v1.7.0 asks for it again when you return. Some Android skins ignore wake locks entirely. Gaps while you were away show up as `[BACKGROUND GAP: Xs]` in the Console and in the session. Practical extras: keep the app in the foreground, plug the phone in, raise the screen timeout, and turn off battery savers for Chrome.

### Bluetooth habits that actually helped on this dongle

- Close / force-stop Torque and Car Scanner, including background work.
- One app at a time on the adapter.
- If connect fails: toggle Bluetooth off and on, unpair **OBDII** in Android settings if it is stuck, **Forget and re-pick device**, watch for a pairing prompt, try again. The app will spend up to about 90 seconds across 10 attempts.
- Leave **BLE notify** and **BLE write mode** on Auto unless you are chasing a specific failure. Auto already includes the working ffea-then-fff1 recipe and remembers the variant that succeeded.
- If live data is empty or stuck, turn off Multi-PID requests and Fast response, then Stop live and Start live again (or Re-run init).
- Do not pull-to-refresh; it is disabled because a reload drops the GATT session.
- After a failed run, **Copy log** from the Console and keep it. The log includes the variant, settle time, and every live request/response.

---

## 13. Troubleshooting

| Symptom | Likely cause | What to try |
|---|---|---|
| "Web Bluetooth isn't available" warning | Wrong browser, or not HTTPS | Use Chrome on Android at the HTTPS app URL. Demo mode still works. |
| Dongle not in the picker | Name is odd, or another app holds it, or Bluetooth / Nearby permission denied | Show all Bluetooth devices. Force-stop other OBD apps. Allow Bluetooth and Nearby devices. |
| Connecting hangs or all 10 attempts fail | First GATT operation hung; poisoned link; other app in background; stale pairing | Let it retry (up to ~90 s). Cancel if you need to stop. Toggle Bluetooth, unpair OBDII, Forget and re-pick, watch for a pairing prompt. Copy the Console log. |
| Connected but every Live tile stays on -- | Live request not decoding; multi-PID / fast-response issue; wrong notify channel | Stop live, turn off Multi-PID and Fast response, Start live again. Re-run init or reconnect. Check Console live traffic for TIMEOUT or NO DATA. |
| Tiles show -- briefly after a profile switch | Tiles are reset until the next poll | Wait one poll cycle. This is normal. |
| Some tiles are N/S | ECU does not advertise that PID | Normal for that vehicle. Build a custom profile without those PIDs, or ignore the grey tiles. |
| "Stop recording first" toast on Read codes, Freeze frame, or Clear | A recording is still running | Live tab → Stop recording. Then retry. |
| Freeze frame shows "Reading…" then no useful data | No confirmed (stored) DTC, so no freeze frame; or you did not see the card under the lists | v1.6.1 shows a clear empty message and a toast. Pending-only P0420 usually has no freeze frame. Scroll down under the code lists. |
| Read codes shows pending P0420 and 0 stored | The catalyst monitor failed once this cycle and has not confirmed | Expected until it fails a second time (or passes). Do not assume the converter is failed on pending alone. |
| Clear codes confirmation looks scary | It is supposed to | Read it. Clearing resets readiness and can fail an emissions test until a drive cycle completes. Permanent codes will remain. |
| Live rate is very low | Many PIDs, single-PID fallback, long timeout | Use a shorter profile. If fallback keeps happening, leave Multi-PID off and accept a slower but reliable rate. |
| Phone sleeps and the link drops | Wake lock ignored by the OS | Keep the app foreground, plug in, raise screen timeout, disable battery optimization for Chrome. |
| App looks like an old version | Cached service worker or an old tab | Close every OBD Scanner tab / the PWA, reopen, or add `?v=1.7.0` to the URL once. Check the header version. |
| Yellow "Adapter settings changed from the Console" banner | You sent ATZ / ATD / ATE / ATH / ATS / ATSP / ATSH / ATCAF / ATCRA by hand | Tap Re-run init, or start Live (it re-syncs first). |
| Console asks "Send a write / control command?" | The command starts with 04 / 10 / 11 / 27 / 2E / 2F / 31 / 34 / 36 / 37 | Cancel unless you are sure. Send anyway sends it exactly as typed. |
| `[BACKGROUND GAP: Xs]` in the Console | The app was in the background or the screen was off; Chrome paused polling | Normal. Keep the app in front during a recording you need complete. |
| CVT temp (Exp) tiles go N/S | The transmission module did not answer 2103 on 7E1 three times in a row (NO DATA, timeout, or the adapter rejected ATSH) | Mode 01 keeps working. Re-run init to try again. Copy the Console log; the EXP lines show what came back. |
| CVT temp reads implausibly (for example far above coolant after an overnight cold soak) | Formula / byte offset differs for this TCM firmware | Compare the three CVT tiles and the raw byte in the Console at a cold start (see section 17). |
| Charts look smoother than the data on a long drive | LTTB downsampling for drawing | Stats and CSV still use every sample. |
| CSV looks empty for some columns | Those PIDs were added mid-recording after a profile switch, or were N/S / -- | Expected. Only rows after a PID starts appearing will have values. |
| Share button missing in Logs | Browser has no Web Share API | Use Export CSV / the list CSV button and open the file in Sheets or Excel. |
| Pull-to-refresh does nothing | Disabled on purpose | Good — a refresh would drop Bluetooth. Use Disconnect / Connect if you really need a clean start. |
| Demo mode works, real dongle does not | Bluetooth / pairing / other app, not the UI | Follow the connect-failure row above. Demo never uses the dongle. |

---

## 14. This vehicle (2013 Mitsubishi reference)

Values below were read from the real car with this app and the dongle described here. They are a snapshot, not a specification.

| Item | Value |
|---|---|
| VIN | JA32U2FU9DU010476 |
| Adapter | ELM327 v1.5 (clone), advertises as OBDII |
| BLE | Service FFF0; subscribe FFEA then FFF1; listen on FFF1; writeWithoutResponse to FFF2 |
| Chip / transceiver | Realtek RTL8773BFR, SIT1040 CAN |
| Bus | ISO 15765-4 CAN 11-bit 500 kbit/s |
| ECU calibration ID | 1860C0360001 (from a manufacturer / enhanced read on other tools; this app does not request 0904 by itself) |
| Supported standard PIDs | 39 advertised; 32 of those are in this app's library |
| Codes observed | Pending P0420; 0 stored; MIL off |
| Charging voltage (running) | About 13.5 V on the Charging / electrical profile during the v1.6 road test; ATRV has also been seen around 14.6 V on earlier connects |
| Notable N/S PIDs | Oil temp (5C); STFT B2, LTFT B2 (08, 09); O2 B1S1 (14); O2 B2S1 / B2S2 (18, 19); catalyst temperatures (3C, 3E) |

Supported library PIDs on this ECU include: engine load, coolant, STFT B1, LTFT B1, MAP, RPM, speed, timing advance, intake air, MAF, throttle, O2 B1S2, run time, distance with MIL on, wide-band lambda S1, EGR command, EVAP purge, fuel level, warm-ups and distance since codes cleared, EVAP pressure, baro, module voltage, absolute load, commanded lambda, relative / absolute throttle, ambient, pedal positions, commanded throttle, relative pedal.

---

## 15. Updating the app

The service worker is network-first. When you open the app online it should pick up a new version.

If the header still shows an old version:

1. Close every OBD Scanner tab, and swipe the PWA away from Recents.
2. Reopen the site or the home-screen icon.
3. If it is still stuck, open the URL with a cache-buster once, for example `https://adioi909.github.io/obd-scanner/?v=1.7.0`.
4. Confirm the small version label in the header.

Settings, custom profiles, and recorded logs stay on the phone across updates.

Source and issue history: https://github.com/adioi909/obd-scanner

---

## 16. Built-in PID library

These are the Mode 01 PIDs the app can decode and graph. A given car will only return the ones it advertised (others show as N/S). Units below are metric as stored; imperial conversion is applied when Units is set to Imperial.

| PID | Short name | Metric unit |
|---|---|---|
| 04 | Load | % |
| 05 | Coolant | °C |
| 06 | STFT B1 | % |
| 07 | LTFT B1 | % |
| 08 | STFT B2 | % |
| 09 | LTFT B2 | % |
| 0A | Fuel press | kPa |
| 0B | MAP | kPa |
| 0C | RPM | rpm |
| 0D | Speed | km/h |
| 0E | Timing | ° BTDC |
| 0F | IAT | °C |
| 10 | MAF | g/s |
| 11 | Throttle | % |
| 14 | O2 B1S1 | V |
| 15 | O2 B1S2 | V |
| 16 | O2 B1S3 | V |
| 17 | O2 B1S4 | V |
| 18 | O2 B2S1 | V |
| 19 | O2 B2S2 | V |
| 1A | O2 B2S3 | V |
| 1B | O2 B2S4 | V |
| 1F | Run time | s |
| 21 | Dist MIL | km |
| 22 | Rail press | kPa |
| 23 | Rail gauge | kPa |
| 24 | λ S1 | λ |
| 2C | EGR cmd | % |
| 2D | EGR err | % |
| 2E | EVAP purge | % |
| 2F | Fuel lvl | % |
| 30 | Warm-ups | — |
| 31 | Dist clr | km |
| 32 | EVAP press | Pa |
| 33 | Baro | kPa |
| 34 | λ S1 (I) | λ |
| 3C | Cat B1S1 | °C |
| 3D | Cat B2S1 | °C |
| 3E | Cat B1S2 | °C |
| 3F | Cat B2S2 | °C |
| 42 | Module V | V |
| 43 | Abs load | % |
| 44 | Cmd λ | λ |
| 45 | Rel thr | % |
| 46 | Ambient | °C |
| 47 | Thr B | % |
| 49 | Pedal D | % |
| 4A | Pedal E | % |
| 4C | Thr cmd | % |
| 4D | MIL time | min |
| 4E | Clr time | min |
| 52 | Ethanol | % |
| 5A | Rel pedal | % |
| 5B | HV batt | % |
| 5C | Oil temp | °C |
| 5D | Inj timing | ° |
| 5E | Fuel rate | L/h |
| 61 | Dmd torque | % |
| 62 | Act torque | % |
| 63 | Ref torque | Nm |

Imperial conversions when that unit system is selected: temperatures in °F, speed in mph, pressure in psi, MAF in lb/min, distance in mi, fuel rate in gal/h.

---

---

## 17. Mitsubishi CVT (Experimental)

An opt-in preset, **Mitsubishi CVT (Experimental)**, reads the CVT fluid temperature from the transmission control module (TCM) of the 2013 Lancer (Jatco JF011E, Mitsubishi F1CJA). It is **read-only**: it sends a Mode 21 read request and never writes anything. It is experimental because Mitsubishi does not publish these offsets and they vary by TCM firmware.

**What the app sends** (only when that preset is selected, at most about every 2 seconds, after the normal Mode 01 requests of that cycle):

```
ATSH7E1      (address the TCM)
ATCRA7E9     (only accept the TCM's replies)
2103         (Mode 21, local identifier 03; multi-frame reply 61 03 + data bytes)
ATSH7DF      (back to the standard OBD broadcast header)
ATCRA        (clear the receive filter)
```

The header switch is only sent when the target module changes, and all three CVT tiles share one 2103 request. The app always restores 7DF and clears the filter afterwards — after a good reply, NO DATA, a timeout, or if the adapter rejects ATSH — and again when Live stops, so standard polling is never left pointed at the TCM. If the adapter rejects ATCRA, the read still runs without the filter.

**Decoding.** Let N be data byte 13 after `61 03` (Torque's letter **N**, the 14th data byte).

| Tile | Formula | Where it comes from |
|---|---|---|
| CVT temp (Exp) | 0.000000002344·N⁵ − 0.000001387·N⁴ + 0.0003193·N³ − 0.03501·N² + 2.302·N − 36.6 (°C) | Community Torque lists for the JF011E-era Mitsubishi CVT: out-club.ru Outlander III thread ("(Out3) CVT temp", 2103, header 7E1) and elm3.ru's Mitsubishi Outlander 2008-2015 list ("CVT temp 1") |
| CVT N-55 (Exp) | N − 55 (°C) | Same out-club.ru list, labelled "(Out3 CVT8)" — the newer JF016E CVT8. A Lancer X owner on drive2.ru reported it worked on his car (cold 25 °C, warm ~80 °C) after the polynomial read high |
| CVT raw N (Exp) | N (count) | The raw byte, so you can check either formula yourself |

The sources disagree because Lancer X cars shipped with different CVT generations. On drive2.ru, one Lancer X owner reported a polynomial formula correct on his car while another needed N−55. The two published polynomials agree within about 3 °C of each other, which suggests they model the same sensor. The app uses the polynomial as the main value because the 2013 Lancer has the JF011E. It shows N−55 next to it in case this TCM behaves like the newer unit.

**How to verify on the car.** After the car has sat overnight (everything at ambient), key on, connect, choose the Mitsubishi CVT (Experimental) preset and Start live. The right formula should read close to ambient air and coolant at a cold start. The CVT should then warm more slowly than the coolant. The Console logs every reply, for example:
`EXP 7E1/7E9 2103 raw (20 data bytes): 10 11 ... | data[13] (Torque N) = 0x64 = 100 -> CVT temp (Exp)=47.5, CVT N-55 (Exp)=45, CVT raw N (Exp)=100`.
Copy that log if neither formula matches.

**v1.7.1 changes to the CVT preset.**

- **Longer timeout on 7E1.** The first live test got NO DATA from the TCM although it is known to answer slowly. While the app is on the 7E1 header it now sends `ATAT0` (adaptive timing off) and `ATSTFF` (about 1 second, set under Settings, CVT timeout) and waits up to about 2.5 seconds for the reply. When it is done, success or not, it sends `ATAT1` and `ATST32` so ordinary polling is as fast as before. The Console banner and Re-run init also restore those.
- **More candidate tiles.** The preset now starts with **CVT 2133 (Exp)** (request `2133`, last byte minus 50) and **CVT 2102 (Exp)** (request `2102`, 6th data byte minus 40), then the 2103 tiles: the polynomial, N−55, **CVT cubic (Exp)** and **CVT J−55 (Exp)** (10th data byte minus 55), and raw N. Each request is sent once per cycle and shared by its tiles. The list is only swapped in automatically if your saved preset still has the old default list; if you edited it, use Profiles → restore presets. Which request your TCM supports is exactly what the probe finds out.
- **Retry CVT** button (Live tab, next to the tiles when a CVT PID is in the profile) clears the N/S marks so the app asks again after you fix something (key on, warm engine, different timeout).

**If the car does not answer.** NO DATA or a timeout on 7E1 three times in a row marks that request's tiles **N/S** and stops asking (Re-run init or **Retry CVT** resets that). Coolant and RPM keep updating from Mode 01 either way.

---

## 18. CVT Probe (v1.7.1)

The first live test on the 2013 Lancer: the TCM request `2103` returned NO DATA, and a functional `0100` showed only one responder (7E8, the engine). The probe tries, in order, the things that usually explain that: a longer timeout, a functional request that a slow TCM might answer, the other service-21 requests that Mitsubishi TCMs use, a custom flow-control retry for multi-frame replies, and the other module addresses. It sends nothing that writes to the car.

**How to run it**

1. Connect, key on (engine running if you can, and note whether the car is cold or warm).
2. Console tab → **Run CVT probe**. It needs a connection. If Live is on it stops Live first; while a recording is running it refuses (stop the recording first).
3. Watch the progress line. It takes about 15 to 40 seconds and never more than about a minute. **Cancel** stops it at the next step.
4. Read the summary: which addresses answered (7E8 engine, 7E9 TCM, others), which requests returned data, and the decoded candidate temperatures. A hint line says what the result suggests.
5. Tap **Copy probe report** and paste it into a message or chat. It contains the app version, time, adapter, VIN, the summary and every raw reply. The same text is saved as one entry in the Console log (and can be copied from there with Copy log).

**What it sends** (read-only: AT setup, service 01, service 21):

| Step | Commands |
|---|---|
| a. Timing and J1979 | `ATAT0`, `ATSTFF`, `ATH1`, `ATCRA`, `ATSH7E1`, `0100`, `0142`; then `ATSH7DF`, `0100` (look for a 7E9 line) |
| b. Basic TCM data | `ATSH7E1`, `2107`, `2106` |
| c. Temperature candidates | `2133`, `2102`, `2103` |
| d. Only if 2103 gave a first frame only or NO DATA | `ATCRA7E9`, `ATFCSH7E1`, `ATFCSD30080A`, `ATFCSM1`, `2103` (an adapter that answers `?` is tolerated), then `ATFCSM0` |
| e. Engine sanity check | `ATSH7E0`, `ATCRA7E8`, `211A` |
| f. Other modules | `ATCRA`, then `ATSH7E2` … `ATSH7E7`, each with `0100` |

**Restore.** Whatever happens (success, timeout, an error halfway, Cancel, the time limit) the probe always sends `ATSH7DF`, `ATCRA`, `ATH0`, `ATAT1`, `ATST32`, `ATFCSM0`, then re-runs the normal init and clears the adapter-state banner. If the Bluetooth link itself dropped, it cannot restore; the banner stays on and Connect again.

**Reading the result**

- *7E9 answered a functional 0100*: the TCM is there and was only too slow; the longer timeout in the CVT preset should now work.
- *7E9 answered service 21 with data*: compare the candidate temperatures with air and coolant temperature. On a cold car (key on a few minutes) the right one is close to ambient; warm, it rises more slowly than coolant. The formulas disagree between sources, so cold and warm readings of all candidates are what settle it.
- *Negative response (7F 21 nn)*: the TCM understood but refused that request or local identifier (12 = not supported, 22 = conditions not correct).
- *Only 7E8 answers*: the TCM did not talk even with a 1 second timeout. Try engine running, then send the report.

**Sending the report.** Paste it into a chat, together with the research notes shipped in the Grok Build zip (`docs/cvt-research.md`), and ask for the next steps.

---

## 19. What changed in v1.7.1

- **CVT Probe** in the Console tab (section 18) with a copyable report that is also saved to the Console log.
- **CVT preset:** long timeout and adaptive timing off while on 7E1, always restored; new (Exp) tiles for 2133, 2102, cubic and J−55; Retry CVT button; Settings → CVT timeout.
- **Adapter state:** `ATST`, `ATAT` and `ATFC…` typed in the Console now mark the adapter dirty and are undone by Re-run init.
- Unchanged: the Bluetooth connect / retry logic. v1.7.0 is kept on the GitHub branches `v1.7.0-stable` and `gh-pages-v1.7.0`.

---

## 20. What changed in v1.7.0

- **Service worker:** only the app shell and the small Help page are precached. MANUAL.md, PDFs, GROK_BUILD_BRIEF.md and zips are never cached by the service worker, so updates stay small on mobile data. Help loads the manual on demand when online.
- **Console safety:** write interlock (Cancel by default) and the adapter-state banner, with automatic re-sync before Live.
- **Long drives:** LTTB downsampling for charts above 1,000 samples; stats and CSV use all samples. Batched database writes (25 samples / 3 s) with forced flushes on stop, background and pagehide.
- **Background recovery:** the wake lock is requested again on return, the stale in-flight command is abandoned, and `[BACKGROUND GAP: Xs]` is logged and stored with the session.
- **Enhanced PIDs:** read-only Mode 21/22 framework with per-PID headers (grouped, only switched when needed, always restored to 7DF) and the experimental Mitsubishi CVT preset.
- Unchanged: the Bluetooth connect / retry logic (10 attempts, ffea-then-fff1, writeWithoutResponse on FFF2, remembered variant).

*OBD Scanner v1.7.1. This manual matches the app as published. It is a personal tool, not a substitute for a service manual or a dealer-level scan tool.*
