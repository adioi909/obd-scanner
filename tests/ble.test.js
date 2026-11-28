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

test('GATT ops are serialized: connect + parallel writes never hit "already in progress"; ffea then fff1 both subscribed', async () => {
  const { fake, t, logs } = await setup({});
  await t.connect();
  assert.deepEqual(ids(t.subscribed), ['ffea', 'fff1']);
  assert.deepEqual(fake.stats.startNotif, [fake.U.ffea, fake.U.fff1], 'default plan subscribes ffea then fff1');
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
  assert.deepEqual(ids(t.subscribed), ['ffea', 'fff1']);
  assert.ok(fake.stats.startNotif.filter(u => u === U.fff1).length >= 2, 'fff1 retried after a plain failure');
  assert.equal(fake.stats.disconnects, 0);
  assert.equal(t.stats.recoveries, 0);
  assert.ok(logs.some(l => /FAILED: GATT operation failed for unknown reason/.test(l)));
  assert.ok(logs.some(l => /Retrying startNotifications fff1/.test(l)));
});

test('hung startNotifications poisons the link -> disconnect, wait, reconnect, rediscover, resubscribe', async () => {
  const U = createFakeGattDongle().U;
  // Default plan subscribes ffea first (succeeds) then fff1 (hangs once) -> recover and retry only ffea.
  const { fake, t, logs } = await setup({ hangStartNotificationsOnce: [U.fff1] }, null, true);
  let lost = 0; t.onDisconnect = () => { lost++; };
  await t.connect();
  assert.deepEqual(ids(t.subscribed), ['ffea'], 'after fff1 hangs mid-sequence, the next attempt retries only the working characteristic');
  assert.equal(t.stats.recoveries, 1);
  assert.equal(fake.stats.connects, 2);
  assert.ok(fake.stats.disconnects >= 1);
  assert.equal(fake.stats.concurrentRejections, 0, 'must not issue ops into the poisoned link');
  assert.equal(lost, 0, 'our own disconnect during recovery must not look like link loss');
  assert.ok(logs.some(l => /HUNG/.test(l)));
  assert.ok(logs.some(l => /Attempt 2\/10: disconnect, wait/.test(l)) && logs.some(l => /Attempt 2\/10 OK/.test(l)));
  assert.ok(logs.some(l => /ffea first \(it subscribed before the hang\)/.test(l)));
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

test('auto: both notify characteristics are subscribed up front, so RX on ffea needs no init fallback', async () => {
  const U = createFakeGattDongle().U;
  const { fake, t, logs } = await setup({ respondOn: U.ffea, mock: { latency: 2 } });
  await t.connect();
  assert.deepEqual(ids(t.subscribed), ['ffea', 'fff1']);
  const s = new ElmSession(t, { timeout: 300 });
  const obd = new Obd(s, { log: (k, m) => logs.push(k + ': ' + m), initTimeouts: FASTINIT });
  const info = await obd.init('0');
  assert.equal(info.adapterOk, true); assert.equal(info.ecuOk, true);
  assert.equal(shortUuid(t.activeNotifyUuid), 'ffea');
  assert.ok(!logs.some(l => /subscribed reserve notify characteristic/.test(l)), 'no wasted fallback; both already subscribed');
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

test('v1.4: fff1 startNotifications always hangs, ffea works -> first attempt subscribes ffea then hangs on fff1, reconnect retries ffea only', async () => {
  const U = createFakeGattDongle().U;
  const { fake, t, logs } = await setup({ hangStartNotificationsAlways: [U.fff1], respondOn: U.ffea, mock: { latency: 2 } }, FASTPLAN);
  await t.connect();
  assert.equal(t.stats.recoveries, 1);
  assert.deepEqual(ids(t.subscribed), ['ffea']);
  const iOk = logs.findIndex(l => /startNotifications ffea .* OK/.test(l));
  const iHang = logs.findIndex(l => /startNotifications fff1 .*HUNG/.test(l));
  assert.ok(iOk >= 0 && iHang > iOk, 'ffea subscribed first, then fff1 hung');
  assert.ok(logs.some(l => /ffea first \(it subscribed before the hang\)/.test(l)));
  assert.ok(logs.some(l => /possible pairing prompt - check phone/.test(l)));
  const s = new ElmSession(t, { timeout: 400 });
  const obd = new Obd(s, { log: (k, m) => logs.push(k + ': ' + m), initTimeouts: FASTINIT });
  const info = await obd.init('0');
  assert.equal(info.ecuOk, true);
  assert.equal(shortUuid(t.activeNotifyUuid), 'ffea');
  assert.equal(fake.stats.concurrentRejections, 0);
});

test('v1.5: notify only works after a first write -> the write-first variant (attempt 6) wins (listener, ATZ write, then startNotifications)', async () => {
  const onStatus = [];
  const { fake, t, logs } = await setup({ notifyOnlyAfterWrite: true, mock: { latency: 2 } }, Object.assign({ onStatus: (m) => onStatus.push(m) }, FASTPLAN));
  await t.connect();
  assert.equal(t.stats.recoveries, 5, 'five failed attempts, the sixth variant is write-first');
  assert.ok(ids(t.subscribed).includes('ffea') || ids(t.subscribed).includes('fff1'));
  assert.ok(logs.some(l => /Write-first: listeners attached; writing ATZ before startNotifications/.test(l)));
  const iW = logs.findIndex(l => /write-first ATZ/.test(l));
  const iS = logs.findIndex((l, i) => i > iW && /startNotifications ffea .* OK/.test(l));
  assert.ok(iW >= 0 && iS > iW, 'write happens before the successful startNotifications');
  assert.equal(fake.stats.concurrentRejections, 0);
  assert.ok(onStatus.some(m => /possible pairing prompt - check phone/.test(m)), 'UI status mentions pairing prompt');
  const s = new ElmSession(t, { timeout: 400 });
  const obd = new Obd(s, { log: (k, m) => logs.push(k + ': ' + m), initTimeouts: FASTINIT });
  const info = await obd.init('0');
  assert.equal(info.ecuOk, true);
});

test('v1.5: every startNotifications hangs -> maxAttempts reconnects, then a fatal error with troubleshooting advice', async () => {
  const { fake, t } = await setup({ hangAllStartNotifications: true }, Object.assign({ maxAttempts: 4 }, FASTPLAN));
  await assert.rejects(t.connect(), (e) => e.fatal === true && /after 4 attempts/.test(e.message) && /force-stop other OBD apps/.test(e.message) && /unpair "OBDII"/.test(e.message) && /Forget and re-pick/.test(e.message));
  assert.equal(t.stats.recoveries, 3);
  assert.equal(fake.stats.concurrentRejections, 0);
});

const DIAG_VARIANT = [{ id: 'ffea-diag-test', order: 'ffea', settle: 0, diag: true, direct: false, writeFirst: false }];
test('v1.3: diagnostics (when the variant enables them) log full properties, descriptors (CCCD), blocklisted getDescriptor and the no-read-property note', async () => {
  const { t, logs } = await setup({}, { variantTable: DIAG_VARIANT });
  await t.connect();
  const j = logs.join('\n');
  assert.match(j, /props ffea: broadcast=\S+ read=false writeWithoutResponse=false write=false notify=true indicate=false/);
  assert.match(j, /descriptors on ffea: 00002902-0000-1000-8000-00805f9b34fb -> CCCD 2902 present/);
  assert.match(j, /getDescriptor\(0x2902\) on ffea: SecurityError .*blocklist/);
  assert.match(j, /ffea has no read property; skipping readValue/);
});

test('v1.3: forget() forgets the device', async () => {
  const { fake, t } = await setup({});
  let forgot = 0; fake.device.forget = async () => { forgot++; };
  assert.equal(await t.forget(), 1);
  assert.equal(forgot, 1);
});

test('v1.4: fff1 hangs only when it is first; default ffea-then-fff1 plan subscribes both on the first try', async () => {
  const U = createFakeGattDongle().U;
  const { fake, t, logs } = await setup({ hangStartNotificationsIfFirst: [U.fff1], mock: { latency: 2 } });
  await t.connect();
  assert.equal(t.stats.recoveries, 0);
  assert.deepEqual(ids(t.subscribed), ['ffea', 'fff1']);
  assert.ok(logs.some(l => /Attempt 1\/10 variant "ffea-s400-nodiag-enum"/.test(l)));
  const s = new ElmSession(t, { timeout: 400 });
  const obd = new Obd(s, { initTimeouts: FASTINIT });
  const info = await obd.init('0');
  assert.equal(info.ecuOk, true);
  assert.equal(shortUuid(t.activeNotifyUuid), 'fff1');
  assert.equal(fake.stats.concurrentRejections, 0);
});

test('v1.4: already-connected GATT is dropped and we wait before a clean setup', async () => {
  const { fake, t, logs } = await setup({});
  await t.connect();
  // Leave the fake "connected" and call setup again via connect() recovery path by invoking _setup.
  // connect() short-circuits if already set up; call _setup inside _exclusive by connecting after forcing gatt.connected.
  assert.equal(fake.device.gatt.connected, true);
  t._goodSubscribeOrder = null; // allow the clean-setup path to run with the default plan
  await t._exclusive(async () => { await t._setup(t._planFor(0)); });
  assert.ok(logs.some(l => /GATT already connected; disconnecting and waiting/.test(l)));
  assert.deepEqual(ids(t.subscribed), ['ffea', 'fff1']);
  assert.equal(fake.stats.concurrentRejections, 0);
});

// ---------------- v1.5: persistent connect (the first GATT op after discovery hangs intermittently) ----------------
const memStore = () => { const m = {}; return { get: (k) => (k in m ? m[k] : null), set: (k, v) => { m[k] = v; }, m }; };
const RETRYBLE = { notifyTimeout: 40, writeTimeout: 60, opTimeout: 40, reconnectWait: 5, subscribeRetryDelay: 5, diagnostics: true };

test('v1.5: default variant table varies settle, order, discovery and diagnostics', () => {
  const t = new BleTransport({});
  const plans = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => t._planFor(n));
  assert.deepEqual(plans.slice(0, 3).map(p => p.settle), [400, 1500, 3000]);
  assert.ok(new Set(plans.map(p => p.variant.order)).size === 2, 'alternates ffea / fff1 first');
  assert.ok(plans.some(p => p.direct) && plans.some(p => !p.direct), 'direct getPrimaryService and enumeration both used');
  assert.ok(plans.some(p => p.diag) && plans.some(p => !p.diag), 'diagnostics on and off both used');
  assert.ok(plans.some(p => p.writeFirst));
  assert.ok(plans.every(p => p.timeout === 4000), 'hang timeout is ~4s');
  assert.equal(new Set(plans.map(p => p.variant.id)).size, 10, 'all ten variants are distinct');
  assert.equal(t._waitFor(1), 1000); assert.equal(t._waitFor(2), 1500); assert.equal(t._waitFor(3), 2000); assert.equal(t._waitFor(9), 3000);
});

test('v1.5: first 3 connections wedge on the first post-discovery op -> attempt 4 succeeds, never gives up at 3, no concurrent ops', async () => {
  const statuses = [];
  const { fake, t, logs } = await setup({ wedgeFirstConnects: 3, mock: { latency: 2 } }, Object.assign({ onStatus: (m) => statuses.push(m), variantStore: memStore() }, RETRYBLE));
  await t.connect();
  assert.equal(fake.stats.connects, 4);
  assert.equal(t.stats.recoveries, 3);
  assert.equal(fake.stats.wedgedHangs, 3);
  assert.equal(fake.stats.concurrentRejections, 0);
  assert.ok(ids(t.subscribed).length >= 1);
  for (let n = 1; n <= 4; n++) assert.ok(logs.some(l => new RegExp('Attempt ' + n + '/10 variant "').test(l)), 'attempt ' + n + ' logged with its variant');
  for (let n = 1; n <= 3; n++) assert.ok(logs.some(l => new RegExp('Attempt ' + n + '/10 FAILED').test(l)));
  assert.ok(logs.some(l => /Attempt 4\/10 OK/.test(l)));
  assert.ok(statuses.some(m => /attempt 4\/10/.test(m)), 'visible attempt counter: ' + statuses.join(' | '));
  assert.ok(logs.some(l => /Attempt 2\/10: disconnect, wait/.test(l)));
  const s = new ElmSession(t, { timeout: 400 });
  const obd = new Obd(s, { initTimeouts: FASTINIT });
  const info = await obd.init('0');
  assert.equal(info.ecuOk, true);
});

test('v1.5: random wedging (seeded, p=0.5) -> connects within the attempt budget for many seeds', async () => {
  let failures = 0, totalConnects = 0;
  for (let seed = 1; seed <= 15; seed++) {
    const { fake, t } = await setup({ wedgeProbability: 0.5, seed, mock: { latency: 1 } }, Object.assign({ postConnectDelay: 0, maxAttempts: 12 }, RETRYBLE, { diagnostics: false }));
    try { await t.connect(); totalConnects += fake.stats.connects; assert.equal(fake.stats.concurrentRejections, 0); }
    catch (e) { failures++; }
  }
  assert.equal(failures, 0, 'every seed connected within 12 attempts');
  assert.ok(totalConnects > 15, 'some seeds needed retries (' + totalConnects + ' connects for 15 seeds)');
});

test('v1.5: gives up only after maxAttempts (fatal, with advice), link marked dead', async () => {
  const { fake, t, logs } = await setup({ wedgeFn: () => true }, Object.assign({ maxAttempts: 5, postConnectDelay: 0 }, RETRYBLE));
  await assert.rejects(t.connect(), (e) => e.fatal === true && /after 5 attempts/.test(e.message) && /force-stop other OBD apps/.test(e.message));
  assert.equal(fake.stats.connects, 5);
  assert.ok(logs.some(l => /Attempt 5\/5 FAILED/.test(l)));
  assert.equal(t._dead, true);
});

test('v1.5: total time budget stops the retries early', async () => {
  const { fake, t, logs } = await setup({ wedgeFn: () => true }, Object.assign({ maxAttempts: 50, totalBudget: 150, postConnectDelay: 0 }, RETRYBLE));
  await assert.rejects(t.connect(), (e) => e.fatal === true);
  assert.ok(fake.stats.connects >= 2 && fake.stats.connects < 50, 'connects=' + fake.stats.connects);
  assert.ok(logs.some(l => /time budget/.test(l)));
});

test('v1.5: Cancel aborts a connect promptly, even in the middle of a hung op, and is not fatal', async () => {
  const { fake, t, logs } = await setup({ wedgeFn: () => true }, { notifyTimeout: 5000, opTimeout: 5000, reconnectWait: 5, postConnectDelay: 0, maxAttempts: 10 });
  const t0 = Date.now();
  const p = t.connect();
  setTimeout(() => t.cancel(), 120);
  await assert.rejects(p, (e) => e.cancelled === true && !e.fatal);
  assert.ok(Date.now() - t0 < 1500, 'cancelled promptly, took ' + (Date.now() - t0) + 'ms');
  assert.ok(fake.stats.connects <= 2);
  assert.equal(t._dead, false);
  assert.equal(fake.device.gatt.connected, false);
  assert.ok(logs.some(l => /Connect cancelled by user/.test(l)));
});

test('v1.5: the winning variant is remembered and tried first next time', async () => {
  const store = memStore();
  const a = await setup({ wedgeFirstConnects: 2, mock: { latency: 1 } }, Object.assign({ variantStore: store, postConnectDelay: 0 }, RETRYBLE));
  await a.t.connect();
  const winner = store.m['obd.bleVariant'];
  assert.ok(winner, 'winner saved');
  assert.equal(winner, new BleTransport({})._variantOrder()[2].id, 'third variant won (first two connections wedged)');
  const b = await setup({ mock: { latency: 1 } }, Object.assign({ variantStore: store, postConnectDelay: 0 }, RETRYBLE));
  assert.equal(b.t._planFor(0).variant.id, winner, 'stored winner is first in the order');
  await b.t.connect();
  assert.equal(b.t.stats.recoveries, 0);
  assert.ok(b.logs.some(l => new RegExp('remembered winning variant "' + winner + '" is tried first').test(l)));
  assert.ok(b.logs.some(l => new RegExp('Attempt 1/10 variant "' + winner + '"').test(l)));
});

test('v1.5: direct discovery variant uses getPrimaryService(fff0); skipping diagnostics avoids a link-poisoning getDescriptors', async () => {
  const table = [
    { id: 'diag-on', order: 'ffea', settle: 0, diag: true, direct: false, writeFirst: false },
    { id: 'direct-diag-off', order: 'fff1', settle: 0, diag: false, direct: true, writeFirst: false }
  ];
  const { fake, t, logs } = await setup({ diagPoisons: true, mock: { latency: 1 } }, Object.assign({ variantTable: table, postConnectDelay: 0 }, RETRYBLE));
  await t.connect();
  assert.equal(t.stats.recoveries, 1);
  assert.equal(fake.stats.directDiscoveries, 1);
  assert.ok(logs.some(l => /getPrimaryService fff0 \(direct\) OK/.test(l)));
  assert.ok(logs.some(l => /skipping getDescriptors/.test(l)));
  assert.equal(t._winnerId, 'direct-diag-off');
});

test('v1.5: direct getPrimaryService falls back to enumeration when it fails', async () => {
  const table = [{ id: 'direct', order: 'ffea', settle: 0, diag: false, direct: true, writeFirst: false }];
  const { fake, t, logs } = await setup({ mock: { latency: 1 } }, Object.assign({ variantTable: table, postConnectDelay: 0 }, RETRYBLE));
  const origConnect = fake.device.gatt.connect;
  fake.device.gatt.connect = function () { return origConnect.call(this).then((srv) => Object.assign({}, srv, { getPrimaryService() { return Promise.reject(Object.assign(new Error('not found'), { name: 'NotFoundError' })); } })); };
  await t.connect();
  assert.ok(logs.some(l => /Direct getPrimaryService\(fff0\) failed/.test(l)));
  assert.ok(logs.some(l => /getPrimaryServices OK/.test(l)));
  assert.equal(t.stats.recoveries, 0);
});
