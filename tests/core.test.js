const test = require('node:test');
const assert = require('node:assert/strict');
const ELM = require('../js/elm.js');
const PIDS = require('../js/pids.js');
const DTC = require('../js/dtc.js');
const { MockTransport, ElmSession } = require('../js/transport.js');
const { Obd } = require('../js/obd.js');

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('parseResponse: spaced, unspaced, prompt, searching, echo', () => {
  assert.deepEqual(ELM.parseResponse('41 0C 1A F8 \r\r>'), [[0x41, 0x0C, 0x1A, 0xF8]]);
  assert.deepEqual(ELM.parseResponse('SEARCHING...\r410C1AF8\r'), [[0x41, 0x0C, 0x1A, 0xF8]]);
  assert.deepEqual(ELM.parseResponse('010C\r41 0C 0F A0\r\r', '010C'), [[0x41, 0x0C, 0x0F, 0xA0]]);
  assert.deepEqual(ELM.parseResponse('410D32\r410D33\r'), [[0x41, 0x0D, 0x32], [0x41, 0x0D, 0x33]]);
  assert.deepEqual(ELM.parseResponse('41\u00000D32'), [[0x41, 0x0D, 0x32]]);
});

test('detectError', () => {
  assert.equal(ELM.detectError('NO DATA\r\r'), 'NO DATA');
  assert.equal(ELM.detectError('SEARCHING...\rUNABLE TO CONNECT\r'), 'UNABLE TO CONNECT');
  assert.equal(ELM.detectError('?\r'), '?');
  assert.equal(ELM.detectError('CAN ERROR'), 'CAN ERROR');
  assert.equal(ELM.detectError('410C1AF8'), null);
  assert.equal(ELM.detectError(''), 'EMPTY');
  assert.deepEqual(ELM.parseResponse('NO DATA'), []);
});

test('multi-frame ISO-TP response (VIN)', () => {
  const raw = '014\r0: 49 02 01 4A 41 33\r1: 32 55 32 46 55 39 44\r2: 55 30 31 30 34 37 36\r\r';
  const msgs = ELM.parseResponse(raw);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].length, 0x14);
  assert.equal(ELM.parseVin(raw), 'JA32U2FU9DU010476');
  assert.equal(ELM.parseVin('014\r0:4902014A4133\r1:3255324655394\r'), null); // truncated
});

test('legacy multi-line VIN', () => {
  const raw = ['49 02 01 00 00 00 31', '49 02 02 47 31 4A 43', '49 02 03 35 34 34 34', '49 02 04 52 37 32 35', '49 02 05 32 33 36 37'].join('\r');
  assert.equal(ELM.parseVin(raw), '1G1JC5444R7252367');
});

test('parsePidResponse single, multi-PID, multi-ECU, freeze frame', () => {
  assert.deepEqual(ELM.parsePidResponse('410C1AF8', 1, PIDS.length), { '0C': [0x1A, 0xF8] });
  const multi = '00A\r0:410C1AF80D32\r1:057B11400000\r';
  assert.deepEqual(ELM.parsePidResponse(multi, 1, PIDS.length), { '0C': [0x1A, 0xF8], '0D': [0x32], '05': [0x7B], '11': [0x40] });
  assert.deepEqual(ELM.parsePidResponse('410D32\r410D00', 1, PIDS.length), { '0D': [0x32] });
  assert.deepEqual(ELM.parsePidResponse('42 0C 00 1A F8', 2, PIDS.length), { '0C': [0x1A, 0xF8] });
  assert.deepEqual(ELM.parsePidResponse('420200 0133', 2, PIDS.length), { '02': [0x01, 0x33] });
});

test('decodeSupported', () => {
  // BE 1F A8 13 -> 01,03,04,05,06,07,0C,0D,0E,0F,10,11,13,15,1C,1F,20
  const p = ELM.decodeSupported([0xBE, 0x1F, 0xA8, 0x13], 0).map(n => ELM.toHex(n));
  assert.deepEqual(p, ['01', '03', '04', '05', '06', '07', '0C', '0D', '0E', '0F', '10', '11', '13', '15', '1C', '1F', '20']);
});

test('PID formulas', () => {
  near(PIDS.decode('0C', [0x1A, 0xF8]), 1726);
  near(PIDS.decode('0D', [0x32]), 50);
  near(PIDS.decode('05', [0x7B]), 83);
  near(PIDS.decode('04', [0xFF]), 100);
  near(PIDS.decode('06', [0x80]), 0);
  near(PIDS.decode('07', [0x90]), 12.5);
  near(PIDS.decode('06', [0x70]), -12.5);
  near(PIDS.decode('0E', [0x94]), 10);
  near(PIDS.decode('10', [0x01, 0x2C]), 3);
  near(PIDS.decode('14', [0x5A, 0x80]), 0.45);
  near(PIDS.decode('3C', [0x12, 0x34]), 426);
  near(PIDS.decode('42', [0x37, 0x14]), 14.1);
  near(PIDS.decode('5C', [0x82]), 90);
  near(PIDS.decode('1F', [0x01, 0x00]), 256);
  near(PIDS.decode('44', [0x80, 0x00]), 1);
  near(PIDS.decode('5E', [0x00, 0x64]), 5);
  assert.equal(PIDS.decode('0C', [0x1A]), null);
  assert.equal(PIDS.decode('ZZ', [1]), null);
});

test('unit conversion', () => {
  near(PIDS.toDisplay('05', 90, 'imperial').value, 194);
  assert.equal(PIDS.toDisplay('05', 90, 'imperial').unit, '°F');
  near(PIDS.toDisplay('0D', 100, 'imperial').value, 62.137);
  near(PIDS.toDisplay('0B', 100, 'imperial').value, 14.5038);
  assert.equal(PIDS.toDisplay('0C', 800, 'imperial').unit, 'rpm');
  assert.equal(PIDS.toDisplay('05', 90, 'metric').value, 90);
});

test('every PID def is well formed', () => {
  const seen = new Set();
  for (const d of PIDS.DEFS) {
    assert.match(d.pid, /^[0-9A-F]{2}$/);
    assert.ok(!seen.has(d.pid), 'dup ' + d.pid); seen.add(d.pid);
    assert.ok(d.bytes >= 1 && d.bytes <= 4);
    assert.ok(PIDS.CATEGORIES.includes(d.cat), d.cat);
    assert.equal(typeof PIDS.decode(d.pid, [0x80, 0x80, 0x80, 0x80]), 'number');
  }
  for (const p of PIDS.PRESETS) for (const id of p.pids) assert.ok(PIDS.get(id), 'preset pid ' + id);
});

test('DTC decoding', () => {
  assert.equal(DTC.decodeDtc(0x01, 0x33), 'P0133');
  assert.equal(DTC.decodeDtc(0x44, 0x20), 'C0420');
  assert.equal(DTC.decodeDtc(0x81, 0x23), 'B0123');
  assert.equal(DTC.decodeDtc(0xC1, 0x00), 'U0100');
  assert.equal(DTC.decodeDtc(0x11, 0xAB), 'P11AB');
  assert.equal(DTC.decodeDtc(0, 0), null);
  // CAN with count byte
  assert.deepEqual(DTC.parseDtcResponse('43 02 01 33 04 42', 3), ['P0133', 'P0442']);
  assert.deepEqual(DTC.parseDtcResponse('4300', 3), []);
  // multi-frame CAN
  assert.deepEqual(DTC.parseDtcResponse('00A\r0:43040133044201\r1:71030000000000', 3), ['P0133', 'P0442', 'P0171', 'P0300']);
  // legacy (no count byte, padded)
  assert.deepEqual(DTC.parseDtcResponse('43 01 33 04 42 00 00', 3), ['P0133', 'P0442']);
  assert.deepEqual(DTC.parseDtcResponse('47 01 01 71', 7), ['P0171']);
  assert.deepEqual(DTC.parseDtcResponse('4A 01 01 33', 0x0A), ['P0133']);
  assert.deepEqual(DTC.parseDtcResponse('NO DATA', 3), []);
  assert.equal(DTC.describe('P0420'), 'Catalyst efficiency below threshold (Bank 1)');
  assert.equal(DTC.describe('P1234'), 'Manufacturer-specific code');
  assert.deepEqual(DTC.parseMonitorStatus([0x82, 0x07, 0x65, 0x00]), { mil: true, count: 2, compressionIgnition: false });
});

test('ElmSession serializes commands and handles chunked responses + timeouts', async () => {
  const sent = [];
  const t = { write: async (s) => { sent.push(s); const c = s.trim();
    if (c === 'SLOW') return; // never answers
    setTimeout(() => { t.onData(c === 'A' ? '41 0C' : 'OK'); }, 5);
    setTimeout(() => { t.onData(c === 'A' ? ' 1A F8\r\r>' : '\r>'); }, 10); } };
  const s = new ElmSession(t, { timeout: 200 });
  const [a, b] = await Promise.all([s.send('A'), s.send('B')]);
  assert.equal(a.trim(), '41 0C 1A F8');
  assert.equal(b.trim(), 'OK');
  assert.deepEqual(sent, ['A\r', 'B\r']);
  await assert.rejects(s.send('SLOW', 50), /TIMEOUT/);
  assert.equal((await s.send('B')).trim(), 'OK');
});

test('end-to-end against mock dongle', async () => {
  const mock = new MockTransport({ latency: 1, vin: 'JA32U2FU9DU010476' });
  await mock.connect();
  const s = new ElmSession(mock);
  const obd = new Obd(s);
  const info = await obd.init('0');
  assert.equal(info.ecuOk, true);
  assert.equal(info.protocolNum, '6');
  assert.equal(obd.isCan, true);
  const sup = await obd.readSupported();
  assert.ok(sup.includes('0C') && sup.includes('5C') && sup.includes('42'));
  assert.equal(await obd.readVin(), 'JA32U2FU9DU010476');
  const d = await obd.readDtcs();
  assert.deepEqual(d.stored.codes, ['P0133', 'P0442']);
  assert.deepEqual(d.pending.codes, ['P0171']);
  assert.deepEqual(d.permanent.codes, ['P0133']);
  const mon = await obd.readMonitor();
  assert.equal(mon.mil, true);
  const v = await obd.queryPids(['0C', '0D', '05', '04', '42', '11', '5C', '06']);
  for (const p of ['0C', '0D', '05', '04', '42', '11', '5C', '06']) assert.equal(typeof v[p], 'number', p);
  assert.ok(obd.multiPid, 'multi-pid should stay enabled with mock');
  const ff = await obd.readFreezeFrame();
  assert.equal(ff.dtc, 'P0133');
  assert.ok(Object.keys(ff.values).length > 5);
  assert.equal(await obd.clearDtcs(), true);
  assert.deepEqual((await obd.readDtcs()).stored.codes, []);
});

test('multi-PID fallback when adapter cannot do it', async () => {
  const mock = new MockTransport({ latency: 1 });
  const orig = mock._respond.bind(mock);
  mock._respond = (c) => (c.startsWith('01') && c.length > 5 && !c.startsWith('0100')) ? 'NO DATA' : orig(c);
  const s = new ElmSession(mock);
  const obd = new Obd(s);
  await obd.init('6');
  const v = await obd.queryPids(['0C', '0D', '05']);
  assert.equal(obd.multiPid, false);
  assert.equal(typeof v['0C'], 'number');
  assert.equal(typeof v['05'], 'number');
});

const { BleTransport, withTimeout, createFakeGattDongle, shortUuid } = require('../js/transport.js');

const FAST = { wake: 80, atz: 120, atws: 80, atd: 80, ati: 80, at: 80, pid: 200 };

test('withTimeout resolves and rejects', async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50, 'x'), 7);
  const t0 = Date.now();
  await assert.rejects(withTimeout(new Promise(() => {}), 40, 'hang'), /hang timed out after 40ms/);
  assert.ok(Date.now() - t0 < 200);
});

test('BleTransport subscribes to fff1 and ffea; startNotifications hang on fff1 does not block; RX on ffea; writeWithResponse fallback', async () => {
  const logs = [];
  const fake = createFakeGattDongle({
    respondOn: '0000ffea-0000-1000-8000-00805f9b34fb',
    dropWithoutResponse: true,
    startNotificationsHangOn: ['0000fff1-0000-1000-8000-00805f9b34fb'],
    mock: { latency: 5, vin: 'JA32U2FU9DU010476' }
  });
  const t = new BleTransport({
    log: (k, m) => logs.push(k + ': ' + m),
    notifyTimeout: 80,
    postSubscribeDelay: 0,
    writeTimeout: 400,
    writeMode: 'auto'
  });
  t.device = fake.device;
  t.name = fake.device.name;
  const t0 = Date.now();
  await t.connect();
  assert.ok(Date.now() - t0 < 800, 'connect must not wait on a hung startNotifications forever');
  const ntf = t.subscribed.map(c => shortUuid(c.uuid));
  assert.ok(ntf.includes('ffea'), 'subscribed to ffea: ' + ntf);
  assert.ok(!ntf.includes('fff1'), 'hung fff1 must not be marked subscribed: ' + ntf);
  assert.equal(t.useWithoutResponse, true, 'auto starts with writeWithoutResponse');

  const s = new ElmSession(t, { timeout: 400, writeProbeMs: 80, writeTimeout: 400 });
  const obd = new Obd(s, { initTimeouts: FAST });
  const info = await obd.init('0');
  assert.equal(info.adapterOk, true);
  assert.equal(info.ecuOk, true);
  assert.ok(/ELM/.test(info.elm), info.elm);
  assert.equal(shortUuid(t.activeNotifyUuid), 'ffea');
  assert.equal(t.useWithoutResponse, false, 'should have fallen back to writeWithResponse');
  assert.equal(await obd.readVin(), 'JA32U2FU9DU010476');
  const joined = logs.join('\n');
  assert.ok(logs.some(l => l.indexOf('startNotifications') >= 0 && l.indexOf('ffea') >= 0), 'logged startNotifications for ffea');
  assert.ok(logs.some(l => /startNotifications fff1 FAILED|startNotifications notify/.test(l) && /fff1/.test(joined)));
  assert.ok(logs.some(l => l.startsWith('tx: writeWithoutResponse') || l.indexOf('writeWithoutResponse') >= 0));
  assert.ok(logs.some(l => /First RX on 0000ffea/.test(l)));
  assert.ok(logs.some(l => /notify ffea \d+ bytes: /.test(l)));
  assert.ok(logs.some(l => /Switching write mode to writeWithResponse/.test(l)));
});

test('BleTransport connect returns after notify timeout when every characteristic hangs', async () => {
  const fake = createFakeGattDongle({
    startNotificationsHangOn: [
      '0000ffea-0000-1000-8000-00805f9b34fb',
      '0000fff1-0000-1000-8000-00805f9b34fb'
    ],
    dropWithoutResponse: false
  });
  const t = new BleTransport({ notifyTimeout: 60, postSubscribeDelay: 0, log: () => {} });
  t.device = fake.device;
  const t0 = Date.now();
  await t.connect();
  assert.ok(Date.now() - t0 < 500);
  assert.equal(t.subscribed.length, 0);
});

test('with-response-only writes work without probing a missing without-response mode', async () => {
  const fake = createFakeGattDongle({
    respondOn: '0000ffea-0000-1000-8000-00805f9b34fb',
    withOnly: true,
    dropWithoutResponse: true,
    mock: { latency: 5 }
  });
  const t = new BleTransport({ notifyTimeout: 80, postSubscribeDelay: 0, writeTimeout: 400, log: () => {} });
  t.device = fake.device;
  await t.connect();
  assert.equal(t.useWithoutResponse, false);
  assert.equal(t.canToggleWrite(), false);
  const s = new ElmSession(t, { timeout: 400, writeProbeMs: 80 });
  const r = await s.send('ATI');
  assert.ok(/ELM327/.test(r), r);
  assert.equal(shortUuid(t.activeNotifyUuid), 'ffea');
});

test('init continues when ATZ is silent and identifies via ATI', async () => {
  const mock = new MockTransport({ latency: 1 });
  const orig = mock.write.bind(mock);
  mock.write = async function (str) {
    const cmd = str.replace(/[\r\n]/g, '').trim().toUpperCase();
    if (cmd === 'ATZ' || cmd === 'ATWS') return;
    return orig(str);
  };
  const s = new ElmSession(mock, { timeout: 200 });
  const obd = new Obd(s, { log: () => {}, initTimeouts: FAST });
  const info = await obd.init('0');
  assert.equal(info.adapterOk, true);
  assert.ok(/ELM/.test(info.elm), 'identified via ATI: ' + info.elm);
  assert.equal(info.ecuOk, true);
});

test('init reports adapterOk=false when the adapter never replies', async () => {
  const mock = new MockTransport({ latency: 1 });
  mock.write = async function () { /* silent */ };
  const s = new ElmSession(mock, { timeout: 80, writeProbeMs: 50 });
  const obd = new Obd(s, { log: () => {}, initTimeouts: { wake: 60, atz: 60, atws: 60, atd: 60, ati: 60, at: 60, pid: 60 } });
  const info = await obd.init('0');
  assert.equal(info.adapterOk, false);
  assert.equal(info.ecuOk, false);
});
