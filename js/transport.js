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
        reject(new Error((label || 'operation') + ' timed out after ' + ms + 'ms'));
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
  function BleTransport(opts) {
    this.opts = opts || {};
    this.device = null; this.server = null; this.writeChar = null;
    this.notifyChars = []; this.subscribed = [];
    this.activeNotifyUuid = null;
    this.onData = function () {}; this.onDisconnect = function () {}; this.log = this.opts.log || function () {};
    this.decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('ascii') : null;
    this.kind = 'ble';
    this.writeModeLocked = this.opts.writeMode === 'with' || this.opts.writeMode === 'without';
    this.useWithoutResponse = this.opts.writeMode !== 'with';
  }

  BleTransport.isSupported = function () { return typeof navigator !== 'undefined' && !!navigator.bluetooth; };

  BleTransport.prototype.request = async function (acceptAll) {
    var options = acceptAll
      ? { acceptAllDevices: true, optionalServices: OPTIONAL_SERVICES }
      : { filters: [{ namePrefix: 'OBD' }, { namePrefix: 'obd' }, { namePrefix: 'Vlink' }, { namePrefix: 'V-LINK' }, { namePrefix: 'IOS-Vlink' }, { namePrefix: 'Android-Vlink' }, { namePrefix: 'VEEPEAK' }, { namePrefix: 'ELM' }, { namePrefix: 'Viecar' }],
          optionalServices: OPTIONAL_SERVICES };
    this.log('info', 'requestDevice ' + (acceptAll ? '(all devices)' : '(name filter OBD*/Vlink*/ELM*)'));
    this.device = await navigator.bluetooth.requestDevice(options);
    this.name = this.device.name || '(unnamed)';
    var self = this;
    this.device.addEventListener('gattserverdisconnected', function () { self.log('warn', 'GATT disconnected'); self.onDisconnect(); });
    return this.device;
  };

  BleTransport.prototype.connect = async function () {
    var self = this;
    if (!this.device) throw new Error('No device selected');
    this.log('info', 'Connecting GATT to ' + this.name + ' (' + (this.device.id || '') + ')');
    this.server = await withTimeout(this.device.gatt.connect(), this.opts.gattTimeout || 15000, 'GATT connect');
    var services = await this.server.getPrimaryServices();
    this.log('info', 'Services visible: ' + services.map(function (s) { return s.uuid; }).join(', '));
    var found = await this._pickCharacteristics(services);
    if (!found) throw new Error('No notify+write characteristic pair found. Check Console for the service list.');
    this.writeChar = found.write;
    this.notifyChars = found.notifyList && found.notifyList.length ? found.notifyList : [found.notify];
    this.profileName = found.label;
    var wp = this.writeChar.properties;
    var mode = this.opts.writeMode || 'auto';
    if (mode === 'without') this.useWithoutResponse = true;
    else if (mode === 'with') this.useWithoutResponse = false;
    else this.useWithoutResponse = !wp.write || !!wp.writeWithoutResponse; // auto: prefer without when available
    this.log('info', 'Using ' + found.label + ' write=' + this.writeChar.uuid + ' (' + this.writeModeLabel() + ')' +
      ' notify=[' + this.notifyChars.map(function (c) { return shortUuid(c.uuid); }).join(', ') + ']');
    this.log('info', 'Write properties: write=' + !!wp.write + ' writeWithoutResponse=' + !!wp.writeWithoutResponse);

    var notifyTimeout = this.opts.notifyTimeout || 5000;
    this.subscribed = [];
    this.log('info', 'Starting notifications on ' + this.notifyChars.length + ' characteristic(s), timeout ' + notifyTimeout + 'ms each (in parallel)');
    var results = await Promise.all(this.notifyChars.map(function (c) { return self._subscribe(c, notifyTimeout); }));
    var ok = results.filter(Boolean).length;
    this.log('info', 'Notifications active on ' + ok + '/' + this.notifyChars.length + ' characteristic(s)' +
      (this.subscribed.length ? ': ' + this.subscribed.map(function (c) { return shortUuid(c.uuid); }).join(', ') : ''));
    if (!ok) this.log('warn', 'startNotifications did not succeed on any characteristic; writes will still be attempted');

    var delay = this.opts.postSubscribeDelay != null ? this.opts.postSubscribeDelay : 300;
    if (delay) {
      this.log('info', 'Waiting ' + delay + 'ms after subscribe before first write');
      await sleep(delay);
    }
    this.log('info', 'BLE link ready for ELM commands');
    return true;
  };

  BleTransport.prototype._subscribe = async function (char, timeoutMs) {
    var self = this;
    var id = shortUuid(char.uuid);
    var kind = char.properties.notify ? 'notify' : (char.properties.indicate ? 'indicate' : 'unknown');
    this.log('info', 'startNotifications ' + kind + ' ' + char.uuid + ' ...');
    char.addEventListener('characteristicvaluechanged', function (ev) { self._onNotify(char, ev); });
    try {
      await withTimeout(char.startNotifications(), timeoutMs, 'startNotifications ' + id);
      this.subscribed.push(char);
      this.log('info', 'startNotifications ' + id + ' OK');
      return true;
    } catch (e) {
      this.log('warn', 'startNotifications ' + id + ' FAILED: ' + e.message);
      return false;
    }
  };

  BleTransport.prototype._onNotify = function (char, ev) {
    var dv = ev.target.value;
    var bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    var id = shortUuid(char.uuid);
    if (!this.activeNotifyUuid) {
      this.activeNotifyUuid = char.uuid;
      this.notifyChar = char;
      this.log('info', 'First RX on ' + char.uuid + ' (remembered)');
    }
    this.log('rx', 'notify ' + id + ' ' + formatBytes(bytes));
    var s = this.decoder ? this.decoder.decode(bytes) : String.fromCharCode.apply(null, bytes);
    this.onData(s);
  };

  BleTransport.prototype.writeModeLabel = function () {
    return this.useWithoutResponse ? 'writeWithoutResponse' : 'writeWithResponse';
  };

  BleTransport.prototype.canToggleWrite = function () {
    if (this.writeModeLocked || !this.writeChar) return false;
    var p = this.writeChar.properties;
    return !!(p.write && p.writeWithoutResponse);
  };

  BleTransport.prototype.toggleWriteMode = function () {
    if (!this.canToggleWrite()) return false;
    this.useWithoutResponse = !this.useWithoutResponse;
    this.log('info', 'Switching write mode to ' + this.writeModeLabel());
    return true;
  };

  BleTransport.prototype.write = async function (str) {
    var enc;
    if (typeof TextEncoder !== 'undefined') enc = new TextEncoder().encode(str);
    else {
      enc = new Uint8Array(str.length);
      for (var k = 0; k < str.length; k++) enc[k] = str.charCodeAt(k) & 0xff;
    }
    this.log('tx', this.writeModeLabel() + ' ' + formatBytes(enc));
    var writeTimeout = this.opts.writeTimeout || 3000;
    for (var i = 0; i < enc.length; i += 20) {
      var chunk = enc.slice(i, i + 20);
      if (enc.length > 20) this.log('tx', '  chunk ' + (i / 20 + 1) + ' ' + formatBytes(chunk));
      await withTimeout(this._writeChunk(chunk), writeTimeout, 'GATT write (' + this.writeModeLabel() + ')');
    }
  };

  BleTransport.prototype._writeChunk = async function (chunk) {
    var c = this.writeChar;
    if (this.useWithoutResponse && c.writeValueWithoutResponse) return c.writeValueWithoutResponse(chunk);
    if (!this.useWithoutResponse && c.writeValueWithResponse) return c.writeValueWithResponse(chunk);
    if (c.writeValueWithoutResponse && !c.properties.write) return c.writeValueWithoutResponse(chunk);
    if (c.writeValueWithResponse) return c.writeValueWithResponse(chunk);
    return c.writeValue(chunk);
  };

  BleTransport.prototype._pickCharacteristics = async function (services) {
    var all = [];
    for (var i = 0; i < services.length; i++) {
      var s = services[i], chars = [];
      try { chars = await s.getCharacteristics(); } catch (e) { this.log('warn', 'getCharacteristics failed on ' + s.uuid + ': ' + e.message); }
      chars.forEach(function (c) {
        var p = c.properties;
        this.log('info', '  ' + shortUuid(s.uuid) + ' / ' + c.uuid + ' [' + ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter(function (k) { return p[k]; }).join(',') + ']');
      }, this);
      all.push({ service: s, chars: chars });
    }
    function notifies(chars) { return chars.filter(function (c) { return c.properties.notify || c.properties.indicate; }); }
    function writers(chars) { return chars.filter(function (c) { return c.properties.write || c.properties.writeWithoutResponse; }); }
    // 1) known profile with its preferred write characteristic; subscribe to ALL notifies in that service
    for (var k = 0; k < BLE_PROFILES.length; k++) {
      var prof = BLE_PROFILES[k];
      var entry = all.filter(function (e) { return e.service.uuid === prof.service; })[0];
      if (!entry) continue;
      var ns = notifies(entry.chars);
      var w = entry.chars.filter(function (c) { return c.uuid === prof.write && (c.properties.write || c.properties.writeWithoutResponse); })[0] || writers(entry.chars)[0];
      var preferred = ns.filter(function (c) { return c.uuid === prof.notify; })[0];
      if (w && ns.length) return { notify: preferred || ns[0], write: w, notifyList: ns, label: prof.name };
    }
    // 2) any service with a notify + a write characteristic
    for (var j = 0; j < all.length; j++) {
      var ns2 = notifies(all[j].chars);
      var ws = writers(all[j].chars);
      if (ns2.length && ws.length) return { notify: ns2[0], write: ws[0], notifyList: ns2, label: 'auto ' + shortUuid(all[j].service.uuid) };
    }
    return null;
  };

  BleTransport.prototype.disconnect = async function () {
    var list = this.subscribed.length ? this.subscribed : this.notifyChars;
    for (var i = 0; i < list.length; i++) {
      try { await list[i].stopNotifications(); } catch (e) { /* ignore */ }
    }
    if (this.device && this.device.gatt && this.device.gatt.connected) this.device.gatt.disconnect();
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
    this.writeProven = false; this.gotRx = false;
    var self = this;
    transport.onData = function (s) { self._onData(s); };
  }

  ElmSession.prototype._onData = function (s) {
    this.gotRx = true;
    this.log('rx', s);
    this.buffer += s;
    if (this.pending && this.buffer.indexOf('>') >= 0) {
      var text = this.buffer.slice(0, this.buffer.lastIndexOf('>'));
      this.buffer = this.buffer.slice(this.buffer.lastIndexOf('>') + 1);
      var p = this.pending; this.pending = null;
      if (p.timer) clearTimeout(p.timer);
      p.resolve(text);
    }
  };

  /** Send a command; resolves with the raw response text (without '>'). Commands are strictly serialized. */
  ElmSession.prototype.send = function (cmd, timeoutMs, sendOpts) {
    var self = this;
    return new Promise(function (resolve, reject) {
      self.queue.push({ cmd: cmd, timeout: timeoutMs || self.opts.timeout || 2500, probe: !sendOpts || sendOpts.probe !== false, resolve: resolve, reject: reject });
      self._pump();
    });
  };

  ElmSession.prototype._waitForPrompt = function (ms) {
    var self = this;
    return new Promise(function (resolve) {
      if (self.pending && self.pending.timer) clearTimeout(self.pending.timer);
      var finished = false;
      var done = function (result) {
        if (finished) return;
        finished = true;
        if (self.pending) { self.pending = null; }
        resolve(result);
      };
      self.pending = {
        resolve: function (text) { done({ ok: true, text: text }); },
        timer: setTimeout(function () { done({ ok: false, text: self.buffer }); }, ms)
      };
    });
  };

  ElmSession.prototype._writeCmd = async function (cmd) {
    var label = cmd === '' ? '(bare CR)' : cmd;
    this.log('tx', label);
    try {
      await withTimeout(this.t.write(cmd + '\r'), this.opts.writeTimeout || 3000, 'write ' + label);
      return true;
    } catch (e) {
      this.log('warn', 'Write failed (' + (this.t.writeModeLabel ? this.t.writeModeLabel() : 'write') + '): ' + e.message);
      return false;
    }
  };

  ElmSession.prototype._pump = async function () {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    var job = this.queue.shift();
    var self = this;
    if (this.afterTimeout) { this.afterTimeout = false; await sleep(150); }
    var probeMs = this.opts.writeProbeMs != null ? this.opts.writeProbeMs : 2000;
    var canToggle = !this.writeProven && this.t && typeof this.t.toggleWriteMode === 'function' && this.t.canToggleWrite && this.t.canToggleWrite();

    async function attempt(waitMs) {
      self.buffer = '';
      var wrote = await self._writeCmd(job.cmd);
      if (!wrote) return { ok: false, text: self.buffer, writeFailed: true };
      return self._waitForPrompt(waitMs);
    }

    var started = Date.now();
    var waitFirst = (canToggle && job.probe !== false) ? Math.min(probeMs, job.timeout) : job.timeout;
    var r = await attempt(waitFirst);

    if (!r.ok && canToggle && this.t.toggleWriteMode()) {
      this.log('info', 'No RX after ' + waitFirst + 'ms for ' + (job.cmd || '(bare CR)') + '; retrying with other write mode');
      r = await attempt(job.timeout);
    }

    if (this.pending && this.pending.timer) clearTimeout(this.pending.timer);
    this.pending = null;
    this.lastLatency = Date.now() - started;
    this.busy = false;
    if (r.ok) {
      this.writeProven = true;
      job.resolve(r.text);
    } else {
      this.log('warn', 'Timeout after ' + this.lastLatency + 'ms for ' + (job.cmd || '(bare CR)') + (r.text ? ' (partial: ' + JSON.stringify(r.text) + ')' : ''));
      this.afterTimeout = true;
      var err = new Error('TIMEOUT'); err.partial = r.text; job.reject(err);
    }
    this._pump();
  };

  ElmSession.prototype.clearQueue = function () {
    var q = this.queue; this.queue = [];
    if (this.pending && this.pending.timer) clearTimeout(this.pending.timer);
    this.pending = null;
    q.forEach(function (j) { j.reject(new Error('CANCELLED')); });
  };


  // ---------------- Fake GATT dongle (unit tests) ----------------
  function createFakeGattDongle(opts) {
    opts = opts || {};
    var FFF0 = uuid16('fff0'), FFEA = uuid16('ffea'), FFF1 = uuid16('fff1'), FFF2 = uuid16('fff2');
    var respondOn = (opts.respondOn || FFEA).toLowerCase();
    var dropWithout = opts.dropWithoutResponse !== false;
    var hangOn = {};
    (opts.startNotificationsHangOn || []).forEach(function (u) { hangOn[u.toLowerCase()] = true; });
    var failOn = {};
    (opts.startNotificationsFailOn || []).forEach(function (u) { failOn[u.toLowerCase()] = true; });
    var elm = opts.elm || new MockTransport(Object.assign({ latency: 0 }, opts.mock || {}));
    elm.onData = function () {};
    var writeBuf = [];

    function makeChar(uuid, props) {
      var c = {
        uuid: uuid,
        properties: { read: !!props.read, write: !!props.write, writeWithoutResponse: !!props.writeWithoutResponse, notify: !!props.notify, indicate: !!props.indicate },
        _listeners: [],
        _notifying: false,
        addEventListener: function (ev, fn) { if (ev === 'characteristicvaluechanged') c._listeners.push(fn); },
        startNotifications: function () {
          if (hangOn[uuid]) return new Promise(function () { /* never settles */ });
          if (failOn[uuid]) return Promise.reject(new Error('startNotifications rejected'));
          c._notifying = true;
          return Promise.resolve(c);
        },
        stopNotifications: function () { c._notifying = false; return Promise.resolve(); },
        writeValueWithoutResponse: function (chunk) { return onWrite(chunk, 'without'); },
        writeValueWithResponse: function (chunk) { return onWrite(chunk, 'with'); },
        writeValue: function (chunk) { return onWrite(chunk, 'with'); },
        _emit: function (str) {
          var enc = new TextEncoder().encode(str);
          var ev = { target: { value: new DataView(enc.buffer, enc.byteOffset, enc.byteLength) } };
          c._listeners.forEach(function (fn) { fn(ev); });
        }
      };
      return c;
    }

    function onWrite(chunk, mode) {
      var u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (mode === 'without' && dropWithout) return Promise.resolve();
      for (var i = 0; i < u8.length; i++) writeBuf.push(u8[i]);
      var text = String.fromCharCode.apply(null, writeBuf);
      if (text.indexOf('\r') < 0 && text.indexOf('\n') < 0) return Promise.resolve();
      writeBuf = [];
      // Deliver the ELM reply on the chosen notify characteristic only.
      return new Promise(function (resolve) {
        elm.write(text).then(function () { resolve(); });
      });
    }

    var ffea = makeChar(FFEA, { notify: true });
    var fff1 = makeChar(FFF1, { notify: true });
    var fff2 = makeChar(FFF2, { write: !opts.withoutOnly, writeWithoutResponse: !opts.withOnly });
    if (opts.withOnly) { fff2.properties.write = true; fff2.properties.writeWithoutResponse = false; }
    if (opts.withoutOnly) { fff2.properties.write = false; fff2.properties.writeWithoutResponse = true; }
    var byUuid = {};
    byUuid[FFEA] = ffea; byUuid[FFF1] = fff1; byUuid[FFF2] = fff2;

    elm.onData = function (s) {
      var target = byUuid[respondOn] || ffea;
      if (target._notifying || target._listeners.length) target._emit(s);
    };

    var service = {
      uuid: FFF0,
      getCharacteristics: function () { return Promise.resolve([ffea, fff1, fff2]); }
    };
    var server = { getPrimaryServices: function () { return Promise.resolve([service]); }, connected: true };
    var device = {
      name: opts.name || 'OBDII',
      id: opts.id || 'fake-dongle',
      gatt: {
        connected: true,
        connect: function () { device.gatt.connected = true; return Promise.resolve(server); },
        disconnect: function () { device.gatt.connected = false; }
      },
      addEventListener: function () {}
    };
    return { device: device, server: server, service: service, chars: { ffea: ffea, fff1: fff1, fff2: fff2 }, elm: elm };
  }

  var api = { BleTransport: BleTransport, MockTransport: MockTransport, ElmSession: ElmSession, BLE_PROFILES: BLE_PROFILES, OPTIONAL_SERVICES: OPTIONAL_SERVICES, withTimeout: withTimeout, formatBytes: formatBytes, createFakeGattDongle: createFakeGattDongle, shortUuid: shortUuid };

  if (isNode) module.exports = api; else root.Transport = api;
})(this);
