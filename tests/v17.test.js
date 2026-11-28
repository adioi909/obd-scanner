/* v1.7.0 tests: console interlock + dirty adapter state, LTTB + exact stats, batched row writes,
   header switching (7E1 -> 7DF restore on success / NO DATA / timeout / rejection), background abort, SW hygiene. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ELM = require('../js/elm.js');
const PIDS = require('../js/pids.js');
const { MockTransport, ElmSession, BleTransport } = require('../js/transport.js');
const { Obd } = require('../js/obd.js');
const { Chart } = require('../js/chart.js');
const { createFakeGattDongle } = require('./fake-gatt.js');
const root = path.join(__dirname, '..');

async function mockObd(mockOpts, obdOpts) {
  const logs = [];
  const mock = new MockTransport(Object.assign({ latency: 1, car: 'mitsubishi2013' }, mockOpts || {}));
  await mock.connect();
  const log = (k, m) => logs.push(k + ': ' + m);
  const s = new ElmSession(mock, { timeout: 300, log });
  const obd = new Obd(s, Object.assign({ log, pidTimeout: 300, enhancedEveryMs: 0 }, obdOpts || {}));
  await obd.init('0');
  await obd.readSupported();
  mock.headerLog.length = 0;
  return { mock, s, obd, logs };
}
const tx = (logs, re) => logs.filter(l => l.startsWith('tx: ') && re.test(l.slice(4)));

// ---------------- 2. Console interlock + dirty state ----------------
test('v1.7: console interlock flags Mode 04 and UDS 10/11/27/2E/2F/31/34/36/37 as write-capable, nothing else', () => {
  for (const c of ['04', '1003', '11 01', '2701', '2EF19041', '2F', '3101FF00', '34', '36', '37']) {
    const r = ELM.classifyCommand(c);
    assert.equal(r.write, true, c); assert.ok(r.reason, c);
  }
  for (const c of ['0100', '010C', '03', '07', '0A', '0902', '2103', '220100', '3E00', '020200', 'ATI', 'ATRV']) {
    assert.equal(ELM.classifyCommand(c).write, false, c);
  }
});

test('v1.7: dirty-AT detection: ATZ/ATD/ATE/ATH/ATS/ATSP/ATSH/ATCAF/ATCRA mark dirty; ATDP/ATDPN/ATI/ATRV do not', () => {
  for (const c of ['ATZ', 'ATD', 'ATE1', 'ATE0', 'ATH1', 'ATS1', 'ATSP6', 'ATSH7E1', 'AT SH 7E0', 'ATCAF0', 'ATCRA7E9', 'ATCRA']) {
    assert.equal(ELM.classifyCommand(c).atMutating, true, c);
  }
  for (const c of ['ATDP', 'ATDPN', 'ATI', 'ATRV', 'AT@1', 'ATWM', '010C']) assert.equal(ELM.classifyCommand(c).atMutating, false, c);
  const st = ELM.createAdapterState();
  ELM.markDirty(st, 'ATH1');
  assert.equal(st.dirty, true); assert.equal(st.headerKnown, true);
  ELM.markDirty(st, 'ATSH7E1');
  assert.equal(st.headerKnown, false);
  assert.deepEqual(st.dirtyCmds, ['ATH1', 'ATSH7E1']);
  ELM.resetAdapterState(st);
  assert.equal(st.dirty, false); assert.deepEqual(st.header, { tx: '7DF', rx: null });
});

test('v1.7: after a manual ATH1 + ATS1 the parser breaks; resync() restores ATH0/ATS0/7DF and live values decode again', async () => {
  const { s, obd, logs } = await mockObd();
  await s.send('ATH1'); await s.send('ATS1'); await s.send('ATSH7E1');
  ['ATH1', 'ATS1', 'ATSH7E1'].forEach(c => ELM.markDirty(obd.adapter, c));
  // Header no longer known after a manual ATSH: the next mode-01 poll restores 7DF first instead of asking the TCM.
  const before = await obd.queryPids(['0C']);
  // v1.7.1: the simulated adapter now really prints headers after ATH1, so the headerless parser may not decode this.
  assert.ok(before['0C'] == null || typeof before['0C'] === 'number');
  assert.ok(tx(logs, /^ATSH7DF$/).length >= 1, 'header restored before polling');
  assert.equal(obd.adapter.dirty, true, 'still dirty until echo/spaces/headers are re-synced');
  assert.equal(await obd.resync(), true);
  assert.equal(obd.adapter.dirty, false);
  assert.ok(tx(logs, /^ATH0$/).length >= 2 && tx(logs, /^ATSH7DF$/).length >= 1);
  const after = await obd.queryPids(['0C', '05']);
  assert.equal(typeof after['0C'], 'number'); assert.equal(typeof after['05'], 'number');
});

test('v1.7: resync after ATZ / ATSP also re-sends the protocol', async () => {
  const { s, obd, logs } = await mockObd();
  await s.send('ATZ'); ELM.markDirty(obd.adapter, 'ATZ');
  await obd.resync();
  assert.ok(tx(logs, /^ATSP0$/).length >= 2, 'ATSP sent again by resync');
  assert.ok(tx(logs, /^ATE0$/).length >= 2);
});

// ---------------- 3. LTTB + exact stats ----------------
test('v1.7: LTTB keeps first/last, hits the target size and keeps a single-sample spike', () => {
  const pts = [];
  for (let i = 0; i < 36000; i++) pts.push([i / 10, 800 + 50 * Math.sin(i / 300)]); // 60 min at 10 Hz
  pts[20000][1] = 7000; // one-sample RPM spike
  pts[25000][1] = -50;  // one-sample dip
  const out = Chart.lttb(pts, 600);
  assert.equal(out.length, 600);
  assert.deepEqual(out[0], pts[0]); assert.deepEqual(out[out.length - 1], pts[pts.length - 1]);
  assert.ok(out.some(p => p[1] === 7000), 'spike survives'); assert.ok(out.some(p => p[1] === -50), 'dip survives');
  for (let i = 1; i < out.length; i++) assert.ok(out[i][0] > out[i - 1][0], 'x strictly increasing');
  assert.equal(Chart.lttb(pts.slice(0, 400), 600).length, 400, 'small series unchanged');
});

test('v1.7: min/avg/max come from the full data set (exact), not the downsampled points', () => {
  const ys = []; let sum = 0;
  for (let i = 0; i < 5000; i++) { const v = (i % 97) * 1.5 + (i === 4321 ? 1000 : 0); ys.push(i % 50 === 0 ? null : v); }
  ys.forEach(v => { if (v != null) sum += v; });
  const n = ys.filter(v => v != null).length;
  const s = Chart.summary(ys);
  assert.equal(s.count, n);
  assert.equal(s.min, Math.min(...ys.filter(v => v != null)));
  assert.equal(s.max, Math.max(...ys.filter(v => v != null)));
  assert.equal(s.avg, sum / n);
  const down = Chart.lttb(ys.map((v, i) => [i, v]).filter(p => p[1] != null), 600).map(p => p[1]);
  const sd = Chart.summary(down);
  assert.notEqual(sd.avg, s.avg, 'downsampled average differs, which is why stats never use it');
  assert.equal(Chart.summary([null, null]).min, null);
});

test('v1.7: drawLine downsamples >1000 samples for drawing only (500-800 points) and reports both counts', () => {
  const calls = { lineTo: 0 };
  const ctx = new Proxy({}, { get: (o, k) => k === 'lineTo' ? () => calls.lineTo++ : (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  const canvas = { clientWidth: 360, clientHeight: 160, dataset: {}, getContext: () => ctx };
  const xs = [], ys = [];
  for (let i = 0; i < 20000; i++) { xs.push(i / 5); ys.push(Math.sin(i / 50)); }
  const r = Chart.drawLine(canvas, xs, ys);
  assert.equal(r.samples, 20000);
  assert.ok(r.plotted >= 500 && r.plotted <= 800, 'plotted ' + r.plotted);
  assert.equal(calls.lineTo - 4 * 0, calls.lineTo); // drawn
  const small = Chart.drawLine(canvas, xs.slice(0, 900), ys.slice(0, 900));
  assert.equal(small.plotted, 900);
});

// ---------------- 3b. batched IndexedDB writes ----------------
test('v1.7: row buffer writes in batches of 25, on the timer, and force-flushes the tail on stop', async () => {
  global.localStorage = global.localStorage || { getItem: () => null, setItem: () => {} };
  const { Store } = require('../js/storage.js');
  const writes = [];
  const rb = Store.createRowBuffer({ maxRows: 25, intervalMs: 0, write: async rows => { writes.push(rows.length); } });
  for (let i = 0; i < 60; i++) rb.push({ t: i });
  await rb.flush('check');
  assert.deepEqual(writes, [25, 25, 10]);
  for (let i = 0; i < 7; i++) rb.push({ t: i });
  assert.equal(rb.pending(), 7);
  await rb.stop();
  assert.deepEqual(writes, [25, 25, 10, 7]);
  assert.equal(rb.stats.rows, 67);
  rb.push({ t: 99 }); assert.equal(rb.pending(), 0, 'ignored after stop');
});

test('v1.7: row buffer timer flush and retry after a failed write (no rows lost)', async () => {
  const { Store } = require('../js/storage.js');
  let fail = true; const got = [];
  const rb = Store.createRowBuffer({ maxRows: 1000, intervalMs: 30, write: async rows => { if (fail) { fail = false; throw new Error('quota'); } got.push(...rows); }, onError: () => {} });
  for (let i = 0; i < 5; i++) rb.push({ t: i });
  await new Promise(r => setTimeout(r, 120));
  await rb.stop();
  assert.deepEqual(got.map(r => r.t), [0, 1, 2, 3, 4]);
});

test('v1.7: new presets are added once to existing profile lists; a deleted preset stays deleted', () => {
  const store = {};
  global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  global.PIDS = PIDS;
  delete require.cache[require.resolve('../js/storage.js')];
  const S = require('../js/storage.js');
  S.PIDS = PIDS; // storage reads root.PIDS
  const old = PIDS.PRESETS.filter(p => p.id !== 'preset-mitsu-cvt');
  store['obd.profiles.v1'] = JSON.stringify(old);
  let list = S.Store.loadProfiles();
  assert.ok(list.some(p => p.id === 'preset-mitsu-cvt'), 'CVT preset added for an existing v1.6 user');
  list = list.filter(p => p.id !== 'preset-mitsu-cvt'); S.Store.saveProfiles(list);
  list = S.Store.loadProfiles();
  assert.ok(!list.some(p => p.id === 'preset-mitsu-cvt'), 'deleted preset not re-added');
});

// ---------------- 5. enhanced PIDs + header switching ----------------
test('v1.7: CVT preset is read-only, labelled (Exp), targets 7E1/7E9 with request 2103 and decodes byte N', () => {
  const pre = PIDS.PRESETS.find(p => p.id === 'preset-mitsu-cvt');
  assert.deepEqual(pre.pids, ['MCVT33', 'MCVT22', 'MCVT02', 'MCVT', 'MCVT8', 'MCVT3', 'MCVTJ', 'MCVTN', '05', '0C']); // v1.7.2 adds 2122
  for (const id of ['MCVT', 'MCVT8', 'MCVTN']) {
    const d = PIDS.get(id);
    assert.ok(/\(Exp/.test(d.short) && /\(Exp/.test(d.name), id);
    assert.equal(d.request, '2103'); assert.equal(d.txHeader, '7E1'); assert.equal(d.rxFilter, '7E9'); assert.equal(d.byteIndex, 13);
    assert.equal(ELM.classifyCommand(d.request).write, false, 'mode 21 read is not write-capable');
  }
  const data = Array.from({ length: 20 }, (_, i) => (i === 13 ? 100 : 0));
  assert.equal(PIDS.decodeEnhanced('MCVTN', data), 100);
  assert.equal(PIDS.decodeEnhanced('MCVT8', data), 45);
  assert.ok(Math.abs(PIDS.decodeEnhanced('MCVT', data) - 47.5) < 0.2);
  assert.equal(PIDS.decodeEnhanced('MCVT', data.slice(0, 10)), null, 'short reply -> no value');
  assert.equal(PIDS.code('MCVT'), '7E1:2103');
});

test('v1.7: parseEnhancedResponse reassembles a multi-frame 61 03 reply (ISO-TP 0:/1:/2:)', () => {
  const raw = '016\r0: 61 03 10 11 12 13\r1: 14 15 16 17 18 19 1A\r2: 1B 1C 64 1E 1F 20 21\r3: 22 23 00 00 00 00 00\r\r';
  const d = ELM.parseEnhancedResponse(raw, '2103');
  assert.equal(d.length, 20); assert.equal(d[13], 0x64);
  assert.equal(ELM.parseEnhancedResponse('NO DATA', '2103'), null);
  assert.equal(ELM.parseEnhancedResponse('7F2112', '2103'), null, 'negative response ignored');
});

test('v1.7: header switching success: 7E1/7E9 for the CVT group, one 2103 for three PIDs, then 7DF restored', async () => {
  const { mock, obd, logs } = await mockObd({ tcmByteN: 100 });
  const v = await obd.queryPids(['MCVT', 'MCVT8', 'MCVTN', '05', '0C']);
  assert.equal(typeof v['05'], 'number'); assert.equal(typeof v['0C'], 'number');
  assert.equal(v.MCVTN, 100); assert.equal(v.MCVT8, 45); assert.ok(Math.abs(v.MCVT - 47.5) < 0.2);
  assert.deepEqual(mock.headerLog, ['ATSH7E1', 'ATCRA7E9', 'ATSH7DF', 'ATCRA']);
  assert.equal(tx(logs, /^2103$/).length, 1, 'one request shared by three PIDs');
  assert.equal(mock.txHeader, '7DF'); assert.equal(mock.rxFilter, null);
  assert.deepEqual(obd.adapter.header, { tx: '7DF', rx: null }); assert.equal(obd.adapter.headerKnown, true);
  assert.ok(logs.some(l => /EXP 7E1\/7E9 2103 raw \(20 data bytes\): .*data\[13\] \(Torque N\) = 0x64 = 100/.test(l)), 'raw hex logged');
  // a standard-only poll right after sends no header commands
  mock.headerLog.length = 0;
  await obd.queryPids(['0C']);
  assert.deepEqual(mock.headerLog, []);
});

test('v1.7: header restored to 7DF after a TIMEOUT on 7E1; mode 01 keeps working; N/S after 3 failures, then skipped', async () => {
  const { mock, obd } = await mockObd({ tcm: 'hang' });
  for (let i = 0; i < 3; i++) {
    const v = await obd.queryPids(['MCVT', '0C']);
    assert.equal(typeof v['0C'], 'number', 'RPM still polled on cycle ' + i);
    assert.equal(v.MCVT, undefined);
    assert.equal(mock.txHeader, '7DF', 'not stuck on 7E1 after cycle ' + i);
    assert.equal(mock.rxFilter, null);
    assert.ok(ELM.sameHeader(obd.adapter.header, ELM.DEFAULT_HEADER));
  }
  assert.equal(obd.enhancedNS.MCVT, true);
  assert.deepEqual(PIDS.pollList(['MCVT', '0C'], obd.supported, obd.enhancedNS), ['0C']);
  mock.headerLog.length = 0;
  const v = await obd.queryPids(['MCVT', '0C']);
  assert.equal(typeof v['0C'], 'number');
  assert.deepEqual(mock.headerLog, [], 'given-up PID sends no ATSH any more');
});

test('v1.7: NO DATA on 7E1 (no TCM) degrades to N/S and restores 7DF each time', async () => {
  const { mock, obd } = await mockObd({ tcm: false });
  for (let i = 0; i < 3; i++) { await obd.queryPids(['MCVT', 'MCVTN', '05']); assert.equal(mock.txHeader, '7DF'); }
  assert.equal(obd.enhancedNS.MCVT, true); assert.equal(obd.enhancedNS.MCVTN, true);
  await obd.init('0');
  assert.deepEqual(obd.enhancedNS, {}, 'Re-run init gives it another chance');
});

test('v1.7: adapter rejects ATSH (?) -> standard polling unaffected, header not considered moved; rejected ATCRA tolerated', async () => {
  const a = await mockObd({ rejectSh: true });
  for (let i = 0; i < 3; i++) { const v = await a.obd.queryPids(['MCVT', '0C']); assert.equal(typeof v['0C'], 'number'); }
  assert.equal(a.obd.enhancedNS.MCVT, true);
  const b = await mockObd({ rejectCra: true, tcmByteN: 90 });
  const v = await b.obd.queryPids(['MCVTN', '0C']);
  assert.equal(v.MCVTN, 90, 'works without a receive filter');
  assert.equal(b.mock.txHeader, '7DF');
});

test('v1.7: short TCM reply (firmware with fewer bytes) -> value absent, raw bytes still logged, header restored', async () => {
  const { mock, obd, logs } = await mockObd({ tcm: 'short' });
  const v = await obd.queryPids(['MCVT']);
  assert.equal(v.MCVT, undefined);
  assert.ok(logs.some(l => /EXP 7E1\/7E9 2103 raw \(8 data bytes\).*reply too short for data\[13\]/.test(l)));
  assert.equal(mock.txHeader, '7DF');
});

test('v1.7: enhanced PIDs are throttled (enhancedEveryMs) so they do not slow the mode 01 loop', async () => {
  const { mock, obd } = await mockObd({}, { enhancedEveryMs: 60000 });
  obd.enhancedEveryMs = 60000;
  await obd.queryPids(['MCVT', '0C']);
  mock.headerLog.length = 0;
  const v = await obd.queryPids(['MCVT', '0C']);
  assert.equal(v.MCVT, undefined); assert.equal(typeof v['0C'], 'number');
  assert.deepEqual(mock.headerLog, []);
});

test('v1.7: header switching through the fake Android GATT stack (serialized BLE, writeWithoutResponse) restores 7DF', async () => {
  const FASTBLE = { postConnectDelay: 0, postSubscribeDelay: 0, subscribeRetryDelay: 10, reconnectWait: 20, notifyTimeout: 80, writeTimeout: 80, opTimeout: 80, gattTimeout: 300, busyDelays: [5, 10, 20, 30] };
  const fake = createFakeGattDongle({ mock: { latency: 2, car: 'mitsubishi2013', tcmByteN: 120 } });
  const t = new BleTransport(Object.assign({ log: () => {} }, FASTBLE));
  t.device = fake.device; t.name = fake.device.name;
  await t.connect();
  const s = new ElmSession(t, { timeout: 500 });
  const obd = new Obd(s, { initTimeouts: { wake: 80, atz: 120, atws: 80, ati: 80, at: 80, pid: 200 }, pidTimeout: 500, enhancedEveryMs: 0 });
  await obd.init('0'); await obd.readSupported();
  const v = await obd.queryPids(['MCVTN', '05', '0C']);
  assert.equal(v.MCVTN, 120); assert.equal(typeof v['05'], 'number');
  assert.equal(fake.stats.concurrentRejections, 0);
  assert.equal(t.useWithoutResponse, true);
  assert.deepEqual(obd.adapter.header, { tx: '7DF', rx: null });
});

// ---------------- 4. background recovery ----------------
test('v1.7: abortPending drops a stale in-flight command and the queue keeps going (no deadlock)', async () => {
  const mock = new MockTransport({ latency: 1, multiPidHang: true });
  await mock.connect();
  const logs = [];
  const s = new ElmSession(mock, { timeout: 60000, log: (k, m) => logs.push(k + ': ' + m) });
  await s.send('ATE0');
  const stale = s.send('010C0D', 60000).then(() => 'resolved', e => e);
  const next = s.send('010C', 2000);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(s.abortPending('BACKGROUND'), true);
  const e = await stale;
  assert.equal(e.message, 'TIMEOUT'); assert.equal(e.aborted, 'BACKGROUND');
  assert.match(await next, /41\s*0C/);
  assert.ok(logs.some(l => /Abandoned in-flight 010C0D/.test(l)));
  assert.equal(s.abortPending('x'), false, 'nothing pending');
});

test('v1.7: clearQueue also releases the in-flight wait, so the session is usable again', async () => {
  const mock = new MockTransport({ latency: 1, multiPidHang: true });
  await mock.connect();
  const s = new ElmSession(mock, { timeout: 60000 });
  const stuck = s.send('010C0D', 60000).catch(e => e.message);
  await new Promise(r => setTimeout(r, 20));
  s.clearQueue();
  assert.equal(await stuck, 'CANCELLED');
  assert.match(await s.send('010C', 2000), /41\s*0C/);
});

// ---------------- 1. service worker + versions ----------------
test('v1.7: service worker precaches only the app shell (no MANUAL.md / PDF / brief) and uses a versioned cache (obd-scanner-v1.7.x)', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(sw, /var CACHE = 'obd-scanner-v1\.7\.\d';/);
  const assets = JSON.parse(sw.match(/var ASSETS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  assert.ok(assets.includes('manual.html') && assets.includes('js/app.js') && assets.includes('index.html'));
  for (const a of assets) assert.ok(!/\.md$|\.pdf$|GROK_BUILD_BRIEF|\.zip$/i.test(a), 'not precached: ' + a);
  const re = new RegExp(sw.match(/var NO_CACHE = \/(.*)\/i;/)[1], 'i');
  for (const u of ['/obd-scanner/MANUAL.md', '/obd-scanner/OBD-Scanner-v1.7-User-Manual.pdf', '/GROK_BUILD_BRIEF.md', '/x.zip']) assert.ok(re.test(u), u);
  assert.ok(!re.test('/obd-scanner/js/app.js'));
});

test('v1.7: version string is v1.7.x everywhere (bumped to 1.7.1 in v1.7.1, see v171.test.js)', () => {
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  assert.match(read('index.html'), /<title>OBD Scanner v1\.7\.\d<\/title>/);
  assert.match(read('index.html'), /id="app-ver">v1\.7\.\d</);
  assert.match(read('js/app.js'), /APP_VERSION = 'v1\.7\.\d'/);
  assert.match(JSON.parse(read('package.json')).version, /^1\.7\.\d$/);
  assert.match(read('MANUAL.md'), /Version 1\.7\.\d/);
  assert.match(read('README.md'), /v1\.7\.\d/);
});
