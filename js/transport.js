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
    var timeout = o.timeout || this._opt('opTimeout', 4000);
    var delays = this._opt('busyDelays', [150, 300, 600, 1000, 1500]);
    var busy = 0, t0 = Date.now();
    for (;;) {
      if (!o.quiet) this.log('info', 'GATT ' + label + ' ...');
      try {
        var work = Promise.resolve().then(fn);
        var v = await withTimeout(this._cancelP ? Promise.race([work, this._cancelP]) : work, timeout, label);
        if (!o.quiet) this.log('info', 'GATT ' + label + ' OK (' + (Date.now() - t0) + 'ms)');
        return v;
      } catch (e) {
        if (e && e.cancelled) throw e;
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

  var HELP_TEXT = 'Try: force-stop other OBD apps (Car Scanner / Torque, including "work in background"), toggle Bluetooth off and on, ' +
    'unpair "OBDII" in Android Bluetooth settings if it is listed, then tap "Forget and re-pick device" and connect again.';
  var CHAR_PROP_KEYS = ['broadcast', 'read', 'writeWithoutResponse', 'write', 'notify', 'indicate', 'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries'];

  /**
   * v1.5: the first GATT operation after discovery hangs INTERMITTENTLY on this clone (Realtek RTL8773BFR), whichever
   * characteristic is tried first, and a hung op wedges the whole link (even writes hang). So channel order is not the
   * fix: we keep reconnecting with different timing / discovery / diagnostics variants, fail fast (~4s), and remember the
   * variant that worked. Each variant: order (which notify char first), settle (ms after connect before the first
   * GATT op), diag (getDescriptors/getDescriptor before subscribing), direct (getPrimaryService('fff0') instead of
   * getPrimaryServices()), writeFirst (write ATZ before startNotifications).
   */
  function mkVariant(order, settle, diag, direct, writeFirst) {
    return { id: order + '-s' + settle + (diag ? '-diag' : '-nodiag') + (direct ? '-direct' : '-enum') + (writeFirst ? '-writefirst' : ''), order: order, settle: settle, diag: diag, direct: direct, writeFirst: !!writeFirst };
  }
  var VARIANTS = [
    mkVariant('ffea', 400, false, false),
    mkVariant('fff1', 1500, false, true),
    mkVariant('ffea', 3000, true, false),
    mkVariant('fff1', 1500, false, false),
    mkVariant('ffea', 3000, false, true),
    mkVariant('ffea', 1500, false, false, true),
    mkVariant('fff1', 3000, false, true),
    mkVariant('ffea', 400, true, false),
    mkVariant('fff1', 3000, false, false),
    mkVariant('ffea', 1500, false, true)
  ];
  var RECONNECT_WAITS = [1000, 1500, 2000, 3000];
  var VARIANT_KEY = 'obd.bleVariant';

  BleTransport.prototype._variantStore = function () {
    if (this.opts.variantStore) return this.opts.variantStore;
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        var ls = window.localStorage;
        return { get: function (k) { return ls.getItem(k); }, set: function (k, v) { ls.setItem(k, v); } };
      }
    } catch (e) { /* storage blocked */ }
    return null;
  };
  BleTransport.prototype._loadWinner = function () { try { var st = this._variantStore(); return st ? st.get(VARIANT_KEY) : null; } catch (e) { return null; } };
  BleTransport.prototype._saveWinner = function (id) { try { var st = this._variantStore(); if (st) st.set(VARIANT_KEY, id); } catch (e) { /* ignore */ } };

  /** Variant order for this connect: the remembered winner first (if still in the table), then the table order. */
  BleTransport.prototype._variantOrder = function () {
    if (this._order) return this._order;
    var table = this.opts.variantTable || VARIANTS;
    var win = this._winnerId || this._loadWinner();
    var first = win ? table.filter(function (v) { return v.id === win; })[0] : null;
    this._order = first ? [first].concat(table.filter(function (v) { return v !== first; })) : table.slice();
    return this._order;
  };

  /** Connect plan for attempt n (0 = first try). After a partial success (one notify char subscribed, the other hung) the
   *  next attempt puts the characteristic that worked first and keeps the other in reserve. */
  BleTransport.prototype._planFor = function (n) {
    var order = this._variantOrder(), v = order[n % order.length];
    var T = this._opt('notifyTimeout', 4000);
    var plan = { n: n, variant: v, rotate: v.order === 'ffea' ? 1 : 0, subscribeAll: true, timeout: T, writeFirst: v.writeFirst, pairing: n > 0,
      settle: v.settle, diag: v.diag, direct: v.direct, name: v.id };
    if (this._partialHang && this._partialHang.worked && this._partialHang.worked.length) {
      var worked = this._partialHang.worked.slice();
      this._partialHang = null;
      plan.onlyUuids = worked; plan.subscribeAll = false;
      plan.name = v.id + ' + ' + worked.map(shortUuid).join('+') + ' first (it subscribed before the hang)';
    }
    return plan;
  };

  BleTransport.prototype._cancelError = function () {
    var e = new Error('Connect cancelled'); e.cancelled = true; e.noRecover = true; return e;
  };
  /** Stop a connect in progress: aborts the current wait/op and disconnects. Safe to call at any time. */
  BleTransport.prototype.cancel = function () {
    if (!this._cancelReject) return false;
    this._cancelled = true; this._expectDisc = true;
    var rej = this._cancelReject; this._cancelReject = null;
    this.log('warn', 'Connect cancelled by user');
    try { if (this.device && this.device.gatt) this.device.gatt.disconnect(); } catch (e) { /* ignore */ }
    rej(this._cancelError());
    return true;
  };
  BleTransport.prototype._sleepC = function (ms) { return this._cancelP ? Promise.race([sleep(ms), this._cancelP]) : sleep(ms); };

  BleTransport.prototype._waitFor = function (n) {
    var fixed = this.opts.reconnectWait;
    return fixed != null ? fixed : RECONNECT_WAITS[Math.min(n - 1, RECONNECT_WAITS.length - 1)];
  };

  /**
   * Persistent connect. Keeps reconnecting (up to maxAttempts, default 10, or totalBudget ms, default 90s) with the next
   * variant each time; the first attempt that gets a subscription wins and is remembered. Cancel() aborts it.
   */
  BleTransport.prototype.connect = function () {
    var self = this;
    if (!this.device) return Promise.reject(new Error('No device selected'));
    return this._exclusive(async function () {
      var max = self._opt('maxAttempts', 10), budget = self._opt('totalBudget', 90000);
      self._cancelled = false; self._order = null; self._partialHang = null; self._dead = false;
      self._cancelP = new Promise(function (resolve, reject) { self._cancelReject = reject; });
      self._cancelP.catch(noop);
      var t0 = Date.now(), lastErr = null, stored = self._loadWinner();
      self.log('info', 'Connecting GATT to ' + self.name + ' (' + (self.device.id || '') + '): up to ' + max + ' attempts / ~' + Math.round(budget / 1000) + 's, Cancel stops it' +
        (stored ? '; remembered winning variant "' + stored + '" is tried first' : ''));
      try {
        for (var n = 0; n < max; n++) {
          if (self._cancelled) throw self._cancelError();
          if (n > 0 && Date.now() - t0 > budget) { self.log('warn', 'Connect time budget (' + budget + 'ms) used up after ' + n + ' attempts'); break; }
          var plan = self._planFor(n), tag = 'Attempt ' + (n + 1) + '/' + max;
          self.attempt = { n: n + 1, max: max, variant: plan.variant.id };
          self.onStatus('Connecting… attempt ' + (n + 1) + '/' + max + ' (' + plan.variant.id + ')');
          if (n > 0) {
            var wait = self._waitFor(n);
            self.stats.recoveries++;
            self._recovering = true; self._expectDisc = true;
            self.log('warn', tag + ': disconnect, wait ' + wait + 'ms so the dongle\'s BLE stack can reset, then reconnect');
            try { if (self.device && self.device.gatt) self.device.gatt.disconnect(); } catch (e) { /* ignore */ }
            self._poisoned = false;
            await self._sleepC(wait);
          }
          var ta = Date.now();
          self.log('info', tag + ' variant "' + plan.variant.id + '": order ' + plan.variant.order + ' first, settle ' + (self.opts.postConnectDelay != null ? self.opts.postConnectDelay : plan.settle) + 'ms, discovery ' + (plan.direct ? 'direct getPrimaryService(fff0)' : 'getPrimaryServices()') +
            ', diagnostics ' + (plan.diag ? 'on' : 'off') + (plan.writeFirst ? ', write-first' : '') + ', hang timeout ' + plan.timeout + 'ms');
          try {
            await self._setup(plan);
            self._recovering = false; self._expectDisc = false;
            self._winnerId = plan.variant.id; self._order = null; self._saveWinner(plan.variant.id);
            self.log('info', tag + ' OK in ' + (Date.now() - ta) + 'ms (' + (Date.now() - t0) + 'ms total); remembered variant "' + plan.variant.id + '" as the winner');
            return true;
          } catch (e) {
            if (e.cancelled || e.noRecover || e.fatal) throw e;
            lastErr = e.message; self._lastErr = e.message;
            self.log('warn', tag + ' FAILED after ' + (Date.now() - ta) + 'ms: ' + e.message);
          }
        }
        self._dead = true; self._poisoned = true; self._recovering = false; self._expectDisc = true;
        try { if (self.device && self.device.gatt) self.device.gatt.disconnect(); } catch (e) { /* ignore */ }
        throw fatalError('Could not establish a working Bluetooth GATT link after ' + (self.attempt ? self.attempt.n : max) + ' attempts / ' + Math.round((Date.now() - t0) / 1000) + 's (' + lastErr + '). ' + HELP_TEXT);
      } catch (e) {
        self._recovering = false;
        if (e.cancelled) { self._expectDisc = true; try { if (self.device && self.device.gatt) self.device.gatt.disconnect(); } catch (x) { /* ignore */ } }
        throw e;
      } finally { self._cancelP = null; self._cancelReject = null; }
    });
  };

  /** Mid-session recovery (a write or fallback hung): disconnect -> wait -> reconnect -> rediscover -> resubscribe with the winning variant first. */
  BleTransport.prototype._recoverLoop = async function (reason, maxTries, firstPlan) {
    var wait = this._opt('reconnectWait', 1000);
    for (var i = 1; i <= maxTries; i++) {
      var plan = this._planFor((firstPlan == null ? 0 : firstPlan) + i - 1);
      this.stats.recoveries++;
      this._recovering = true; this._expectDisc = true;
      this.onStatus('Reconnecting Bluetooth (' + i + '/' + maxTries + ')…');
      this.log('warn', 'Recovery ' + i + '/' + maxTries + ' (' + reason + '): disconnect, wait ' + wait + 'ms, reconnect, rediscover. Variant: ' + plan.name + ', notify timeout ' + plan.timeout + 'ms');
      try { if (this.device && this.device.gatt) this.device.gatt.disconnect(); } catch (e) { /* ignore */ }
      this._poisoned = false;
      await sleep(wait);
      try {
        await this._setup(plan);
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

  BleTransport.prototype._setup = async function (plan) {
    var self = this;
    plan = plan || this._planFor(0);
    this._lastPlan = plan;
    this.subscribed = []; this.altNotify = []; this.notifyChars = []; this.writeChar = null;
    // A previous page (pull-to-refresh) or a failed reconnect may have left the device "connected".
    // startNotifications into a stale link hangs, so drop it and wait before a clean setup.
    if (this.device && this.device.gatt && this.device.gatt.connected) {
      this.log('info', 'GATT already connected; disconnecting and waiting before a clean setup');
      this._expectDisc = true;
      try { this.device.gatt.disconnect(); } catch (e) { /* ignore */ }
      await this._sleepC(this._waitFor(1));
      this._expectDisc = false;
    }
    this.server = await this._runOp('gatt.connect', function () { return self.device.gatt.connect(); }, { timeout: this._opt('gattTimeout', 15000) });
    var d1 = this.opts.postConnectDelay != null ? this.opts.postConnectDelay : (plan.settle != null ? plan.settle : 400);
    if (d1) { this.log('info', 'Settle: waiting ' + d1 + 'ms after connect before the first GATT operation'); await this._sleepC(d1); }
    var services = null;
    if (plan.direct && typeof this.server.getPrimaryService === 'function') {
      try {
        var svc = await this._runOp('getPrimaryService fff0 (direct)', function () { return self.server.getPrimaryService(uuid16('fff0')); });
        services = [svc];
      } catch (e) {
        if (e.timeout || e.busy || e.cancelled) throw e;
        this.log('info', 'Direct getPrimaryService(fff0) failed (' + (e.name || '') + ' ' + e.message + '); using getPrimaryServices() instead');
      }
    }
    if (!services) services = await this._runOp('getPrimaryServices', function () { return self.server.getPrimaryServices(); });
    this.log('info', 'Services visible: ' + services.map(function (s) { return s.uuid; }).join(', '));
    var found = await this._pickCharacteristics(services);
    if (!found) { var ne = new Error('No notify+write characteristic pair found. Check Console for the service list.'); ne.noRecover = true; throw ne; }
    this.writeChar = found.write; this.profileName = found.label;
    var list = found.notifyList.slice();
    var want = String(this._opt('notifyChar', 'auto')).toLowerCase();
    this.notifyLocked = false;
    if (want !== 'auto') {
      var m = list.filter(function (c) { return shortUuid(c.uuid) === want; })[0];
      if (m) { list = [m]; this.notifyLocked = true; this.log('info', 'Notify characteristic locked to ' + want + ' (Settings)'); }
      else this.log('warn', 'Settings asked for notify ' + want + ' but it is not in this service; using auto');
    }
    if (!this.notifyLocked) {
      if (plan.rotate && list.length > 1) {
        var r = plan.rotate % list.length;
        list = list.slice(r).concat(list.slice(0, r));
      }
      if (plan.onlyUuids && plan.onlyUuids.length) {
        // a characteristic that subscribed before the previous hang goes first; the rest stay in reserve (init subscribes them if no RX)
        var firstUs = plan.onlyUuids.map(function (u) { return list.filter(function (c) { return c.uuid === u; })[0]; }).filter(Boolean);
        list = firstUs.concat(list.filter(function (c) { return firstUs.indexOf(c) < 0; }));
      }
    }
    this.notifyChars = list;
    var wp = this.writeChar.properties;
    if (!this._modeChosen) {
      var mode = this._opt('writeMode', 'auto');
      if (mode === 'without') this.useWithoutResponse = true;
      else if (mode === 'with') this.useWithoutResponse = false;
      else this.useWithoutResponse = !wp.write || !!wp.writeWithoutResponse;
      this._modeChosen = true;
    }
    this.log('info', 'Using ' + found.label + ' write=' + this.writeChar.uuid + ' [' + this.writeModeLabel() + '; write=' + !!wp.write + ' writeWithoutResponse=' + !!wp.writeWithoutResponse + ']' +
      ' notify order=[' + list.map(function (c) { return shortUuid(c.uuid); }).join(', ') + '] plan="' + plan.name + '"');

    if (plan.writeFirst) {
      list.forEach(function (c) { self._attachListener(c); });
      this.log('info', 'Write-first: listeners attached; writing ATZ before startNotifications (some clones only enable notify after the first write)');
      try {
        await this._runOp('write-first ATZ (' + this.writeModeLabel() + ')', function () { return self._writeChunk(new Uint8Array([0x41, 0x54, 0x5A, 0x0D])); }, { timeout: this._opt('writeTimeout', 3000) });
      } catch (e) { if (e.timeout || e.busy) throw e; this.log('warn', 'Write-first ATZ failed: ' + e.message + ' (continuing)'); }
      await sleep(this._opt('writeFirstDelay', 500));
    }
    await this._subscribeSequence(list, plan);
    var d2 = this._opt('postSubscribeDelay', 300);
    if (d2) { this.log('info', 'Waiting ' + d2 + 'ms after subscribe before first write'); await sleep(d2); }
    this.log('info', 'BLE link ready for ELM commands');
  };

  /** Subscribe SEQUENTIALLY. Default plan subscribes every notify characteristic (ffea, then fff1).
   *  A hang after a successful subscribe is remembered so the next reconnect retries only the ones that worked. */
  BleTransport.prototype._subscribeSequence = async function (list, plan) {
    var subscribeAll = !plan || plan.subscribeAll !== false;
    for (var i = 0; i < list.length; i++) {
      if (!subscribeAll && this.subscribed.length) break;
      try {
        await this._trySubscribe(list[i], true, plan);
      } catch (e) {
        if ((e.timeout || e.busy) && this.subscribed.length) {
          this._partialHang = { worked: this.subscribed.map(function (c) { return c.uuid; }), hung: list[i].uuid };
          this.log('warn', 'startNotifications ' + shortUuid(list[i].uuid) + ' hung after ' +
            this.subscribed.map(function (c) { return shortUuid(c.uuid); }).join('+') +
            ' had already subscribed; will reconnect and retry the working one(s)');
        }
        throw e;
      }
    }
    if (!this.subscribed.length) throw new Error('Could not enable notifications on any characteristic');
    if (this.subscribed.length > 1)
      this.log('info', 'Subscribed ' + this.subscribed.map(function (c) { return shortUuid(c.uuid); }).join(' then ') +
        ' (listening on all; RX is expected on fff1 for this dongle)');
    this.altNotify = list.filter(function (c) { return this.subscribed.indexOf(c) < 0; }, this);
    if (this.altNotify.length && !this.notifyLocked)
      this.log('info', 'Alternate notify characteristic(s) held in reserve (used only if no RX arrives): ' + this.altNotify.map(function (c) { return shortUuid(c.uuid); }).join(', '));
  };

  BleTransport.prototype._attachListener = function (char) {
    var self = this;
    if (char.__obdListening) return;
    char.__obdListening = true;
    char.addEventListener('characteristicvaluechanged', function (ev) { self._onNotify(char, ev); });
  };

  /** Log full properties, descriptors (is there a CCCD 0x2902?) and readValue if allowed. Purely diagnostic. */
  BleTransport.prototype._diagnose = async function (char) {
    var self = this, id = shortUuid(char.uuid), p = char.properties || {};
    this.log('info', '  props ' + id + ': ' + CHAR_PROP_KEYS.map(function (k) { return k + '=' + (p[k] === undefined ? 'n/a' : !!p[k]); }).join(' '));
    var dt = this._opt('descTimeout', 3000);
    if (typeof char.getDescriptors === 'function') {
      try {
        var ds = await this._runOp('getDescriptors ' + id, function () { return char.getDescriptors(); }, { timeout: dt, quiet: true });
        var u = (ds || []).map(function (d) { return d.uuid; });
        this.log('info', '  descriptors on ' + id + ': ' + (u.length ? u.join(', ') : '(none listed)') + (u.some(function (x) { return /^00002902/.test(x); }) ? ' -> CCCD 2902 present' : ' -> no CCCD 2902 listed'));
      } catch (e) { if (e.timeout || e.busy) throw e; this.log('info', '  getDescriptors ' + id + ' failed: ' + (e.name || '') + ' ' + e.message); }
    } else this.log('info', '  getDescriptors not supported by this browser');
    if (typeof char.getDescriptor === 'function') {
      try {
        await this._runOp('getDescriptor(0x2902) ' + id, function () { return char.getDescriptor(0x2902); }, { timeout: dt, quiet: true });
        this.log('info', '  getDescriptor(0x2902) on ' + id + ': OK');
      } catch (e) { if (e.timeout || e.busy) throw e; this.log('info', '  getDescriptor(0x2902) on ' + id + ': ' + (e.name || '') + ' ' + e.message + ' (Chrome blocklists the CCCD for scripts; startNotifications writes it itself, so this error is normal)'); }
    }
    if (p.read && typeof char.readValue === 'function') {
      try {
        var dv = await this._runOp('readValue ' + id, function () { return char.readValue(); }, { timeout: dt, quiet: true });
        var u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
        this.log('info', '  readValue ' + id + ': ' + formatBytes(u8));
      } catch (e) { if (e.timeout || e.busy) throw e; this.log('info', '  readValue ' + id + ' failed: ' + e.message); }
    } else this.log('info', '  ' + id + ' has no read property; skipping readValue');
  };

  BleTransport.prototype._trySubscribe = async function (char, retry, plan) {
    var self = this, id = shortUuid(char.uuid);
    var kind = char.properties.notify ? 'notify' : (char.properties.indicate ? 'indicate' : 'notify');
    this._attachListener(char);
    var timeout = plan ? plan.timeout : this._opt('notifyTimeout', 4000);
    var diagOn = plan ? plan.diag !== false : (this._lastPlan ? this._lastPlan.diag !== false : true);
    if (this.opts.diagnostics !== false && diagOn) await this._diagnose(char);
    else if (plan && !plan.diag) this.log('info', '  (skipping getDescriptors/getDescriptor(0x2902) diagnostics on this attempt)');
    var tries = retry ? 2 : 1;
    for (var n = 1; n <= tries; n++) {
      if (plan && plan.pairing) {
        this.onStatus('Enabling notifications on ' + id + '… possible pairing prompt - check phone');
        this.log('info', 'possible pairing prompt - check phone (waiting up to ' + timeout + 'ms for startNotifications ' + id + ')');
      }
      try {
        await this._runOp('startNotifications ' + id + ' (' + kind + ', try ' + n + '/' + tries + ', timeout ' + timeout + 'ms)', function () { return char.startNotifications(); }, { timeout: timeout });
        if (this.subscribed.indexOf(char) < 0) this.subscribed.push(char);
        if (!this._goodNotifyUuid) this._goodNotifyUuid = char.uuid;
        return true;
      } catch (e) {
        if (e.timeout || e.busy) throw e; // poisoned: do not touch GATT again, let recovery handle it
        if (n < tries) { var dl = this._opt('subscribeRetryDelay', 500); this.log('info', 'Retrying startNotifications ' + id + ' in ' + dl + 'ms'); await sleep(dl); }
      }
    }
    return false;
  };

  /** Forget the browser's saved permission for this device (and any other saved OBD device). Returns how many were forgotten. */
  BleTransport.prototype.forget = async function () {
    var n = 0;
    try { if (this.device && typeof this.device.forget === 'function') { await this.device.forget(); n++; } } catch (e) { this.log('warn', 'device.forget failed: ' + e.message); }
    try {
      if (typeof navigator !== 'undefined' && navigator.bluetooth && typeof navigator.bluetooth.getDevices === 'function') {
        var ds = await navigator.bluetooth.getDevices();
        for (var i = 0; i < ds.length; i++) if (ds[i] !== this.device && typeof ds[i].forget === 'function') { await ds[i].forget(); n++; }
      }
    } catch (e) { this.log('warn', 'getDevices/forget failed: ' + e.message); }
    return n;
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
      var maxRec = self._opt('maxRecoveries', 3), attempt = 0;
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
          await self._recoverLoop(e.message, 1, 0);
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
      if (self._poisoned) { try { await self._recoverLoop('poisoned before fallback', 1, 0); } catch (e) { return null; } }
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
    this.car = this.opts.car || null;
    this.dtcs = this.opts.dtcs || (this.car === 'mitsubishi2013'
      ? { '03': [], '07': ['0420'], '0A': [] }
      : { '03': ['0133', '0442'], '07': ['0171'], '0A': ['0133'] });
    this.latency = this.opts.latency != null ? this.opts.latency : 25;
    this.splitPrompt = !!this.opts.splitPrompt;
    if (this.car === 'mitsubishi2013' && this.opts.vin == null) this.opts.vin = 'JA32U2FU9DU010476';
    // v1.7.0: simulated CVT TCM on 7E1/7E9 (mode 21). opts.tcm: true (default) | false (no TCM: NO DATA) | 'hang' (no prompt) | 'short'
    this.tcm = this.opts.tcm != null ? this.opts.tcm : true;
    this.txHeader = '7DF'; this.rxFilter = null;
    this.headerLog = []; // every ATSH / ATCRA seen, for tests
    // v1.7.1: timing / flow-control state and a log of every command, so tests can check what the app sent.
    this.st = '32'; this.at = 1; this.fcMode = 0; this.cmdLog = [];
  }
  MockTransport.prototype.connect = async function () { this.connected = true; return true; };
  MockTransport.prototype.disconnect = async function () { this.connected = false; this.onDisconnect(); };
  MockTransport.prototype.write = async function (str) {
    var self = this;
    var cmd = str.replace(/[\r\n]/g, '').trim().toUpperCase();
    var compact = cmd.replace(/\s+/g, '');
    this.cmdLog.push(compact);
    var reply = this._respond(compact);
    if (reply == null) return; // hang: no prompt, like a clone that never finishes a multi-PID request
    var body = (this.echo ? cmd + '\r' : '') + reply;
    var delay = this.latency;
    function emit(text, extra) {
      var chunks = [];
      for (var i = 0; i < text.length; i += 20) chunks.push(text.slice(i, i + 20));
      chunks.forEach(function (c, idx) { setTimeout(function () { self.onData(c); }, delay + (extra || 0) + idx * 2); });
    }
    // Hardware often delivers the payload and the prompt in two notifications: "...\r" then "\r>".
    if (this.splitPrompt) {
      emit(body + '\r', 0);
      emit('\r>', 8);
    } else {
      emit(body + '\r\r>', 0);
    }
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
      if (a === 'Z' || a === 'D') { this.echo = true; this.spaces = true; this.headers = false; this.txHeader = '7DF'; this.rxFilter = null; this.st = '32'; this.at = 1; this.fcMode = 0; if (a === 'D') return 'OK'; return '\r\rELM327 v1.5'; }
      var mst = /^ST([0-9A-F]{2})$/.exec(a);
      if (mst) { this.st = mst[1]; return 'OK'; }
      if (/^AT[0-2]$/.test(a)) { this.at = +a[2]; return 'OK'; }
      if (/^FC(SH[0-9A-F]{3}|SD[0-9A-F]{2,}|SM[0-2])$/.test(a)) {
        if (this.opts.rejectFc) return '?';
        if (a.indexOf('FCSM') === 0) this.fcMode = +a[4];
        return 'OK';
      }
      if (/^SH[0-9A-F]{3}$/.test(a)) { this.txHeader = a.slice(2); this.headerLog.push('ATSH' + this.txHeader); return this.opts.rejectSh ? '?' : 'OK'; }
      if (/^CRA[0-9A-FX]{0,3}$/.test(a)) { this.rxFilter = a.length > 3 ? a.slice(3) : null; this.headerLog.push(a.length > 3 ? 'ATCRA' + this.rxFilter : 'ATCRA'); return this.opts.rejectCra ? '?' : 'OK'; }
      if (a === 'I') return 'ELM327 v1.5';
      if (a === '@1') return 'OBDII to RS232 Interpreter';
      if (a === 'E0') { this.echo = false; return 'OK'; }
      if (a === 'E1') { this.echo = true; return 'OK'; }
      if (a === 'S0') { this.spaces = false; return 'OK'; }
      if (a === 'S1') { this.spaces = true; return 'OK'; }
      if (a === 'H0') { this.headers = false; return 'OK'; }
      if (a === 'H1') { this.headers = true; return 'OK'; }
      if (a === 'RV') return this.car === 'mitsubishi2013' ? '14.6V' : '12.6V';
      if (a === 'DPN') return 'A6';
      if (a === 'DP') return 'AUTO, ISO 15765-4 (CAN 11/500)';
      if (/^(L[01]|SP[0-9A-C]|AT[0-2]|ST[0-9A-F]{2}|AL|D|WS|CAF[01]|M[01])$/.test(a)) return 'OK';
      return '?';
    }
    if (!/^[0-9A-F]+$/.test(c) || c.length % 2 === 1 && c.length > 2) {
      // allow single trailing response-count digit (e.g. "010C1")
      if (!/^[0-9A-F]+$/.test(c)) return '?';
    }
    var body = c;
    if (body.length % 2 === 1) body = body.slice(0, -1); // strip "1" response-count suffix
    var mode = body.slice(0, 2), rest = body.slice(2);
    var tx = this.txHeader, list = [];
    if (mode === '21' || mode === '22') {
      if (mode !== '21') return 'NO DATA';
      if (tx === '7E1') {
        if (!this.tcm || !this._tcmTiming()) return 'NO DATA';
        if (this.tcm === 'hang' && rest === '03') return null;
        var d = this._tcmService(rest);
        if (!d) return this.opts.tcmNrc ? this._deliver([{ id: '7E9', hex: '7F2112' }]) : 'NO DATA';
        return this._deliver([{ id: '7E9', hex: '61' + rest + d.map(hx).join('') }]);
      }
      if (tx === '7E0' && rest === '1A') return this._deliver([{ id: '7E8', hex: '611A408000' }]);
      return 'NO DATA';
    }
    if (tx === '7DF' || tx === '7E0') {
      var e = this._engineHex(mode, rest, body);
      if (e === null) return null; // simulated hang
      if (e) list.push({ id: '7E8', hex: e });
    }
    // v1.7.1: optional J1979 answers from the TCM (functional 7DF or physical 7E1) and from other modules (physical 7E2..7E7)
    if (mode === '01' && (rest === '00' || rest === '42')) {
      if (this.opts.tcmJ1979 && (tx === '7DF' || tx === '7E1') && this._tcmTiming()) list.push({ id: '7E9', hex: rest === '00' ? '410098018001' : '4142' + hx2(13800) });
      var oe = this.opts.otherEcus;
      if (oe && oe[tx] && rest === '00') list.push({ id: oe[tx], hex: '410080000001' });
    }
    if (!list.length) return 'NO DATA';
    return this._deliver(list);
  };

  /** v1.7.1: does the simulated TCM hear us with the current ATST / ATAT? (opts.tcmDelayMs models a slow module) */
  MockTransport.prototype._tcmTiming = function () {
    var d = this.opts.tcmDelayMs || 0;
    if (!d) return true;
    return parseInt(this.st, 16) * 4 >= d && (this.at === 0 || d <= 200);
  };

  /** Data bytes (after 61 xx) of the simulated TCM, or null if that request is not supported. */
  MockTransport.prototype._tcmService = function (rest) {
    var o = this.opts, i, data;
    if (o.tcmPids && o.tcmPids.indexOf(rest) < 0) return null;
    if (rest === '03') {
      // 20 data bytes; data[13] (Torque "N") is the fluid temperature thermistor count
      var sim = this._sim();
      var n = Math.round(Math.min(200, 60 + sim.run * 0.5)); // ~28 C at start, warming
      if (o.tcmByteN != null) n = o.tcmByteN;
      data = [];
      for (i = 0; i < 20; i++) data.push(i === 13 ? n : (0x10 + i));
      if (this.tcm === 'short') data = data.slice(0, 8);
      return data;
    }
    if (rest === '07') return [0x10, 0x00, 0x00, 0x00, 0x00];
    if (rest === '06') return [0x00, 0x00, 0x01, 0x00, 0x00, 0x00];
    if (rest === '33') return [o.t33 != null ? o.t33 : 95];
    if (rest === '02') return [0x20, 0x30, 0x40, 0x50, 0x60, o.t02 != null ? o.t02 : 65, 0x70, 0x80];
    return null;
  };

  /** Engine ECU (7E8) reply as a hex string (no PCI), '' for NO DATA, null for a simulated hang. */
  MockTransport.prototype._engineHex = function (mode, rest, body) {
    var self = this;
    if (mode === '03' || mode === '07' || mode === '0A') {
      var list = this.dtcs[mode] || [];
      return hx(parseInt(mode, 16) + 0x40) + hx(list.length) + list.join('');
    }
    if (mode === '04') { this.dtcs = { '03': [], '07': [], '0A': this.dtcs['0A'] }; return '44'; }
    if (mode === '09' && rest === '02') {
      var vin = this.opts.vin || '1HGBH41JXMN109186';
      return '490201' + vin.split('').map(function (ch) { return hx(ch.charCodeAt(0)); }).join('');
    }
    if (mode === '01' || mode === '02') {
      var pids = [];
      if (mode === '01') { for (var k = 0; k < rest.length; k += 2) pids.push(rest.substr(k, 2)); }
      else pids.push(rest.substr(0, 2));
      if (mode === '01' && pids.length > 1 && this.opts.multiPidHang) return null;
      if (mode === '01' && pids.length > 1 && this.opts.multiPidNoData) return '';
      if (mode === '02' && !this.dtcs['03'].length) return '';
      var out = hx(parseInt(mode, 16) + 0x40);
      var any = false;
      pids.forEach(function (p) {
        var data;
        if (['00', '20', '40', '60'].indexOf(p) >= 0) {
          if (self.car === 'mitsubishi2013' && p === '00') data = 'BE3FA813';
          else if (self.car === 'mitsubishi2013' && p === '20') data = '9017E001';
          else if (self.car === 'mitsubishi2013' && p === '40') data = 'FED00040';
          else data = (p === '60') ? null : self._bitmask(parseInt(p, 16));
        } else if (mode === '01' && p === '01' && self.car === 'mitsubishi2013') data = '0007E500';
        else if (mode === '02' && p === '02') data = '0133';
        else data = self._pidData(p);
        if (data != null) { out += p + (mode === '02' ? '00' : '') + data; any = true; }
      });
      return any ? out : '';
    }
    return '';
  };

  /** Format replies from one or more simulated modules, honouring ATH and ATCRA. */
  MockTransport.prototype._deliver = function (list) {
    var self = this, out = [];
    list.forEach(function (r) {
      if (self.rxFilter && self.rxFilter !== r.id) return; // ATCRA filter
      out.push(self.headers ? self._framesH1(r.id, r.hex) : self._fmtH0(r.hex));
    });
    return out.length ? out.join('\r') : 'NO DATA';
  };

  /** Headers off: single line, or the ELM "014 / 0: / 1:" multi-line layout above 7 bytes. */
  MockTransport.prototype._fmtH0 = function (hex) {
    var bb = hex.match(/../g) || [];
    if (bb.length <= 7) return this._fmt(hex);
    var ls = [hx2(bb.length).slice(1)], j = 6, sq = 0;
    ls.push('0: ' + this._fmt(bb.slice(0, 6).join('')));
    while (j < bb.length) { sq++; var ch = bb.slice(j, j + 7); while (ch.length < 7) ch.push('00'); ls.push(sq.toString(16).toUpperCase() + ': ' + this._fmt(ch.join(''))); j += 7; }
    return ls.join('\r');
  };

  /** Headers on (ATH1): raw CAN frames, "7E8 06 41 00 .." single frame, or "7E9 10 LL .." first frame + "7E9 2n .." consecutive frames. */
  MockTransport.prototype._framesH1 = function (id, hex) {
    var self = this, bb = hex.match(/../g) || [], lines = [];
    function line(bytes) { return id + (self.spaces ? ' ' : '') + self._fmt(bytes.join('')); }
    if (bb.length <= 7) return line([hx(bb.length)].concat(bb));
    lines.push(line(['1' + hx2(bb.length).slice(1, 2), hx2(bb.length).slice(2)].concat(bb.slice(0, 6))));
    var j = 6, sq = 0;
    while (j < bb.length) { sq = (sq + 1) & 15; var ch = bb.slice(j, j + 7); while (ch.length < 7) ch.push('00'); lines.push(line(['2' + sq.toString(16).toUpperCase()].concat(ch))); j += 7; }
    return lines.join('\r');
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
        abort: function (why) { resolve({ ok: false, text: self.buffer, aborted: why || 'ABORTED' }); },
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
    else if (r.aborted) {
      this.log('warn', 'Abandoned in-flight ' + label + ' after ' + this.lastLatency + 'ms (' + r.aborted + ')');
      this.afterTimeout = true; // let a late prompt drain before the next command
      var ab = new Error(r.aborted === 'CANCELLED' ? 'CANCELLED' : 'TIMEOUT'); ab.partial = r.text; ab.aborted = r.aborted; job.reject(ab);
    } else {
      this.log('warn', 'Timeout after ' + this.lastLatency + 'ms (no prompt) for ' + label + (r.text ? ' (partial: ' + JSON.stringify(r.text) + ')' : ' (no RX at all)'));
      this.afterTimeout = true;
      var err = new Error('TIMEOUT'); err.partial = r.text; job.reject(err);
    }
    this._pump();
  };

  /**
   * v1.7.0: give up on the command currently waiting for its prompt (e.g. it went stale while Chrome was in the
   * background). The waiting job rejects with TIMEOUT (aborted) and the queue keeps running, so nothing deadlocks.
   */
  ElmSession.prototype.abortPending = function (why) {
    var p = this.pending;
    if (!p) return false;
    this.pending = null;
    if (p.timer) clearTimeout(p.timer);
    if (p.abort) p.abort(why || 'ABORTED');
    return true;
  };

  ElmSession.prototype.clearQueue = function (reason) {
    var q = this.queue; this.queue = [];
    q.forEach(function (j) { j.reject(reason || new Error('CANCELLED')); });
    // Release the in-flight wait too (v1.6 only cleared its timer, which could leave the pump busy forever).
    this.abortPending('CANCELLED');
  };

  var api = { BleTransport: BleTransport, MockTransport: MockTransport, ElmSession: ElmSession, BLE_PROFILES: BLE_PROFILES, OPTIONAL_SERVICES: OPTIONAL_SERVICES, withTimeout: withTimeout, VARIANTS: VARIANTS, formatBytes: formatBytes, shortUuid: shortUuid, uuid16: uuid16, isBusyError: isBusyError };

  if (isNode) module.exports = api; else root.Transport = api;
})(this);
