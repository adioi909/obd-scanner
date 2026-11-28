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


  // ---------------- v1.7.0: adapter state tracking ----------------
  /** Standard OBD broadcast header (CAN 11-bit functional address) and "no receive filter". */
  var DEFAULT_HEADER = { tx: '7DF', rx: null };
  /** v1.7.1: default ELM timing after ATZ: ATST 32 (about 200 ms) and adaptive timing 1 (ATAT1). */
  var DEFAULT_TIMING = { st: '32', at: 1 };

  /** Mutable record of what the app believes the adapter is configured as. */
  function createAdapterState() {
    return { dirty: false, dirtyCmds: [], header: { tx: DEFAULT_HEADER.tx, rx: DEFAULT_HEADER.rx }, headerKnown: true,
      timing: { st: DEFAULT_TIMING.st, at: DEFAULT_TIMING.at }, timingKnown: true,
      fc: { mode: 0, sh: null, sd: null }, fcKnown: true };
  }
  /** Back to the state right after a successful init (ATZ ... ATSPx leaves the default 7DF header, no CRA filter, automatic flow control). */
  function resetAdapterState(st) {
    st.dirty = false; st.dirtyCmds = []; st.header = { tx: DEFAULT_HEADER.tx, rx: DEFAULT_HEADER.rx }; st.headerKnown = true;
    st.timing = { st: DEFAULT_TIMING.st, at: DEFAULT_TIMING.at }; st.timingKnown = true;
    st.fc = { mode: 0, sh: null, sd: null }; st.fcKnown = true;
    return st;
  }

  function compactCmd(cmd) { return String(cmd || '').replace(/\s+/g, '').toUpperCase(); }

  // AT commands that change how the adapter formats replies or which bus/module it talks to.
  // ATDP / ATDPN (read protocol) and ATI / ATRV are read-only and deliberately NOT matched.
  var AT_MUTATING = /^AT(Z|WS|D|D[01]|E[01]?|H[01]?|S[01]|SPA?[0-9A-C]?|TP[0-9A-C]?|SH[0-9A-F]*|CAF[01]?|CRA[0-9A-FX]*|AT[0-2]|ST[0-9A-F]{1,2}|FC(SM[0-2]|SH[0-9A-F]*|SD[0-9A-F]*))$/;

  // First byte of an OBD / UDS request that can write, reset or unlock something.
  var WRITE_SERVICES = {
    '04': 'Mode 04: clear DTCs, freeze frame and readiness monitors',
    '10': 'UDS 0x10 DiagnosticSessionControl (switches the module into another session)',
    '11': 'UDS 0x11 ECUReset (reboots the module)',
    '27': 'UDS 0x27 SecurityAccess (unlocks protected functions)',
    '2E': 'UDS 0x2E WriteDataByIdentifier (writes coding / configuration)',
    '2F': 'UDS 0x2F InputOutputControlByIdentifier (drives actuators)',
    '31': 'UDS 0x31 RoutineControl (runs module routines)',
    '34': 'UDS 0x34 RequestDownload (starts reprogramming)',
    '36': 'UDS 0x36 TransferData (reprogramming data)',
    '37': 'UDS 0x37 RequestTransferExit (ends reprogramming)'
  };

  /**
   * Classify a command typed in the Console.
   * Returns { cmd, isAt, atMutating, write, service, reason }.
   */
  function classifyCommand(cmd) {
    var c = compactCmd(cmd);
    var out = { cmd: c, isAt: c.indexOf('AT') === 0, atMutating: false, write: false, service: null, reason: null };
    if (out.isAt) { out.atMutating = AT_MUTATING.test(c); return out; }
    if (/^[0-9A-F]{2}/.test(c)) {
      var sv = c.slice(0, 2);
      if (WRITE_SERVICES[sv]) { out.write = true; out.service = sv; out.reason = WRITE_SERVICES[sv]; }
    }
    return out;
  }

  /** Mark the adapter as possibly out of sync with what the parser expects (after a manual AT command). */
  function markDirty(st, cmd) {
    var c = compactCmd(cmd);
    st.dirty = true;
    if (st.dirtyCmds.indexOf(c) < 0) st.dirtyCmds.push(c);
    if (/^AT(Z|D|D[01]|WS|SH|CRA|SP|TP)/.test(c)) st.headerKnown = false; // header / filter no longer known
    if (/^AT(Z|D|D[01]|WS|AT|ST|FC)/.test(c)) st.timingKnown = false; // ATST / ATAT / flow control (v1.7.1)
    return st;
  }

  function sameHeader(a, b) { return !!a && !!b && a.tx === b.tx && (a.rx || null) === (b.rx || null); }

  /**
   * Commands needed to move from the current header state to target {tx, rx}. rx null = clear filter (bare ATCRA).
   * Only sends what changed; if the current state is unknown, sends both.
   */
  function headerSwitchCommands(st, target) {
    var cmds = [];
    var cur = st.headerKnown ? st.header : null;
    if (!cur || cur.tx !== target.tx) cmds.push('ATSH' + target.tx);
    if (!cur || (cur.rx || null) !== (target.rx || null)) cmds.push(target.rx ? 'ATCRA' + target.rx : 'ATCRA');
    return cmds;
  }
  function headerKey(h) { return (h && h.tx ? h.tx : DEFAULT_HEADER.tx) + '/' + (h && h.rx ? h.rx : '-'); }

  /** Find a mode-21/22 positive reply (0x61 / 0x62 + echoed id) in raw text and return the data bytes after the echo. */
  function parseEnhancedResponse(raw, request) {
    var req = compactCmd(request);
    var mode = parseInt(req.slice(0, 2), 16);
    var idBytes = hexToBytes(req.slice(2));
    var msgs = parseResponse(raw, req);
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var idx = m.indexOf(mode + 0x40);
      if (idx < 0) continue;
      var ok = true;
      for (var k = 0; k < idBytes.length; k++) if (m[idx + 1 + k] !== idBytes[k]) { ok = false; break; }
      if (ok) return m.slice(idx + 1 + idBytes.length);
    }
    return null;
  }

  /** Space-separated hex for logging. */
  function bytesHex(bytes) { return (bytes || []).map(function (b) { return toHex(b); }).join(' '); }

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
    toHex: toHex,
    DEFAULT_HEADER: DEFAULT_HEADER,
    DEFAULT_TIMING: DEFAULT_TIMING,
    WRITE_SERVICES: WRITE_SERVICES,
    createAdapterState: createAdapterState,
    resetAdapterState: resetAdapterState,
    classifyCommand: classifyCommand,
    markDirty: markDirty,
    sameHeader: sameHeader,
    headerSwitchCommands: headerSwitchCommands,
    headerKey: headerKey,
    parseEnhancedResponse: parseEnhancedResponse,
    bytesHex: bytesHex
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ELM = api;
})(this);
