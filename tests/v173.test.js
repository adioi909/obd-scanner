/* v1.7.3: late-prompt drain, receive-filter test, engine service 21 sweep, Mode 08 read vs run. */
const test = require('node:test');
const assert = require('node:assert/strict');
const ELM = require('../js/elm.js');
const LAB = require('../js/lab.js');
const { MockTransport, ElmSession } = require('../js/transport.js');
const { Obd } = require('../js/obd.js');

async function rig(mockOpts) {
  const mock = new MockTransport(Object.assign({ latency: 1, car: 'mitsubishi2013' }, mockOpts || {}));
  await mock.connect();
  const s = new ElmSession(mock, { timeout: 400, drainLateMs: 0 });
  const obd = new Obd(s, { pidTimeout: 400, enhancedEveryMs: 0 });
  await obd.init('0');
  mock.cmdLog.length = 0;
  return { mock, s, obd };
}

test('v1.7.3: a late prompt after TIMEOUT is drained and does not become the next reply', async () => {
  let late = null;
  const t = { write: async (s) => {
    const c = s.trim();
    if (c === 'SLOW') late = setTimeout(() => t.onData('NO DATA\r\r>'), 60);
    else setTimeout(() => t.onData('OK\r\r>'), 5);
  }};
  const s = new ElmSession(t, { timeout: 200, drainLateMs: 200 });
  await assert.rejects(s.send('SLOW', 30), /TIMEOUT/);
  assert.equal((await s.send('ATI', 200)).trim(), 'OK');
  clearTimeout(late);
});

test('v1.7.3: 0800 is a read, 0801 is a confirmed write, Mode 04 still is', () => {
  assert.equal(ELM.classifyCommand('0800').write, false);
  assert.equal(ELM.classifyCommand('0801').write, true);
  assert.equal(ELM.classifyCommand('08').write, false);
  assert.equal(ELM.classifyCommand('04').write, true);
  assert.equal(ELM.classifyCommand('2103').write, false);
  assert.equal(ELM.classifyCommand('2E01').write, true);
});

test('v1.7.3: filter test sees a working ATCRA and a silent 7E9, and restores 7DF', async () => {
  const r = await rig();
  const snap = LAB.snapshotAdapter(r.obd);
  const rep = await LAB.filterTest(r.obd, { snap: snap });
  assert.equal(rep.filterWorks, true);
  assert.equal(rep.filterIgnored, false);
  assert.equal(rep.tcm7E9, false);
  assert.equal(rep.engine21, true);
  assert.match(rep.verdict, /not responding/);
  assert.equal(r.mock.txHeader, '7DF');
  assert.equal(r.mock.rxFilter, null);
  assert.equal(r.mock.fcMode, 0);
  assert.equal(r.mock.at, 1);
  assert.equal(r.mock.st, '32');
  r.mock.cmdLog.forEach(c => { if (!/^AT/.test(c)) assert.ok(/^(01|21)/.test(c), c); });
});

test('v1.7.3: a clone that ignores ATCRA is called out, and is not treated as a silent TCM', async () => {
  const r = await rig({ craIgnored: true });
  const rep = await LAB.filterTest(r.obd, { snap: LAB.snapshotAdapter(r.obd) });
  assert.equal(rep.filterIgnored, true);
  assert.equal(rep.filterWorks, false);
  assert.match(rep.verdict, /ignored it/);
});

test('v1.7.3: functional 0100 from 7E9 is reported when the filter lets it through', async () => {
  const r = await rig({ tcmJ1979: true, tcm: true });
  const rep = await LAB.filterTest(r.obd, { snap: LAB.snapshotAdapter(r.obd) });
  assert.equal(rep.tcm7E9, true);
  assert.match(rep.verdict, /TCM is on the bus/);
});

test('v1.7.3: engine sweep is service 21 only, keeps 211A, and does not invent a temperature', async () => {
  const r = await rig();
  const rep = await LAB.engineSweep(r.obd, { snap: LAB.snapshotAdapter(r.obd) });
  const hit = rep.rows.find(x => x.cmd === '211A');
  assert.equal(hit.status, 'data');
  assert.ok(rep.rows.some(x => x.cmd === '2103' && x.status === 'no-data'));
  assert.ok(!/fluid temperature/i.test(rep.text) || /not a CVT temperature/.test(rep.text));
  r.mock.cmdLog.forEach(c => { if (!/^AT/.test(c)) assert.ok(/^21/.test(c), c); });
  assert.equal(r.mock.txHeader, '7DF');
});

test('v1.7.3: 0800 lists TID 01 and does not send 0801; mode08Run refuses 0800 and restores', async () => {
  const r = await rig();
  const rep = await LAB.mode08Supported(r.obd, { snap: LAB.snapshotAdapter(r.obd) });
  assert.ok(rep.names.some(t => t.tid === '01'));
  assert.ok(!r.mock.cmdLog.some(c => c === '0801'));
  await assert.rejects(LAB.mode08Run(r.obd, '00'), /Refusing/);
  const ran = await LAB.mode08Run(r.obd, '01', { snap: LAB.snapshotAdapter(r.obd) });
  assert.equal(ran.status, 'data');
  assert.equal(r.mock.txHeader, '7DF');
  assert.ok(r.mock.cmdLog.includes('0801'));
});
