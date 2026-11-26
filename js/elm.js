/* ELM327 response parsing. Pure functions, no DOM. Works in browser (window.ELM) and Node (require). */
(function (root) {
  'use strict';

  // Error / status strings an ELM327 (or clone) may return instead of data.
  var ERROR_PATTERNS = [
    'NO DATA', 'UNABLE TO CONNECT', 'CAN ERROR', 'BUS ERROR', 'BUS BUSY', 'BUS INIT: ...ERROR',
    'DATA ERROR', 'FB ERROR', 'LV RESET', 'STOPPED', 'BUFFER FULL', 'ACT ALERT', 'ERR', '?'
  ];

  /** Remove prompt, NULs, echo noise and status lines. Returns array of clean upper-case lines. */
  function cleanLines(raw, sentCmd) {
    var text = String(raw || '').replace(/\u0000/g, '').replace(/>/g, '');
    var lines = text.split(/[\r\n]+/).map(function (l) { return l.trim().toUpperCase(); });
    var echo = sentCmd ? String(sentCmd).replace(/\s+/g, '').toUpperCase() : null;
    return lines.filter(function (l) {
      if (!l) return false;
      if (l === 'SEARCHING...' || l === 'SEARCHING' || l.indexOf('BUS INIT') === 0 && l.indexOf('ERROR') < 0) return false;
      if (echo && l.replace(/\s+/g, '') === echo) return false; // echo left on
      return true;
    });
  }

  /** Detect an ELM error/status response. Returns the error string or null. */
  function detectError(raw, sentCmd) {
    var lines = cleanLines(raw, sentCmd);
    if (!lines.length) return 'EMPTY';
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      for (var j = 0; j < ERROR_PATTERNS.length; j++) {
        var p = ERROR_PATTERNS[j];
        if (p === '?' ? l === '?' : (p === 'ERR' ? /^ERR\d+/.test(l) : l.indexOf(p) >= 0)) return l;
      }
    }
    return null;
  }

  function hexToBytes(hex) {
    var h = hex.replace(/[^0-9A-F]/gi, '');
    if (h.length % 2) h = h.slice(0, -1);
    var out = [];
    for (var i = 0; i < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
    return out;
  }

  /**
   * Parse a raw OBD response (headers off) into an array of messages (byte arrays).
   * Handles:
   *  - single-frame responses, with or without spaces ("41 0C 1A F8" / "410C1AF8")
   *  - several ECUs answering (one line each)
   *  - ISO 15765 multi-frame ("014" byte-count line + "0:" "1:" ... segments)
   */
  function parseResponse(raw, sentCmd) {
    if (detectError(raw, sentCmd)) return [];
    var lines = cleanLines(raw, sentCmd);
    var messages = [];
    var multi = null; // {len, bytes}

    function flushMulti() {
      if (multi) {
        messages.push(multi.len ? multi.bytes.slice(0, multi.len) : multi.bytes);
        multi = null;
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      var compact = l.replace(/\s+/g, '');
      // Byte-count line of a multi-frame response: 3 hex digits alone, e.g. "014"
      if (/^[0-9A-F]{3}$/.test(compact) && i + 1 < lines.length && /^[0-9A-F]:/.test(lines[i + 1].replace(/\s+/g, ''))) {
        flushMulti();
        multi = { len: parseInt(compact, 16), bytes: [] };
        continue;
      }
      var seg = /^([0-9A-F]):(.*)$/.exec(compact);
      if (seg) {
        if (!multi) multi = { len: 0, bytes: [] };
        if (seg[1] === '0' && multi.bytes.length) { flushMulti(); multi = { len: 0, bytes: [] }; }
        multi.bytes = multi.bytes.concat(hexToBytes(seg[2]));
        continue;
      }
      flushMulti();
      if (/^[0-9A-F]+$/.test(compact)) messages.push(hexToBytes(compact));
    }
    flushMulti();
    return messages;
  }

  /**
   * Parse a mode 01 (or 02 freeze frame) response that may contain several PIDs
   * (multi-PID request "010C0D05") and several ECUs.
   * pidLen(pid) -> number of data bytes for that PID (from PID library), or null if unknown.
   * Returns { "0C": [A,B], "0D": [A], ... } (first ECU wins per PID).
   */
  function parsePidResponse(raw, mode, pidLen, sentCmd) {
    var respMode = (mode || 1) + 0x40;
    var isFreeze = respMode === 0x42;
    var out = {};
    var msgs = parseResponse(raw, sentCmd);
    msgs.forEach(function (m) {
      var idx = m.indexOf(respMode);
      if (idx < 0) return;
      var i = idx + 1;
      while (i < m.length) {
        var pid = m[i];
        var key = toHex(pid);
        var n = pidLen(key);
        i += 1;
        if (isFreeze) i += 1; // frame number byte
        if (n == null) {
          // unknown length: take the rest only if this is the only PID
          if (!out[key]) out[key] = m.slice(i);
          break;
        }
        if (i + n > m.length) break;
        if (!out[key]) out[key] = m.slice(i, i + n);
        i += n;
      }
    });
    return out;
  }

  /** Decode supported-PID bitmasks (responses to 0100, 0120, 0140...). base is 0x00,0x20.. Returns array of PID ints. */
  function decodeSupported(bytes4, base) {
    var pids = [];
    for (var b = 0; b < 4; b++) {
      for (var bit = 0; bit < 8; bit++) {
        if (bytes4[b] & (0x80 >> bit)) pids.push(base + b * 8 + bit + 1);
      }
    }
    return pids;
  }

  /** Parse VIN from a mode 09 PID 02 response. */
  function parseVin(raw) {
    var msgs = parseResponse(raw, '0902');
    for (var k = 0; k < msgs.length; k++) {
      var m = msgs[k];
      var bytes;
      if (m[0] === 0x49 && m[1] === 0x02) {
        bytes = m.slice(2);
        // CAN: one "number of data items" byte (0x01). Legacy: each line "49 02 0N" + 4 bytes -> already merged? handle generic
        if (bytes[0] === 0x01) bytes = bytes.slice(1);
      } else continue;
      var s = bytes.filter(function (c) { return c >= 0x20 && c < 0x7f; }).map(function (c) { return String.fromCharCode(c); }).join('');
      s = s.replace(/[^A-HJ-NPR-Z0-9]/gi, '');
      if (s.length >= 17) return s.slice(-17);
    }
    // Legacy (non-CAN) protocols: 5 separate lines 49 02 01..05 + 4 bytes each
    var legacy = msgs.filter(function (m) { return m[0] === 0x49 && m[1] === 0x02 && m.length === 7; });
    if (legacy.length >= 5) {
      legacy.sort(function (a, b) { return a[2] - b[2]; });
      var all = [];
      legacy.forEach(function (m) { all = all.concat(m.slice(3)); });
      var v = all.filter(function (c) { return c >= 0x20 && c < 0x7f; }).map(function (c) { return String.fromCharCode(c); }).join('');
      if (v.length >= 17) return v.slice(-17);
    }
    return null;
  }

  function toHex(n, width) {
    var s = n.toString(16).toUpperCase();
    while (s.length < (width || 2)) s = '0' + s;
    return s;
  }

  var api = {
    cleanLines: cleanLines,
    detectError: detectError,
    hexToBytes: hexToBytes,
    parseResponse: parseResponse,
    parsePidResponse: parsePidResponse,
    decodeSupported: decodeSupported,
    parseVin: parseVin,
    toHex: toHex
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ELM = api;
})(this);
