/* v1.7.2: ScanGauge 2122, Torque flow-control while the CVT preset is polling, and one no-filter retry after NO DATA. */
const test = require('node:test');
const assert = require('node:assert/strict');
const ELM = require('../js/elm.js');
const PIDS = require('../js/pids.js');
const PROBE = require('../js/probe.js');
const { MockTransport, ElmSession } = require('../js/transport.js');
const { Obd } = require('../js/obd.js');

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

test('v1.7.2: 2122 decodes A-55, is read-only, and is on the CVT preset', () => {
  assert.equal(PIDS.decodeEnhanced('MCVT22', [90]), 35);
  assert.equal(PIDS.decodeEnhanced('MCVT22', []), null);
  const d = PIDS.get('MCVT22');
  assert.equal(d.request, '2122');
  assert.equal(d.txHeader, '7E1');
  assert.equal(d.rxFilter, '7E9');
  assert.equal(d.flowControl, true);
  assert.equal(d.slowTimeout, true);
  assert.equal(ELM.classifyCommand('2122').write, false);
  assert.equal(ELM.classifyCommand('04').write, true);
  assert.ok(PIDS.PRESETS.find(p => p.id === 'preset-mitsu-cvt').pids.includes('MCVT22'));
});

test('v1.7.2: pickCvt prefers the candidate closest to coolant, else ScanGauge 2122', () => {
  const cold = PIDS.pickCvt({ '05': 22, MCVT22: 80, MCVT33: 24, MCVT: 47 });
  assert.equal(cold.pid, 'MCVT33');
  assert.equal(cold.value, 24);
  const noCool = PIDS.pickCvt({ MCVT: 47, MCVT22: 35, MCVT33: 45 });
  assert.equal(noCool.pid, 'MCVT22');
  assert.equal(PIDS.pickCvt({ MCVT: 400 }), null);
  assert.equal(PIDS.pickCvt({}), null);
});

test('v1.7.2: live CVT poll sends Torque flow control, then restores ATFCSM0, and does not retry a good reply', async () => {
  const r = await rig({ tcm: true, t22: 90 });
  const v = await r.obd.queryPids(['MCVT22', '05'], { forceEnhanced: true });
  assert.equal(v.MCVT22, 35);
  assert.equal(typeof v['05'], 'number');
  const log = r.mock.cmdLog;
  const iFc = log.indexOf('ATFCSM1');
  const iReq = log.indexOf('2122');
  const iOff = log.lastIndexOf('ATFCSM0');
  assert.ok(log.includes('ATFCSH7E1') && log.includes('ATFCSD30080A'), log.join(' '));
  assert.ok(iFc >= 0 && iFc < iReq && iReq < iOff, log.join(' '));
  assert.equal(log.filter(c => c === '2122').length, 1);
  assert.equal(r.mock.fcMode, 0);
  assert.equal(r.mock.txHeader, '7DF');
  assert.equal(r.mock.rxFilter, null);
  assert.equal(r.mock.st, '32');
  assert.equal(r.mock.at, 1);
  r.mock.cmdLog.length = 0;
  await r.obd.queryPids(['0C']);
  assert.ok(!r.mock.cmdLog.some(c => /^ATFC/.test(c)), 'mode 01 does not touch flow control');
});

test('v1.7.2: NO DATA with the receive filter on is retried once with the filter cleared', async () => {
  const r = await rig({ tcm: true, tcmNeedsOpenFilter: true, t22: 80 });
  const v = await r.obd.queryPids(['MCVT22'], { forceEnhanced: true });
  assert.equal(v.MCVT22, 25);
  assert.equal(r.mock.cmdLog.filter(c => c === '2122').length, 2);
  assert.ok(r.mock.cmdLog.includes('ATCRA'), 'filter was cleared for the retry');
  assert.equal(r.mock.fcMode, 0);
  assert.equal(r.mock.txHeader, '7DF');
  assert.equal(r.obd.enhancedNS.MCVT22, undefined);
});

test('v1.7.2: a timeout is not retried, and flow control is still restored', async () => {
  const r = await rig({ tcm: 'hang' });
  const v = await r.obd.queryPids(['MCVT'], { forceEnhanced: true });
  assert.equal(v.MCVT, undefined);
  assert.equal(r.mock.cmdLog.filter(c => c === '2103').length, 1);
  assert.equal(r.mock.fcMode, 0);
  assert.equal(r.mock.st, '32');
});

test('v1.7.2: probe asks 2122 and decodes it, and still only sends services 01 and 21', async () => {
  const r = await rig({ tcm: true, t22: 90, t22b: 100 });
  const rep = await PROBE.run(r.obd, { log: () => {}, requestTimeout: 250, reinit: async () => {} });
  const hit = rep.summary.requests.find(q => q.tx === '7E1' && q.cmd === '2122');
  assert.equal(hit.status, 'data');
  assert.equal(rep.summary.candidates.find(c => c.req === '2122' && /first byte/.test(c.label)).value, 35);
  assert.equal(rep.summary.candidates.find(c => c.req === '2122' && /4th data byte/.test(c.label)).value, 45);
  r.mock.cmdLog.forEach(c => { if (!/^AT/.test(c)) assert.ok(/^(01|21)/.test(c), c); });
  assert.equal(r.mock.fcMode, 0);
  assert.equal(ELM.classifyCommand('10').write, true);
});

test('v1.7.2: a stored v1.7.1 CVT preset list is upgraded; an edited list is not', () => {
  const store = {};
  global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  global.PIDS = PIDS;
  delete require.cache[require.resolve('../js/storage.js')];
  const S = require('../js/storage.js');
  S.PIDS = PIDS;
  const list = JSON.parse(JSON.stringify(PIDS.PRESETS));
  list.find(p => p.id === 'preset-mitsu-cvt').pids = ['MCVT33', 'MCVT02', 'MCVT', 'MCVT8', 'MCVT3', 'MCVTJ', 'MCVTN', '05', '0C'];
  store['obd.profiles.v1'] = JSON.stringify(list);
  let out = S.Store.loadProfiles();
  assert.ok(out.find(p => p.id === 'preset-mitsu-cvt').pids.includes('MCVT22'));
  const edited = JSON.parse(JSON.stringify(out));
  edited.find(p => p.id === 'preset-mitsu-cvt').pids = ['MCVT22', '05'];
  store['obd.profiles.v1'] = JSON.stringify(edited);
  out = S.Store.loadProfiles();
  assert.deepEqual(out.find(p => p.id === 'preset-mitsu-cvt').pids, ['MCVT22', '05']);
});
