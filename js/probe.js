/* CVT Probe (v1.7.1): a read-only, time-boxed survey of which module answers where on a Mitsubishi CAN car.
   Only AT setup commands and services 01 and 21 are sent (no writes, no Mode 10 session). Whatever happens,
   the adapter is put back (ATSH7DF, ATCRA, ATH0, ATAT1, ATST32, ATFCSM0) and the normal init is re-run.
   Works in the browser (window.PROBE) and in Node (require) so it can be tested with the mock adapter. */
(function (root) {
  'use strict';
  var isNode = typeof module !== 'undefined' && module.exports;
  var ELM = isNode ? require('./elm.js') : root.ELM;
  var PIDS = isNode ? require('./pids.js') : root.PIDS;

  var RESTORE = ['ATSH7DF', 'ATCRA', 'ATH0', 'ATAT1', 'ATST32', 'ATFCSM0'];
  var HEX = '0123456789ABCDEF';
  function hx(n) { return HEX[(n >> 4) & 15] + HEX[n & 15]; }
  function hexs(a) { return (a || []).map(hx).join(' '); }
  function cleanRaw(raw) { return String(raw || '').replace(/\r/g, '⏎').replace(/\n/g, '↵').replace(/>/g, '').trim(); }

  // ---------------- parsing (headers ON) ----------------
  /**
   * Split an ELM reply received with ATH1 into CAN frames { id, bytes }.
   * Accepts "7E9 10 12 61 03 .." (spaces on) and "7E910126103.." (ATS0). Lines that carry no CAN id (headers off,
   * "014 / 0: / 1:" layout) fall back to the headerless parser and are reported with id '?'.
   */
  function parseFrames(raw, sent) {
    var lines = ELM.cleanLines(raw, sent), frames = [], other = false;
    lines.forEach(function (l) {
      var toks = l.split(/\s+/).filter(Boolean), compact = l.replace(/\s+/g, '');
      if (!/^[0-9A-F]+$/.test(compact)) { other = true; return; }
      var id = null, hex = null;
      if (toks.length > 1 && /^[0-9A-F]{3}$/.test(toks[0]) && toks.slice(1).every(function (t) { return /^[0-9A-F]{2}$/.test(t); })) { id = toks[0]; hex = toks.slice(1).join(''); }
      else if (toks.length > 1 && /^[0-9A-F]{8}$/.test(toks[0]) && toks.slice(1).every(function (t) { return /^[0-9A-F]{2}$/.test(t); })) { id = toks[0]; hex = toks.slice(1).join(''); }
      else if (toks.length === 1 && compact.length >= 5 && compact.length % 2 === 1 && /^7[0-9A-F]{2}/.test(compact)) { id = compact.slice(0, 3); hex = compact.slice(3); }
      if (id) frames.push({ id: id, bytes: ELM.hexToBytes(hex) });
      else other = true;
    });
    var plain = [];
    if (!frames.length) {
      ELM.parseResponse(raw, sent).forEach(function (m) { plain.push({ id: '?', payload: m, declared: m.length, complete: true, frames: 1 }); });
    }
    return { frames: frames, plain: plain, other: other };
  }

  /** ISO-TP reassembly per CAN id: single frame (0n), first frame (1n ll) + consecutive frames (2n). Flow-control frames (3n) are ignored. */
  function reassemble(frames) {
    var msgs = [], open = {};
    frames.forEach(function (f) {
      var b = f.bytes; if (!b.length) return;
      var pci = b[0] >> 4, m;
      if (pci === 0) { var n = b[0] & 15; msgs.push({ id: f.id, payload: b.slice(1, 1 + n), declared: n, complete: b.length - 1 >= n, frames: 1 }); }
      else if (pci === 1) { m = { id: f.id, payload: b.slice(2), declared: ((b[0] & 15) << 8) | b[1], complete: false, frames: 1 }; open[f.id] = m; msgs.push(m); }
      else if (pci === 2) { m = open[f.id]; if (m) { m.payload = m.payload.concat(b.slice(1)); m.frames++; } }
    });
    msgs.forEach(function (m) {
      if (m.declared > m.payload.length) m.complete = false;
      else { m.payload = m.payload.slice(0, m.declared); m.complete = true; }
    });
    return msgs;
  }

  /**
   * Decide what a reply to `cmd` (e.g. '2133', '0100') amounted to.
   * status: 'data' | 'nrc' | 'first-frame-only' | 'other' (answered, but not with the expected positive reply) | 'no-data' | 'timeout' | 'error' | 'rejected'
   */
  function interpret(cmd, msgs, error) {
    var mode = parseInt(cmd.slice(0, 2), 16), idb = ELM.hexToBytes(cmd.slice(2)), i, m, ok, k;
    var res = { status: null, id: null, data: null, nrc: null, ids: [] };
    msgs.forEach(function (x) { if (x.id && res.ids.indexOf(x.id) < 0) res.ids.push(x.id); });
    for (i = 0; i < msgs.length; i++) {
      m = msgs[i];
      if (m.payload[0] === mode + 0x40) {
        ok = true; for (k = 0; k < idb.length; k++) if (m.payload[1 + k] !== idb[k]) { ok = false; break; }
        if (ok && m.complete) { res.status = 'data'; res.id = m.id; res.data = m.payload.slice(1 + idb.length); return res; }
        if (ok && !m.complete) { res.status = 'first-frame-only'; res.id = m.id; res.data = m.payload.slice(1 + idb.length); res.declared = m.declared; res.gotBytes = m.payload.length; return res; }
      }
    }
    for (i = 0; i < msgs.length; i++) {
      m = msgs[i];
      if (m.payload[0] === 0x7F && m.payload[1] === mode) { res.status = 'nrc'; res.id = m.id; res.nrc = m.payload[2]; return res; }
    }
    if (msgs.length) { res.status = 'other'; res.id = msgs[0].id; return res; }
    var e = String(error || '').toUpperCase();
    res.status = !e ? 'no-data' : /TIMEOUT/.test(e) ? 'timeout' : e === '?' ? 'rejected' : /NO DATA/.test(e) ? 'no-data' : 'error';
    res.error = error || null;
    return res;
  }

  // ---------------- the probe ----------------
  /**
   * Run the probe on a connected Obd instance.
   * opts: { log, onProgress(text, pct), control: {cancelled}, budgetMs (55000), requestTimeout (2600), reinit: async fn, version, onDirty }
   * Always restores the adapter in a finally block and returns { steps, summary, restore, ... }; it does not throw for per-request problems.
   */
  async function run(obd, opts) {
    opts = opts || {};
    var log = opts.log || function () {}, progress = opts.onProgress || function () {};
    var ctl = opts.control || {}, budget = opts.budgetMs || 55000, reqTimeout = opts.requestTimeout || 2600, t0 = Date.now();
    var rep = { version: opts.version || '', startedAt: new Date(t0).toISOString(), steps: [], restore: [], aborted: null, error: null, restoreOk: null, reinit: null, durationMs: 0, ranCustomFlowControl: false };
    var cur = { tx: '7DF', rx: 'none' }, done = 0, TOTAL = 35;
    function Stop(msg) { var e = new Error(msg); e.stop = true; return e; }
    function guard() {
      if (ctl.cancelled) throw Stop('cancelled by user');
      if (obd.s && obd.s.dead) throw Stop('Bluetooth link lost');
      if (Date.now() - t0 > budget) throw Stop('time budget of ' + Math.round(budget / 1000) + ' s used up');
    }
    function tick(text) { done++; progress(text, Math.min(95, Math.round(done * 100 / TOTAL))); }

    async function at(cmd) {
      guard();
      var rec = { kind: 'at', cmd: cmd, raw: '', error: null, ms: 0, tms: Date.now() - t0 }, t1 = Date.now();
      try { rec.raw = await obd.cmd(cmd, 3000); }
      catch (e) { if (e.message === 'CANCELLED' || e.fatal) throw e; rec.error = e.message; rec.raw = e.partial || ''; }
      rec.ms = Date.now() - t1;
      if (!rec.error) { var er = ELM.detectError(rec.raw, cmd); if (er === '?') rec.error = '?'; }
      rec.rejected = rec.error === '?';
      if (!rec.error) { if (/^ATSH/.test(cmd)) cur.tx = cmd.slice(4); if (cmd === 'ATCRA') cur.rx = 'none'; else if (/^ATCRA/.test(cmd)) cur.rx = cmd.slice(5); }
      rep.steps.push(rec);
      log('info', 'PROBE ' + cmd + ' -> ' + (rec.error ? rec.error : cleanRaw(rec.raw) || 'OK'));
      tick(cmd);
      return rec;
    }
    async function req(cmd, note) {
      guard();
      var rec = { kind: 'req', cmd: cmd, note: note || '', tx: cur.tx, rx: cur.rx, raw: '', error: null, ms: 0, tms: Date.now() - t0 }, t1 = Date.now();
      try { rec.raw = await obd.cmd(cmd, reqTimeout); }
      catch (e) { if (e.message === 'CANCELLED' || e.fatal) throw e; rec.error = e.message === 'TIMEOUT' ? 'TIMEOUT (no prompt)' : e.message; rec.raw = e.partial || ''; }
      rec.ms = Date.now() - t1;
      if (!rec.error) { var er = ELM.detectError(rec.raw, cmd); if (er) rec.error = er; }
      var fr = parseFrames(rec.raw, cmd);
      var msgs = reassemble(fr.frames).concat(fr.plain);
      rec.msgs = msgs.map(function (m) { return { id: m.id, payload: m.payload, declared: m.declared, complete: m.complete, frames: m.frames }; });
      rec.frameCount = fr.frames.length;
      rec.result = interpret(cmd, msgs, rec.error);
      rep.steps.push(rec);
      log('info', 'PROBE ' + rec.tx + '/' + rec.rx + ' ' + cmd + ' -> ' + rec.result.status + (rec.result.ids.length ? ' from ' + rec.result.ids.join(',') : '') + ' raw=' + cleanRaw(rec.raw));
      tick(cur.tx + ' ' + cmd);
      return rec;
    }
    try {
      obd.adapter.headerKnown = false; obd.adapter.timingKnown = false; // from here the adapter state is under the probe's control
      progress('Setting up long timeout and headers…', 2);
      // (a) is anything at 7E1 answering J1979? then a functional 0100 with the long timeout (look for a 7E9 line)
      await at('ATAT0'); await at('ATSTFF'); await at('ATH1'); await at('ATCRA'); await at('ATSH7E1');
      await req('0100', '(a) physical J1979 to 7E1'); await req('0142', '(a) physical J1979 to 7E1');
      await at('ATSH7DF'); await req('0100', '(a) functional 7DF, long timeout: look for a 7E9 line');
      // (b) known Lancer CVT service-21 reads
      await at('ATSH7E1'); await req('2107', '(b) selector / brake bits'); await req('2106', '(b) gear number');
      // (c) temperature candidates
      await req('2133', '(c) candidate: first data byte - 50'); await req('2102', '(c) candidate: 6th data byte - 40');
      await req('2122', '(c) ScanGauge CVT: first data byte - 55');
      var r2103 = await req('2103', '(c) Torque N = 14th data byte');
      // (d) custom flow control if the 2103 reply did not arrive complete
      if (r2103.result.status !== 'data') {
        rep.ranCustomFlowControl = true;
        await at('ATCRA7E9'); await at('ATFCSH7E1'); await at('ATFCSD30080A'); await at('ATFCSM1');
        await req('2103', '(d) again with custom flow control (ATFCSM1)');
        await at('ATFCSM0');
      }
      // (e) service 21 on the engine ECU, as a sanity check for this adapter and car
      await at('ATSH7E0'); await at('ATCRA7E8'); await req('211A', '(e) engine ECU service 21 sanity check');
      // (f) any other responder?
      await at('ATCRA');
      for (var h = 2; h <= 7; h++) { await at('ATSH7E' + h); await req('0100', '(f) physical J1979 to 7E' + h); }
    } catch (e) {
      if (e.stop) rep.aborted = e.message; else { rep.error = e.message || String(e); rep.aborted = 'error: ' + rep.error; }
      log('warn', 'PROBE stopped early: ' + rep.aborted);
    } finally {
      progress('Restoring the adapter…', 96);
      var dead = false, allOk = true;
      for (var i = 0; i < RESTORE.length; i++) {
        var c = RESTORE[i], rr = { kind: 'restore', cmd: c, raw: '', error: null };
        if (dead || (obd.s && obd.s.dead)) { dead = true; rr.error = 'skipped (link down)'; allOk = false; rep.restore.push(rr); continue; }
        try { rr.raw = await obd.cmd(c, 3000); var er2 = ELM.detectError(rr.raw, c); if (er2 === '?') rr.error = '? (rejected; harmless on clones)'; }
        catch (e2) {
          rr.error = e2.message; rr.raw = e2.partial || '';
          if (e2.fatal) dead = true;
          else if (e2.message === 'CANCELLED') { // queue was cleared under us: one more try
            try { rr.raw = await obd.cmd(c, 3000); rr.error = null; } catch (e3) { allOk = false; }
          } else allOk = false;
        }
        rep.restore.push(rr);
        log('info', 'PROBE restore ' + c + ' -> ' + (rr.error || cleanRaw(rr.raw) || 'OK'));
      }
      rep.restoreOk = allOk && !dead;
      if (rep.restoreOk) { ELM.resetAdapterState(obd.adapter); }
      else { obd.adapter.headerKnown = false; obd.adapter.timingKnown = false; obd.adapter.dirty = true; if (opts.onDirty) { try { opts.onDirty(); } catch (e4) { /* ignore */ } } }
      if (opts.reinit && !dead) {
        try { progress('Re-running the normal init…', 98); await opts.reinit(); rep.reinit = 'ok'; }
        catch (e5) { rep.reinit = 'failed: ' + (e5 && e5.message); log('warn', 'PROBE re-init failed: ' + (e5 && e5.message)); }
      } else if (opts.reinit) rep.reinit = 'skipped (link down)';
      rep.durationMs = Date.now() - t0;
    }
    rep.summary = summarize(rep);
    progress('Done', 100);
    return rep;
  }

  // ---------------- summary + candidates ----------------
  function round1(v) { return Math.round(v * 10) / 10; }
  function plausible(v) { return v >= -30 && v <= 140; }

  function summarize(rep) {
    var answered = {}, requests = [], i, s;
    rep.steps.forEach(function (st) {
      if (st.kind !== 'req') return;
      st.result.ids.forEach(function (id) {
        if (!answered[id]) answered[id] = [];
        var k = st.tx + ' ' + st.cmd; if (answered[id].indexOf(k) < 0) answered[id].push(k);
      });
      requests.push({ tx: st.tx, rx: st.rx, cmd: st.cmd, note: st.note, status: st.result.status, id: st.result.id, ids: st.result.ids,
        data: st.result.data ? hexs(st.result.data) : '', nrc: st.result.nrc == null ? null : hx(st.result.nrc), error: st.result.error || null, ms: st.ms });
    });
    var cands = [];
    function lastData(cmd) {
      for (var i = rep.steps.length - 1; i >= 0; i--) { var s = rep.steps[i]; if (s.kind === 'req' && s.cmd === cmd && s.tx === '7E1' && s.result.status === 'data') return s; }
      return null;
    }
    var d33 = lastData('2133');
    if (d33 && d33.result.data.length) {
      var dd = d33.result.data, last = dd[dd.length - 1];
      cands.push({ req: '2133', label: 'last byte - 50', raw: hexs(dd), value: last - 50 });
      if (dd.length > 1) cands.push({ req: '2133', label: 'first byte - 50 (Pelican A-50)', raw: hexs(dd), value: dd[0] - 50 });
    }
    var d02 = lastData('2102');
    if (d02 && d02.result.data.length > 5) cands.push({ req: '2102', label: '6th data byte - 40 (letter F)', raw: hexs(d02.result.data), value: d02.result.data[5] - 40 });
    var d22 = lastData('2122');
    if (d22 && d22.result.data.length) {
      var b22 = d22.result.data;
      cands.push({ req: '2122', label: 'first byte - 55 (ScanGauge CVT)', raw: hexs(b22), value: b22[0] - 55 });
      if (b22.length > 3) cands.push({ req: '2122', label: '4th data byte - 55 (ScanGauge TFT RXD 4008)', raw: '', value: b22[3] - 55 });
    }
    var d03 = null;
    for (i = rep.steps.length - 1; i >= 0; i--) { s = rep.steps[i]; if (s.kind === 'req' && s.cmd === '2103' && s.tx === '7E1' && s.result.status === 'data') { d03 = s; break; } }
    if (d03) {
      var dt = d03.result.data;
      if (dt.length > 13) {
        var N = dt[13];
        cands.push({ req: '2103', label: 'Torque N (14th data byte) = ' + N + ', polynomial (JF011E list)', raw: hexs(dt), value: PIDS.cvtPoly(N) });
        cands.push({ req: '2103', label: 'N - 55 (CVT8 list)', raw: '', value: N - 55 });
        cands.push({ req: '2103', label: '"CVT temp 2" cubic on N', raw: '', value: PIDS.cvtCubic(N) });
      } else cands.push({ req: '2103', label: 'reply has only ' + dt.length + ' data bytes, byte N (14th) is missing', raw: hexs(dt), value: null });
      if (dt.length > 9) cands.push({ req: '2103', label: '10th data byte - 55 (letter J, OBDb)', raw: '', value: dt[9] - 55 });
    }
    cands.forEach(function (c) { if (c.value != null) { c.value = round1(c.value); c.plausible = plausible(c.value); } });
    var ids = Object.keys(answered).sort();
    function got(tx, cmd) { return requests.some(function (r) { return r.tx === tx && r.cmd === cmd && r.status === 'data'; }); }
    var tcmIds = ids.filter(function (x) { return x === '7E9'; });
    var hints = [];
    var tcmAnswered = !!answered['7E9'];
    var functional7E9 = requests.some(function (r) { return r.tx === '7DF' && r.cmd === '0100' && r.ids.indexOf('7E9') >= 0; });
    var cvtAny = requests.some(function (r) { return r.tx === '7E1' && /^21/.test(r.cmd) && r.status === 'data'; });
    if (!ids.length) hints.push('Nothing answered at all. Key on? Is the link still alive? Check the Console log.');
    else if (!tcmAnswered) hints.push('Only ' + ids.join(', ') + ' answered. 7E9 (the CVT TCM) stayed silent even with ATSTFF and no filter: engine running or key on, cold or warm, and the PIDs below may simply not exist on this TCM. Try the Other-modules results and send the report.');
    if (tcmAnswered && !cvtAny) hints.push('7E9 answered, but not to any service-21 request that worked. Look at the negative-response (NRC) lines: they say which request the TCM understood.');
    if (functional7E9) hints.push('The TCM DID answer a functional 0100 with the long timeout: the earlier single-responder result was a timing issue, not a missing module.');
    if (cvtAny && !cands.length) hints.push('The TCM answered service 21 but no temperature candidate could be decoded; send the raw replies.');
    if (cvtAny && cands.length) hints.push('Compare the candidates with outside / coolant temperature on a cold car (key on a few minutes) and again warm; the right one tracks ambient to coolant-like.');
    if (rep.ranCustomFlowControl) hints.push('The 2103 retry with custom flow control (ATFCSM1) was needed or tried; compare its result with the first 2103.');
    return { answered: answered, ids: ids, tcmIds: tcmIds, requests: requests, candidates: cands, hints: hints, tcmAnswered: tcmAnswered,
      functionalTcm: functional7E9, cvtService21: cvtAny, aborted: rep.aborted, restoreOk: rep.restoreOk, reinit: rep.reinit, durationMs: rep.durationMs, anyGot: got };
  }

  // ---------------- text report ----------------
  function describe(r) {
    switch (r.status) {
      case 'data': return 'DATA from ' + r.id + (r.data ? ': ' + r.data : '');
      case 'first-frame-only': return 'FIRST FRAME ONLY from ' + r.id + (r.data ? ': ' + r.data : '') + ' (rest of the reply never arrived: flow control?)';
      case 'nrc': return 'NEGATIVE RESPONSE 7F ' + r.cmd.slice(0, 2) + ' ' + r.nrc + ' from ' + r.id;
      case 'other': return 'answered from ' + (r.ids.join(',') || '?') + ' but not with the expected positive reply';
      case 'no-data': return 'NO DATA';
      case 'timeout': return 'TIMEOUT (adapter never finished)';
      case 'rejected': return 'adapter replied "?"';
      default: return (r.error || 'error');
    }
  }

  /** Plain-text report for pasting into a chat, with the full raw replies. ctx: { app, ua, info:{elm,protocol,voltage,vin} } */
  function formatReport(rep, ctx) {
    ctx = ctx || {}; var info = ctx.info || {}, sm = rep.summary || summarize(rep), L = [];
    L.push('=== OBD Scanner CVT probe report ===');
    L.push('App: ' + (ctx.app || rep.version) + '   Time: ' + rep.startedAt + '   Duration: ' + (rep.durationMs / 1000).toFixed(1) + ' s');
    if (ctx.ua) L.push('UA: ' + ctx.ua);
    L.push('Adapter: ' + (info.elm || '?') + '   Protocol: ' + (info.protocol || '?') + '   Battery: ' + (info.voltage || '?') + '   VIN: ' + (info.vin || '?'));
    L.push('Probe: read-only (AT setup + services 01 and 21). Restore: ' + (rep.restoreOk ? 'ok' : 'INCOMPLETE') + '   Re-init: ' + (rep.reinit || 'n/a') + (rep.aborted ? '   STOPPED EARLY: ' + rep.aborted : ''));
    L.push('');
    L.push('--- Summary ---');
    L.push('Addresses that answered: ' + (sm.ids.length ? sm.ids.map(function (id) { return id + ' (' + sm.answered[id].join(', ') + ')'; }).join('; ') : 'none'));
    L.push('7E9 (CVT TCM) answered: ' + (sm.tcmAnswered ? 'YES' : 'no') + '   service 21 data from TCM: ' + (sm.cvtService21 ? 'YES' : 'no') + '   functional 0100 showed 7E9: ' + (sm.functionalTcm ? 'YES' : 'no'));
    L.push('Requests:');
    sm.requests.forEach(function (r) { L.push('  ' + r.tx + (r.rx !== 'none' ? '/' + r.rx : '') + '  ' + r.cmd + '  ->  ' + describe(r) + '  [' + r.ms + ' ms]' + (r.note ? '  ' + r.note : '')); });
    L.push('Candidate temperatures (EXPERIMENTAL, check against ambient/coolant):');
    if (!sm.candidates.length) L.push('  (none decoded)');
    sm.candidates.forEach(function (c) { L.push('  ' + c.req + ': ' + c.label + ' = ' + (c.value == null ? 'n/a' : c.value + ' C / ' + round1(c.value * 9 / 5 + 32) + ' F') + (c.plausible === false ? '  (implausible)' : '') + (c.raw ? '   data: ' + c.raw : '')); });
    sm.hints.forEach(function (h) { L.push('Note: ' + h); });
    L.push('');
    L.push('--- Full transcript (raw replies; ⏎ = CR) ---');
    rep.steps.forEach(function (st) {
      if (st.kind === 'at') L.push('+' + (st.tms / 1000).toFixed(1) + 's  ' + st.cmd + '  <- ' + (st.error ? st.error : cleanRaw(st.raw) || 'OK'));
      else {
        L.push('+' + (st.tms / 1000).toFixed(1) + 's  [' + st.tx + (st.rx !== 'none' ? '/' + st.rx : '') + '] ' + st.cmd + '  ' + st.note + '  (' + st.ms + ' ms)');
        L.push('        raw: ' + (cleanRaw(st.raw) || '(empty)') + (st.error ? '   error: ' + st.error : ''));
        (st.msgs || []).forEach(function (m) { L.push('        ' + m.id + ' payload (' + m.payload.length + ' of ' + m.declared + ' bytes' + (m.complete ? '' : ', INCOMPLETE') + '): ' + hexs(m.payload)); });
      }
    });
    L.push('--- Restore ---');
    rep.restore.forEach(function (r) { L.push(r.cmd + '  <- ' + (r.error || cleanRaw(r.raw) || 'OK')); });
    L.push('=== end of report ===');
    return L.join('\n');
  }

  var api = { run: run, parseFrames: parseFrames, reassemble: reassemble, interpret: interpret, summarize: summarize, formatReport: formatReport, RESTORE: RESTORE };
  if (isNode) module.exports = api; else root.PROBE = api;
})(this);
