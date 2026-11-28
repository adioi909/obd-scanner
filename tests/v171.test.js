/* v1.7.1 tests: CVT probe (mock GATT-level session: restore on success / timeout / mid-probe error / cancel / budget, 7E9 detection,
   multi-frame 2103 parsing with headers on) and the CVT timeout switching (ATAT0 + ATSTFF while on 7E1, ATST32 / ATAT1 restored). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ELM = require('../js/elm.js');
const PIDS = require('../js/pids.js');
const PROBE = require('../js/probe.js');
const { MockTransport, ElmSession } = require('../js/transport.js');
const { Obd, normSt } = require('../js/obd.js');
const root = path.join(__dirname, '..');

async function rig(mockOpts, obdOpts) {
  const logs = [];
  const mock = new MockTransport(Object.assign({ latency: 1, car: 'mitsubishi2013' }, mockOpts || {}));
  await mock.connect();
  const log = (k, m) => logs.push(k + ': ' + m);
  const s = new ElmSession(mock, { timeout: 300, log });
  const obd = new Obd(s, Object.assign({ log, pidTimeout: 300, enhancedEveryMs: 0 }, obdOpts || {}));
  await obd.init('0');
  mock.cmdLog.length = 0;
  return { mock, s, obd, logs };
}
const RESTORE = ['ATSH7DF', 'ATCRA', 'ATH0', 'ATAT1', 'ATST32', 'ATFCSM0'];
function assertRestored(mock, obd) {
  assert.equal(mock.txHeader, '7DF'); assert.equal(mock.rxFilter, null); assert.equal(mock.headers, false);
  assert.equal(mock.st, '32'); assert.equal(mock.at, 1); assert.equal(mock.fcMode, 0);
  assert.deepEqual(mock.cmdLog.slice(-RESTORE.length - 0).filter(c => RESTORE.indexOf(c) >= 0).slice(-RESTORE.length), RESTORE.slice(-RESTORE.length));
  assert.equal(obd.adapter.dirty, false);
}
async function probe(r, opts) {
  const calls = { reinit: 0 };
  const rep = await PROBE.run(r.obd, Object.assign({ log: () => {}, requestTimeout: 250, reinit: async () => { calls.reinit++; } }, opts || {}));
  return { rep, calls };
}

// ---------------- parsing with headers ON ----------------
test('v1.7.1: parseFrames/reassemble: single frame with headers on matches the real car reply', () => {
  const f = PROBE.parseFrames('7E8 06 41 00 BE 3F A8 13\r\r>', '0100');
  assert.equal(f.frames.length, 1); assert.equal(f.frames[0].id, '7E8');
  const m = PROBE.reassemble(f.frames)[0];
  assert.deepEqual(m.payload, [0x41, 0x00, 0xBE, 0x3F, 0xA8, 0x13]); assert.equal(m.complete, true);
  const r = PROBE.interpret('0100', [m]);
  assert.equal(r.status, 'data'); assert.equal(r.id, '7E8'); assert.deepEqual(r.data, [0xBE, 0x3F, 0xA8, 0x13]);
});

test('v1.7.1: multi-frame 2103 with headers on (spaces on and off) is reassembled, N = data[13]', () => {
  const lines = ['7E9 10 16 61 03 10 11 12 13', '7E9 21 14 15 16 17 18 19 1A', '7E9 22 1B 1C 5A 1E 1F 00 00', '7E9 23 00 00 00 00 00 00 00'];
  // data bytes 0x10..0x1F with data[13]=0x5A -> payload 61 03 + 20 bytes = 22 bytes = 0x16
  const withSpaces = lines.join('\r') + '\r\r>';
  const noSpaces = lines.map(l => l.replace(/ /g, '')).join('\r') + '\r\r>';
  [withSpaces, noSpaces].forEach(raw => {
    const f = PROBE.parseFrames(raw, '2103');
    assert.equal(f.frames.length, 4);
    const m = PROBE.reassemble(f.frames);
    assert.equal(m.length, 1); assert.equal(m[0].declared, 22); assert.equal(m[0].payload.length, 22); assert.equal(m[0].complete, true);
    const r = PROBE.interpret('2103', m);
    assert.equal(r.status, 'data'); assert.equal(r.data.length, 20); assert.equal(r.data[13], 0x5A);
  });
});

test('v1.7.1: only a first frame -> first-frame-only; NRC and NO DATA are told apart; headerless layout falls back', () => {
  const ff = PROBE.parseFrames('7E9 10 16 61 03 10 11 12 13\r\r>', '2103');
  const r1 = PROBE.interpret('2103', PROBE.reassemble(ff.frames));
  assert.equal(r1.status, 'first-frame-only'); assert.equal(r1.declared, 22);
  const nrc = PROBE.parseFrames('7E9 03 7F 21 12\r\r>', '2101');
  const r2 = PROBE.interpret('2101', PROBE.reassemble(nrc.frames));
  assert.equal(r2.status, 'nrc'); assert.equal(r2.nrc, 0x12); assert.equal(r2.id, '7E9');
  const nd = PROBE.parseFrames('NO DATA\r\r>', '2103');
  assert.equal(PROBE.interpret('2103', [], 'NO DATA').status, 'no-data'); assert.equal(nd.frames.length, 0);
  const hl = PROBE.parseFrames('014\r0: 61 03 10 11 12 13\r1: 14 15 16 17 18 19 1A\r2: 1B 1C 1D 1E 1F 20 21\r\r>', '2103');
  assert.equal(hl.frames.length, 0); assert.equal(hl.plain.length, 1); assert.equal(hl.plain[0].id, '?');
  assert.equal(PROBE.interpret('2103', hl.plain).status, 'data');
});

test('v1.7.1: mock adapter prints headers after ATH1 and frames long replies like a real ELM', async () => {
  const r = await rig({ tcmJ1979: true });
  await r.s.send('ATH1'); await r.s.send('ATS1');
  assert.equal((await r.s.send('0100', 500)).split('\r')[0].trim(), '7E8 06 41 00 BE 3F A8 13');
  await r.s.send('ATSH7E1');
  const raw = await r.s.send('2103', 500);
  assert.ok(/7E9 10 16 61 03/.test(raw) && /7E9 21 /.test(raw) && /7E9 22 /.test(raw), raw);
});

// ---------------- the probe ----------------
test('v1.7.1: probe on a car with a TCM: addresses, data, candidates, full restore, re-init', async () => {
  const r = await rig({ tcm: true, tcmJ1979: true, tcmByteN: 100, t33: 95, t02: 65, otherEcus: { '7E3': '7EB' } });
  const { rep, calls } = await probe(r);
  const sm = rep.summary;
  assert.equal(rep.aborted, null);
  assert.deepEqual(sm.ids, ['7E8', '7E9', '7EB']);
  assert.equal(sm.tcmAnswered, true); assert.equal(sm.functionalTcm, true); assert.equal(sm.cvtService21, true);
  const st = (tx, cmd) => sm.requests.find(q => q.tx === tx && q.cmd === cmd);
  assert.equal(st('7E1', '0100').status, 'data'); assert.equal(st('7E1', '2107').status, 'data'); assert.equal(st('7E1', '2103').status, 'data');
  assert.equal(st('7E0', '211A').status, 'data'); assert.equal(st('7E3', '0100').status, 'data'); assert.equal(st('7E2', '0100').status, 'no-data');
  const byLabel = Object.fromEntries(sm.candidates.map(c => [c.req + ' ' + c.label.split(' ')[0] + ' ' + c.label.split(' ')[1], c.value]));
  assert.equal(sm.candidates.find(c => c.req === '2133' && /last byte/.test(c.label)).value, 45);
  assert.equal(sm.candidates.find(c => c.req === '2102').value, 25);
  assert.equal(sm.candidates.find(c => /N - 55/.test(c.label)).value, 45);
  assert.equal(sm.candidates.find(c => /polynomial/.test(c.label)).value, Math.round(PIDS.cvtPoly(100) * 10) / 10);
  assert.equal(sm.candidates.find(c => /cubic/.test(c.label)).value, Math.round(PIDS.cvtCubic(100) * 10) / 10);
  assert.ok(byLabel);
  assert.equal(rep.ranCustomFlowControl, false, 'step (d) only runs when 2103 failed');
  assert.equal(rep.restoreOk, true); assert.equal(calls.reinit, 1); assert.equal(rep.reinit, 'ok');
  assertRestored(r.mock, r.obd);
  // read-only: nothing but AT setup and services 01 / 21 went out
  r.mock.cmdLog.forEach(c => { if (!/^AT/.test(c)) assert.ok(/^(01|21)/.test(c), 'unexpected request ' + c); });
  const report = PROBE.formatReport(rep, { app: 'v1.7.1', info: { elm: 'ELM327 v1.5', vin: 'JA32U2FU9DU010476' } });
  assert.ok(/7E9 \(CVT TCM\) answered: YES/.test(report) && /2133/.test(report) && /Full transcript/.test(report) && /7E9 payload \(22 of 22 bytes\)/.test(report));
});

test('v1.7.1: a slow TCM is only seen with ATAT0 + ATSTFF: the probe finds 7E9 on the functional 0100, normal timing does not', async () => {
  const r = await rig({ tcm: true, tcmJ1979: true, tcmDelayMs: 600 });
  await r.s.send('ATH1');
  const plain = await r.s.send('0100', 500);
  assert.ok(!/7E9/.test(plain), 'default ATST32 / ATAT1 cuts the TCM off: ' + plain);
  await r.s.send('ATH0');
  const { rep } = await probe(r);
  assert.equal(rep.summary.functionalTcm, true, 'long timeout shows the 7E9 line on 7DF');
  assert.equal(rep.summary.cvtService21, true);
  assertRestored(r.mock, r.obd);
});

test('v1.7.1: no TCM at all: NO DATA everywhere, custom flow control retried (and undone), clear hint, restore still runs', async () => {
  const r = await rig({ tcm: false });
  const { rep } = await probe(r);
  const sm = rep.summary;
  assert.deepEqual(sm.ids, ['7E8']); assert.equal(sm.tcmAnswered, false); assert.equal(sm.candidates.length, 0);
  assert.equal(rep.ranCustomFlowControl, true);
  ['ATCRA7E9', 'ATFCSH7E1', 'ATFCSD30080A', 'ATFCSM1'].forEach(c => assert.ok(r.mock.cmdLog.includes(c), c));
  assert.ok(sm.hints.some(h => /7E9/.test(h)));
  assertRestored(r.mock, r.obd);
});

test('v1.7.1: a clone that answers "?" to the ATFC commands does not break the probe', async () => {
  const r = await rig({ tcm: false, rejectFc: true });
  const { rep } = await probe(r);
  assert.equal(rep.aborted, null);
  const rej = rep.steps.filter(s => s.kind === 'at' && /^ATFC/.test(s.cmd));
  assert.ok(rej.length >= 3 && rej.every(s => s.rejected));
  assert.equal(rep.restoreOk, true); assertRestored(r.mock, r.obd);
});

test('v1.7.1: timeout (a TCM that never finishes 2103): recorded as TIMEOUT, probe continues, adapter restored', async () => {
  const r = await rig({ tcm: 'hang' });
  const { rep, calls } = await probe(r, { requestTimeout: 200 });
  const q = rep.summary.requests.filter(x => x.cmd === '2103');
  assert.ok(q.length >= 1 && q.every(x => x.status === 'timeout'), JSON.stringify(q));
  assert.ok(rep.summary.requests.some(x => x.cmd === '211A' && x.status === 'data'), 'later steps still ran');
  assert.equal(rep.restoreOk, true); assert.equal(calls.reinit, 1);
  assertRestored(r.mock, r.obd);
});

test('v1.7.1: mid-probe error (queue cleared while 2106 is in flight): probe stops, restore + re-init still run', async () => {
  const r = await rig({ tcm: true });
  const orig = r.obd.cmd.bind(r.obd); let thrown = false;
  r.obd.cmd = async function (c, t) { if (c === '2106' && !thrown) { thrown = true; throw new Error('CANCELLED'); } return orig(c, t); };
  const { rep, calls } = await probe(r);
  assert.ok(/CANCELLED/.test(rep.aborted), rep.aborted);
  assert.ok(!rep.summary.requests.some(x => x.cmd === '2133'), 'nothing after the failure was sent');
  assert.equal(rep.restoreOk, true); assert.equal(calls.reinit, 1);
  assertRestored(r.mock, r.obd);
});

test('v1.7.1: user cancel and time budget both stop early and restore', async () => {
  let r = await rig({ tcm: true }); const ctl = { cancelled: false };
  let { rep } = await probe(r, { control: ctl, onProgress: (t, pct) => { if (pct >= 20) ctl.cancelled = true; } });
  assert.equal(rep.aborted, 'cancelled by user'); assertRestored(r.mock, r.obd);
  r = await rig({ tcm: true });
  ({ rep } = await probe(r, { budgetMs: -1 }));
  assert.ok(/time budget/.test(rep.aborted)); assert.equal(rep.steps.length, 0);
  assert.deepEqual(r.mock.cmdLog, RESTORE); assertRestored(r.mock, r.obd);
});

test('v1.7.1: link dead during the probe: restore is skipped cleanly (no crash, adapter flagged dirty)', async () => {
  const r = await rig({ tcm: true });
  const orig = r.obd.cmd.bind(r.obd);
  r.obd.cmd = async function (c, t) { if (c === '2107') { r.s.dead = true; const e = new Error('GATT disconnected'); e.fatal = true; throw e; } return orig(c, t); };
  const { rep } = await probe(r);
  assert.ok(/GATT/.test(rep.aborted)); assert.equal(rep.restoreOk, false);
  assert.ok(rep.restore.every(x => /skipped/.test(x.error)));
  assert.equal(rep.reinit, 'skipped (link down)'); assert.equal(r.obd.adapter.dirty, true);
});

test('v1.7.1: a normal probe finishes well inside the 60 s budget', async () => {
  const r = await rig({ tcm: true });
  const t0 = Date.now(); const { rep } = await probe(r);
  assert.ok(Date.now() - t0 < 10000 && rep.durationMs < 10000);
});

// ---------------- CVT timeout switching ----------------
test('v1.7.1: CVT poll: ATAT0 + ATSTFF only while on 7E1, ATAT1 + ATST32 restored afterwards; standard polls leave timing alone', async () => {
  const r = await rig({ tcm: true });
  const v = await r.obd.queryPids(['MCVT33', '05'], { forceEnhanced: true });
  assert.equal(v['MCVT33'], 45);
  const log = r.mock.cmdLog;
  const iAT0 = log.indexOf('ATAT0'), iFF = log.indexOf('ATSTFF'), iReq = log.indexOf('2133'), iBack = log.indexOf('ATST32');
  assert.ok(iAT0 >= 0 && iFF >= 0 && iAT0 < iReq && iFF < iReq && iReq < iBack, log.join(' '));
  assert.ok(log.indexOf('ATAT1') > iReq);
  assert.equal(r.mock.st, '32'); assert.equal(r.mock.at, 1);
  r.mock.cmdLog.length = 0;
  await r.obd.queryPids(['0C']);
  assert.ok(!r.mock.cmdLog.some(c => /^AT(ST|AT)/.test(c)), 'no timing commands for a plain mode-01 poll');
  r.mock.cmdLog.length = 0;
  await r.obd.queryPids(['MCVT33'], { forceEnhanced: true });
  assert.equal(r.mock.cmdLog.filter(c => c === 'ATSTFF').length, 1);
});

test('v1.7.1: configurable CVT timeout (ATSTC8) and normSt validation', async () => {
  assert.equal(normSt('c8'), 'C8'); assert.equal(normSt('xyz'), 'FF'); assert.equal(normSt('5'), 'FF'); assert.equal(normSt(''), 'FF');
  const r = await rig({ tcm: true }, { enhancedSt: 'C8' });
  await r.obd.queryPids(['MCVT33'], { forceEnhanced: true });
  assert.ok(r.mock.cmdLog.includes('ATSTC8') && !r.mock.cmdLog.includes('ATSTFF'));
  assert.equal(r.mock.st, '32');
});

test('v1.7.1: timing is restored after a timeout and after NO DATA too', async () => {
  for (const tcm of ['hang', false]) {
    const r = await rig({ tcm });
    await r.obd.queryPids(['MCVT33', 'MCVT'], { forceEnhanced: true });
    assert.equal(r.mock.st, '32', 'tcm=' + tcm); assert.equal(r.mock.at, 1); assert.equal(r.mock.txHeader, '7DF'); assert.equal(r.mock.rxFilter, null);
  }
});

test('v1.7.1: 3-failure N/S fallback still works per request, and Retry CVT clears it', async () => {
  const r = await rig({ tcm: true, tcmPids: ['03'] }); // 2133 and 2102 unsupported, 2103 fine
  for (let i = 0; i < 3; i++) await r.obd.queryPids(['MCVT33', 'MCVT02', 'MCVT'], { forceEnhanced: true });
  assert.equal(r.obd.enhancedNS['MCVT33'], true); assert.equal(r.obd.enhancedNS['MCVT02'], true); assert.ok(!r.obd.enhancedNS['MCVT']);
  const before = r.mock.cmdLog.filter(c => c === '2133').length;
  await r.obd.queryPids(['MCVT33', 'MCVT'], { forceEnhanced: true });
  assert.equal(r.mock.cmdLog.filter(c => c === '2133').length, before, 'N/S PIDs are skipped');
  assert.equal(r.obd.clearEnhancedNS(), 2);
  await r.obd.queryPids(['MCVT33', 'MCVT'], { forceEnhanced: true });
  assert.equal(r.mock.cmdLog.filter(c => c === '2133').length, before + 1, 'tried again after Retry CVT');
});

test('v1.7.1: a manual ATST / ATAT / ATFC command from the Console marks the adapter dirty and resync puts timing back', async () => {
  for (const c of ['ATST64', 'ATAT0', 'ATFCSM1', 'ATFCSH7E1']) assert.equal(ELM.classifyCommand(c).atMutating, true, c);
  const r = await rig({ tcm: true });
  await r.s.send('ATSTFF'); await r.s.send('ATAT0'); ELM.markDirty(r.obd.adapter, 'ATSTFF'); ELM.markDirty(r.obd.adapter, 'ATAT0');
  assert.equal(r.obd.adapter.timingKnown, false);
  assert.equal(await r.obd.resync(), true);
  assert.equal(r.mock.st, '32'); assert.equal(r.mock.at, 1); assert.equal(r.obd.adapter.dirty, false);
});

// ---------------- PIDs, preset, storage, versions ----------------
test('v1.7.1: new (Exp) candidate PIDs decode like the research says and are read-only', () => {
  assert.equal(PIDS.decodeEnhanced('MCVT33', [95]), 45);
  assert.equal(PIDS.decodeEnhanced('MCVT02', [1, 2, 3, 4, 5, 65, 7]), 25);
  const d3 = []; for (let i = 0; i < 20; i++) d3.push(i === 9 ? 100 : i === 13 ? 100 : 0);
  assert.equal(PIDS.decodeEnhanced('MCVTJ', d3), 45);
  assert.equal(PIDS.decodeEnhanced('MCVT3', d3), Math.round(PIDS.cvtCubic(100) * 1000) / 1000);
  ['MCVT33', 'MCVT02', 'MCVTJ', 'MCVT3'].forEach(p => { const d = PIDS.get(p); assert.ok(d.enhanced && d.experimental && d.slowTimeout && d.txHeader === '7E1' && d.rxFilter === '7E9' && /^21/.test(d.request)); assert.ok(/\(Exp\)/.test(d.short)); });
  assert.equal(PIDS.get('MCVT33').request, '2133'); assert.equal(PIDS.get('MCVT02').request, '2102');
  const pre = PIDS.PRESETS.find(p => p.id === 'preset-mitsu-cvt');
  ['MCVT33', 'MCVT02', 'MCVT', 'MCVT8', 'MCVTN'].forEach(p => assert.ok(pre.pids.includes(p), p));
});

test('v1.7.1: a stored CVT preset with the old default list is upgraded once; an edited one is left alone', () => {
  const store = {};
  global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  global.PIDS = PIDS;
  delete require.cache[require.resolve('../js/storage.js')];
  const S = require('../js/storage.js');
  S.PIDS = PIDS;
  const list = JSON.parse(JSON.stringify(PIDS.PRESETS));
  list.find(p => p.id === 'preset-mitsu-cvt').pids = ['MCVT', 'MCVT8', 'MCVTN', '05', '0C'];
  store['obd.profiles.v1'] = JSON.stringify(list);
  let out = S.Store.loadProfiles();
  assert.deepEqual(out.find(p => p.id === 'preset-mitsu-cvt').pids, PIDS.PRESETS.find(p => p.id === 'preset-mitsu-cvt').pids);
  const edited = JSON.parse(JSON.stringify(out)); edited.find(p => p.id === 'preset-mitsu-cvt').pids = ['MCVT', '05'];
  store['obd.profiles.v1'] = JSON.stringify(edited);
  out = S.Store.loadProfiles();
  assert.deepEqual(out.find(p => p.id === 'preset-mitsu-cvt').pids, ['MCVT', '05']);
  assert.equal(S.Store.loadSettings().cvtSt, 'FF');
});

test('v1.7.1: version strings, service worker cache, probe wired into the page', () => {
  const rd = f => fs.readFileSync(path.join(root, f), 'utf8');
  assert.ok(/APP_VERSION = 'v1\.7\.1'/.test(rd('js/app.js')));
  assert.ok(/<title>OBD Scanner v1\.7\.1<\/title>/.test(rd('index.html')) && /id="app-ver">v1\.7\.1</.test(rd('index.html')));
  assert.ok(/CACHE = 'obd-scanner-v1\.7\.1'/.test(rd('sw.js')) && /js\/probe\.js/.test(rd('sw.js')));
  assert.equal(JSON.parse(rd('package.json')).version, '1.7.1');
  const html = rd('index.html');
  ['btn-probe', 'btn-probe-copy', 'btn-probe-cancel', 'probe-summary', 'btn-retry-cvt', 's-cvtst', 'js/probe.js'].forEach(id => assert.ok(html.includes(id), id));
  assert.ok(/Version 1\.7\.1/.test(rd('MANUAL.md')) && /v1\.7\.1/.test(rd('README.md')));
  assert.ok(/CVT probe/i.test(rd('MANUAL.md')) && /Copy probe report/.test(rd('MANUAL.md')));
});
