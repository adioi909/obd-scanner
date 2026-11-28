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
    this.adapter = ELM.createAdapterState(); // v1.7.0: header / dirty tracking
    this.enhancedNS = {};      // enhanced PID -> true once it is given up on (shown as N/S)
    this.enhancedFails = {};   // header|request -> consecutive failures
    this.enhancedMaxFails = this.opts.enhancedMaxFails || 3;
    this.enhancedEveryMs = this.opts.enhancedEveryMs != null ? this.opts.enhancedEveryMs : 2000; // temps change slowly
    this._enhancedLast = 0;
    // v1.7.1: ELM timeout used while talking to the TCM (hex byte, units of 4 ms; FF = about 1 s) with adaptive timing off.
    this.enhancedSt = normSt(this.opts.enhancedSt);
  }

  /** Normalise a user-supplied ATST value to two hex digits (20..FF); anything else becomes FF. */
  function normSt(v) {
    var h = String(v == null ? 'FF' : v).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    var n = parseInt(h, 16);
    if (!h || isNaN(n) || n < 0x20) return 'FF';
    return (n > 255 ? 'FF' : (n < 16 ? '0' : '') + n.toString(16).toUpperCase());
  }

  Obd.prototype.cmd = function (c, t) { return this.s.send(c, t); };

  /** ELM init sequence. protocol: '0' auto or '6' etc. Returns info object.
   *  A single command timeout never aborts init, but a dead link (e.fatal) does, and if the adapter
   *  never answers at all we stop instead of spamming the remaining commands into a dead link. */
  Obd.prototype.init = async function (protocol) {
    var info = { adapterOk: false, ecuOk: false };
    var self = this;
    function identFrom(raw, sent) {
      return (ELM.cleanLines(raw, sent).filter(function (l) { return /ELM|V\d/.test(l); })[0] || '').trim();
    }
    async function at(c, t) {
      var label = c === '' ? '(bare CR)' : c;
      try {
        var r = await self.cmd(c, t);
        info.adapterOk = true; // a prompt came back, so the adapter is alive (even if the text is empty)
        return r;
      } catch (e) {
        if (e.fatal || self.s.dead) throw e;
        self.log('warn', label + ' failed: ' + e.message);
        if (e.partial && String(e.partial).trim()) info.adapterOk = true;
        return e.partial || '';
      }
    }
    var T = Object.assign({ wake: 2000, atz: 10000, atws: 8000, ati: 4000, at: 3000, pid: 12000 }, this.opts.initTimeouts || {});

    // If a reserve notify characteristic is still unsubscribed, do not burn 2s+10s on the wrong channel.
    var tr0 = self.s.t;
    var probing = !!(tr0 && tr0.altNotify && tr0.altNotify.length);
    var wakeMs = probing ? Math.min(T.wake, 800) : T.wake;
    var atzMs = probing ? Math.min(T.atz, 1500) : T.atz;
    self.log('info', 'Init: bare CR to wake the adapter' + (probing ? ' (short ' + wakeMs + 'ms probe; reserve notify not yet subscribed)' : ''));
    await at('', wakeMs);
    self.log('info', 'Init: ATZ (up to ' + atzMs + 'ms; clones can be slow or silent)');
    var z = await at('ATZ', atzMs);
    info.elm = identFrom(z, 'ATZ');

    // Adapter silent: one deliberate change per step (reserve notify characteristic, then write mode), never per command.
    var steps = 0, tr = self.s.t;
    while (!info.adapterOk && tr && typeof tr.nextFallback === 'function' && steps < 3) {
      steps++;
      var fb = await tr.nextFallback();
      if (!fb) break;
      self.log('info', 'Init: no RX yet, fallback ' + steps + ': ' + fb);
      await at('', T.wake);
      z = await at('ATZ', T.atz);
      info.elm = identFrom(z, 'ATZ') || info.elm;
    }
    if (!info.adapterOk) {
      self.log('warn', 'Init: adapter never answered; stopping here instead of sending the rest of the init into a silent link');
      this.info = info;
      return info;
    }
    if (!info.elm) {
      var ati = await at('ATI', T.ati);
      info.elm = identFrom(ati, 'ATI');
      if (!info.elm) { var ws = await at('ATWS', T.atws); info.elm = identFrom(ws, 'ATWS'); }
    }
    self.log('info', 'Init: adapter id = ' + (info.elm || '(unknown)'));

    await at('ATE0', T.at); await at('ATL0', T.at); await at('ATS0', T.at); await at('ATH0', T.at);
    await at('ATAL', T.at); // allow long ISO-TP / multi-PID replies (default ELM limit is 8 bytes)
    await at('ATAT1', T.at);
    await at('ATSP' + (protocol || '0'), T.at);
    var r = '';
    try { r = await this.cmd('0100', T.pid); } catch (e) { if (e.fatal || self.s.dead) throw e; r = e.partial || ''; }
    var err = ELM.detectError(r, '0100');
    info.ecuOk = !err;
    info.ecuError = err;
    if (!err) {
      var msgs = ELM.parsePidResponse(r, 1, PIDS.length);
      this._supportedFirst = msgs['00'] || null;
    }
    var dpn = (await at('ATDPN', T.at)).replace(/[^0-9A-F]/gi, '').toUpperCase();
    info.protocolNum = dpn.replace(/^A/, '');
    info.protocol = PROTOCOLS[info.protocolNum] || (dpn ? ('Protocol ' + dpn) : 'unknown');
    this.isCan = /^[6-9AB]$/.test(info.protocolNum);
    var rv = await at('ATRV', T.at);
    info.voltage = (ELM.cleanLines(rv, 'ATRV')[0] || '').trim();
    ELM.resetAdapterState(this.adapter);
    this.enhancedNS = {}; this.enhancedFails = {}; this._enhancedLast = 0;
    this.protocol = protocol || '0';
    this.info = info;
    return info;
  };

  /**
   * v1.7.0: re-sync the parser-critical adapter settings after a manual AT command from the Console
   * (echo/spaces/headers off, long messages, CAN auto-format, default 7DF header, no receive filter).
   * If the protocol may have changed (ATZ / ATD / ATSP / ATWS) the protocol is set again too.
   */
  Obd.prototype.resync = async function () {
    var st = this.adapter, self = this;
    var full = st.dirtyCmds.some(function (c) { return /^AT(Z|WS|D$|D[01]$|SP|TP)/.test(c); });
    var cmds = ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAL', 'ATCAF1'];
    var timing = st.dirtyCmds.some(function (c) { return /^AT(AT|ST|FC)/.test(c); });
    if (full) cmds.push('ATAT1', 'ATSP' + (this.protocol || '0'));
    else if (timing) cmds.push('ATAT' + ELM.DEFAULT_TIMING.at, 'ATST' + ELM.DEFAULT_TIMING.st, 'ATFCSM0'); // v1.7.1: a manual ATST / ATAT / ATFC* from the Console
    cmds.push('ATSH' + ELM.DEFAULT_HEADER.tx, 'ATCRA');
    this.log('warn', 'Adapter state was changed from the Console (' + st.dirtyCmds.join(', ') + '); re-syncing ' + cmds.join(' ') + ' before polling');
    var ok = true;
    for (var i = 0; i < cmds.length; i++) {
      try {
        var r = await this.cmd(cmds[i], 3000);
        if (ELM.detectError(r, cmds[i]) === '?') self.log('warn', 'Re-sync: adapter rejected ' + cmds[i]);
      } catch (e) {
        if (e.message === 'CANCELLED' || e.fatal) throw e;
        ok = false; self.log('warn', 'Re-sync: ' + cmds[i] + ' failed: ' + e.message);
      }
    }
    if (ok) ELM.resetAdapterState(st);
    else { st.headerKnown = false; }
    return ok;
  };

  /** Switch the tx header / rx filter only if it differs from what the adapter is known to use. Returns false if the adapter rejected ATSH. */
  Obd.prototype.setHeader = async function (target) {
    var st = this.adapter;
    var cmds = ELM.headerSwitchCommands(st, target);
    var ok = true;
    for (var i = 0; i < cmds.length; i++) {
      var c = cmds[i], r = '';
      try { r = await this.cmd(c, 2000); }
      catch (e) {
        if (e.message === 'CANCELLED' || e.fatal) throw e;
        st.headerKnown = false;
        this.log('warn', 'Header switch ' + c + ' failed: ' + e.message);
        return false;
      }
      var err = ELM.detectError(r, c);
      if (err === '?') {
        if (/^ATSH/.test(c)) { st.headerKnown = false; this.log('warn', 'Adapter rejected ' + c); return false; }
        this.log('warn', 'Adapter rejected ' + c + ' (continuing without a receive filter)');
        ok = true; // CRA unsupported on some clones: physical addressing still works with headers off
      }
    }
    st.header = { tx: target.tx, rx: target.rx || null };
    st.headerKnown = true;
    return ok;
  };

  /**
   * v1.7.1: set the ELM response timeout (ATST hh) and adaptive timing (ATAT0/1/2) only if they differ from what the adapter is
   * known to use. A '?' reply is tolerated (some clones ignore these); the app still tracks the intended state.
   */
  Obd.prototype.setTiming = async function (target) {
    var st = this.adapter, cur = st.timingKnown ? st.timing : null;
    var cmds = [];
    if (!cur || cur.at !== target.at) cmds.push('ATAT' + target.at);
    if (!cur || cur.st !== target.st) cmds.push('ATST' + target.st);
    for (var i = 0; i < cmds.length; i++) {
      var r = '';
      try { r = await this.cmd(cmds[i], 2000); }
      catch (e) {
        if (e.message === 'CANCELLED' || e.fatal) throw e;
        st.timingKnown = false;
        this.log('warn', 'Timing command ' + cmds[i] + ' failed: ' + e.message);
        return false;
      }
      if (ELM.detectError(r, cmds[i]) === '?') this.log('warn', 'Adapter rejected ' + cmds[i] + ' (continuing)');
    }
    st.timing = { st: target.st, at: target.at }; st.timingKnown = true;
    return true;
  };

  Obd.prototype.restoreDefaultTiming = async function () {
    var d = ELM.DEFAULT_TIMING, t = this.adapter.timing;
    if (this.adapter.timingKnown && t && t.st === d.st && t.at === d.at) return true;
    var ok = await this.setTiming({ st: d.st, at: d.at });
    if (!ok) ok = await this.setTiming({ st: d.st, at: d.at });
    if (ok) this.log('info', 'Timing restored to ATST' + d.st + ' / ATAT' + d.at);
    return ok;
  };

  /** Make sure the standard broadcast header (ATSH 7DF, no ATCRA filter) and normal timing (ATST32, ATAT1) are active. */
  Obd.prototype.restoreDefaultHeader = async function () {
    var ok = true;
    if (!(this.adapter.headerKnown && ELM.sameHeader(this.adapter.header, ELM.DEFAULT_HEADER))) {
      ok = await this.setHeader(ELM.DEFAULT_HEADER);
      if (!ok) {
        // One more try: a stale prompt or a busy bus can eat the first command.
        ok = await this.setHeader(ELM.DEFAULT_HEADER);
      }
      if (ok) this.log('info', 'Header restored to ' + ELM.DEFAULT_HEADER.tx + ' (receive filter cleared)');
    }
    var tOk = await this.restoreDefaultTiming();
    return ok && tOk;
  };

  /** v1.7.1: forget the 3-failure N/S verdicts so enhanced PIDs are tried again ("Retry CVT"). */
  Obd.prototype.clearEnhancedNS = function () {
    var n = Object.keys(this.enhancedNS).length;
    this.enhancedNS = {}; this.enhancedFails = {}; this._enhancedLast = 0;
    this.log('info', 'Retry CVT: cleared ' + n + ' N/S verdict(s); enhanced PIDs will be tried again');
    return n;
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
  function livePreview(raw) {
    return String(raw || '').replace(/\r/g, '\\r').replace(/\n/g, '\\n').slice(0, 180);
  }

  Obd.prototype._pidTimeout = function () {
    return this.opts.pidTimeout || (this.s && this.s.opts && this.s.opts.timeout) || 1500;
  };

  /** Ask for one PID. Retries without the fast-response "1" suffix if the adapter rejects it or nothing decodes. */
  Obd.prototype._queryOne = async function (pid, timeout) {
    var cmd = '01' + pid;
    if (this.fastResponse && this.isCan) cmd += '1';
    var r, errName = null;
    try { r = await this.cmd(cmd, timeout); }
    catch (e) {
      if (e.message === 'CANCELLED') throw e;
      r = e.partial || '';
      errName = e.message;
    }
    var err = errName || ELM.detectError(r, cmd);
    this.log('info', 'Live ' + cmd + ' -> ' + (errName ? errName + (r ? ' partial=' + livePreview(r) : ' (no RX)') : livePreview(r) || '(empty)'));
    var parsed = ELM.parsePidResponse(r, 1, PIDS.length, cmd);
    if (parsed[pid]) return PIDS.decode(pid, parsed[pid]);
    if (cmd.length % 2 === 1 && (err === '?' || !parsed[pid])) {
      this.fastResponse = false;
      this.log('warn', 'Fast-response suffix failed for ' + cmd + (err ? ' (' + err + ')' : ' (no decode)') + '; retrying as 01' + pid);
      try { r = await this.cmd('01' + pid, timeout); }
      catch (e) {
        if (e.message === 'CANCELLED') throw e;
        r = e.partial || '';
        this.log('info', 'Live 01' + pid + ' -> ' + e.message + (r ? ' partial=' + livePreview(r) : ' (no RX)'));
        return null;
      }
      this.log('info', 'Live 01' + pid + ' -> ' + livePreview(r));
      parsed = ELM.parsePidResponse(r, 1, PIDS.length, '01' + pid);
      if (parsed[pid]) return PIDS.decode(pid, parsed[pid]);
    }
    return null;
  };

  /**
   * v1.7.0: poll a mixed list. Standard mode-01 PIDs go out on the default 7DF header; enhanced PIDs are grouped
   * by target header so ATSH / ATCRA is only sent when switching modules, and identical requests are sent once.
   * The default header is ALWAYS restored before returning, on success, NO DATA, timeout or error.
   */
  Obd.prototype.queryPids = async function (pids, opts) {
    var std = [], enh = [];
    (pids || []).forEach(function (p) { (PIDS.isEnhanced(p) ? enh : std).push(p); });
    var out = {};
    if (std.length) {
      var tm = this.adapter.timing, tmOk = this.adapter.timingKnown && tm && tm.st === ELM.DEFAULT_TIMING.st && tm.at === ELM.DEFAULT_TIMING.at;
      if (!this.adapter.headerKnown || !ELM.sameHeader(this.adapter.header, ELM.DEFAULT_HEADER) || !tmOk) await this.restoreDefaultHeader();
      out = await this._queryStandard(std);
    }
    var self = this;
    enh = enh.filter(function (p) { return !self.enhancedNS[p]; });
    var force = opts && opts.forceEnhanced;
    if (enh.length && (force || Date.now() - this._enhancedLast >= this.enhancedEveryMs)) {
      this._enhancedLast = Date.now();
      try {
        var ev = await this._queryEnhanced(enh);
        Object.keys(ev).forEach(function (k) { out[k] = ev[k]; });
      } finally {
        await this.restoreDefaultHeader();
      }
    }
    return out;
  };

  /** Group enhanced PIDs by header, then by request. */
  Obd.prototype._queryEnhanced = async function (pids) {
    var out = {}, groups = {}, order = [], self = this;
    pids.forEach(function (p) {
      var d = PIDS.get(p), hk = ELM.headerKey({ tx: d.txHeader, rx: d.rxFilter });
      if (!groups[hk]) { groups[hk] = { header: { tx: d.txHeader, rx: d.rxFilter || null }, reqs: {}, reqOrder: [] }; order.push(hk); }
      var g = groups[hk];
      if (!g.reqs[d.request]) { g.reqs[d.request] = []; g.reqOrder.push(d.request); }
      g.reqs[d.request].push(p);
    });
    for (var gi = 0; gi < order.length; gi++) {
      var g = groups[order[gi]];
      var switched = await this.setHeader(g.header);
      if (!switched) {
        g.reqOrder.forEach(function (rq) { self._enhancedFailed(g.header, rq, g.reqs[rq], 'header switch rejected'); });
        continue;
      }
      // v1.7.1: long ELM timeout + adaptive timing off while this group talks to a slow module (the TCM); restored with the header.
      var slow = g.reqOrder.some(function (rq0) { return g.reqs[rq0].some(function (p0) { return PIDS.get(p0).slowTimeout; }); });
      var wantT = slow ? { st: this.enhancedSt, at: 0 } : { st: ELM.DEFAULT_TIMING.st, at: ELM.DEFAULT_TIMING.at };
      await this.setTiming(wantT);
      var reqTimeout = Math.max(this._pidTimeout(), 1500, slow ? parseInt(this.enhancedSt, 16) * 4 + 1200 : 0);
      for (var ri = 0; ri < g.reqOrder.length; ri++) {
        var rq = g.reqOrder[ri], members = g.reqs[rq];
        var r = '', errName = null;
        try { r = await this.cmd(rq, reqTimeout); }
        catch (e) {
          if (e.message === 'CANCELLED' || e.fatal) throw e;
          errName = e.message; r = e.partial || '';
        }
        var tag = g.header.tx + (g.header.rx ? '/' + g.header.rx : '') + ' ' + rq;
        var err = errName || ELM.detectError(r, rq);
        var data = ELM.parseEnhancedResponse(r, rq);
        if (!data) {
          this.log('info', 'EXP ' + tag + ' -> ' + (err || 'no positive reply') + (r ? ' raw=' + livePreview(r) : ''));
          this._enhancedFailed(g.header, rq, members, err || 'no positive reply');
          continue;
        }
        this.enhancedFails[ELM.headerKey(g.header) + '|' + rq] = 0;
        var parts = [];
        members.forEach(function (p) {
          var d = PIDS.get(p);
          var v = PIDS.decodeEnhanced(p, data);
          if (v != null) out[p] = v;
          parts.push(d.short + '=' + (v == null ? 'n/a' : v));
        });
        var anyDef = PIDS.get(members[0]);
        var bi = anyDef.byteIndex;
        var byteNote = bi != null && data.length > bi ? (' | data[' + bi + '] (Torque ' + torqueLetter(bi) + ') = 0x' + ELM.toHex(data[bi]) + ' = ' + data[bi]) : (bi != null ? ' | reply too short for data[' + bi + ']' : '');
        // Raw bytes always logged for experimental PIDs so the formula can be checked against a cold-start reading.
        this.log('info', 'EXP ' + tag + ' raw (' + data.length + ' data bytes): ' + ELM.bytesHex(data) + byteNote + ' -> ' + parts.join(', '));
      }
    }
    return out;
  };

  Obd.prototype._enhancedFailed = function (header, rq, members, why) {
    var key = ELM.headerKey(header) + '|' + rq;
    var n = (this.enhancedFails[key] || 0) + 1;
    this.enhancedFails[key] = n;
    if (n >= this.enhancedMaxFails) {
      var self = this;
      members.forEach(function (p) { self.enhancedNS[p] = true; });
      this.log('warn', 'Enhanced request ' + header.tx + ' ' + rq + ' failed ' + n + ' times in a row (' + why + '); marking ' + members.join(', ') + ' as N/S and skipping it. Tap Retry CVT (Live tab) or re-run init to try again.');
    }
  };

  function torqueLetter(i) { var L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'; return i < 26 ? L[i] : 'A' + L[i - 26]; }

  Obd.prototype._queryStandard = async function (pids) {
    var out = {};
    if (!pids.length) return out;
    var timeout = this._pidTimeout();
    var self = this;
    var groups = [];
    var per = (this.multiPid && this.isCan) ? 6 : 1;
    for (var i = 0; i < pids.length; i += per) groups.push(pids.slice(i, i + per));
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      if (grp.length === 1) {
        var one = await this._queryOne(grp[0], timeout);
        if (one != null) out[grp[0]] = one;
        continue;
      }
      var cmd = '01' + grp.join('');
      var r = '', timedOut = false, failReason = null;
      try { r = await this.cmd(cmd, timeout); }
      catch (e) {
        if (e.message === 'CANCELLED') throw e;
        timedOut = e.message === 'TIMEOUT';
        r = e.partial || '';
        failReason = e.message + (r ? ' partial=' + livePreview(r) : ' (no RX)');
        this.log('info', 'Live ' + cmd + ' -> ' + failReason);
      }
      if (!failReason) this.log('info', 'Live ' + cmd + ' -> ' + (livePreview(r) || '(empty)'));
      var err = failReason ? (timedOut ? 'TIMEOUT' : failReason) : ELM.detectError(r, cmd);
      var parsed = ELM.parsePidResponse(r, 1, PIDS.length, cmd);
      var got = 0;
      grp.forEach(function (p) {
        if (parsed[p]) {
          var v = PIDS.decode(p, parsed[p]);
          if (v != null) { out[p] = v; got++; }
        }
      });
      if (got < grp.length) {
        var why = err ? String(err) : (got ? ('decoded ' + got + '/' + grp.length + ' PIDs') : 'no PIDs decoded');
        if (got === 0 || timedOut || err) {
          this.multiPid = false;
          this.log('warn', 'Multi-PID request ' + cmd + ' failed (' + why + '); falling back to single-PID requests');
        } else {
          this.log('info', 'Multi-PID request ' + cmd + ' incomplete (' + why + '); fetching the missing PIDs individually');
        }
        if (timedOut) {
          // Nudge the adapter in case it is still waiting on the ECU, so the next command is not mixed with a late prompt.
          try { await this.cmd('', Math.min(500, timeout)); } catch (e) { if (e.message === 'CANCELLED') throw e; }
        }
        for (var k = 0; k < grp.length; k++) {
          var p = grp[k];
          if (out[p] != null) continue;
          var v1 = await this._queryOne(p, timeout);
          if (v1 != null) out[p] = v1;
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

  var api = { Obd: Obd, PROTOCOLS: PROTOCOLS, normSt: normSt };
  if (isNode) module.exports = api; else root.OBD = api;
})(this);
