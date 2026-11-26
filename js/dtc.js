/* DTC decoding for modes 03 (stored), 07 (pending), 0A (permanent). */
(function (root) {
  'use strict';
  var ELM = (typeof module !== 'undefined' && module.exports) ? require('./elm.js') : root.ELM;
  var LETTERS = ['P', 'C', 'B', 'U'];

  /** Two bytes -> "P0133". Returns null for 0000 padding. */
  function decodeDtc(a, b) {
    if (a === 0 && b === 0) return null;
    var letter = LETTERS[(a >> 6) & 0x03];
    var d1 = (a >> 4) & 0x03;
    var rest = ((a & 0x0f).toString(16) + (b >> 4).toString(16) + (b & 0x0f).toString(16)).toUpperCase();
    return letter + d1 + rest;
  }

  /**
   * Parse DTC response. mode = 0x03, 0x07 or 0x0A (request mode).
   * CAN responses: [4x, count, A1, B1, A2, B2 ...] -> odd length.
   * Legacy (J1850/ISO9141/KWP): one line per 3 DTCs: [4x, A1,B1,A2,B2,A3,B3] padded with 00 -> even length.
   */
  function parseDtcResponse(raw, mode) {
    var resp = mode + 0x40;
    var msgs = ELM.parseResponse(raw);
    var codes = [];
    msgs.forEach(function (m) {
      if (m[0] !== resp) return;
      var data = m.slice(1);
      if (data.length % 2 === 1) data = data.slice(1); // CAN count byte
      for (var i = 0; i + 1 < data.length; i += 2) {
        var c = decodeDtc(data[i], data[i + 1]);
        if (c && codes.indexOf(c) < 0) codes.push(c);
      }
    });
    return codes;
  }

  /** Mode 01 PID 01 monitor status -> {mil, count, compression} */
  function parseMonitorStatus(bytes) {
    if (!bytes || bytes.length < 2) return null;
    return { mil: !!(bytes[0] & 0x80), count: bytes[0] & 0x7f, compressionIgnition: !!(bytes[1] & 0x08) };
  }

  // Short generic descriptions for common SAE codes (P0xxx). Manufacturer codes show without text.
  var DESCRIPTIONS = {
    P0010: 'Camshaft position actuator circuit (Bank 1)', P0011: 'Camshaft timing over-advanced (Bank 1)',
    P0016: 'Crank/cam position correlation (Bank 1 Sensor A)', P0030: 'HO2S heater control circuit (B1S1)',
    P0036: 'HO2S heater control circuit (B1S2)', P0068: 'MAP/MAF - throttle position correlation',
    P0100: 'MAF circuit', P0101: 'MAF circuit range/performance', P0102: 'MAF circuit low', P0103: 'MAF circuit high',
    P0105: 'MAP/Baro circuit', P0106: 'MAP/Baro range/performance', P0107: 'MAP circuit low', P0108: 'MAP circuit high',
    P0110: 'IAT circuit', P0112: 'IAT circuit low', P0113: 'IAT circuit high',
    P0115: 'ECT circuit', P0116: 'ECT range/performance', P0117: 'ECT circuit low', P0118: 'ECT circuit high',
    P0120: 'Throttle position sensor A circuit', P0121: 'TPS A range/performance', P0122: 'TPS A low', P0123: 'TPS A high',
    P0125: 'Insufficient coolant temp for closed loop', P0128: 'Coolant thermostat (below regulating temp)',
    P0130: 'O2 sensor circuit (B1S1)', P0131: 'O2 sensor low voltage (B1S1)', P0132: 'O2 sensor high voltage (B1S1)',
    P0133: 'O2 sensor slow response (B1S1)', P0134: 'O2 sensor no activity (B1S1)', P0135: 'O2 heater circuit (B1S1)',
    P0136: 'O2 sensor circuit (B1S2)', P0137: 'O2 sensor low voltage (B1S2)', P0138: 'O2 sensor high voltage (B1S2)',
    P0139: 'O2 sensor slow response (B1S2)', P0140: 'O2 sensor no activity (B1S2)', P0141: 'O2 heater circuit (B1S2)',
    P0150: 'O2 sensor circuit (B2S1)', P0155: 'O2 heater circuit (B2S1)', P0161: 'O2 heater circuit (B2S2)',
    P0171: 'System too lean (Bank 1)', P0172: 'System too rich (Bank 1)', P0174: 'System too lean (Bank 2)', P0175: 'System too rich (Bank 2)',
    P0190: 'Fuel rail pressure sensor circuit', P0201: 'Injector circuit - cyl 1', P0202: 'Injector circuit - cyl 2',
    P0203: 'Injector circuit - cyl 3', P0204: 'Injector circuit - cyl 4', P0217: 'Engine overtemperature',
    P0219: 'Engine overspeed', P0220: 'TPS B circuit', P0230: 'Fuel pump primary circuit',
    P0234: 'Turbo/supercharger overboost', P0299: 'Turbo/supercharger underboost',
    P0300: 'Random/multiple cylinder misfire', P0301: 'Cylinder 1 misfire', P0302: 'Cylinder 2 misfire',
    P0303: 'Cylinder 3 misfire', P0304: 'Cylinder 4 misfire', P0305: 'Cylinder 5 misfire', P0306: 'Cylinder 6 misfire',
    P0325: 'Knock sensor 1 circuit (Bank 1)', P0327: 'Knock sensor 1 low (Bank 1)', P0328: 'Knock sensor 1 high (Bank 1)',
    P0335: 'Crankshaft position sensor A circuit', P0336: 'CKP sensor A range/performance',
    P0340: 'Camshaft position sensor circuit', P0341: 'CMP sensor range/performance',
    P0400: 'EGR flow', P0401: 'EGR flow insufficient', P0402: 'EGR flow excessive', P0403: 'EGR control circuit',
    P0420: 'Catalyst efficiency below threshold (Bank 1)', P0430: 'Catalyst efficiency below threshold (Bank 2)',
    P0440: 'EVAP system', P0441: 'EVAP incorrect purge flow', P0442: 'EVAP small leak detected',
    P0443: 'EVAP purge control valve circuit', P0446: 'EVAP vent control circuit', P0455: 'EVAP large leak detected',
    P0456: 'EVAP very small leak detected', P0461: 'Fuel level sensor range/performance',
    P0480: 'Cooling fan 1 control circuit', P0500: 'Vehicle speed sensor A', P0505: 'Idle air control system',
    P0506: 'Idle RPM lower than expected', P0507: 'Idle RPM higher than expected',
    P0562: 'System voltage low', P0563: 'System voltage high', P0600: 'Serial communication link',
    P0601: 'ECM memory checksum error', P0603: 'ECM keep-alive memory error', P0606: 'ECM processor fault',
    P0700: 'Transmission control system (MIL request)', P0705: 'Transmission range sensor circuit',
    P0715: 'Input/turbine speed sensor circuit', P0720: 'Output speed sensor circuit',
    P0740: 'Torque converter clutch circuit', P0741: 'TCC stuck off', P0841: 'Trans fluid pressure sensor/switch A range',
    P2135: 'TPS A/B voltage correlation', P2138: 'Pedal position D/E voltage correlation',
    P2195: 'O2 sensor signal stuck lean (B1S1)', P2196: 'O2 sensor signal stuck rich (B1S1)',
    P2096: 'Post-cat fuel trim too lean (B1)', P2097: 'Post-cat fuel trim too rich (B1)',
    U0001: 'High speed CAN bus', U0100: 'Lost communication with ECM/PCM', U0101: 'Lost communication with TCM',
    U0121: 'Lost communication with ABS', U0140: 'Lost communication with BCM', U0155: 'Lost communication with cluster'
  };

  function describe(code) { return DESCRIPTIONS[code] || (/^P1|^P3[0-3]|^[BCU][12]/.test(code) ? 'Manufacturer-specific code' : ''); }

  var api = { decodeDtc: decodeDtc, parseDtcResponse: parseDtcResponse, parseMonitorStatus: parseMonitorStatus, describe: describe, DESCRIPTIONS: DESCRIPTIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DTC = api;
})(this);
