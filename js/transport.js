/* Transports (Web Bluetooth BLE serial, mock ELM327) and the serialized ELM command queue. */
(function (root) {
  'use strict';
  var isNode = typeof module !== 'undefined' && module.exports;

  function uuid16(x) { return '0000' + x + '-0000-1000-8000-00805f9b34fb'; }

  // Known BLE "serial" services used by ELM327-style dongles, with their preferred notify/write characteristics.
  var BLE_PROFILES = [
    { name: 'FFF0 (common clone)', service: uuid16('fff0'), notify: uuid16('fff1'), write: uuid16('fff2') },
    { name: 'FFE0 (HM-10 style)', service: uuid16('ffe0'), notify: uuid16('ffe1'), write: uuid16('ffe1') },
    { name: '18F0 (Vgate/iCar)', service: uuid16('18f0'), notify: uuid16('2af0'), write: uuid16('2af1') },
    { name: 'E7810A71 (IOS-Vlink)', service: 'e7810a71-73ae-499d-8c2c-9d2a2b1e1b31', notify: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f', write: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f' },
    { name: 'Nordic UART', service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e' },
    { name: 'AE30', service: uuid16('ae30'), notify: uuid16('ae02'), write: uuid16('ae01') },
    { name: 'FF00', service: uuid16('ff00'), notify: uuid16('ff01'), write: uuid16('ff02') },
    { name: 'FFB0', service: uuid16('ffb0'), notify: uuid16('ffb2'), write: uuid16('ffb1') }
  ];
  var OPTIONAL_SERVICES = BLE_PROFILES.map(function (p) { return p.service; });

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** Reject if `promise` does not settle within ms. The original work is not cancelled. */
  function withTimeout(promise, ms, label) {
    var timedOut = false;
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        timedOut = true;
        var te = new Error((label || 'operation') + ' timed out after ' + ms + 'ms'); te.timeout = true; reject(te);
      }, ms);
      Promise.resolve(promise).then(
        function (v) { clearTimeout(t); if (!timedOut) resolve(v); },
        function (e) { clearTimeout(t); if (!timedOut) reject(e); }
      );
    });
  }

  function shortUuid(u) {
    u = String(u || '').toLowerCase();
    if (u.indexOf('0000') === 0 && u.indexOf('-0000-1000-8000-00805f9b34fb') > 0) return u.slice(4, 8);
    return u.slice(0, 8);
  }

  function bytesToHex(u8) {
    var s = [];
    for (var i = 0; i < u8.length; i++) s.push((u8[i] < 16 ? '0' : '') + u8[i].toString(16).toUpperCase());
    return s.join(' ');
  }

  function bytesToAscii(u8) {
    var out = '';
    for (var i = 0; i < u8.length; i++) {
      var c = u8[i];
      out += c === 13 ? '\\r' : c === 10 ? '\\n' : (c >= 32 && c < 127 ? String.fromCharCode(c) : '.');
    }
    return out;
  }

  function formatBytes(u8) {
    return u8.length + ' bytes: ' + bytesToHex(u8) + "  '" + bytesToAscii(u8) + "'";
  }


  // ---------------- Web Bluetooth transport ----------------
  // Android's GATT stack allows exactly ONE outstanding operation per device. Every GATT call below goes through
  // one strictly serialized chain (_exclusive) and _runOp (timeout + busy-retry). A timed-out op poisons the link:
  // we never write into it again, we disconnect -> wait -> reconnect -> rediscover -> resubscribe instead.
  var BUSY_RE = /already in progress|operation in progress|operation is already|gatt busy/i;
  function isBusyError(e) { return !!e && BUSY_RE.test(String(e.message || e)); }
  function fatalError(msg, cause) { var e = new Error(msg); e.fatal = true; e.cause = cause; return e; }
  function noop() {}

  function BleTransport(opts) {
    this.opts = opts || {};
    this.device = null; this.server = null; this.writeChar = null; this.notifyChar = null;
    this.notifyChars = []; this.subscribed = []; this.altNotify = [];
    this.activeNotifyUuid = null; this.rxSeen = false;
    this.onData = function () {}; this.onDisconnect = function () {};
    this.log = this.opts.log || function () {};
    this.onStatus = this.opts.onStatus || function () {};
    this.decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('ascii') : null;
    this.kind = 'ble'; this.logsRx = true;
    this._chain = Promise.resolve();
    this._poisoned = false; this._dead = false; this._expectDisc = false; this._recovering = false;
    this.writeModeLocked = this.opts.writeMode === 'with' || this.opts.writeMode === 'without';
    this.useWithoutResponse = this.opts.writeMode !== 'with';
    this._modeChosen = false; this.notifyLocked = false;
    this.stats = { recoveries: 0, busyRetries: 0 };
  }

  BleTransport.isSupported = function () { return typeof navigator !== 'undefined' && !!navigator.bluetooth; };

  BleTransport.prototype._opt = function (k, d) { return this.opts[k] != null ? this.opts[k] : d; };

  BleTransport.prototype.request = async function (acceptAll) {
    var options = acceptAll
      ? { acceptAllDevices: true, optionalServices: OPTIONAL_SERVICES }
      : { filters: [{ namePrefix: 'OBD' }, { namePrefix: 'obd' }, { namePrefix: 'Vlink' }, { namePrefix: 'V-LINK' }, { namePrefix: 'IOS-Vlink' }, { namePrefix: 'Android-Vlink' }, { namePrefix: 'VEEPEAK' }, { namePrefix: 'ELM' }, { namePrefix: 'Viecar' }],
          optionalServices: OPTIONAL_SERVICES };
    this.log('info', 'requestDevice ' + (acceptAll ? '(all devices)' : '(name filter OBD*/Vlink*/ELM*)'));
    this.device = await navigator.bluetooth.requestDevice(options);
    this.name = this.device.name || '(unnamed)';
    var self = this;
    this.device.addEventListener('gattserverdisconnected', function () {
      if (self._expectDisc || self._recovering) { self.log('info', 'GATT disconnected (expected)'); return; }
      self.log('warn', 'GATT disconnected'); self.onDisconnect();
    });
    return this.device;
  };

  /** Run fn after every previously queued GATT job has finished. This is the ONLY way jobs start. */
  BleTransport.prototype._exclusive = function (fn) {
    var p = this._chain.then(fn);
    this._chain = p.then(noop, noop);
    return p;
  };

  /**
   * One GATT operation with timeout. "Already in progress" is treated as BUSY: wait with backoff and retry the SAME
   * op (never counted as no-RX, never changes write mode). A timeout poisons the link (a hung GATT op can only be
   * cleared by disconnecting).
   */
  BleTransport.prototype._runOp = async function (label, fn, o) {
    o = o || {};
    var timeout = o.timeout || this._opt('opTimeout', 5000);
    var delays = this._opt('busyDelays', [150, 300, 600, 1000, 1500]);
    var busy = 0, t0 = Date.now();
    for (;;) {
      if (!o.quiet) this.log('info', 'GATT ' + label + ' ...');
      try {
        var v = await withTimeout(Promise.resolve().then(fn), timeout, label);
        if (!o.quiet) this.log('info', 'GATT ' + label + ' OK (' + (Date.now() - t0) + 'ms)');
        return v;
      } catch (e) {
        if (e && e.timeout) { this._poisoned = true; this.log('warn', 'GATT ' + label + ' HUNG (' + timeout + 'ms) -> link poisoned, will reconnect'); throw e; }
        if (isBusyError(e)) {
          if (busy < delays.length) {
            this.stats.busyRetries++;
            this.log('warn', 'GATT busy during ' + label + ' ("' + e.message + '"): waiting ' + delays[busy] + 'ms, retrying the same op');
            await sleep(delays[busy++]);
            continue;
          }
          this._poisoned = true;
          var be = new Error(label + ': GATT still busy after ' + delays.length + ' retries'); be.busy = true; throw be;
        }
        if (e && (e.name === 'NetworkError' || /disconnected|not connected/i.test(String(e.message)))) this._poisoned = true;
        if (!o.quiet) this.log('warn', 'GATT ' + label + ' FAILED: ' + (e && e.message));
        throw e;
      }
    }
  };

  BleTransport.prototype.connect = function () {
    var self = this;
    if (!this.device) return Promise.reject(new Error('No device selected'));
    return this._exclusive(async function () {
      self.log('info', 'Connecting GATT to ' + self.name + ' (' + (self.device.id || '') + ')');
      try { await self._setup(); }
      catch (e) {
        if (e.noRecover || e.fatal) throw e;
        self.log('warn', 'GATT setup failed: ' + e.message + ' -> reconnecting');
        var ok = await self._recoverLoop(e.message, self._opt('maxRecoveries', 2));
        if (!ok) {
          self._dead = true;
          throw fatalError('Could not establish a working Bluetooth GATT link after ' + self._opt('maxRecoveries', 2) + ' reconnect attempts (' + (self._lastErr || e.message) + ').', e);
        }
      }
      return true;
    });
  };

  /** disconnect -> wait -> connect -> rediscover -> resubscribe. Must be called from inside _exclusive. */
  BleTransport.prototype._recoverLoop = async function (reason, maxTries) {
    var wait = this._opt('reconnectWait', 1000);
    for (var i = 1; i <= maxTries; i++) {
      this.stats.recoveries++;
      this._recovering = true; this._expectDisc = true;
      this.onStatus('Reconnecting Bluetooth (' + i + '/' + maxTries + ')…');
      this.log('warn', 'Recovery ' + i + '/' + maxTries + ' (' + reason + '): disconnect, wait ' + wait + 'ms, reconnect, rediscover');
      try { if (this.device && this.device.gatt) this.device.gatt.disconnect(); } catch (e) { /* ignore */ }
      this._poisoned = false;
      await sleep(wait);
      try {
        await this._setup();
        this._recovering = false; this._expectDisc = false;
        this.log('info', 'Recovery ' + i + ' OK');
        return true;
      } catch (e) {
        this._lastErr = e.message; reason = e.message;
        this.log('warn', 'Recovery ' + i + ' failed: ' + e.message);
        if (e.noRecover) { this._recovering = false; this._expectDisc = false; throw e; }
      }
    }
    this._recovering = false; this._expectDisc = false; this._poisoned = true;
    return false;
  };

  BleTransport.prototype._setup = async function () {
    var self = this;
    this.subscribed = []; this.altNotify = []; this.notifyChars = []; this.writeChar = null;
    this.server = await this._runOp('gatt.connect', function () { return self.device.gatt.connect(); }, { timeout: this._opt('gattTimeout', 15000) });
    var d1 = this._opt('postConnectDelay', 400);
    if (d1) { this.log('info', 'Waiting ' + d1 + 'ms after connect before first GATT operation'); await sleep(d1); }
    var services = await this._runOp('getPrimaryServices', function () { return self.server.getPrimaryServices(); });
    this.log('info', 'Services visible: ' + services.map(function (s) { return s.uuid; }).join(', '));
    var found = await this._pickCharacteristics(services);
    if (!found) { var ne = new Error('No notify+write characteristic pair found. Check Console for the service list.'); ne.noRecover = true; throw ne; }
    this.writeChar = found.write; this.profileName = found.label;
    var list = found.notifyList.slice();
    // manual notify choice (Settings)
    var want = String(this._opt('notifyChar', 'auto')).toLowerCase();
    this.notifyLocked = false;
    if (want !== 'auto') {
      var m = list.filter(function (c) { return shortUuid(c.uuid) === want; })[0];
      if (m) { list = [m]; this.notifyLocked = true; this.log('info', 'Notify characteristic locked to ' + want + ' (Settings)'); }
      else this.log('warn', 'Settings asked for notify ' + want + ' but it is not in this service; using auto');
    }
    // after a reconnect, prefer the characteristic that already produced RX
    if (this.activeNotifyUuid) {
      var act = list.filter(function (c) { return c.uuid === self.activeNotifyUuid; })[0];
      if (act) list = [act].concat(list.filter(function (c) { return c !== act; }));
    }
    this.notifyChars = list;
    var wp = this.writeChar.properties;
    if (!this._modeChosen) {
      var mode = this._opt('writeMode', 'auto');
      if (mode === 'without') this.useWithoutResponse = true;
      else if (mode === 'with') this.useWithoutResponse = false;
      else this.useWithoutResponse = !wp.write || !!wp.writeWithoutResponse; // auto: prefer without
      this._modeChosen = true;
    }
    this.log('info', 'Using ' + found.label + ' write=' + this.writeChar.uuid + ' [' + this.writeModeLabel() + '; write=' + !!wp.write + ' writeWithoutResponse=' + !!wp.writeWithoutResponse + ']' +
      ' notify order=[' + list.map(function (c) { return shortUuid(c.uuid); }).join(', ') + ']');
    await this._subscribeSequence(list);
    var d2 = this._opt('postSubscribeDelay', 300);
    if (d2) { this.log('info', 'Waiting ' + d2 + 'ms after subscribe before first write'); await sleep(d2); }
    this.log('info', 'BLE link ready for ELM commands');
  };

  /** Subscribe SEQUENTIALLY. Primary first (retry once); alternates only if the primary cannot be enabled. */
  BleTransport.prototype._subscribeSequence = async function (list) {
    var ok = await this._trySubscribe(list[0], true);
    var i = 1;
    while (!ok && i < list.length) { ok = await this._trySubscribe(list[i], false); i++; }
    if (!ok) throw new Error('Could not enable notifications on any characteristic');
    this.altNotify = list.filter(function (c) { return this.subscribed.indexOf(c) < 0; }, this);
    if (this.altNotify.length && !this.notifyLocked)
      this.log('info', 'Alternate notify characteristic(s) held in reserve (used only if no RX arrives): ' + this.altNotify.map(function (c) { return shortUuid(c.uuid); }).join(', '));
  };

  BleTransport.prototype._trySubscribe = async function (char, retry) {
    var self = this, id = shortUuid(char.uuid);
    var kind = char.properties.notify ? 'notify' : (char.properties.indicate ? 'indicate' : 'notify');
    if (!char.__obdListening) {
      char.__obdListening = true;
      char.addEventListener('characteristicvaluechanged', function (ev) { self._onNotify(char, ev); });
    }
    var tries = retry ? 2 : 1;
    for (var n = 1; n <= tries; n++) {
      try {
        await this._runOp('startNotifications ' + id + ' (' + kind + ', try ' + n + '/' + tries + ')', function () { return char.startNotifications(); }, { timeout: this._opt('notifyTimeout', 5000) });
        if (this.subscribed.indexOf(char) < 0) this.subscribed.push(char);
        return true;
      } catch (e) {
        if (e.timeout || e.busy) throw e; // poisoned: do not touch GATT again, let recovery handle it
        if (n < tries) { var dl = this._opt('subscribeRetryDelay', 500); this.log('info', 'Retrying startNotifications ' + id + ' in ' + dl + 'ms'); await sleep(dl); }
      }
    }
    return false;
  };

  BleTransport.prototype._onNotify = function (char, ev) {
    var dv = ev.target.value;
    var bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    this.rxSeen = true;
    if (!this.activeNotifyUuid) {
      this.activeNotifyUuid = char.uuid; this.notifyChar = char;
      this.log('info', 'First RX on ' + char.uuid + ' (remembered)');
    }
    this.log('rx', 'notify ' + shortUuid(char.uuid) + ' ' + formatBytes(bytes));
    var s = this.decoder ? this.decoder.decode(bytes) : String.fromCharCode.apply(null, bytes);
    this.onData(s);
  };

  BleTransport.prototype._pickCharacteristics = async function (services) {
    var self = this, all = [];
    for (var i = 0; i < services.length; i++) {
      var s = services[i], chars = [];
      try { chars = await this._runOp('getCharacteristics ' + shortUuid(s.uuid), function () { return s.getCharacteristics(); }, { quiet: true }); }
      catch (e) { if (e.timeout || e.busy) throw e; this.log('warn', 'getCharacteristics failed on ' + s.uuid + ': ' + e.message); }
      chars.forEach(function (c) {
        var p = c.properties;
        self.log('info', '  ' + shortUuid(s.uuid) + ' / ' + c.uuid + ' [' + ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter(function (k) { return p[k]; }).join(',') + ']');
      });
      all.push({ service: s, chars: chars });
    }
    function notifies(chars) { return chars.filter(function (c) { return c.properties.notify || c.properties.indicate; }); }
    function writers(chars) { return chars.filter(function (c) { return c.properties.write || c.properties.writeWithoutResponse; }); }
    for (var k = 0; k < BLE_PROFILES.length; k++) {
      var prof = BLE_PROFILES[k];
      var entry = all.filter(function (e) { return e.service.uuid === prof.service; })[0];
      if (!entry) continue;
      var ns = notifies(entry.chars);
      var w = entry.chars.filter(function (c) { return c.uuid === prof.write && (c.properties.write || c.properties.writeWithoutResponse); })[0] || writers(entry.chars)[0];
      var preferred = ns.filter(function (c) { return c.uuid === prof.notify; })[0];
      if (w && ns.length) return { write: w, notifyList: (preferred ? [preferred] : []).concat(ns.filter(function (c) { return c !== preferred; })), label: prof.name };
    }
    for (var j = 0; j < all.length; j++) {
      var ns2 = notifies(all[j].chars), ws = writers(all[j].chars);
      if (ns2.length && ws.length) return { write: ws[0], notifyList: ns2, label: 'auto ' + shortUuid(all[j].service.uuid) };
    }
    return null;
  };

  BleTransport.prototype.writeModeLabel = function () { return this.useWithoutResponse ? 'writeWithoutResponse' : 'writeWithResponse'; };

  BleTransport.prototype.canToggleWrite = function () {
    if (this.writeModeLocked || !this.writeChar) return false;
    var p = this.writeChar.properties;
    return !!(p.write && p.writeWithoutResponse);
  };

  BleTransport.prototype.toggleWriteMode = function () {
    if (!this.canToggleWrite()) return false;
    this.useWithoutResponse = !this.useWithoutResponse;
    this.log('info', 'Write mode is now ' + this.writeModeLabel());
    return true;
  };

  BleTransport.prototype._writeChunk = function (chunk) {
    var c = this.writeChar;
    if (this.useWithoutResponse && c.writeValueWithoutResponse) return c.writeValueWithoutResponse(chunk);
    if (!this.useWithoutResponse && c.writeValueWithResponse) return c.writeValueWithResponse(chunk);
    if (c.writeValueWithoutResponse && !c.properties.write) return c.writeValueWithoutResponse(chunk);
    if (c.writeValueWithResponse) return c.writeValueWithResponse(chunk);
    return c.writeValue(chunk);
  };

  BleTransport.prototype.write = function (str) {
    var self = this, enc;
    if (typeof TextEncoder !== 'undefined') enc = new TextEncoder().encode(str);
    else { enc = new Uint8Array(str.length); for (var k = 0; k < str.length; k++) enc[k] = str.charCodeAt(k) & 0xff; }
    return this._exclusive(async function () {
      var maxRec = self._opt('maxRecoveries', 2), attempt = 0;
      for (;;) {
        if (self._dead) throw fatalError('Bluetooth link is dead (earlier unrecoverable failure)');
        self.log('tx', self.writeModeLabel() + ' ' + formatBytes(enc));
        try {
          if (self._poisoned) throw new Error('GATT link is poisoned by an earlier hung operation');
          var n = Math.ceil(enc.length / 20);
          for (var i = 0; i < enc.length; i += 20) {
            var chunk = enc.slice(i, i + 20);
            await self._runOp('write ' + self.writeModeLabel() + (n > 1 ? ' chunk ' + (i / 20 + 1) + '/' + n : ''), function () { return self._writeChunk(chunk); },
              { timeout: self._opt('writeTimeout', 3000), quiet: true });
          }
          return;
        } catch (e) {
          if (e.fatal) throw e;
          attempt++;
          self.log('warn', 'Write failed (' + self.writeModeLabel() + '): ' + e.message);
          if (attempt > maxRec) { self._dead = true; throw fatalError('Bluetooth write failed and ' + maxRec + ' reconnect attempts did not fix it (' + e.message + ').', e); }
          if (!self.rxSeen && !e.busy && self.canToggleWrite()) { self.toggleWriteMode(); self.log('info', 'No RX has ever arrived, so after reconnect the other write mode will be used (once, not per command)'); }
          await self._recoverLoop(e.message, 1);
        }
      }
    });
  };

  /**
   * Called by init when the adapter has not answered at all. Performs ONE deliberate change per call:
   * 1) subscribe the reserve notify characteristic (e.g. ffea), else 2) switch write mode. Returns a description or null.
   */
  BleTransport.prototype.nextFallback = function () {
    var self = this;
    return this._exclusive(async function () {
      if (self._dead) return null;
      if (self._poisoned) { try { await self._recoverLoop('poisoned before fallback', 1); } catch (e) { return null; } }
      if (!self.notifyLocked && self.altNotify.length) {
        var c = self.altNotify.shift();
        try {
          var ok = await self._trySubscribe(c, false);
          return 'subscribed reserve notify characteristic ' + shortUuid(c.uuid) + (ok ? '' : ' (FAILED)');
        } catch (e) { return 'reserve notify ' + shortUuid(c.uuid) + ' hung (' + e.message + ')'; }
      }
      if (self.canToggleWrite() && !self._fallbackToggled) {
        self._fallbackToggled = true; self.toggleWriteMode();
        return 'switched to ' + self.writeModeLabel();
      }
      return null;
    });
  };

  BleTransport.prototype.disconnect = function () {
    var self = this;
    this._expectDisc = true;
    return this._exclusive(async function () {
      if (!self._poisoned) {
        for (var i = 0; i < self.subscribed.length; i++) {
          try { await withTimeout(Promise.resolve(self.subscribed[i].stopNotifications()), 1500, 'stopNotifications'); } catch (e) { break; }
        }
      }
      try { if (self.device && self.device.gatt && self.device.gatt.connected) self.device.gatt.disconnect(); } catch (e) { /* ignore */ }
    });
  };

  // ---------------- Mock ELM327 (simulated car) ----------------
  function MockTransport(opts) {
    this.opts = opts || {};
    this.onData = function () {}; this.onDisconnect = function () {}; this.log = this.opts.log || function () {};
    this.kind = 'mock'; this.name = 'Mock OBDII (simulated)';
    this.echo = true; this.spaces = true; this.headers = false; this.linefeed = true;
    this.t0 = Date.now();
    this.dtcs = { '03': ['0133', '0442'], '07': ['0171'], '0A': ['0133'] };
    this.latency = this.opts.latency != null ? this.opts.latency : 25;
  }
  MockTransport.prototype.connect = async function () { this.connected = true; return true; };
  MockTransport.prototype.disconnect = async function () { this.connected = false; this.onDisconnect(); };
  MockTransport.prototype.write = async function (str) {
    var self = this;
    var cmd = str.replace(/[\r\n]/g, '').trim().toUpperCase();
    var reply = this._respond(cmd.replace(/\s+/g, ''));
    var out = (this.echo ? cmd + '\r' : '') + reply + '\r\r>';
    // Deliver in 20-byte BLE-like chunks
    var chunks = [];
    for (var i = 0; i < out.length; i += 20) chunks.push(out.slice(i, i + 20));
    var delay = this.latency;
    chunks.forEach(function (c, idx) { setTimeout(function () { self.onData(c); }, delay + idx * 2); });
  };

  MockTransport.prototype._sim = function () {
    var t = (Date.now() - this.t0) / 1000;
    var rpm = 780 + 1400 * Math.max(0, Math.sin(t / 6)) + 40 * Math.sin(t * 3);
    var speed = Math.max(0, 60 * Math.sin(t / 12));
    return {
      rpm: rpm, speed: speed, ect: Math.min(92, 40 + t * 0.8), iat: 28 + 3 * Math.sin(t / 30), load: 18 + 40 * Math.max(0, Math.sin(t / 6)),
      maf: rpm / 250, map: 32 + 50 * Math.max(0, Math.sin(t / 6)), thr: 15 + 50 * Math.max(0, Math.sin(t / 6)),
      stft1: 2 * Math.sin(t * 1.7), ltft1: 3.1, stft2: 1.5 * Math.cos(t * 1.5), ltft2: -1.6,
      o2a: 0.45 + 0.4 * Math.sin(t * 4), o2b: 0.68 + 0.02 * Math.sin(t), timing: 12 + 8 * Math.sin(t / 5),
      fuel: 62, volt: 14.1 + 0.1 * Math.sin(t), baro: 101, cat: 420 + 30 * Math.sin(t / 20), amb: 22, oil: Math.min(98, 35 + t * 0.6), run: t
    };
  };

  function hx(n) { n = Math.max(0, Math.min(255, Math.round(n))); return (n < 16 ? '0' : '') + n.toString(16).toUpperCase(); }
  function hx2(n) { n = Math.max(0, Math.min(65535, Math.round(n))); return hx(n >> 8) + hx(n & 255); }

  MockTransport.prototype._pidData = function (pid) {
    var s = this._sim();
    var trimB = function (p) { return hx(p * 128 / 100 + 128); };
    switch (pid) {
      case '01': return '82076500'; // MIL on, 2 DTCs
      case '04': return hx(s.load * 255 / 100);
      case '05': return hx(s.ect + 40);
      case '06': return trimB(s.stft1);
      case '07': return trimB(s.ltft1);
      case '08': return trimB(s.stft2);
      case '09': return trimB(s.ltft2);
      case '0B': return hx(s.map);
      case '0C': return hx2(s.rpm * 4);
      case '0D': return hx(s.speed);
      case '0E': return hx((s.timing + 64) * 2);
      case '0F': return hx(s.iat + 40);
      case '10': return hx2(s.maf * 100);
      case '11': return hx(s.thr * 255 / 100);
      case '14': return hx(s.o2a * 200) + trimB(s.stft1);
      case '15': return hx(s.o2b * 200) + 'FF';
      case '18': return hx((s.o2a * 0.9) * 200) + trimB(s.stft2);
      case '19': return hx(0.7 * 200) + 'FF';
      case '1F': return hx2(s.run);
      case '21': return '0000';
      case '2F': return hx(s.fuel * 255 / 100);
      case '30': return '12';
      case '31': return hx2(312);
      case '33': return hx(s.baro);
      case '3C': return hx2((s.cat + 40) * 10);
      case '3E': return hx2((s.cat - 60 + 40) * 10);
      case '42': return hx2(s.volt * 1000);
      case '43': return hx2(s.load * 255 / 100);
      case '44': return hx2(32768);
      case '46': return hx(s.amb + 40);
      case '47': return hx(s.thr * 255 / 100 * 0.9);
      case '49': return hx(s.thr * 255 / 100);
      case '4C': return hx(s.thr * 255 / 100);
      case '5C': return hx(s.oil + 40);
      default: return null;
    }
  };

  MockTransport.SUPPORTED = ['01', '03', '04', '05', '06', '07', '08', '09', '0B', '0C', '0D', '0E', '0F', '10', '11', '13', '14', '15', '18', '19', '1C', '1F', '20', '21', '2F', '30', '31', '33', '3C', '3E', '40', '42', '43', '44', '46', '47', '49', '4C', '5C'];

  MockTransport.prototype._bitmask = function (base) {
    var b = [0, 0, 0, 0];
    MockTransport.SUPPORTED.forEach(function (p) {
      var n = parseInt(p, 16) - base - 1;
      if (n >= 0 && n < 32) b[n >> 3] |= 0x80 >> (n & 7);
    });
    return b.map(hx).join('');
  };

  MockTransport.prototype._fmt = function (hex) {
    if (!this.spaces) return hex;
    return hex.replace(/(..)/g, '$1 ').trim();
  };

  MockTransport.prototype._respond = function (c) {
    var self = this;
    if (c.indexOf('AT') === 0) {
      var a = c.slice(2);
      if (a === 'Z') { this.echo = true; this.spaces = true; this.headers = false; return '\r\rELM327 v1.5'; }
      if (a === 'I') return 'ELM327 v1.5';
      if (a === '@1') return 'OBDII to RS232 Interpreter';
      if (a === 'E0') { this.echo = false; return 'OK'; }
      if (a === 'E1') { this.echo = true; return 'OK'; }
      if (a === 'S0') { this.spaces = false; return 'OK'; }
      if (a === 'S1') { this.spaces = true; return 'OK'; }
      if (a === 'H0') { this.headers = false; return 'OK'; }
      if (a === 'H1') { this.headers = true; return 'OK'; }
      if (a === 'RV') return '12.6V';
      if (a === 'DPN') return 'A6';
      if (a === 'DP') return 'AUTO, ISO 15765-4 (CAN 11/500)';
      if (/^(L[01]|SP[0-9A-C]|AT[0-2]|ST[0-9A-F]{2}|D|WS|CAF[01]|M[01])$/.test(a)) return 'OK';
      return '?';
    }
    if (!/^[0-9A-F]+$/.test(c) || c.length % 2 === 1 && c.length > 2) {
      // allow single trailing response-count digit (e.g. "010C1")
      if (!/^[0-9A-F]+$/.test(c)) return '?';
    }
    var body = c;
    if (body.length % 2 === 1) body = body.slice(0, -1); // strip "1" response-count suffix
    var mode = body.slice(0, 2), rest = body.slice(2);
    if (mode === '03' || mode === '07' || mode === '0A') {
      var list = this.dtcs[mode] || [];
      var resp = hx(parseInt(mode, 16) + 0x40) + hx(list.length) + list.join('');
      return this._fmt(resp);
    }
    if (mode === '04') { this.dtcs = { '03': [], '07': [], '0A': this.dtcs['0A'] }; return '44'; }
    if (mode === '09' && rest === '02') {
      var vin = this.opts.vin || '1HGBH41JXMN109186';
      var bytes = '490201' + vin.split('').map(function (ch) { return hx(ch.charCodeAt(0)); }).join('');
      // ISO-TP style multi-frame: 014 + 0:6 bytes, 1..:7 bytes
      var b = bytes.match(/../g), lines = ['014'], i = 0, seq = 0;
      lines.push('0:' + self._fmt(b.slice(0, 6).join(''))); i = 6;
      while (i < b.length) { seq++; var chunk = b.slice(i, i + 7); while (chunk.length < 7) chunk.push('00'); lines.push(seq.toString(16).toUpperCase() + ':' + self._fmt(chunk.join(''))); i += 7; }
      return lines.join('\r');
    }
    if (mode === '01' || mode === '02') {
      var pids = [];
      if (mode === '01') { for (var k = 0; k < rest.length; k += 2) pids.push(rest.substr(k, 2)); }
      else pids.push(rest.substr(0, 2));
      if (mode === '02' && !this.dtcs['03'].length) return 'NO DATA';
      var out = hx(parseInt(mode, 16) + 0x40);
      var any = false;
      pids.forEach(function (p) {
        var data;
        if (['00', '20', '40', '60'].indexOf(p) >= 0) data = (p === '60') ? null : self._bitmask(parseInt(p, 16));
        else if (mode === '02' && p === '02') data = '0133';
        else data = self._pidData(p);
        if (data != null) { out += p + (mode === '02' ? '00' : '') + data; any = true; }
      });
      if (!any) return 'NO DATA';
      if (out.length / 2 > 7) {
        var bb = out.match(/../g), ls = [hx2(bb.length).slice(1)], j = 6, sq = 0;
        ls.push('0:' + self._fmt(bb.slice(0, 6).join('')));
        while (j < bb.length) { sq++; var ch = bb.slice(j, j + 7); while (ch.length < 7) ch.push('00'); ls.push(sq.toString(16).toUpperCase() + ':' + self._fmt(ch.join(''))); j += 7; }
        return ls.join('\r');
      }
      return this._fmt(out);
    }
    return 'NO DATA';
  };

  // ---------------- Serialized command queue ----------------
  function ElmSession(transport, opts) {
    this.t = transport; this.opts = opts || {};
    this.log = this.opts.log || function () {};
    this.buffer = ''; this.pending = null; this.queue = []; this.busy = false;
    this.gotRx = false; this.dead = false; this.deadError = null;
    var self = this;
    transport.onData = function (s) { self._onData(s); };
  }

  ElmSession.prototype._onData = function (s) {
    this.gotRx = true;
    if (!this.t.logsRx) this.log('rx', s);
    this.buffer += s;
    this._check();
  };

  ElmSession.prototype._check = function () {
    if (this.pending && this.buffer.indexOf('>') >= 0) {
      var text = this.buffer.slice(0, this.buffer.lastIndexOf('>'));
      this.buffer = this.buffer.slice(this.buffer.lastIndexOf('>') + 1);
      var p = this.pending; this.pending = null;
      if (p.timer) clearTimeout(p.timer);
      p.resolve(text);
    }
  };

  /** Send a command; resolves with the raw response text (without '>'). Commands are strictly serialized. */
  ElmSession.prototype.send = function (cmd, timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (self.dead) return reject(self.deadError);
      self.queue.push({ cmd: cmd, timeout: timeoutMs || self.opts.timeout || 2500, resolve: resolve, reject: reject });
      self._pump();
    });
  };

  ElmSession.prototype._waitForPrompt = function (ms) {
    var self = this;
    return new Promise(function (resolve) {
      self.pending = {
        resolve: function (text) { resolve({ ok: true, text: text }); },
        timer: setTimeout(function () { self.pending = null; resolve({ ok: false, text: self.buffer }); }, ms)
      };
      self._check(); // reply may already have arrived while the write was still completing
    });
  };

  ElmSession.prototype._kill = function (e) {
    this.dead = true; this.deadError = e;
    this.log('warn', 'LINK DEAD: ' + e.message + ' - aborting all queued commands');
    this.clearQueue(e);
  };

  ElmSession.prototype._pump = async function () {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    var job = this.queue.shift();
    if (this.dead) { this.busy = false; job.reject(this.deadError); return this._pump(); }
    if (this.afterTimeout) { this.afterTimeout = false; await sleep(150); }
    this.buffer = '';
    var label = job.cmd === '' ? '(bare CR)' : job.cmd;
    var started = Date.now();
    this.log('tx', label);
    try {
      await this.t.write(job.cmd + '\r'); // transport handles busy-retry, hung ops and reconnects itself
    } catch (e) {
      this.busy = false;
      this.log('warn', 'Write failed for ' + label + ': ' + e.message);
      if (e.fatal) this._kill(e);
      job.reject(e);
      return this._pump();
    }
    var r = await this._waitForPrompt(job.timeout);
    this.lastLatency = Date.now() - started;
    this.busy = false;
    if (r.ok) job.resolve(r.text);
    else {
      this.log('warn', 'Timeout after ' + this.lastLatency + 'ms (no prompt) for ' + label + (r.text ? ' (partial: ' + JSON.stringify(r.text) + ')' : ' (no RX at all)'));
      this.afterTimeout = true;
      var err = new Error('TIMEOUT'); err.partial = r.text; job.reject(err);
    }
    this._pump();
  };

  ElmSession.prototype.clearQueue = function (reason) {
    var q = this.queue; this.queue = [];
    if (this.pending && this.pending.timer) clearTimeout(this.pending.timer);
    this.pending = null;
    q.forEach(function (j) { j.reject(reason || new Error('CANCELLED')); });
  };

  var api = { BleTransport: BleTransport, MockTransport: MockTransport, ElmSession: ElmSession, BLE_PROFILES: BLE_PROFILES, OPTIONAL_SERVICES: OPTIONAL_SERVICES, withTimeout: withTimeout, formatBytes: formatBytes, shortUuid: shortUuid, uuid16: uuid16, isBusyError: isBusyError };

  if (isNode) module.exports = api; else root.Transport = api;
})(this);
