/* Fake Web Bluetooth GATT dongle for unit tests, modelled on Android's single-outstanding-GATT-operation rule:
   any call made while another op is in flight (or hung) is rejected with "GATT operation already in progress."
   A hung op stays busy until device.gatt.disconnect() is called, exactly like the real stack. */
const { MockTransport, uuid16 } = require('../js/transport.js');

function createFakeGattDongle(opts) {
  opts = opts || {};
  const U = { svc: uuid16('fff0'), ffea: uuid16('ffea'), fff1: uuid16('fff1'), fff2: uuid16('fff2') };
  const stats = { concurrentRejections: 0, fakeBusy: 0, connects: 0, disconnects: 0, startNotif: [], writes: [] };
  const discListeners = [];
  const once = { hang: {}, fail: {} };
  let busy = false, busyWrites = opts.busyOnWrites || 0;
  const elm = new MockTransport(Object.assign({ latency: 0 }, opts.mock || {}));
  if (opts.silent) elm.write = async function () {};
  let writeBuf = [];
  const delay = opts.opDelay != null ? opts.opDelay : 1;

  function op(label, fn) {
    if (!device.gatt.connected && label !== 'connect') {
      const e = new Error('GATT Server is disconnected. Cannot perform GATT operations.'); e.name = 'NetworkError'; return Promise.reject(e);
    }
    if (busy) { stats.concurrentRejections++; return Promise.reject(new Error('GATT operation already in progress.')); }
    const r = fn();
    if (r.hang) { busy = true; return new Promise(() => {}); } // never settles; busy until disconnect
    if (r.fakeBusy) { stats.fakeBusy++; return Promise.reject(new Error('GATT operation already in progress.')); }
    busy = true;
    return new Promise((res, rej) => setTimeout(() => { busy = false; r.error ? rej(new Error(r.error)) : res(r.value); }, delay));
  }

  function makeChar(uuid, props) {
    const c = {
      uuid, properties: Object.assign({ read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false }, props),
      _listeners: [], _notifying: false,
      addEventListener(ev, fn) { if (ev === 'characteristicvaluechanged') c._listeners.push(fn); },
      startNotifications() {
        return op('startNotifications', () => {
          stats.startNotif.push(uuid);
          if ((opts.hangStartNotificationsOnce || []).includes(uuid) && !once.hang[uuid]) { once.hang[uuid] = true; return { hang: true }; }
          if ((opts.failFirstStartNotifications || []).includes(uuid) && !once.fail[uuid]) { once.fail[uuid] = true; return { error: 'GATT operation failed for unknown reason.' }; }
          c._notifying = true; return { value: c };
        });
      },
      stopNotifications() { return op('stopNotifications', () => { c._notifying = false; return { value: c }; }); },
      writeValueWithoutResponse(chunk) { return write(chunk, 'without'); },
      writeValueWithResponse(chunk) { return write(chunk, 'with'); },
      writeValue(chunk) { return write(chunk, 'with'); },
      _emit(str) {
        const enc = new TextEncoder().encode(str);
        const ev = { target: { value: new DataView(enc.buffer, enc.byteOffset, enc.byteLength) } };
        c._listeners.forEach(fn => fn(ev));
      }
    };
    return c;
  }

  function write(chunk, mode) {
    return op('write', () => {
      if (opts.alwaysHangWrites) return { hang: true };
      if (opts.hangWithoutResponse && mode === 'without') return { hang: true };
      if (busyWrites > 0) { busyWrites--; return { fakeBusy: true }; }
      const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      stats.writes.push(mode + ':' + Buffer.from(u8).toString('latin1').replace(/\r/g, '\\r'));
      if (mode === 'without' && opts.dropWithoutResponse) return { value: undefined };
      for (const b of u8) writeBuf.push(b);
      const text = String.fromCharCode.apply(null, writeBuf);
      if (text.indexOf('\r') >= 0) { writeBuf = []; elm.write(text); }
      return { value: undefined };
    });
  }

  const ffea = makeChar(U.ffea, { notify: true });
  const fff1 = makeChar(U.fff1, { notify: true });
  const fff2 = makeChar(U.fff2, opts.withOnly ? { write: true } : opts.withoutOnly ? { writeWithoutResponse: true } : { write: true, writeWithoutResponse: true });
  const byUuid = { [U.ffea]: ffea, [U.fff1]: fff1, [U.fff2]: fff2 };
  elm.onData = function (s) { const t = byUuid[opts.respondOn || U.fff1]; if (t._notifying) t._emit(s); };

  const service = { uuid: U.svc, getCharacteristics() { return op('getCharacteristics', () => ({ value: [ffea, fff1, fff2] })); } };
  const server = { getPrimaryServices() { return op('getPrimaryServices', () => ({ value: [service] })); } };
  const device = {
    name: 'OBDII', id: 'fake',
    gatt: {
      connected: false,
      connect() { stats.connects++; device.gatt.connected = true; return new Promise(r => setTimeout(() => r(server), delay)); },
      disconnect() {
        if (!device.gatt.connected) return;
        device.gatt.connected = false; busy = false; stats.disconnects++;
        [ffea, fff1].forEach(c => { c._notifying = false; });
        setTimeout(() => discListeners.forEach(fn => fn()), 0);
      }
    },
    addEventListener(ev, fn) { if (ev === 'gattserverdisconnected') discListeners.push(fn); }
  };
  return { device, stats, chars: { ffea, fff1, fff2 }, U, elm };
}

module.exports = { createFakeGattDongle };
