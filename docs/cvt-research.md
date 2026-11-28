# CVT fluid temp on a 2013 Lancer (JF011E/F1CJA) with a generic ELM327 - research notes (2026-11-27)

Context: ATSH7E1 / ATCRA7E9 accepted, then 2103 and 2101 -> NO DATA. Functional 0100 (ATH1, 7DF) shows only 7E8.
Research only. No code/deploy changes. Nothing below has been verified on Robert's car.

## What the sources say

| Finding | Source | Confidence |
|---|---|---|
| Mitsubishi CAN TCM = request 7E1, reply 7E9, KWP-style service 21 (21 xx -> 61 xx ...), no session step in any entry | Torque OUT3.csv (every CVT PID header 7E1, start cmds `atsh7E1 atfcsh7E1 atfcsd30080a atfcsm1 atcra7E9`, stop cmds restore 7E0/7E8) https://out-club.ru/board/showthread.php?t=65510 ; elm3.ru csv https://elm3.ru/wp-content/uploads/PIDs/Mitsubishi_Outlander_2008-2015.csv ; ScanGauge (07E1 xxxx) https://www.scangauge.com/support/x-gauge-commands/mitsubishi/ ; OBD2 Australia (Pajero 7E1 21 02 @-40) https://obd2australia.com.au/auto-transmission-temperature-pids/ | High that 7E1/7E9 is the Mitsubishi TCM pair; medium-high that no session is needed |
| Lancer-specific: OBDb/Pelican lists 7E1->7E9 "Transmission" service 21 reads for Lancer CVT (21 07 brake/selector, 21 06 gear, 21 04, 21 05, 21 10, 21 02, 21 03) marked verified for 2008, 2015, 2019. 2013 is NOT in the verified list ("tester needed") | https://pelican.clutch.engineering/cars/mitsubishi/lancer/parameters | Medium (crowd-sourced; shows the addressing exists on Lancers either side of 2013) |
| Same page, Mode 01 PID 42: model years 2008, 2010, **2013**, 2015, 2019 show BOTH 7E0->7E8 and 7E1->7E9 responding to functional Mode 01. So on some 2013 Lancers the TCM does answer J1979 | same URL (module list under "Control module voltage VPWR") | Medium. Conflicts with Robert's 0100 (only 7E8): points at timing/adapter or a variant difference, not a missing TCM |
| CVT temp byte, option A (Outlander III / ASX / "Lancer X" lists): 2103 on 7E1, N = 14th data byte after `61 03`; temp = 5th-order polynomial of N (list "CVT temp 1"/"(Out3) CVT temp"), range -50..250 | out-club OUT3.csv, elm3.ru csv | Medium for Outlander; low-medium for Lancer (see disagreement) |
| Option B: same byte, **N-55** ("(Out3 CVT8) New CVT temp") | out-club OUT3 (new version); drive2 thread https://www.drive2.ru/l/593053208474079260/ (a CVT owner: cold start 25 C, ~80 C after a drive; thread says "N-55 for all modern Mitsubishi CVTs", another says same formulas on ASX/Lancer/Pajero Sport) | Medium; attribution of which car in the thread is unclear |
| Option C: "CVT temp 2" cubic 0.0000286N^3-0.00951N^2+1.46N-30.1 | elm3.ru csv; drive2 (a Lancer X owner "Cohobah": CVT temp 2 works, #1 does not; another owner said cold start read above coolant) | Low-medium |
| Option D (OBDb Lancer, 2015/2019 "supported"): 2103 data byte index 9 (letter J) **J-55** ("AT ATF temp"; same as Out3 "3.0 AT Temp J-55"); 2103 byte N = raw "temperature sensor count" | Pelican Lancer page | Low-medium (example values on that page are not credible, e.g. 185 C) |
| Option E (OBDb Lancer 2015 only): **2133**, first data byte A, A-50 ("Transmission temperature", example 0x5F -> 45 C, a realistic value); single short frame | Pelican Lancer page | Low-medium, but nicest to test: tiny single-frame reply |
| Option F (OBDb Lancer 2015/2019): 2102, 6th data byte (letter F), F-40 ("ATF temp") | Pelican Lancer page; also Pajero 21 02 -40 (OBD2 Australia) and ScanGauge "Transmission Temperature Alt" 07E1 2102 (-40) | Low-medium |
| Option G: ScanGauge X-Gauge "CVT Temperature" = 07E1 **2122**, N-55 (their MTH FFBD = -67 F = (x-55) C converted). Page says experimental/looking for testers; the "worked on 2011 Lancer Ralliart" codes there are the SST (21 9A gear, 21 B2 temp, -50) not CVT | https://www.scangauge.com/support/x-gauge-commands/mitsubishi/ | Low (untested by them) |
| Engine ECU 7E0/7E8 does answer service 21 on Lancers (21 1A, 21 1E, 21 0E, ...). I found **no** source reporting CVT/ATF temp through 7E0 | Pelican Lancer page; Torque OUT3 (7E0 2102 coolant B-40) | High that 7E0 21xx exists; no evidence of CVT temp there |
| No source puts the CVT TCM anywhere but 7E1/7E9 on 11-bit CAN. 761/762 = BMU (EV/PHEV), 7B6/7B7 = AWC, 7E2/7EA = EV unit, 784/785 ABS, 6A0/514 meter, 688/511 climate (Outlander III) | OUT3.csv; Pelican | Medium |
| ELM327 behaviour: default AT ST = 0x32 (~200 ms), adaptive timing (AT1) never exceeds ST; datasheet says low-priority requests can give NO DATA and suggests AT ST FF; CFC1 sends ISO 15765 flow control automatically (custom FC via ATFCSH/ATFCSD/ATFCSM1, ATFCSM0 = back to automatic); CAF1 adds PCI bytes and pads to 8 data bytes; ATCRA with no argument clears the filter | https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DSH.pdf (read) | High |
| Ignition ON is enough (engine start not required) | out-club thread setup steps | Medium |
| Session control: none of the Torque, ScanGauge, Car Scanner (custom PID docs https://www.carscanner.info/custompids/), OBD2 Australia or OBDb entries sends Mode 10 before 21 xx. I found no source requiring one | all of the above | Medium |

## Disagreement (do not pick a formula yet)
Polynomial (OUT3 "CVT temp"), N-55, and cubic "CVT temp 2" all use the SAME byte N but give different numbers; drive2 posters say the right one depends on CVT generation (the Lancer X owner "Cohobah" says the polynomial fails and cubic works; a CVT owner says N-55). OBDb has different bytes entirely for 2015/2019 Lancers (J-55, 2133 A-50, 2102 F-40). The only reliable way: capture raw 2103/2102/2133 replies cold (ambient, key on a few minutes) and warm, and find the byte that goes from ~ambient to ~coolant-ish and back; torque forum method: https://torque-bhp.com/community/main-forum/mitsubishi-lancer/ (admin piemmm).

## Why NO DATA, ranked (inference, not sourced)
1. Timing: app init uses ATAT1 with default ATST (~200 ms); the TCM may answer later than the adaptive window learned from fast 7E8 replies (same would hide a 7E9 reply to functional 0100). Fix to try: ATAT0 + ATSTFF.
2. Variant/cal: this 2013 TCM may not implement 2103/2101 (2101 is not in any Mitsubishi CVT list I found, so NO DATA there proves nothing). Probe PIDs that appear in several lists first (2107, 2106).
3. Flow control only matters for multi-frame; it would show the first frame, not NO DATA.
4. Clone ELM v1.5 quirks (ATFC*/ATCRA accepted but ignored) - plausible, unsourced.

## Console sequences: see the final message from the agent (same content summarised in the chat). Each ends with:
ATSH7DF, ATCRA, ATH0, (ATAT1, ATST32, ATFCSM0 if you changed them), then the Re-run init button.

## Console sequences (read-only: only services 01 and 21; none trips the Mode 04/10/etc. write interlock)
RESTORE block (end of every sequence): ATSH7DF, ATCRA, ATH0, ATAT1, ATST32, ATFCSM0 (only if used), then tap Re-run init.
Key on (engine running is fine). Each no-answer takes about 1 s with ATSTFF.

1. Is anything at 7E1 answering J1979, with maximum patience?
   ATAT0 / ATSTFF / ATH1 / ATCRA / ATSH7E1 / 0100 / 0142
   Success: `7E9 06 41 00 xx xx xx xx` and `7E9 04 41 42 xx xx` (xxxx/1000 = ~12-14 V). Also try ATSH7DF + 0100 again with ATAT0/ATSTFF: success = a second line starting 7E9.
2. Known Lancer CVT service-21 reads (OBDb/Pelican, Torque OUT3):
   ATSH7E1 / 2107 / 2106
   Success: `7E9 0x 61 07 aa bb cc ..` (bits of aa change with lever P/R/N/D and brake) and `7E9 .. 61 06 ..`.
3. Temperature candidates, smallest reply first:
   2133 -> `7E9 03 61 33 xx` (xx-50, ~ambient cold)
   2102 -> `7E9 .. 61 02 ..` (letter F = 6th data byte, F-40)
   2122 -> ScanGauge N-55 candidate
   2103 -> multi-frame: `7E9 10 xx 61 03 ..` + `7E9 21 ..` + `7E9 22 ..`; N = 14th data byte after 61 03
4. If 2103 shows only the first frame (`7E9 10 ..`) or NO DATA:
   ATSH7E1 / ATCRA7E9 / ATFCSH7E1 / ATFCSD30080A / ATFCSM1 / 2103   (restore with ATFCSM0)
5. Engine ECU sanity that service 21 works on this adapter/car:
   ATSH7E0 / ATCRA7E8 / 211A   -> `7E8 .. 61 1A ..` (abs load = byte*100/255)
6. Last resort, find another responder: ATH1 / ATCRA / for each of ATSH7E2..ATSH7E7: 0100
