const test = require('node:test');
const assert = require('node:assert/strict');
const { BleTransport, ElmSession, shortUuid, isBusyError, withTimeout } = require('../js/transport.js');
const { Obd } = require('../js/obd.js');
const { createFakeGattDongle } = require('./fake-gatt.js');

const FASTBLE = { postConnectDelay: 0, postSubscribeDelay: 0, subscribeRetryDelay: 10, reconnectWait: 20, notifyTimeout: 80, writeTimeout: 80, opTimeout: 80, gattTimeout: 300, busyDelays: [5, 10, 20, 30] };
const FASTINIT = { wake: 80, atz: 120, atws: 80, ati: 80, at: 80, pid: 200 };

async function setup(fakeOpts, tOpts, viaRequest) {
  const fake = createFakeGattDongle(fakeOpts);
  const logs = [];
  const t = new BleTransport(Object.assign({ log: (k, m) => logs.push(k + ': ' + m) }, FASTBLE, tOpts || {}));
  if (viaRequest) {
    Object.defineProperty(globalThis.navigator, 'bluetooth', { value: { requestDevice: async () => fake.device }, configurable: true });
    await t.request(false);
  } else { t.device = fake.device; t.name = fake.device.name; }
  return { fake, t, logs };
}
const ids = (list) => list.map(c => shortUuid(c.uuid));
const txCmds = (logs) => logs.filter(l => /^tx: (\(bare CR\)|AT[A-Z0-9@]*|0100)$/.test(l));

test('isBusyError matches Android busy errors only', () => {
  assert.ok(isBusyError(new Error('GATT operation already in progress.')));
  assert.ok(!isBusyError(new Error('GATT operation failed for unknown reason.')));
  assert.ok(!isBusyError(new Error('timed out after 3000ms')));
});

test('withTimeout flags timeouts', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20, 'x'), (e) => e.timeout === true);
});

test('GATT ops are serialized: connect + parallel writes never hit "already in progress"; only fff1 subscribed', async () => {
  const { fake, t, logs } = await setup({});
  await t.connect();
  assert.deepEqual(ids(t.subscribed), ['fff1']);
  assert.deepEqual(fake.stats.startNotif, [fake.U.fff1], 'ffea must not be subscribed unless needed');
  await Promise.all([t.write('ATI\r'), t.write('ATI\r'), t.write('ATI\r'), t.write('ATI\r'), t.write('ATI\r')]);
  assert.equal(fake.stats.concurrentRejections, 0);
  assert.equal(fake.stats.writes.length, 5);
  assert.equal(t.stats.recoveries, 0);
  assert.ok(logs.some(l => /BLE link ready/.test(l)));
});

test('full init through the serialized transport (fff1 notify, writeWithoutResponse)', async () => {
  const { fake, t } = await setup({ mock: { latency: 2, vin: 'JA32U2FU9DU010476' } });
  await t.connect();
  const s = new ElmSession(t, { timeout: 500 });
  const obd = new Obd(s, { initTimeouts: FASTINIT });
  const info = await obd.init('0');
  assert.equal(info.adapterOk, true); assert.equal(info.ecuOk, true);
  assert.equal(await obd.readVin(), 'JA32U2FU9DU010476');
  assert.equal(fake.stats.concurrentRejections, 0);
  assert.equal(t.useWithoutResponse, true);
  assert.equal(shortUuid(t.activeNotifyUuid), 'fff1');
  assert.equal(t.stats.recoveries, 0);
});

test('fff1 first startNotifications attempt fails instantly, retry succeeds (no reconnect)', async () => {
  const U = createFakeGattDongle().U;
  const { fake, t, logs } = await setup({ failFirstStartNotifications: [U.fff1] });
  await t.connect();
  assert.deepEqual(ids(t.subscribed), ['fff1']);
  assert.equal(fake.stats.startNotif.length, 2);
  assert.equal(fake.stats.disconnects, 0);
  assert.equal(t.stats.recoveries, 0);
  assert.ok(logs.some(l => /FAILED: GATT operation failed for unknown reason/.test(l)));
  assert.ok(logs.some(l => /Retrying startNotifications fff1/.test(l)));
});

test('hung startNotifications poisons the link -> disconnect, wait, reconnect, rediscover, resubscribe', async () => {
  const U = createFakeGattDongle().U;
  const { fake, t, logs } = await setup({ hangStartNotificationsOnce: [U.fff1] }, null, true);
  let lost = 0; t.onDisconnect = () => { lost++; };
  await t.connect();
  assert.deepEqual(ids(t.subscribed), ['ffea'], 'after fff1 hangs, the next attempt tries ffea first');
  assert.equal(t.stats.recoveries, 1);
  assert.equal(fake.stats.connects, 2);
  assert.ok(fake.stats.disconnects >= 1);
  assert.equal(fake.stats.concurrentRejections, 0, 'must not issue ops into the poisoned link');
  assert.equal(lost, 0, 'our own disconnect during recovery must not look like link loss');
  assert.ok(logs.some(l => /HUNG/.test(l)));
  assert.ok(logs.some(l => /Recovery 1\/3/.test(l)) && logs.some(l => /Recovery 1 OK/.test(l)));
});

test('a real (unexpected) disconnect still reports link loss', async () => {
  const { fake, t } = await setup({}, null, true);
  let lost = 0; t.onDisconnect = () => { lost++; };
  await t.connect();
  fake.device.gatt.disconnect();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(lost, 1);
});

test('"already in progress" on a write = busy: wait and retry the same op; no mode switch, no recovery', async () => {
  const { fake, t, logs } = await setup({ busyOnWrites: 2, mock: { latency: 2 } });
  await t.connect();
  const s = new ElmSession(t, { timeout: 500 });
  const r = await s.send('ATI');
  assert.ok(/ELM327/.test(r), r);
  assert.equal(fake.stats.fakeBusy, 2);
  assert.ok(t.stats.busyRetries >= 2);
  assert.equal(t.stats.recoveries, 0);
  assert.equal(t.useWithoutResponse, true);
  assert.ok(!logs.some(l => /Write mode is now/.test(l)));
  assert.ok(logs.some(l => /GATT busy during write/.test(l)));
});

test('hung writeWithoutResponse -> reconnect -> writeWithResponse used from then on (init completes)', async () => {
  const { fake, t, logs } = await setup({ hangWithoutResponse: true, mock: { latency: 2 } });
  await t.connect();
  const s = new ElmSession(t, { timeout: 500 });
  const obd = new Obd(s, { initTimeouts: FASTINIT });
  const info = await obd.init('0');
  assert.equal(info.ecuOk, true);
  assert.equal(t.useWithoutResponse, false);
  assert.equal(t.stats.recoveries, 1, 'exactly one recovery, no per-command flipping');
  assert.equal(fake.stats.concurrentRejections, 0);
  assert.ok(fake.stats.writes.every(w => w.startsWith('with:')));
  assert.equal(logs.filter(l => /Write mode is now/.test(l)).length, 1);
});

test('unrecoverable link: after 3 reconnects the transport goes fatal, session dies, init aborts without spamming commands', async () => {
  const { fake, t, logs } = await setup({ alwaysHangWrites: true });
  await t.connect();
  const s = new ElmSession(t, { timeout: 500 });
  const obd = new Obd(s, { log: (k, m) => logs.push(k + ': ' + m), initTimeouts: FASTINIT });
  await assert.rejects(obd.init('0'), (e) => e.fatal === true && /reconnect attempts did not fix/.test(e.message));
  assert.equal(t.stats.recoveries, 3);
  assert.equal(s.dead, true);
  assert.ok(txCmds(logs).length <= 2, 'commands sent into dead link: ' + txCmds(logs).join(','));
  await assert.rejects(s.send('ATI'), (e) => e.fatal === true);
  assert.equal(fake.stats.concurrentRejections, 0);
});

test('manual notify choice ffea locks to ffea and works', async () => {
  const U = createFakeGattDongle().U;
  const { t } = await setup({ respondOn: U.ffea, mock: { latency: 2 } }, { notifyChar: 'ffea' });
  await t.connect();
  assert.deepEqual(ids(t.subscribed), ['ffea']);
  assert.equal(t.notifyLocked, true);
  const s = new ElmSession(t, { timeout: 500 });
  assert.ok(/ELM327/.test(await s.send('ATI')));
  assert.equal(shortUuid(t.activeNotifyUuid), 'ffea');
});

test('auto: if fff1 gives no RX, init subscribes the reserve ffea characteristic (then it works)', async () => {
  const U = createFakeGattDongle().U;
  const { fake, t, logs } = await setup({ respondOn: U.ffea, mock: { latency: 2 } });
  await t.connect();
  assert.deepEqual(ids(t.subscribed), ['fff1']);
  const s = new ElmSession(t, { timeout: 300 });
  const obd = new Obd(s, { log: (k, m) => logs.push(k + ': ' + m), initTimeouts: FASTINIT });
  const info = await obd.init('0');
  assert.equal(info.adapterOk, true); assert.equal(info.ecuOk, true);
  assert.deepEqual(ids(t.subscribed).sort(), ['ffea', 'fff1']);
  assert.equal(shortUuid(t.activeNotifyUuid), 'ffea');
  assert.ok(logs.some(l => /fallback 1: subscribed reserve notify characteristic ffea/.test(l)));
  assert.equal(fake.stats.concurrentRejections, 0);
});

test('writeMode=with is locked: no toggling, writes use response', async () => {
  const { fake, t } = await setup({ dropWithoutResponse: true, mock: { latency: 2 } }, { writeMode: 'with' });
  await t.connect();
  assert.equal(t.useWithoutResponse, false);
  assert.equal(t.canToggleWrite(), false);
  const s = new ElmSession(t, { timeout: 500 });
  assert.ok(/ELM327/.test(await s.send('ATI')));
  assert.ok(fake.stats.writes.every(w => w.startsWith('with:')));
});

test('writeWithoutResponse silently dropped by the dongle: init falls back once (not per command) to writeWithResponse', async () => {
  const { fake, t, logs } = await setup({ dropWithoutResponse: true, mock: { latency: 2 } });
  await t.connect();
  const s = new ElmSession(t, { timeout: 300 });
  const obd = new Obd(s, { log: (k, m) => logs.push(k + ': ' + m), initTimeouts: FASTINIT });
  const info = await obd.init('0');
  assert.equal(info.ecuOk, true);
  assert.equal(t.useWithoutResponse, false);
  assert.equal(logs.filter(l => /Write mode is now/.test(l)).length, 1);
  assert.equal(t.stats.recoveries, 0);
});

test('silent adapter on a healthy link: init stops early with adapterOk=false and sends few commands', async () => {
  const { t, logs } = await setup({ silent: true });
  await t.connect();
  const s = new ElmSession(t, { timeout: 100 });
  const obd = new Obd(s, { log: (k, m) => logs.push(k + ': ' + m), initTimeouts: FASTINIT });
  const info = await obd.init('0');
  assert.equal(info.adapterOk, false);
  assert.ok(txCmds(logs).length <= 8, txCmds(logs).join(','));
  assert.ok(logs.some(l => /adapter never answered; stopping here/.test(l)));
});

test('verbose logging covers subscribe, TX bytes and RX hex+ascii', async () => {
  const { t, logs } = await setup({ mock: { latency: 2 } });
  await t.connect();
  const s = new ElmSession(t, { timeout: 500 });
  await s.send('ATI');
  const j = logs.join('\n');
  assert.match(j, /GATT startNotifications fff1 \(notify, try 1\/2, timeout \d+ms\) \.\.\./);
  assert.match(j, /GATT startNotifications fff1 .* OK/);
  assert.match(j, /tx: writeWithoutResponse 4 bytes: 41 54 49 0D  'ATI\\r'/);
  assert.match(j, /rx: notify fff1 \d+ bytes: .*'/);
  assert.match(j, /First RX on 0000fff1/);
});

const FASTPLAN = { notifyTimeout: 40, reconnectWait: 10 };

test('v1.3: fff1 startNotifications always hangs, ffea works -> reconnect rotates to ffea first and init succeeds', async () => {
  const U = createFakeGattDongle().U;
  const { fake, t, logs } = await setup({ hangStartNotificationsAlways: [U.fff1], respondOn: U.ffea, mock: { latency: 2 } }, FASTPLAN);
  await t.connect();
  assert.equal(t.stats.recoveries, 1);
  assert.deepEqual(ids(t.subscribed), ['ffea']);
  const iHang = logs.findIndex(l => /startNotifications fff1 .*HUNG/.test(l));
  const iOk = logs.findIndex(l => /startNotifications ffea .* OK/.test(l));
  assert.ok(iHang >= 0 && iOk > iHang, 'fff1 hung first, then ffea succeeded');
  assert.ok(logs.some(l => /Plan: rotated: ffea first, longer timeout, notify timeout 80ms/.test(l)), 'timeout doubled on attempt 2');
  assert.ok(logs.some(l => /possible pairing prompt - check phone/.test(l)));
  const s = new ElmSession(t, { timeout: 400 });
  const obd = new Obd(s, { log: (k, m) => logs.push(k + ': ' + m), initTimeouts: FASTINIT });
  const info = await obd.init('0');
  assert.equal(info.ecuOk, true);
  assert.equal(shortUuid(t.activeNotifyUuid), 'ffea');
  assert.equal(fake.stats.concurrentRejections, 0);
});

test('v1.3: notify only works after a first write -> 4th attempt is write-first (listener, ATZ write, then startNotifications)', async () => {
  const onStatus = [];
  const { fake, t, logs } = await setup({ notifyOnlyAfterWrite: true, mock: { latency: 2 } }, Object.assign({ onStatus: (m) => onStatus.push(m) }, FASTPLAN));
  await t.connect();
  assert.equal(t.stats.recoveries, 3);
  assert.deepEqual(ids(t.subscribed), ['fff1']);
  assert.ok(logs.some(l => /Write-first: listeners attached; writing ATZ before startNotifications/.test(l)));
  const iW = logs.findIndex(l => /write-first ATZ/.test(l));
  const iS = logs.findIndex((l, i) => i > iW && /startNotifications fff1 .* OK/.test(l));
  assert.ok(iW >= 0 && iS > iW, 'write happens before the successful startNotifications');
  assert.equal(fake.stats.concurrentRejections, 0);
  assert.ok(onStatus.some(m => /possible pairing prompt - check phone/.test(m)), 'UI status mentions pairing prompt');
  const s = new ElmSession(t, { timeout: 400 });
  const obd = new Obd(s, { log: (k, m) => logs.push(k + ': ' + m), initTimeouts: FASTINIT });
  const info = await obd.init('0');
  assert.equal(info.ecuOk, true);
});

test('v1.3: every startNotifications hangs -> 3 reconnects, then a fatal error with troubleshooting advice', async () => {
  const { fake, t } = await setup({ hangAllStartNotifications: true }, FASTPLAN);
  await assert.rejects(t.connect(), (e) => e.fatal === true && /3 reconnect attempts/.test(e.message) && /force-stop other OBD apps/.test(e.message) && /unpair "OBDII"/.test(e.message) && /Forget and re-pick/.test(e.message));
  assert.equal(t.stats.recoveries, 3);
  assert.equal(fake.stats.concurrentRejections, 0);
});

test('v1.3: diagnostics log full properties, descriptors (CCCD), blocklisted getDescriptor and the no-read-property note', async () => {
  const { t, logs } = await setup({});
  await t.connect();
  const j = logs.join('\n');
  assert.match(j, /props fff1: broadcast=\S+ read=false writeWithoutResponse=false write=false notify=true indicate=false/);
  assert.match(j, /descriptors on fff1: 00002902-0000-1000-8000-00805f9b34fb -> CCCD 2902 present/);
  assert.match(j, /getDescriptor\(0x2902\) on fff1: SecurityError .*blocklist/);
  assert.match(j, /fff1 has no read property; skipping readValue/);
});

test('v1.3: forget() forgets the device', async () => {
  const { fake, t } = await setup({});
  let forgot = 0; fake.device.forget = async () => { forgot++; };
  assert.equal(await t.forget(), 1);
  assert.equal(forgot, 1);
});
