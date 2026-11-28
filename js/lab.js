/* Lab (v1.7.3): read-only checks that the CVT probe could not answer, plus adapter snapshot/restore.
   Mode 08 TID 00 is a read. Running a Mode 08 test (0801 and up) is a vehicle control and is not done here;
   the UI confirms that separately. Nothing in this file sends Mode 04/10/11/27/2E/2F/31. */
(function (root) {
  'use strict';
  var isNode = typeof module !== 'undefined' && module.exports;
  var ELM = isNode ? require('./elm.js') : root.ELM;
  var PROBE = isNode ? require('./probe.js') : root.PROBE;

  var ENGINE_21 = ['2102', '2103', '2105', '2110', '211A', '211E', '2133'];
  var MODE8_NAME = {
    1: 'EVAP system leak test',
    2: 'EVAP leak test, 0.040 inch',
    3: 'EVAP leak test, 0.020 inch',
    4: 'purge flow test',
    5: 'EVAP leak test, 0.090 inch'
  };

  function clean(raw) { return String(raw || '').replace(/\r/g, '⏎').replace(/\n/g, '↵').replace(/>/g, '').trim(); }

  function snapshotAdapter(obd) {
    var a = obd && obd.adapter;
    if (!a) return null;
    return {
      at: new Date().toISOString(),
      header: a.header ? { tx: a.header.tx, rx: a.header.rx || null } : null,
      headerKnown: !!a.headerKnown,
      timing: a.timing ? { st: a.timing.st, at: a.timing.at } : null,
      timingKnown: !!a.timingKnown,
      fc: a.fc ? { mode: a.fc.mode, sh: a.fc.sh || null, sd: a.fc.sd || null } : null,
      fcKnown: !!a.fcKnown
    };
  }

  function forgetAdapter(obd) {
    if (!obd || !obd.adapter) return;
    obd.adapter.headerKnown = false;
    obd.adapter.timingKnown = false;
    obd.adapter.fcKnown = false;
  }

  async function sendAll(obd, cmds, timeout) {
    var lines = [], ok = true;
    for (var i = 0; i < cmds.length; i++) {
      var raw = '', err = null;
      try { raw = await obd.cmd(cmds[i], timeout || 2500); }
      catch (e) {
        if (e.message === 'CANCELLED' || e.fatal) throw e;
        err = e.message; raw = e.partial || ''; ok = false;
      }
      if (!err && ELM.detectError(raw, cmds[i]) === '?') err = '?';
      lines.push(cmds[i] + ' <- ' + (err || clean(raw) || 'OK'));
      if (err && err !== '?') ok = false;
    }
    return { ok: ok, lines: lines };
  }

  /** Put the dongle back to the app's normal settings: 7DF, no filter, headers off, ATAT1, ATST32, automatic flow control. */
  async function restoreDefaults(obd) {
    var r = await sendAll(obd, PROBE.RESTORE.slice());
    if (r.ok) ELM.resetAdapterState(obd.adapter);
    else { obd.adapter.headerKnown = false; obd.adapter.timingKnown = false; obd.adapter.fcKnown = false; obd.adapter.dirty = true; }
    r.how = 'defaults';
    return r;
  }

  /** Restore a snapshot taken before a Lab action. Headers are forced off so the live parser still matches. */
  async function restoreSnapshot(obd, snap) {
    if (!snap || !snap.headerKnown || !snap.header) return restoreDefaults(obd);
    var cmds = ['ATSH' + snap.header.tx, snap.header.rx ? 'ATCRA' + snap.header.rx : 'ATCRA', 'ATH0'];
    if (snap.timingKnown && snap.timing) cmds.push('ATAT' + snap.timing.at, 'ATST' + snap.timing.st);
    else cmds.push('ATAT1', 'ATST32');
    if (snap.fcKnown && snap.fc && snap.fc.mode === 1 && snap.fc.sh && snap.fc.sd) cmds.push('ATFCSH' + snap.fc.sh, 'ATFCSD' + snap.fc.sd, 'ATFCSM1');
    else cmds.push('ATFCSM0');
    var r = await sendAll(obd, cmds);
    if (r.ok) {
      obd.adapter.header = { tx: snap.header.tx, rx: snap.header.rx || null };
      obd.adapter.headerKnown = true;
      obd.adapter.timing = snap.timingKnown && snap.timing ? { st: snap.timing.st, at: snap.timing.at } : { st: '32', at: 1 };
      obd.adapter.timingKnown = true;
      obd.adapter.fc = (snap.fcKnown && snap.fc && snap.fc.mode === 1) ? { mode: 1, sh: snap.fc.sh, sd: snap.fc.sd } : { mode: 0, sh: null, sd: null };
      obd.adapter.fcKnown = true;
      obd.adapter.dirty = false;
    } else { obd.adapter.headerKnown = false; obd.adapter.dirty = true; }
    r.how = 'snapshot';
    return r;
  }

  async function exchange(obd, cmd, timeout, log) {
    var raw = '', error = null, t0 = Date.now();
    try { raw = await obd.cmd(cmd, timeout); }
    catch (e) {
      if (e.message === 'CANCELLED' || e.fatal) throw e;
      error = e.message === 'TIMEOUT' ? 'TIMEOUT' : e.message;
      raw = e.partial || '';
    }
    if (!error) { var er = ELM.detectError(raw, cmd); if (er) error = er; }
    var rec = { cmd: cmd, raw: raw, error: error, ms: Date.now() - t0 };
    if (!/^AT/i.test(cmd)) {
      var fr = PROBE.parseFrames(raw, cmd);
      rec.result = PROBE.interpret(cmd, PROBE.reassemble(fr.frames).concat(fr.plain), error);
    }
    if (log) log('info', 'LAB ' + cmd + ' -> ' + (rec.result ? rec.result.status : (error || clean(raw) || 'OK')) + (rec.result && rec.result.id ? ' from ' + rec.result.id : ''));
    return rec;
  }

  function saw(rec, id) {
    if (!rec || !rec.result) return false;
    if (rec.result.id === id) return true;
    return (rec.result.ids || []).indexOf(id) >= 0;
  }

  /**
   * Does this clone really apply ATCRA, and does 7E9 answer a functional 0100 when that is the only ID allowed?
   * Read-only. Restores `snap` (or defaults) before returning.
   */
  async function filterTest(obd, opts) {
    opts = opts || {};
    var log = opts.log || function () {};
    var snap = opts.snap || snapshotAdapter(obd);
    var rep = { kind: 'filter', steps: [], verdict: '', restore: null };
    forgetAdapter(obd);
    try {
      await exchange(obd, 'ATAT0', 2000, log);
      await exchange(obd, 'ATH1', 2000, log);
      await exchange(obd, 'ATST32', 2000, log);
      await exchange(obd, 'ATCRA7E8', 2000, log);
      await exchange(obd, 'ATSH7DF', 2000, log);
      var keep = await exchange(obd, '0100', opts.fastTimeout || 1500, log);
      rep.steps.push(keep);
      await exchange(obd, 'ATCRA7E0', 2000, log);
      var decoy = await exchange(obd, '0100', opts.fastTimeout || 1500, log);
      rep.steps.push(decoy);
      await exchange(obd, 'ATSTFF', 2000, log);
      await exchange(obd, 'ATCRA7E9', 2000, log);
      var tcm = await exchange(obd, '0100', opts.slowTimeout || 4000, log);
      rep.steps.push(tcm);
      await exchange(obd, 'ATST32', 2000, log);
      await exchange(obd, 'ATCRA7E8', 2000, log);
      await exchange(obd, 'ATSH7E0', 2000, log);
      var eng = await exchange(obd, '211A', opts.fastTimeout || 1500, log);
      rep.steps.push(eng);
      rep.control7E8 = saw(keep, '7E8');
      rep.decoyStill7E8 = saw(decoy, '7E8');
      rep.filterWorks = rep.control7E8 && !rep.decoyStill7E8;
      rep.filterIgnored = rep.control7E8 && rep.decoyStill7E8;
      rep.tcm7E9 = saw(tcm, '7E9');
      rep.engine21 = !!(eng.result && eng.result.status === 'data');
      if (!rep.control7E8) rep.verdict = 'Engine did not answer 0100 with the filter set to 7E8. The link or the header is wrong; this test cannot say anything about the CVT.';
      else if (rep.filterIgnored) rep.verdict = 'This dongle accepted ATCRA and then ignored it: a filter of 7E0 still delivered 7E8. It cannot hear the CVT (7E9) even if the module answers. A clone that only passes 7E8 will not read transmission temperature. An OBDLink or other adapter that really applies ATCRA is the next thing to try.';
      else if (rep.tcm7E9) rep.verdict = '7E9 answered the functional 0100 when the filter allowed only 7E9. The TCM is on the bus. The earlier NO DATA was the receive filter or the timeout, not a missing module.';
      else if (rep.filterWorks) rep.verdict = 'The receive filter works (7E0 hid the engine, 7E8 showed it) and 7E9 still did not answer. On this car the CVT module is not responding at the address the Mitsubishi lists use. Service 21 on the engine ' + (rep.engine21 ? 'does answer (211A), so the dongle can do physical addressing.' : 'did not answer 211A this time.');
      else rep.verdict = 'Filter test was inconclusive. Send the Lab log.';
    } finally {
      rep.restore = await restoreSnapshot(obd, snap);
    }
    rep.text = formatFilter(rep);
    return rep;
  }

  function formatFilter(rep) {
    var L = ['Receive-filter test (read-only)'];
    L.push(rep.verdict || '');
    L.push('Filter works: ' + (rep.filterWorks ? 'yes' : 'no') + '   Filter ignored: ' + (rep.filterIgnored ? 'YES' : 'no') + '   7E9 answered: ' + (rep.tcm7E9 ? 'YES' : 'no') + '   Engine 211A: ' + (rep.engine21 ? 'data' : 'no'));
    (rep.steps || []).forEach(function (s) {
      var ids = s.result && s.result.ids && s.result.ids.length ? s.result.ids.join(',') : (s.result && s.result.id) || '';
      L.push('  ' + s.cmd + ' -> ' + (s.result ? s.result.status : s.error || '?') + (ids ? ' ' + ids : '') + '  [' + s.ms + ' ms]');
    });
    if (rep.restore) L.push('Restore (' + rep.restore.how + '): ' + (rep.restore.ok ? 'ok' : 'INCOMPLETE'));
    return L.join('\n');
  }

  /** Service 21 reads on the engine ECU only. 211A already answered on this car. No temperature formula is applied. */
  async function engineSweep(obd, opts) {
    opts = opts || {};
    var log = opts.log || function () {};
    var snap = opts.snap || snapshotAdapter(obd);
    var rep = { kind: 'engine21', rows: [] };
    forgetAdapter(obd);
    try {
      await exchange(obd, 'ATH1', 2000, log);
      await exchange(obd, 'ATAT0', 2000, log);
      await exchange(obd, 'ATST32', 2000, log);
      await exchange(obd, 'ATSH7E0', 2000, log);
      await exchange(obd, 'ATCRA7E8', 2000, log);
      for (var i = 0; i < ENGINE_21.length; i++) {
        var rec = await exchange(obd, ENGINE_21[i], opts.timeout || 1500, log);
        var data = rec.result && rec.result.data ? rec.result.data : null;
        rep.rows.push({ cmd: ENGINE_21[i], status: rec.result ? rec.result.status : 'error', id: rec.result && rec.result.id, hex: data ? data.map(ELM.toHex).join(' ') : '', ms: rec.ms, error: rec.error });
      }
    } finally {
      rep.restore = await restoreSnapshot(obd, snap);
    }
    rep.text = formatEngine(rep);
    return rep;
  }

  function formatEngine(rep) {
    var L = ['Engine service 21 (7E0/7E8, read-only). Raw bytes only — not a CVT temperature.'];
    (rep.rows || []).forEach(function (r) { L.push('  ' + r.cmd + '  ' + r.status + (r.hex ? '  ' + r.hex : '') + (r.error && r.status !== 'no-data' ? '  ' + r.error : '') + '  [' + r.ms + ' ms]'); });
    L.push(rep.rows.some(function (r) { return r.status === 'data' && r.cmd !== '211A'; })
      ? 'Something besides 211A answered. The hex is in the log. Do not treat it as fluid temperature until it is compared cold and hot.'
      : 'Only 211A is known to answer on this car. The other engine requests were included so a new reply would show up here.');
    if (rep.restore) L.push('Restore (' + rep.restore.how + '): ' + (rep.restore.ok ? 'ok' : 'INCOMPLETE'));
    return L.join('\n');
  }

  /** Mode 08 TID 00: which on-board tests the ECU lists. Does not run a test. */
  async function mode08Supported(obd, opts) {
    opts = opts || {};
    var log = opts.log || function () {};
    var snap = opts.snap || snapshotAdapter(obd);
    var rep = { kind: 'mode08', tids: [], raw: '' };
    forgetAdapter(obd);
    try {
      await exchange(obd, 'ATSH7DF', 2000, log);
      await exchange(obd, 'ATCRA', 2000, log);
      await exchange(obd, 'ATH0', 2000, log);
      var rec = await exchange(obd, '0800', opts.timeout || 2500, log);
      rep.raw = clean(rec.raw);
      rep.status = rec.result ? rec.result.status : 'error';
      var bytes = rec.result && rec.result.data ? rec.result.data : [];
      if (rec.result && rec.result.status === 'data' && bytes.length >= 4) rep.tids = ELM.decodeSupported(bytes.slice(0, 4), 0);
      rep.names = rep.tids.map(function (n) { return { tid: ELM.toHex(n), n: n, name: MODE8_NAME[n] || ('on-board test ' + n) }; });
    } finally {
      rep.restore = await restoreSnapshot(obd, snap);
    }
    rep.text = formatMode8(rep);
    return rep;
  }

  function formatMode8(rep) {
    var L = ['Mode 08 supported tests (0800, read-only). Running one is a separate confirmed action and cannot be undone from here.'];
    if (!rep.names || !rep.names.length) L.push('No test list returned (' + (rep.status || 'no data') + '). Many cars, including this Lancer, simply do not support Mode 08.');
    else rep.names.forEach(function (t) { L.push('  TID ' + t.tid + '  ' + t.name); });
    if (rep.raw) L.push('Raw: ' + rep.raw);
    if (rep.restore) L.push('Restore (' + rep.restore.how + '): ' + (rep.restore.ok ? 'ok' : 'INCOMPLETE'));
    return L.join('\n');
  }

  /** Run one Mode 08 test. Caller must already have confirmed. Restores the dongle; does not undo the test. */
  async function mode08Run(obd, tid, opts) {
    opts = opts || {};
    var log = opts.log || function () {};
    var id = ELM.toHex(parseInt(tid, 16));
    var cls = ELM.classifyCommand('08' + id);
    if (!cls.write) throw new Error('Refusing to send 08' + id + ' (not a test request)');
    var snap = opts.snap || snapshotAdapter(obd);
    var rep = { kind: 'mode08-run', tid: id, name: MODE8_NAME[parseInt(id, 16)] || ('test ' + id) };
    forgetAdapter(obd);
    try {
      await exchange(obd, 'ATSH7DF', 2000, log);
      await exchange(obd, 'ATCRA', 2000, log);
      var rec = await exchange(obd, '08' + id, opts.timeout || 8000, log);
      rep.status = rec.result ? rec.result.status : 'error';
      rep.hex = rec.result && rec.result.data ? rec.result.data.map(ELM.toHex).join(' ') : '';
      rep.raw = clean(rec.raw);
      rep.error = rec.error;
    } finally {
      rep.restore = await restoreSnapshot(obd, snap);
    }
    rep.text = 'Mode 08 TID ' + id + ' (' + rep.name + ') -> ' + (rep.status || rep.error || '?') + (rep.hex ? '  ' + rep.hex : '') +
      '\nThe dongle is restored. The test itself is not reversible. Raw: ' + (rep.raw || '');
    return rep;
  }

  var api = {
    ENGINE_21: ENGINE_21, snapshotAdapter: snapshotAdapter, restoreDefaults: restoreDefaults, restoreSnapshot: restoreSnapshot,
    filterTest: filterTest, engineSweep: engineSweep, mode08Supported: mode08Supported, mode08Run: mode08Run, MODE8_NAME: MODE8_NAME
  };
  if (isNode) module.exports = api; else root.LAB = api;
})(this);
