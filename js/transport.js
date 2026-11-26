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

  // ---------------- Web Bluetooth transport ----------------
  function BleTransport(opts) {
    this.opts = opts || {};
    this.device = null; this.server = null; this.notifyChar = null; this.writeChar = null;
    this.onData = function () {}; this.onDisconnect = function () {}; this.log = this.opts.log || function () {};
    this.decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('ascii') : null;
    this.kind = 'ble';
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
    this.log('info', 'Connecting GATT to ' + this.name + ' (' + this.device.id + ')');
    this.server = await this.device.gatt.connect();
    var services = await this.server.getPrimaryServices();
    this.log('info', 'Services visible: ' + services.map(function (s) { return s.uuid; }).join(', '));
    var found = await this._pickCharacteristics(services);
    if (!found) throw new Error('No notify+write characteristic pair found. Check Console for the service list.');
    this.notifyChar = found.notify; this.writeChar = found.write; this.profileName = found.label;
    var wp = this.writeChar.properties;
    var mode = this.opts.writeMode || 'auto';
    this.useWithoutResponse = mode === 'without' ? true : mode === 'with' ? false : (!wp.write && wp.writeWithoutResponse);
    if (mode === 'auto' && wp.write && wp.writeWithoutResponse) this.useWithoutResponse = true;
    this.log('info', 'Using ' + found.label + ' notify=' + this.notifyChar.uuid + ' write=' + this.writeChar.uuid + ' (' + (this.useWithoutResponse ? 'writeWithoutResponse' : 'write') + ')');
    this.notifyChar.addEventListener('characteristicvaluechanged', function (ev) {
      var dv = ev.target.value;
      var bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      var s = self.decoder ? self.decoder.decode(bytes) : String.fromCharCode.apply(null, bytes);
      self.onData(s);
    });
    await this.notifyChar.startNotifications();
    return true;
  };

  BleTransport.prototype._pickCharacteristics = async function (services) {
    var all = [];
    for (var i = 0; i < services.length; i++) {
      var s = services[i], chars = [];
      try { chars = await s.getCharacteristics(); } catch (e) { this.log('warn', 'getCharacteristics failed on ' + s.uuid + ': ' + e.message); }
      chars.forEach(function (c) {
        var p = c.properties;
        this.log('info', '  ' + s.uuid.slice(0, 8) + ' / ' + c.uuid + ' [' + ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter(function (k) { return p[k]; }).join(',') + ']');
      }, this);
      all.push({ service: s, chars: chars });
    }
    // 1) known profile with its preferred characteristics
    for (var k = 0; k < BLE_PROFILES.length; k++) {
      var prof = BLE_PROFILES[k];
      var entry = all.filter(function (e) { return e.service.uuid === prof.service; })[0];
      if (!entry) continue;
      var n = entry.chars.filter(function (c) { return c.uuid === prof.notify && (c.properties.notify || c.properties.indicate); })[0];
      var w = entry.chars.filter(function (c) { return c.uuid === prof.write && (c.properties.write || c.properties.writeWithoutResponse); })[0];
      if (n && w) return { notify: n, write: w, label: prof.name };
    }
    // 2) any service with a notify + a write characteristic
    for (var j = 0; j < all.length; j++) {
      var ns = all[j].chars.filter(function (c) { return c.properties.notify || c.properties.indicate; });
      var ws = all[j].chars.filter(function (c) { return c.properties.write || c.properties.writeWithoutResponse; });
      if (ns.length && ws.length) return { notify: ns[0], write: ws[0], label: 'auto ' + all[j].service.uuid.slice(0, 8) };
    }
    return null;
  };

  BleTransport.prototype.write = async function (str) {
    var enc = new TextEncoder().encode(str);
    for (var i = 0; i < enc.length; i += 20) {
      var chunk = enc.slice(i, i + 20);
      if (this.useWithoutResponse && this.writeChar.writeValueWithoutResponse) await this.writeChar.writeValueWithoutResponse(chunk);
      else if (this.writeChar.writeValueWithResponse) await this.writeChar.writeValueWithResponse(chunk);
      else await this.writeChar.writeValue(chunk);
    }
  };

  BleTransport.prototype.disconnect = async function () {
    try { if (this.notifyChar) await this.notifyChar.stopNotifications(); } catch (e) { /* ignore */ }
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
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
    var self = this;
    transport.onData = function (s) { self._onData(s); };
  }

  ElmSession.prototype._onData = function (s) {
    this.log('rx', s);
    this.buffer += s;
    if (this.pending && this.buffer.indexOf('>') >= 0) {
      var text = this.buffer.slice(0, this.buffer.lastIndexOf('>'));
      this.buffer = this.buffer.slice(this.buffer.lastIndexOf('>') + 1);
      var p = this.pending; this.pending = null;
      clearTimeout(p.timer);
      p.resolve(text);
    }
  };

  /** Send a command; resolves with the raw response text (without '>'). Commands are strictly serialized. */
  ElmSession.prototype.send = function (cmd, timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      self.queue.push({ cmd: cmd, timeout: timeoutMs || self.opts.timeout || 2500, resolve: resolve, reject: reject });
      self._pump();
    });
  };

  ElmSession.prototype._pump = async function () {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    var job = this.queue.shift();
    var self = this;
    if (this.afterTimeout) { this.afterTimeout = false; await new Promise(function (r) { setTimeout(r, 150); }); } // let a late reply drain
    this.buffer = '';
    var started = Date.now();
    var done = new Promise(function (res) {
      self.pending = {
        resolve: function (text) { res({ ok: true, text: text }); },
        timer: setTimeout(function () { self.pending = null; res({ ok: false, text: self.buffer }); }, job.timeout)
      };
    });
    try {
      this.log('tx', job.cmd);
      await this.t.write(job.cmd + '\r');
    } catch (e) {
      clearTimeout(this.pending && this.pending.timer); this.pending = null;
      this.busy = false; job.reject(e); this._pump(); return;
    }
    var r = await done;
    this.lastLatency = Date.now() - started;
    this.busy = false;
    if (r.ok) job.resolve(r.text);
    else {
      this.log('warn', 'Timeout after ' + job.timeout + 'ms for ' + job.cmd + (r.text ? ' (partial: ' + JSON.stringify(r.text) + ')' : ''));
      this.afterTimeout = true;
      var err = new Error('TIMEOUT'); err.partial = r.text; job.reject(err);
    }
    this._pump();
  };

  ElmSession.prototype.clearQueue = function () {
    var q = this.queue; this.queue = [];
    q.forEach(function (j) { j.reject(new Error('CANCELLED')); });
  };

  var api = { BleTransport: BleTransport, MockTransport: MockTransport, ElmSession: ElmSession, BLE_PROFILES: BLE_PROFILES, OPTIONAL_SERVICES: OPTIONAL_SERVICES };
  if (isNode) module.exports = api; else root.Transport = api;
})(this);
