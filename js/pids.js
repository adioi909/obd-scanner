/*
 * Mode 01 PID library (SAE J1979). To add a PID, add one entry to DEFS:
 *   pid:   two hex digits (mode 01 PID number)
 *   name:  long name, short: tile label
 *   bytes: number of data bytes the ECU returns (A, B, C, D)
 *   unit:  metric unit the formula returns
 *   kind:  unit-conversion family: temp | speed | pressure | flow | distance | volume_rate | none
 *   min/max: gauge range in metric units
 *   cat:   category used to group the profile picker
 *   f(A,B,C,D): formula returning the metric value
 */
(function (root) {
  'use strict';
  var pct = function (A) { return A * 100 / 255; };
  var trim = function (A) { return (A - 128) * 100 / 128; };
  var temp = function (A) { return A - 40; };
  var u16 = function (A, B) { return A * 256 + B; };
  var catTemp = function (A, B) { return (A * 256 + B) / 10 - 40; };
  var lambda = function (A, B) { return (A * 256 + B) * 2 / 65536; };

  var DEFS = [
    { pid: '04', name: 'Calculated engine load', short: 'Load', bytes: 1, unit: '%', kind: 'none', min: 0, max: 100, cat: 'Engine', f: pct },
    { pid: '05', name: 'Engine coolant temperature', short: 'Coolant', bytes: 1, unit: '°C', kind: 'temp', min: -40, max: 130, cat: 'Temperatures', f: temp },
    { pid: '06', name: 'Short term fuel trim - Bank 1', short: 'STFT B1', bytes: 1, unit: '%', kind: 'none', min: -25, max: 25, cat: 'Fuel', f: trim },
    { pid: '07', name: 'Long term fuel trim - Bank 1', short: 'LTFT B1', bytes: 1, unit: '%', kind: 'none', min: -25, max: 25, cat: 'Fuel', f: trim },
    { pid: '08', name: 'Short term fuel trim - Bank 2', short: 'STFT B2', bytes: 1, unit: '%', kind: 'none', min: -25, max: 25, cat: 'Fuel', f: trim },
    { pid: '09', name: 'Long term fuel trim - Bank 2', short: 'LTFT B2', bytes: 1, unit: '%', kind: 'none', min: -25, max: 25, cat: 'Fuel', f: trim },
    { pid: '0A', name: 'Fuel pressure (gauge)', short: 'Fuel press', bytes: 1, unit: 'kPa', kind: 'pressure', min: 0, max: 765, cat: 'Fuel', f: function (A) { return A * 3; } },
    { pid: '0B', name: 'Intake manifold absolute pressure', short: 'MAP', bytes: 1, unit: 'kPa', kind: 'pressure', min: 0, max: 255, cat: 'Air', f: function (A) { return A; } },
    { pid: '0C', name: 'Engine RPM', short: 'RPM', bytes: 2, unit: 'rpm', kind: 'none', min: 0, max: 8000, cat: 'Engine', f: function (A, B) { return (A * 256 + B) / 4; } },
    { pid: '0D', name: 'Vehicle speed', short: 'Speed', bytes: 1, unit: 'km/h', kind: 'speed', min: 0, max: 200, cat: 'Engine', f: function (A) { return A; } },
    { pid: '0E', name: 'Timing advance', short: 'Timing', bytes: 1, unit: '° BTDC', kind: 'none', min: -10, max: 50, cat: 'Engine', f: function (A) { return A / 2 - 64; } },
    { pid: '0F', name: 'Intake air temperature', short: 'IAT', bytes: 1, unit: '°C', kind: 'temp', min: -40, max: 100, cat: 'Temperatures', f: temp },
    { pid: '10', name: 'Mass air flow rate', short: 'MAF', bytes: 2, unit: 'g/s', kind: 'flow', min: 0, max: 200, cat: 'Air', f: function (A, B) { return u16(A, B) / 100; } },
    { pid: '11', name: 'Throttle position', short: 'Throttle', bytes: 1, unit: '%', kind: 'none', min: 0, max: 100, cat: 'Air', f: pct },
    { pid: '14', name: 'O2 sensor voltage B1S1', short: 'O2 B1S1', bytes: 2, unit: 'V', kind: 'none', min: 0, max: 1.275, cat: 'O2 / Catalyst', f: function (A) { return A / 200; } },
    { pid: '15', name: 'O2 sensor voltage B1S2', short: 'O2 B1S2', bytes: 2, unit: 'V', kind: 'none', min: 0, max: 1.275, cat: 'O2 / Catalyst', f: function (A) { return A / 200; } },
    { pid: '16', name: 'O2 sensor voltage B1S3', short: 'O2 B1S3', bytes: 2, unit: 'V', kind: 'none', min: 0, max: 1.275, cat: 'O2 / Catalyst', f: function (A) { return A / 200; } },
    { pid: '17', name: 'O2 sensor voltage B1S4', short: 'O2 B1S4', bytes: 2, unit: 'V', kind: 'none', min: 0, max: 1.275, cat: 'O2 / Catalyst', f: function (A) { return A / 200; } },
    { pid: '18', name: 'O2 sensor voltage B2S1', short: 'O2 B2S1', bytes: 2, unit: 'V', kind: 'none', min: 0, max: 1.275, cat: 'O2 / Catalyst', f: function (A) { return A / 200; } },
    { pid: '19', name: 'O2 sensor voltage B2S2', short: 'O2 B2S2', bytes: 2, unit: 'V', kind: 'none', min: 0, max: 1.275, cat: 'O2 / Catalyst', f: function (A) { return A / 200; } },
    { pid: '1A', name: 'O2 sensor voltage B2S3', short: 'O2 B2S3', bytes: 2, unit: 'V', kind: 'none', min: 0, max: 1.275, cat: 'O2 / Catalyst', f: function (A) { return A / 200; } },
    { pid: '1B', name: 'O2 sensor voltage B2S4', short: 'O2 B2S4', bytes: 2, unit: 'V', kind: 'none', min: 0, max: 1.275, cat: 'O2 / Catalyst', f: function (A) { return A / 200; } },
    { pid: '1F', name: 'Run time since engine start', short: 'Run time', bytes: 2, unit: 's', kind: 'none', min: 0, max: 65535, cat: 'Status', f: u16 },
    { pid: '21', name: 'Distance traveled with MIL on', short: 'Dist MIL', bytes: 2, unit: 'km', kind: 'distance', min: 0, max: 65535, cat: 'Status', f: u16 },
    { pid: '22', name: 'Fuel rail pressure (rel. manifold)', short: 'Rail press', bytes: 2, unit: 'kPa', kind: 'pressure', min: 0, max: 5177, cat: 'Fuel', f: function (A, B) { return u16(A, B) * 0.079; } },
    { pid: '23', name: 'Fuel rail gauge pressure (direct inj.)', short: 'Rail gauge', bytes: 2, unit: 'kPa', kind: 'pressure', min: 0, max: 655350, cat: 'Fuel', f: function (A, B) { return u16(A, B) * 10; } },
    { pid: '24', name: 'O2 sensor 1 lambda (wide band)', short: 'λ S1', bytes: 4, unit: 'λ', kind: 'none', min: 0, max: 2, cat: 'O2 / Catalyst', f: lambda },
    { pid: '2C', name: 'Commanded EGR', short: 'EGR cmd', bytes: 1, unit: '%', kind: 'none', min: 0, max: 100, cat: 'Emissions', f: pct },
    { pid: '2D', name: 'EGR error', short: 'EGR err', bytes: 1, unit: '%', kind: 'none', min: -100, max: 100, cat: 'Emissions', f: trim },
    { pid: '2E', name: 'Commanded evaporative purge', short: 'EVAP purge', bytes: 1, unit: '%', kind: 'none', min: 0, max: 100, cat: 'Emissions', f: pct },
    { pid: '2F', name: 'Fuel tank level input', short: 'Fuel lvl', bytes: 1, unit: '%', kind: 'none', min: 0, max: 100, cat: 'Fuel', f: pct },
    { pid: '30', name: 'Warm-ups since codes cleared', short: 'Warm-ups', bytes: 1, unit: '', kind: 'none', min: 0, max: 255, cat: 'Status', f: function (A) { return A; } },
    { pid: '31', name: 'Distance since codes cleared', short: 'Dist clr', bytes: 2, unit: 'km', kind: 'distance', min: 0, max: 65535, cat: 'Status', f: u16 },
    { pid: '32', name: 'EVAP system vapor pressure', short: 'EVAP press', bytes: 2, unit: 'Pa', kind: 'none', min: -8192, max: 8192, cat: 'Emissions', f: function (A, B) { var v = u16(A, B); if (v > 32767) v -= 65536; return v / 4; } },
    { pid: '33', name: 'Absolute barometric pressure', short: 'Baro', bytes: 1, unit: 'kPa', kind: 'pressure', min: 0, max: 255, cat: 'Air', f: function (A) { return A; } },
    { pid: '34', name: 'O2 sensor 1 lambda (current type)', short: 'λ S1 (I)', bytes: 4, unit: 'λ', kind: 'none', min: 0, max: 2, cat: 'O2 / Catalyst', f: lambda },
    { pid: '3C', name: 'Catalyst temperature B1S1', short: 'Cat B1S1', bytes: 2, unit: '°C', kind: 'temp', min: -40, max: 1000, cat: 'O2 / Catalyst', f: catTemp },
    { pid: '3D', name: 'Catalyst temperature B2S1', short: 'Cat B2S1', bytes: 2, unit: '°C', kind: 'temp', min: -40, max: 1000, cat: 'O2 / Catalyst', f: catTemp },
    { pid: '3E', name: 'Catalyst temperature B1S2', short: 'Cat B1S2', bytes: 2, unit: '°C', kind: 'temp', min: -40, max: 1000, cat: 'O2 / Catalyst', f: catTemp },
    { pid: '3F', name: 'Catalyst temperature B2S2', short: 'Cat B2S2', bytes: 2, unit: '°C', kind: 'temp', min: -40, max: 1000, cat: 'O2 / Catalyst', f: catTemp },
    { pid: '42', name: 'Control module voltage', short: 'Module V', bytes: 2, unit: 'V', kind: 'none', min: 10, max: 16, cat: 'Electrical', f: function (A, B) { return u16(A, B) / 1000; } },
    { pid: '43', name: 'Absolute load value', short: 'Abs load', bytes: 2, unit: '%', kind: 'none', min: 0, max: 100, cat: 'Engine', f: function (A, B) { return u16(A, B) * 100 / 255; } },
    { pid: '44', name: 'Commanded air-fuel equivalence ratio', short: 'Cmd λ', bytes: 2, unit: 'λ', kind: 'none', min: 0, max: 2, cat: 'Fuel', f: lambda },
    { pid: '45', name: 'Relative throttle position', short: 'Rel thr', bytes: 1, unit: '%', kind: 'none', min: 0, max: 100, cat: 'Air', f: pct },
    { pid: '46', name: 'Ambient air temperature', short: 'Ambient', bytes: 1, unit: '°C', kind: 'temp', min: -40, max: 60, cat: 'Temperatures', f: temp },
    { pid: '47', name: 'Absolute throttle position B', short: 'Thr B', bytes: 1, unit: '%', kind: 'none', min: 0, max: 100, cat: 'Air', f: pct },
    { pid: '49', name: 'Accelerator pedal position D', short: 'Pedal D', bytes: 1, unit: '%', kind: 'none', min: 0, max: 100, cat: 'Air', f: pct },
    { pid: '4A', name: 'Accelerator pedal position E', short: 'Pedal E', bytes: 1, unit: '%', kind: 'none', min: 0, max: 100, cat: 'Air', f: pct },
    { pid: '4C', name: 'Commanded throttle actuator', short: 'Thr cmd', bytes: 1, unit: '%', kind: 'none', min: 0, max: 100, cat: 'Air', f: pct },
    { pid: '4D', name: 'Time run with MIL on', short: 'MIL time', bytes: 2, unit: 'min', kind: 'none', min: 0, max: 65535, cat: 'Status', f: u16 },
    { pid: '4E', name: 'Time since codes cleared', short: 'Clr time', bytes: 2, unit: 'min', kind: 'none', min: 0, max: 65535, cat: 'Status', f: u16 },
    { pid: '52', name: 'Ethanol fuel %', short: 'Ethanol', bytes: 1, unit: '%', kind: 'none', min: 0, max: 100, cat: 'Fuel', f: pct },
    { pid: '5A', name: 'Relative accelerator pedal position', short: 'Rel pedal', bytes: 1, unit: '%', kind: 'none', min: 0, max: 100, cat: 'Air', f: pct },
    { pid: '5B', name: 'Hybrid battery pack remaining life', short: 'HV batt', bytes: 1, unit: '%', kind: 'none', min: 0, max: 100, cat: 'Electrical', f: pct },
    { pid: '5C', name: 'Engine oil temperature', short: 'Oil temp', bytes: 1, unit: '°C', kind: 'temp', min: -40, max: 160, cat: 'Temperatures', f: temp },
    { pid: '5D', name: 'Fuel injection timing', short: 'Inj timing', bytes: 2, unit: '°', kind: 'none', min: -210, max: 302, cat: 'Fuel', f: function (A, B) { return u16(A, B) / 128 - 210; } },
    { pid: '5E', name: 'Engine fuel rate', short: 'Fuel rate', bytes: 2, unit: 'L/h', kind: 'volume_rate', min: 0, max: 50, cat: 'Fuel', f: function (A, B) { return u16(A, B) / 20; } },
    { pid: '61', name: "Driver's demand engine torque", short: 'Dmd torque', bytes: 1, unit: '%', kind: 'none', min: -125, max: 130, cat: 'Engine', f: function (A) { return A - 125; } },
    { pid: '62', name: 'Actual engine torque', short: 'Act torque', bytes: 1, unit: '%', kind: 'none', min: -125, max: 130, cat: 'Engine', f: function (A) { return A - 125; } },
    { pid: '63', name: 'Engine reference torque', short: 'Ref torque', bytes: 2, unit: 'Nm', kind: 'none', min: 0, max: 65535, cat: 'Engine', f: u16 }
  ];

  // Non-display PIDs whose lengths we still need when parsing multi-PID responses.
  var LENGTH_ONLY = { '00': 4, '20': 4, '40': 4, '60': 4, '80': 4, 'A0': 4, 'C0': 4, '01': 4, '02': 2, '03': 2, '12': 1, '13': 1, '1C': 1, '1D': 1, '1E': 1, '41': 4, '51': 1 };

  // ---- v1.7.0: read-only enhanced (manufacturer) PIDs ----
  // Polled with a mode 21/22 request on a specific module header. Never written to.
  // decode(dataBytes) gets the bytes AFTER the positive-reply echo (61 03 ...); dataBytes[0] is Torque's "A".
  // Mitsubishi CVT fluid temperature, 2013 Lancer (Jatco JF011E / F1CJA TCM at 7E1, replies on 7E9).
  // Request 2103; temperature byte = Torque "N" = dataBytes[13]. EXPERIMENTAL: offsets vary by TCM firmware.
  // Sources (community Torque lists, not factory data):
  //   out-club.ru Outlander III Torque thread (OUT3.csv): "(Out3) CVT temp" 2103 / 7E1 / 5th-order polynomial on N,
  //     "(Out3 CVT8) CVT Temperature" 2103 / 7E1 / N-55 (newer JF016E CVT8), start cmds atsh7E1 + atcra7E9.
  //   elm3.ru Mitsubishi_Outlander_2008-2015.csv: same 2103 / 7E1 polynomial ("CVT temp 1").
  //   drive2.ru "PID температуры АКПП Lancer X": Lancer X owners report the polynomial family on older CVTs and N-55 on the newer one.
  function cvtPoly(N) {
    return 0.000000002344 * Math.pow(N, 5) - 0.000001387 * Math.pow(N, 4) + 0.0003193 * Math.pow(N, 3) - 0.03501 * N * N + 2.302 * N - 36.6;
  }
  /** "CVT temp 2" cubic from the elm3.ru / out-club Outlander CSV (same byte N as the polynomial). */
  function cvtCubic(N) { return 0.0000286 * N * N * N - 0.00951 * N * N + 1.46 * N - 30.1; }
  // slowTimeout: while polling the TCM the app uses a long ELM timeout (ATSTFF, adaptive timing off) and restores ATST32 / ATAT1 afterwards.
  var CVT_REQ = { mode: '21', request: '2103', txHeader: '7E1', rxFilter: '7E9', minBytes: 14, slowTimeout: true };
  // v1.7.1 research candidates (see docs/cvt-research.md): other 7E1 service-21 reads that may carry a fluid temperature.
  //   2133: first data byte A, A-50 (Pelican/OBDb Lancer 2015, single short frame). 2102: 6th data byte (Torque letter F), F-40 (Pelican Lancer 2015/2019; Pajero 21 02 -40).
  //   2103 byte J (10th data byte), J-55 (Pelican "AT ATF temp"; same as the Out3 3.0 "AT Temp" J-55).
  var CVT33_REQ = { mode: '21', request: '2133', txHeader: '7E1', rxFilter: '7E9', minBytes: 1, slowTimeout: true };
  var CVT02_REQ = { mode: '21', request: '2102', txHeader: '7E1', rxFilter: '7E9', minBytes: 6, slowTimeout: true };
  var ENHANCED = [
    Object.assign({ pid: 'MCVT', name: 'CVT fluid temperature (Exp)', short: 'CVT temp (Exp)', bytes: 0, unit: '°C', kind: 'temp', min: -40, max: 150,
      cat: 'Mitsubishi CVT (Exp)', enhanced: true, experimental: true, byteIndex: 13, formula: 'polynomial on N (JF011E)',
      decode: function (d) { return d.length > 13 ? cvtPoly(d[13]) : null; } }, CVT_REQ),
    Object.assign({ pid: 'MCVT8', name: 'CVT temp alt N-55 (Exp, JF016E formula)', short: 'CVT N-55 (Exp)', bytes: 0, unit: '°C', kind: 'temp', min: -55, max: 200,
      cat: 'Mitsubishi CVT (Exp)', enhanced: true, experimental: true, byteIndex: 13, formula: 'N - 55 (CVT8)',
      decode: function (d) { return d.length > 13 ? d[13] - 55 : null; } }, CVT_REQ),
    Object.assign({ pid: 'MCVT33', name: 'CVT temp 2133 A-50 (Exp)', short: 'CVT 2133 (Exp)', bytes: 0, unit: '°C', kind: 'temp', min: -50, max: 205,
      cat: 'Mitsubishi CVT (Exp)', enhanced: true, experimental: true, byteIndex: 0, formula: 'A - 50 (request 2133)',
      decode: function (d) { return d.length > 0 ? d[0] - 50 : null; } }, CVT33_REQ),
    Object.assign({ pid: 'MCVT02', name: 'CVT temp 2102 F-40 (Exp)', short: 'CVT 2102 (Exp)', bytes: 0, unit: '°C', kind: 'temp', min: -40, max: 215,
      cat: 'Mitsubishi CVT (Exp)', enhanced: true, experimental: true, byteIndex: 5, formula: 'F - 40 (request 2102)',
      decode: function (d) { return d.length > 5 ? d[5] - 40 : null; } }, CVT02_REQ),
    Object.assign({ pid: 'MCVTJ', name: 'CVT temp 2103 J-55 (Exp, OBDb)', short: 'CVT J-55 (Exp)', bytes: 0, unit: '°C', kind: 'temp', min: -55, max: 200,
      cat: 'Mitsubishi CVT (Exp)', enhanced: true, experimental: true, byteIndex: 9, formula: 'J - 55 (request 2103)',
      decode: function (d) { return d.length > 9 ? d[9] - 55 : null; } }, Object.assign({}, CVT_REQ, { minBytes: 10 })),
    Object.assign({ pid: 'MCVT3', name: 'CVT temp 2103 cubic N (Exp, "CVT temp 2")', short: 'CVT cubic (Exp)', bytes: 0, unit: '°C', kind: 'temp', min: -50, max: 250,
      cat: 'Mitsubishi CVT (Exp)', enhanced: true, experimental: true, byteIndex: 13, formula: 'cubic on N (CVT temp 2)',
      decode: function (d) { return d.length > 13 ? cvtCubic(d[13]) : null; } }, CVT_REQ),
    Object.assign({ pid: 'MCVTN', name: 'CVT temp raw byte N (Exp)', short: 'CVT raw N (Exp)', bytes: 0, unit: '', kind: 'none', min: 0, max: 255,
      cat: 'Mitsubishi CVT (Exp)', enhanced: true, experimental: true, byteIndex: 13, formula: 'raw N',
      decode: function (d) { return d.length > 13 ? d[13] : null; } }, CVT_REQ)
  ];

  var BY_PID = {};
  DEFS.forEach(function (d) { BY_PID[d.pid] = d; });
  ENHANCED.forEach(function (d) { BY_PID[d.pid] = d; });

  function get(pid) { return BY_PID[String(pid).toUpperCase()] || null; }
  function isEnhanced(pid) { var d = get(pid); return !!(d && d.enhanced); }
  /** Label used in CSV headers / editor: "[010C]" for mode 01, "[7E1:2103]" for enhanced. */
  function code(pid) { var d = get(pid); return d && d.enhanced ? d.txHeader + ':' + d.request : '01' + String(pid).toUpperCase(); }
  /** Decode an enhanced PID from the data bytes after the 61 xx echo. */
  function decodeEnhanced(pid, dataBytes) {
    var d = get(pid);
    if (!d || !d.enhanced || !dataBytes || dataBytes.length < (d.minBytes || 1)) return null;
    var v = d.decode(dataBytes);
    return v == null || isNaN(v) ? null : Math.round(v * 1000) / 1000;
  }
  function length(pid) { var d = get(pid); if (d && !d.enhanced) return d.bytes; var k = String(pid).toUpperCase(); return LENGTH_ONLY[k] != null ? LENGTH_ONLY[k] : null; }

  /** Decode a PID's data bytes to a metric number. */
  function decode(pid, bytes) {
    var d = get(pid);
    if (!d || !bytes || bytes.length < (d.bytes > 2 ? 2 : d.bytes)) return null;
    var v = d.f(bytes[0] || 0, bytes[1] || 0, bytes[2] || 0, bytes[3] || 0);
    return Math.round(v * 1000) / 1000;
  }

  // ---- Units ----
  var IMPERIAL = {
    temp: { unit: '°F', conv: function (c) { return c * 9 / 5 + 32; } },
    speed: { unit: 'mph', conv: function (k) { return k * 0.621371; } },
    pressure: { unit: 'psi', conv: function (k) { return k * 0.145038; } },
    flow: { unit: 'lb/min', conv: function (g) { return g * 0.132277; } },
    distance: { unit: 'mi', conv: function (k) { return k * 0.621371; } },
    volume_rate: { unit: 'gal/h', conv: function (l) { return l * 0.264172; } }
  };

  /** Convert a metric value to the display system. Returns {value, unit, min, max}. */
  function toDisplay(pid, metric, system) {
    var d = get(pid);
    if (!d) return { value: metric, unit: '', min: 0, max: 100 };
    var imp = system === 'imperial' && IMPERIAL[d.kind];
    if (!imp) return { value: metric, unit: d.unit, min: d.min, max: d.max };
    return { value: metric == null ? null : imp.conv(metric), unit: imp.unit, min: imp.conv(d.min), max: imp.conv(d.max) };
  }

  /** PIDs from a profile that we will actually poll: known to the library and, if given, reported as supported. */
  function pollList(wanted, supported, enhancedNS) {
    return (wanted || []).filter(function (x) {
      var d = get(x);
      if (!d) return false;
      if (d.enhanced) return !(enhancedNS && enhancedNS[d.pid]);
      return !supported || supported.indexOf(x) >= 0;
    });
  }
  /** Is this PID available on the connected car? Enhanced PIDs count as supported until they fail. */
  function isSupported(pid, supported, enhancedNS) {
    var d = get(pid);
    if (!d) return false;
    if (d.enhanced) return !(enhancedNS && enhancedNS[d.pid]);
    return !supported || supported.indexOf(d.pid) >= 0;
  }

  function unitFor(pid, system) { return toDisplay(pid, 0, system).unit; }

  function format(v, unit) {
    if (v == null || isNaN(v)) return '--';
    var a = Math.abs(v);
    var dp = a >= 1000 ? 0 : a >= 100 ? 0 : a >= 10 ? 1 : (unit === 'V' || unit === 'λ') ? 3 : 1;
    if (unit === 'rpm' || unit === 's' || unit === 'min' || unit === '') dp = 0;
    return v.toFixed(dp);
  }

  var CATEGORIES = ['Engine', 'Temperatures', 'Fuel', 'Air', 'O2 / Catalyst', 'Electrical', 'Emissions', 'Status', 'Mitsubishi CVT (Exp)'];

  var PRESETS = [
    { id: 'preset-quick', name: 'Quick look', pids: ['0C', '0D', '05', '04', '42', '11'] },
    { id: 'preset-cooling', name: 'Cooling system', pids: ['05', '0F', '46', '5C', '0C', '0D', '04', '42'] },
    { id: 'preset-fuel', name: 'Fuel trims', pids: ['06', '07', '08', '09', '14', '15', '10', '0C', '04', '05'] },
    { id: 'preset-air', name: 'Air intake', pids: ['10', '0B', '0F', '33', '11', '0C', '04'] },
    { id: 'preset-cat', name: 'O2 / Catalyst', pids: ['14', '15', '18', '19', '3C', '3E', '06', '07', '0C'] },
    { id: 'preset-elec', name: 'Charging / electrical', pids: ['42', '0C', '04', '05'] },
    { id: 'preset-mitsu-cvt', name: 'Mitsubishi CVT (Experimental)', pids: ['MCVT33', 'MCVT02', 'MCVT', 'MCVT8', 'MCVT3', 'MCVTJ', 'MCVTN', '05', '0C'], experimental: true }
  ];
  // v1.7.1: when a stored preset still has exactly the old default list, replace it with the new one (edited presets are never touched).
  var PRESET_UPGRADES = [
    { id: 'preset-mitsu-cvt', from: ['MCVT', 'MCVT8', 'MCVTN', '05', '0C'], to: PRESETS.filter(function (p) { return p.id === 'preset-mitsu-cvt'; })[0].pids.slice() }
  ];

  var api = { DEFS: DEFS, ENHANCED: ENHANCED, ALL: DEFS.concat(ENHANCED), CATEGORIES: CATEGORIES, PRESETS: PRESETS, get: get, isEnhanced: isEnhanced, isSupported: isSupported, code: code, decodeEnhanced: decodeEnhanced, cvtPoly: cvtPoly, cvtCubic: cvtCubic, PRESET_UPGRADES: PRESET_UPGRADES, length: length, decode: decode, toDisplay: toDisplay, pollList: pollList, unitFor: unitFor, format: format };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PIDS = api;
})(this);
