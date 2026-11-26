/* High-level OBD-II operations on top of ElmSession. */
(function (root) {
  'use strict';
  var isNode = typeof module !== 'undefined' && module.exports;
  var ELM = isNode ? require('./elm.js') : root.ELM;
  var PIDS = isNode ? require('./pids.js') : root.PIDS;
  var DTC = isNode ? require('./dtc.js') : root.DTC;

  var PROTOCOLS = {
    '0': 'Automatic', '1': 'SAE J1850 PWM', '2': 'SAE J1850 VPW', '3': 'ISO 9141-2', '4': 'ISO 14230-4 KWP (5 baud)',
    '5': 'ISO 14230-4 KWP (fast)', '6': 'ISO 15765-4 CAN 11-bit 500k', '7': 'ISO 15765-4 CAN 29-bit 500k',
    '8': 'ISO 15765-4 CAN 11-bit 250k', '9': 'ISO 15765-4 CAN 29-bit 250k', 'A': 'SAE J1939 CAN'
  };

  function Obd(session, opts) {
    this.s = session; this.opts = opts || {};
    this.log = this.opts.log || function () {};
    this.supported = null; // array of PID hex strings
    this.multiPid = this.opts.multiPid !== false; // try multi-PID requests on CAN
    this.fastResponse = this.opts.fastResponse !== false; // append response-count digit
    this.isCan = false;
  }

  Obd.prototype.cmd = function (c, t, sendOpts) { return this.s.send(c, t, sendOpts); };

  /** ELM init sequence. protocol: '0' auto or '6' etc. Returns info object.
   *  Never throws: a single command timeout will not abort the rest of init. */
  Obd.prototype.init = async function (protocol) {
    var info = { adapterOk: false, ecuOk: false };
    var self = this;
    function identFrom(raw, sent) {
      return (ELM.cleanLines(raw, sent).filter(function (l) { return /ELM|V\d/.test(l); })[0] || '').trim();
    }
    async function at(c, t, sendOpts) {
      var label = c === '' ? '(bare CR)' : c;
      try {
        var r = await self.cmd(c, t, sendOpts);
        if (String(r).trim()) info.adapterOk = true;
        return r;
      } catch (e) {
        self.log('warn', label + ' failed: ' + e.message);
        if (e.partial && String(e.partial).trim()) info.adapterOk = true;
        return e.partial || '';
      }
    }

    var T = Object.assign({ wake: 2000, atz: 10000, atws: 8000, atd: 4000, ati: 4000, at: 3000, pid: 12000 }, this.opts.initTimeouts || {});
    self.log('info', 'Init: waking adapter with a bare CR (also probes write mode)');
    await at('', T.wake); // probes writeWithoutResponse then writeWithResponse if no RX

    self.log('info', 'Init: ATZ (up to ' + T.atz + 'ms; clones can be slow or silent)');
    var z = await at('ATZ', T.atz, { probe: false });
    info.elm = identFrom(z, 'ATZ');
    if (!info.elm) {
      self.log('info', 'Init: ATZ did not identify the adapter; trying ATWS, then ATD + ATI');
      var ws = await at('ATWS', T.atws, { probe: false });
      info.elm = identFrom(ws, 'ATWS');
      if (!info.elm) await at('ATD', T.atd, { probe: false });
      var ident = await at('ATI', T.ati, { probe: false });
      info.elm = identFrom(ident, 'ATI') || identFrom(z, 'ATZ') || (ident || z || '').trim();
      // If still nothing and the other write mode has not been tried, flip and retry ATZ once.
      if (!info.adapterOk && self.s.t && self.s.t.canToggleWrite && self.s.t.canToggleWrite() && self.s.t.toggleWriteMode()) {
        self.log('info', 'Init: no adapter RX yet; retrying ATZ with the other write mode');
        z = await at('ATZ', T.atz, { probe: false });
        info.elm = identFrom(z, 'ATZ') || info.elm;
      }
    }
    self.log('info', 'Init: adapter id = ' + (info.elm || '(unknown)'));

    await at('ATE0', T.at, { probe: false });
    await at('ATL0', T.at, { probe: false });
    await at('ATS0', T.at, { probe: false });
    await at('ATH0', T.at, { probe: false });
    await at('ATAT1', T.at, { probe: false });
    await at('ATSP' + (protocol || '0'), T.at, { probe: false });
    var r = '';
    try { r = await this.cmd('0100', T.pid, { probe: false }); if (String(r).trim()) info.adapterOk = true; } catch (e) { r = e.partial || ''; }
    var err = ELM.detectError(r, '0100');
    info.ecuOk = !err;
    info.ecuError = err;
    if (!err) {
      var msgs = ELM.parsePidResponse(r, 1, PIDS.length);
      this._supportedFirst = msgs['00'] || null;
    }
    var dpn = (await at('ATDPN', T.at, { probe: false })).replace(/[^0-9A-F]/gi, '').toUpperCase();
    info.protocolNum = dpn.replace(/^A/, '');
    info.protocol = PROTOCOLS[info.protocolNum] || (dpn ? ('Protocol ' + dpn) : 'unknown');
    this.isCan = /^[6-9AB]$/.test(info.protocolNum);
    var rv = await at('ATRV', T.at, { probe: false });
    info.voltage = (ELM.cleanLines(rv, 'ATRV')[0] || '').trim();
    this.info = info;
    return info;
  };


  /** Query supported PIDs 0100/0120/0140/... -> array of PID hex strings. */
  Obd.prototype.readSupported = async function () {
    var all = [];
    var base = 0;
    while (base <= 0xE0) {
      var key = ELM.toHex(base);
      var bytes;
      if (base === 0 && this._supportedFirst) bytes = this._supportedFirst;
      else {
        var r;
        try { r = await this.cmd('01' + key, 4000); } catch (e) { break; }
        bytes = ELM.parsePidResponse(r, 1, PIDS.length)[key];
      }
      if (!bytes || bytes.length < 4) break;
      var list = ELM.decodeSupported(bytes, base);
      all = all.concat(list);
      if (list.indexOf(base + 0x20) < 0) break;
      base += 0x20;
    }
    this.supported = all.map(function (n) { return ELM.toHex(n); });
    return this.supported;
  };

  Obd.prototype.readVin = async function () {
    try { var r = await this.cmd('0902', 5000); return ELM.parseVin(r); } catch (e) { return null; }
  };

  Obd.prototype.readMonitor = async function () {
    try { var r = await this.cmd('0101', 3000); return DTC.parseMonitorStatus(ELM.parsePidResponse(r, 1, PIDS.length)['01']); } catch (e) { return null; }
  };

  Obd.prototype.readDtcs = async function () {
    var out = {};
    var modes = [['03', 'stored'], ['07', 'pending'], ['0A', 'permanent']];
    for (var i = 0; i < modes.length; i++) {
      var r;
      try { r = await this.cmd(modes[i][0], 6000); } catch (e) { out[modes[i][1]] = { error: e.message, codes: [] }; continue; }
      var err = ELM.detectError(r, modes[i][0]);
      if (err && err !== 'NO DATA') out[modes[i][1]] = { error: err, codes: [] };
      else out[modes[i][1]] = { codes: err ? [] : DTC.parseDtcResponse(r, parseInt(modes[i][0], 16)) };
    }
    return out;
  };

  Obd.prototype.clearDtcs = async function () {
    var r = await this.cmd('04', 8000);
    var msgs = ELM.parseResponse(r, '04');
    return msgs.some(function (m) { return m[0] === 0x44; });
  };

  /**
   * Query a list of PIDs once. Uses multi-PID requests (up to 6 per request) on CAN when enabled,
   * falling back automatically to single requests. Returns {pid: metricValue}.
   */
  Obd.prototype.queryPids = async function (pids) {
    var out = {};
    if (!pids.length) return out;
    var groups = [];
    var per = (this.multiPid && this.isCan) ? 6 : 1;
    for (var i = 0; i < pids.length; i += per) groups.push(pids.slice(i, i + per));
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      var cmd = '01' + grp.join('');
      if (grp.length === 1 && this.fastResponse && this.isCan) cmd += '1';
      var r;
      try { r = await this.cmd(cmd, this.opts.pidTimeout || 1500); } catch (e) { if (e.message === 'CANCELLED') throw e; continue; }
      var err = ELM.detectError(r, cmd);
      if (err === '?' && cmd.length % 2 === 1) { this.fastResponse = false; this.log('warn', 'Adapter rejected response-count suffix; disabled'); }
      var parsed = ELM.parsePidResponse(r, 1, PIDS.length, cmd);
      var got = 0;
      grp.forEach(function (p) { if (parsed[p]) { out[p] = PIDS.decode(p, parsed[p]); got++; } });
      if (grp.length > 1 && got < grp.length) {
        if (got === 0) { this.multiPid = false; this.log('warn', 'Multi-PID request failed; falling back to single-PID requests'); }
        // fetch the missing ones individually this round
        for (var k = 0; k < grp.length; k++) {
          var p = grp[k];
          if (out[p] != null) continue;
          try {
            var r1 = await this.cmd('01' + p, this.opts.pidTimeout || 1500);
            var pr = ELM.parsePidResponse(r1, 1, PIDS.length, '01' + p);
            if (pr[p]) out[p] = PIDS.decode(p, pr[p]);
          } catch (e) { if (e.message === 'CANCELLED') throw e; }
        }
      }
    }
    return out;
  };

  /** Read freeze frame #0: the DTC that stored it and every supported mode-01 PID we can decode. */
  Obd.prototype.readFreezeFrame = async function () {
    var r = await this.cmd('020200', 4000);
    var p = ELM.parsePidResponse(r, 2, PIDS.length, '020200');
    if (!p['02']) return null;
    var dtc = require_dtc().decodeDtc(p['02'][0], p['02'][1]);
    if (!dtc) return { dtc: null, values: {} };
    var list = (this.supported || []).filter(function (x) { return PIDS.get(x); });
    var values = {};
    for (var i = 0; i < list.length; i++) {
      try {
        var rr = await this.cmd('02' + list[i] + '00', 1500);
        var pp = ELM.parsePidResponse(rr, 2, PIDS.length, '02' + list[i] + '00');
        if (pp[list[i]]) values[list[i]] = PIDS.decode(list[i], pp[list[i]]);
      } catch (e) { /* skip */ }
    }
    return { dtc: dtc, values: values };
  };
  function require_dtc() { return DTC; }

  var api = { Obd: Obd, PROTOCOLS: PROTOCOLS };
  if (isNode) module.exports = api; else root.OBD = api;
})(this);
