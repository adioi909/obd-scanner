/* UI controller. */
(function () {
  'use strict';
  var APP_VERSION = 'v1.5';
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); };

  var settings = Store.loadSettings();
  var profiles = Store.loadProfiles();
  var state = { lastDevice: null, transport: null, session: null, obd: null, connected: false, connecting: null, live: false, recording: null, supported: null, vin: null };

  // ---------------- Console log ----------------
  var LOG_MAX = 1500, logLines = [];
  function log(kind, text) {
    if ((kind === 'rx' || kind === 'tx') && state.live && !$('#con-rx').checked) return;
    var t = new Date();
    var ts = t.toTimeString().slice(0, 8) + '.' + String(t.getMilliseconds()).padStart(3, '0');
    var shown = kind === 'rx' ? String(text).replace(/\r/g, '⏎').replace(/\n/g, '↵') : text;
    var prefix = kind === 'tx' ? '→ ' : kind === 'rx' ? '← ' : kind === 'warn' ? '! ' : '· ';
    logLines.push({ kind: kind, line: ts + ' ' + prefix + shown });
    if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
    scheduleConsole();
  }
  var conTimer = null;
  function scheduleConsole() {
    if (conTimer) return;
    conTimer = setTimeout(function () {
      conTimer = null;
      var el = $('#console');
      if (!$('#view-console').classList.contains('active')) return;
      var atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
      el.innerHTML = logLines.slice(-400).map(function (l) { return '<span class="' + l.kind + '">' + esc(l.line) + '</span>'; }).join('\n');
      if (atBottom) el.scrollTop = el.scrollHeight;
    }, 150);
  }

  function toast(msg, ms) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, ms || 2500);
  }
  function confirmDlg(title, body, okText) {
    return new Promise(function (resolve) {
      var d = $('#dlg'); $('#dlg-title').textContent = title; $('#dlg-body').textContent = body; $('#dlg-ok').textContent = okText || 'OK';
      d.onclose = function () { resolve(d.returnValue === 'ok'); };
      d.returnValue = ''; d.showModal();
    });
  }
  function setStatus(cls, text) { var s = $('#status'); s.className = 'pill ' + cls; s.textContent = text; }

  // ---------------- Tabs ----------------
  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () { showView(b.dataset.view); });
  });
  function showView(v) {
    document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.toggle('active', x.dataset.view === v); });
    document.querySelectorAll('.view').forEach(function (x) { x.classList.toggle('active', x.id === 'view-' + v); });
    if (v === 'console') scheduleConsole();
    if (v === 'logs') renderSessions();
    if (v === 'profiles') renderProfiles();
    if (v === 'live') renderTiles();
    window.scrollTo(0, 0);
  }

  // ---------------- Settings ----------------
  function bindSettings() {
    $('#s-units').value = settings.units; $('#s-proto').value = settings.protocol;
    $('#s-multi').checked = settings.multiPid; $('#s-fast').checked = settings.fastResponse;
    $('#s-write').value = settings.writeMode; $('#s-notify').value = settings.notifyChar || 'auto'; $('#s-timeout').value = settings.timeout;
    var save = function () {
      settings.units = $('#s-units').value; settings.protocol = $('#s-proto').value;
      settings.multiPid = $('#s-multi').checked; settings.fastResponse = $('#s-fast').checked;
      settings.writeMode = $('#s-write').value; settings.notifyChar = $('#s-notify').value; settings.timeout = Math.max(500, +$('#s-timeout').value || 2500);
      Store.saveSettings(settings);
      if (state.obd) { state.obd.multiPid = settings.multiPid; state.obd.fastResponse = settings.fastResponse; }
      if (state.session) state.session.opts.timeout = settings.timeout;
      if (state.obd) state.obd.opts.pidTimeout = settings.timeout;
      renderTiles();
    };
    ['#s-units', '#s-proto', '#s-multi', '#s-fast', '#s-write', '#s-notify', '#s-timeout'].forEach(function (id) { $(id).addEventListener('change', save); });
  }

  // ---------------- Connect ----------------
  if (!Transport.BleTransport.isSupported()) $('#bt-warning').classList.remove('hidden');

  async function connect(kind, acceptAll) {
    if (state.connected) await disconnect();
    else if (state.transport) {
      // Link was lost or a previous attempt failed: drop leftover GATT/listeners before a new connect.
      var prev = state.transport;
      state.transport = null;
      if (state.session) { try { state.session.clearQueue(); } catch (e) { /* ignore */ } state.session = null; }
      prev.onDisconnect = function () {};
      try { await prev.disconnect(); } catch (e) { /* ignore */ }
      log('info', 'Cleaned up the previous GATT session; waiting 800ms before reconnecting');
      await sleep(800);
    }
    var t;
    try {
      if (kind === 'mock') t = new Transport.MockTransport({ log: log });
      else {
        if (!Transport.BleTransport.isSupported()) { toast('Web Bluetooth not available here. Use Chrome on Android.'); return; }
        t = new Transport.BleTransport({ log: log, writeMode: settings.writeMode, notifyChar: settings.notifyChar, onStatus: function (m) { setStatus('busy', m); var pt = $('#conn-progress-text'); if (pt) pt.textContent = m; } });
        await t.request(acceptAll); // must run directly from the click gesture
        state.lastDevice = t.device;
      }
      setStatus('busy', 'Connecting…');
      if (t.kind === 'ble') { state.connecting = t; $('#conn-progress-text').textContent = 'Connecting…'; $('#conn-progress').classList.remove('hidden'); $('#conn-help').classList.add('hidden'); }
      await t.connect();
    } catch (e) {
      log('warn', 'Connect failed: ' + (e && e.message));
      var userCancelled = e && (e.name === 'NotFoundError' || e.cancelled);
      setStatus(userCancelled ? 'off' : 'err', userCancelled ? 'Disconnected' : 'Connect failed');
      state.connecting = null; $('#conn-progress').classList.add('hidden');
      if (t && t.disconnect && t.device) { try { await t.disconnect(); } catch (x) { /* ignore */ } }
      if (e && e.cancelled) toast('Connect cancelled', 3000);
      else if (!userCancelled) { $('#conn-help').classList.remove('hidden'); toast('Connect failed: ' + (e && e.message), 8000); }
      return;
    }
    state.connecting = null; $('#conn-progress').classList.add('hidden');
    $('#conn-help').classList.add('hidden');
    state.transport = t;
    t.onDisconnect = function () { onLinkLost(); };
    state.session = new Transport.ElmSession(t, { log: log, timeout: settings.timeout });
    state.obd = new OBD.Obd(state.session, { log: log, multiPid: settings.multiPid, fastResponse: settings.fastResponse, pidTimeout: settings.timeout });
    state.connected = true;
    var bleLabel = t.kind === 'mock' ? 'Simulated' : (t.name + ' · ' + (t.profileName || '') + (t.subscribed && t.subscribed.length ? ' · ntf ' + t.subscribed.map(function (c) { return Transport.shortUuid(c.uuid); }).join('+') : ''));
    $('#i-ble').textContent = bleLabel;
    $('#btn-disconnect').classList.remove('hidden'); $('#btn-reinit').classList.remove('hidden');
    try {
      await initElm();
    } catch (e) {
      log('warn', 'Init failed: ' + (e && e.message));
      setStatus('err', e && e.fatal ? 'Bluetooth link failed' : 'Init failed');
      toast((e && e.fatal ? 'Bluetooth link failed: ' : 'Init failed: ') + (e && e.message) + ' Copy the Console log.', 6000);
    }
  }

  async function initElm() {
    var o = state.obd;
    setStatus('busy', 'Initializing ELM…');
    var info = await o.init(settings.protocol);
    $('#i-elm').textContent = info.elm || '--';
    $('#i-volt').textContent = info.voltage || '--';
    if (!info.adapterOk) {
      $('#i-proto').textContent = 'No adapter response';
      setStatus('err', 'No adapter response');
      toast('Dongle did not answer. Open Console, Copy log, and send it.', 5000);
      return;
    }
    $('#i-proto').textContent = info.ecuOk ? info.protocol : ('No ECU response (' + (info.ecuError || '?') + ')');
    if (!info.ecuOk) {
      setStatus('err', 'Adapter OK, no ECU');
      toast('Adapter answered but the car did not. Key on? Try protocol ATSP6.', 4000);
      return;
    }
    setStatus('busy', 'Reading vehicle…');
    var sup = await o.readSupported();
    state.supported = sup;
    $('#i-sup').textContent = sup.length + ' (' + sup.filter(function (p) { return PIDS.get(p); }).length + ' in library)';
    var vin = await o.readVin();
    state.vin = vin; $('#i-vin').textContent = vin || 'not reported';
    var mon = await o.readMonitor();
    $('#i-mil').textContent = mon ? ((mon.mil ? 'MIL ON' : 'MIL off') + ' · ' + mon.count + ' stored') : '--';
    var ntf = state.transport.activeNotifyUuid ? (' · RX ' + Transport.shortUuid(state.transport.activeNotifyUuid)) : '';
    setStatus('on', (state.transport.kind === 'mock' ? 'Demo · ' : '') + (state.transport.name || 'Connected') + ntf);
    log('info', 'Init complete' + (state.transport.activeNotifyUuid ? ' (RX on ' + state.transport.activeNotifyUuid + ', ' + (state.transport.writeModeLabel ? state.transport.writeModeLabel() : '') + ')' : ''));
    renderTiles();
  }

  function onLinkLost() {
    if (!state.connected) return;
    state.connected = false;
    stopLive();
    if (state.session) { try { state.session.clearQueue(); } catch (e) { /* ignore */ } }
    var t = state.transport;
    if (t) {
      t.onDisconnect = function () {};
      try { t.disconnect(); } catch (e) { /* ignore */ }
    }
    setStatus('err', 'Link lost');
    toast('Bluetooth link lost. Wait a moment, then tap Connect.', 4000);
    $('#btn-disconnect').classList.add('hidden'); $('#btn-reinit').classList.add('hidden');
  }

  async function disconnect() {
    await stopLive();
    var t = state.transport; state.connected = false;
    if (state.session) state.session.clearQueue();
    if (t) { t.onDisconnect = function () {}; try { await t.disconnect(); } catch (e) { /* ignore */ } }
    state.transport = state.session = state.obd = null;
    setStatus('off', 'Disconnected');
    $('#btn-disconnect').classList.add('hidden'); $('#btn-reinit').classList.add('hidden');
  }

  $('#btn-cancel-connect').onclick = function () { if (state.connecting) { setStatus('busy', 'Cancelling…'); state.connecting.cancel(); } };
  $('#btn-connect').onclick = function () { connect('ble', false); };
  $('#btn-connect-all').onclick = function () { connect('ble', true); };
  $('#btn-mock').onclick = function () { connect('mock'); };
  $('#btn-disconnect').onclick = disconnect;
  $('#btn-forget').onclick = async function () {
    await disconnect();
    var n = 0;
    try {
      var ghost = new Transport.BleTransport({ log: log });
      ghost.device = state.lastDevice;
      n = await ghost.forget();
    } catch (e) { log('warn', 'Forget failed: ' + e.message); }
    state.lastDevice = null;
    log('info', 'Forgot ' + n + ' saved Bluetooth device permission(s)');
    $('#i-ble').textContent = '--'; $('#i-elm').textContent = '--'; $('#i-proto').textContent = '--'; $('#i-vin').textContent = '--';
    setStatus('off', 'Disconnected');
    toast(n ? 'Forgot ' + n + ' saved device(s). Tap Connect dongle and pick OBDII again.' : 'No saved device to forget here. If OBDII is listed in Android Bluetooth settings, unpair it, then Connect.', 7000);
  };
  $('#btn-reinit').onclick = function () { if (state.connected) initElm(); };

  function requireConn() { if (!state.connected) { toast('Connect the dongle first (or use Demo mode)'); return false; } return true; }

  // ---------------- Profiles ----------------
  function activeProfile() { return profiles.find(function (p) { return p.id === settings.activeProfile; }) || profiles[0]; }

  function renderProfileSelect() {
    var sel = $('#live-profile');
    sel.innerHTML = profiles.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + p.pids.length + ')</option>'; }).join('');
    var a = activeProfile(); if (a) sel.value = a.id;
  }
  $('#live-profile').addEventListener('change', function (e) {
    if (state.recording) { toast('Stop recording before switching profile'); renderProfileSelect(); return; }
    settings.activeProfile = e.target.value; Store.saveSettings(settings); renderTiles();
  });

  function renderProfiles() {
    var el = $('#profile-list');
    el.innerHTML = '<div class="card"><h2>Profiles</h2>' + profiles.map(function (p) {
      return '<div class="list-item"><div><b>' + esc(p.name) + '</b><div class="meta">' + p.pids.map(function (x) { var d = PIDS.get(x); return d ? esc(d.short) : x; }).join(' · ') + '</div></div>' +
        '<div class="btn-row"><button class="btn small" data-edit="' + esc(p.id) + '">Edit</button><button class="btn small danger" data-del="' + esc(p.id) + '">Delete</button></div></div>';
    }).join('') + (profiles.length ? '' : '<div class="empty">No profiles.</div>') +
      '<div class="btn-row"><button class="btn primary big grow" id="btn-new-prof">+ New profile</button><button class="btn big" id="btn-restore">Restore presets</button></div></div>';
    el.querySelectorAll('[data-edit]').forEach(function (b) { b.onclick = function () { editProfile(b.dataset.edit); }; });
    el.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = async function () {
        var p = profiles.find(function (x) { return x.id === b.dataset.del; });
        if (!(await confirmDlg('Delete profile?', 'Delete "' + p.name + '"? Recorded sessions are kept.', 'Delete'))) return;
        profiles = profiles.filter(function (x) { return x.id !== p.id; }); Store.saveProfiles(profiles); renderProfiles(); renderProfileSelect();
      };
    });
    $('#btn-new-prof').onclick = function () { editProfile(null); };
    $('#btn-restore').onclick = function () { profiles = Store.restorePresets(profiles); renderProfiles(); renderProfileSelect(); toast('Presets restored'); };
  }

  function editProfile(id) {
    var p = id ? profiles.find(function (x) { return x.id === id; }) : { id: 'p-' + Date.now().toString(36), name: '', pids: [] };
    var chosen = p.pids.slice();
    var ed = $('#profile-editor');
    var onlySup = !!state.supported;
    function draw() {
      var html = '<h2>' + (id ? 'Edit profile' : 'New profile') + '</h2>' +
        '<input type="text" id="pe-name" placeholder="Profile name, e.g. Cooling system" style="width:100%" value="' + esc(p.name) + '">' +
        '<label class="row">Only show PIDs this car supports' + (state.supported ? '' : ' (connect first)') + '<input type="checkbox" id="pe-only" ' + (onlySup ? 'checked' : '') + (state.supported ? '' : ' disabled') + '></label>' +
        '<div class="meta" id="pe-count">' + chosen.length + ' selected</div>';
      PIDS.CATEGORIES.forEach(function (cat) {
        var defs = PIDS.DEFS.filter(function (d) { return d.cat === cat; });
        if (onlySup && state.supported) defs = defs.filter(function (d) { return state.supported.indexOf(d.pid) >= 0 || chosen.indexOf(d.pid) >= 0; });
        if (!defs.length) return;
        html += '<div class="pid-group"><h4>' + esc(cat) + '</h4>' + defs.map(function (d) {
          var sup = state.supported ? state.supported.indexOf(d.pid) >= 0 : null;
          return '<label class="pid-opt' + (sup === false ? ' unsup' : '') + '"><input type="checkbox" data-pid="' + d.pid + '" ' + (chosen.indexOf(d.pid) >= 0 ? 'checked' : '') + '>' +
            '<span class="nm">' + esc(d.name) + ' <span class="pidc">01' + d.pid + '</span></span>' + (sup ? '<span class="badge">car ✓</span>' : '') + '</label>';
        }).join('') + '</div>';
      });
      html += '<div class="btn-row" style="position:sticky;bottom:72px;background:var(--card);padding:8px 0"><button class="btn big grow" id="pe-cancel">Cancel</button><button class="btn primary big grow" id="pe-save">Save</button></div>';
      ed.innerHTML = html;
      ed.querySelectorAll('[data-pid]').forEach(function (c) {
        c.onchange = function () {
          var pid = c.dataset.pid;
          if (c.checked) { if (chosen.indexOf(pid) < 0) chosen.push(pid); } else chosen = chosen.filter(function (x) { return x !== pid; });
          $('#pe-count').textContent = chosen.length + ' selected';
        };
      });
      var only = $('#pe-only'); if (only) only.onchange = function () { p.name = $('#pe-name').value; onlySup = only.checked; draw(); };
      $('#pe-cancel').onclick = function () { ed.classList.add('hidden'); $('#profile-list').classList.remove('hidden'); };
      $('#pe-save').onclick = function () {
        var name = $('#pe-name').value.trim();
        if (!name) { toast('Give the profile a name'); return; }
        if (!chosen.length) { toast('Pick at least one PID'); return; }
        p.name = name; p.pids = chosen;
        if (!id) profiles.push(p);
        Store.saveProfiles(profiles);
        ed.classList.add('hidden'); $('#profile-list').classList.remove('hidden');
        renderProfiles(); renderProfileSelect(); toast('Profile saved');
      };
    }
    draw();
    $('#profile-list').classList.add('hidden'); ed.classList.remove('hidden'); window.scrollTo(0, 0);
  }

  // ---------------- Live data ----------------
  var tileStats = {};
  function renderTiles() {
    renderProfileSelect();
    var p = activeProfile(); var el = $('#tiles');
    if (!p) { el.innerHTML = '<div class="empty">Create a profile first.</div>'; return; }
    el.innerHTML = p.pids.map(function (pid) {
      var d = PIDS.get(pid); if (!d) return '';
      var unsup = state.supported && state.supported.indexOf(pid) < 0;
      return '<div class="tile" id="tile-' + pid + '"' + (unsup ? ' style="opacity:.5"' : '') + '><div class="lbl">' + esc(d.short) + (unsup ? ' (n/s)' : '') + '</div>' +
        '<div><span class="val">--</span><span class="unit">' + esc(PIDS.unitFor(pid, settings.units)) + '</span></div>' +
        '<div class="bar"><i></i></div><div class="mm"><span class="mn">min --</span><span class="mx">max --</span></div></div>';
    }).join('');
    tileStats = {};
  }
  function updateTiles(values) {
    Object.keys(values).forEach(function (pid) {
      var el = document.getElementById('tile-' + pid); if (!el) return;
      var disp = PIDS.toDisplay(pid, values[pid], settings.units);
      var st = tileStats[pid] || (tileStats[pid] = { min: Infinity, max: -Infinity });
      if (disp.value != null) { st.min = Math.min(st.min, disp.value); st.max = Math.max(st.max, disp.value); }
      el.querySelector('.val').textContent = PIDS.format(disp.value, disp.unit);
      el.querySelector('.mn').textContent = 'min ' + PIDS.format(st.min, disp.unit);
      el.querySelector('.mx').textContent = 'max ' + PIDS.format(st.max, disp.unit);
      var pct = Math.max(0, Math.min(100, (disp.value - disp.min) / (disp.max - disp.min) * 100));
      el.querySelector('.bar i').style.width = (isNaN(pct) ? 0 : pct) + '%';
    });
  }

  var wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', function () { wakeLock = null; }); }
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { /* ignore */ }
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && state.live) keepAwake(true); });

  var liveLoop = null;
  async function startLive() {
    if (!requireConn() || state.live) return;
    var p = activeProfile(); if (!p || !p.pids.length) { toast('Pick a profile with PIDs'); return; }
    var pids = p.pids.filter(function (x) { return PIDS.get(x) && (!state.supported || state.supported.indexOf(x) >= 0); });
    if (!pids.length) { toast('This car supports none of the PIDs in this profile'); return; }
    state.live = true; $('#btn-live').textContent = 'Stop live'; keepAwake(true);
    log('info', 'Live start: ' + pids.join(',') + ' (raw request/response lines are always logged)');
    var cycles = 0, t0 = Date.now(), recent = [];
    liveLoop = (async function () {
      while (state.live && state.connected) {
        var vals;
        try { vals = await state.obd.queryPids(pids); } catch (e) { if (e.message === 'CANCELLED') break; log('warn', e.message); await sleep(300); continue; }
        var now = Date.now();
        cycles++; recent.push(now); while (recent.length && now - recent[0] > 5000) recent.shift();
        updateTiles(vals);
        if (state.recording) recordRow(now, vals);
        var rate = recent.length > 1 ? (recent.length - 1) / ((recent[recent.length - 1] - recent[0]) / 1000) : 0;
        $('#st-rate').textContent = rate.toFixed(1) + ' Hz';
        var since = state.recording ? state.recording.meta.start : t0;
        $('#st-samples').textContent = (state.recording ? state.recording.meta.samples : cycles) + (state.recording ? ' recorded' : ' reads');
        $('#st-time').textContent = fmtDur(now - since);
        if (!Object.keys(vals).length) await sleep(200);
      }
    })();
  }
  async function stopLive() {
    if (state.recording) await stopRecording();
    if (!state.live) return;
    state.live = false; $('#btn-live').textContent = 'Start live'; keepAwake(false);
    if (liveLoop) { try { await liveLoop; } catch (e) { /* ignore */ } liveLoop = null; }
  }
  $('#btn-live').onclick = function () { state.live ? stopLive() : startLive(); };

  // ---------------- Recording ----------------
  async function startRecording() {
    if (!requireConn()) return;
    var p = activeProfile(); if (!p) return;
    var meta = { id: 's-' + Date.now(), name: p.name + ' ' + new Date().toLocaleString(), profile: p.name, pids: p.pids.slice(), start: Date.now(), end: null, samples: 0, vin: state.vin || null, adapter: state.transport.kind };
    await Store.putSession(meta);
    state.recording = { meta: meta, buf: [], flushTimer: setInterval(flush, 2000) };
    $('#btn-rec').textContent = '■ Stop recording'; $('#btn-rec').classList.add('on');
    if (!state.live) await startLive();
    toast('Recording started');
  }
  function recordRow(t, vals) { var r = state.recording; r.buf.push({ sid: r.meta.id, t: t, v: vals }); r.meta.samples++; }
  async function flush() {
    var r = state.recording; if (!r || !r.buf.length) return;
    var rows = r.buf; r.buf = []; r.meta.end = Date.now();
    try { await Store.addRows(rows); await Store.putSession(r.meta); } catch (e) { log('warn', 'Save failed: ' + e.message); }
  }
  async function stopRecording() {
    var r = state.recording; if (!r) return;
    clearInterval(r.flushTimer); await flush(); r.meta.end = Date.now(); await Store.putSession(r.meta);
    state.recording = null;
    $('#btn-rec').textContent = '● Record'; $('#btn-rec').classList.remove('on');
    toast('Saved ' + r.meta.samples + ' samples to Logs');
  }
  $('#btn-rec').onclick = function () { state.recording ? stopRecording() : startRecording(); };

  // ---------------- Sessions / logs ----------------
  async function renderSessions() {
    var list = await Store.listSessions();
    var el = $('#session-list');
    el.innerHTML = '<div class="card"><h2>Recorded sessions</h2>' + (list.length ? list.map(function (s) {
      var dur = (s.end || s.start) - s.start; var rate = dur > 0 ? s.samples / (dur / 1000) : 0;
      return '<div class="list-item"><div><b>' + esc(s.name) + '</b><div class="meta">' + s.samples + ' samples · ' + fmtDur(dur) + ' · ' + rate.toFixed(1) + ' Hz' + (s.adapter === 'mock' ? ' · demo' : '') + '</div></div>' +
        '<div class="btn-row"><button class="btn small" data-view-s="' + s.id + '">View</button><button class="btn small" data-csv="' + s.id + '">CSV</button><button class="btn small danger" data-del-s="' + s.id + '">✕</button></div></div>';
    }).join('') : '<div class="empty">No sessions yet. Go to Live, pick a profile and hit Record.</div>') + '</div>';
    el.querySelectorAll('[data-view-s]').forEach(function (b) { b.onclick = function () { viewSession(b.dataset.viewS); }; });
    el.querySelectorAll('[data-csv]').forEach(function (b) { b.onclick = function () { exportCsv(b.dataset.csv); }; });
    el.querySelectorAll('[data-del-s]').forEach(function (b) {
      b.onclick = async function () {
        if (!(await confirmDlg('Delete session?', 'This permanently deletes the recorded data.', 'Delete'))) return;
        await Store.deleteSession(b.dataset.delS); renderSessions(); $('#session-detail').classList.add('hidden');
      };
    });
  }

  async function sessionData(sid) {
    var list = await Store.listSessions();
    var meta = list.find(function (s) { return s.id === sid; });
    var rows = await Store.getRows(sid);
    return { meta: meta, rows: rows };
  }

  async function viewSession(sid) {
    var sd = await sessionData(sid); var m = sd.meta, rows = sd.rows;
    var el = $('#session-detail');
    var xs = rows.map(function (r) { return (r.t - m.start) / 1000; });
    var html = '<div class="card"><div class="btn-row"><button class="btn small" id="sd-close">← Back</button><button class="btn small" id="sd-csv">Export CSV</button>' +
      (navigator.canShare ? '<button class="btn small" id="sd-share">Share</button>' : '') + '</div><h3 style="margin-top:10px">' + esc(m.name) + '</h3>' +
      '<div class="meta">' + rows.length + ' samples · ' + fmtDur((m.end || m.start) - m.start) + (m.vin ? ' · VIN ' + esc(m.vin) : '') + '</div>';
    m.pids.forEach(function (pid) {
      var d = PIDS.get(pid); if (!d) return;
      var ys = rows.map(function (r) { var v = r.v[pid]; return v == null ? null : PIDS.toDisplay(pid, v, settings.units).value; });
      var valid = ys.filter(function (v) { return v != null; });
      var unit = PIDS.unitFor(pid, settings.units);
      var mn = valid.length ? Math.min.apply(null, valid) : null, mx = valid.length ? Math.max.apply(null, valid) : null;
      var avg = valid.length ? valid.reduce(function (a, b) { return a + b; }, 0) / valid.length : null;
      html += '<div class="chart-box"><div class="lbl"><b style="color:var(--text)">' + esc(d.name) + ' (' + esc(unit) + ')</b><span>min ' + PIDS.format(mn, unit) + ' · avg ' + PIDS.format(avg, unit) + ' · max ' + PIDS.format(mx, unit) + '</span></div><canvas data-chart="' + pid + '"></canvas></div>';
    });
    html += '</div>';
    el.innerHTML = html; el.classList.remove('hidden'); $('#session-list').classList.add('hidden');
    el.querySelectorAll('canvas[data-chart]').forEach(function (c) {
      var pid = c.dataset.chart;
      Chart.drawLine(c, xs, rows.map(function (r) { var v = r.v[pid]; return v == null ? null : PIDS.toDisplay(pid, v, settings.units).value; }));
    });
    $('#sd-close').onclick = function () { el.classList.add('hidden'); $('#session-list').classList.remove('hidden'); };
    $('#sd-csv').onclick = function () { exportCsv(sid); };
    var sh = $('#sd-share'); if (sh) sh.onclick = function () { exportCsv(sid, true); };
    window.scrollTo(0, 0);
  }

  function buildCsv(meta, rows, units) {
    var pids = meta.pids.filter(function (p) { return PIDS.get(p); });
    var head = ['timestamp', 'elapsed_s'].concat(pids.map(function (p) { var d = PIDS.get(p); return d.name + ' (' + PIDS.unitFor(p, units) + ') [01' + p + ']'; }));
    var q = function (s) { s = String(s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var lines = [head.map(q).join(',')];
    rows.forEach(function (r) {
      var cols = [new Date(r.t).toISOString(), ((r.t - meta.start) / 1000).toFixed(3)];
      pids.forEach(function (p) { var v = r.v[p]; cols.push(v == null ? '' : +PIDS.toDisplay(p, v, units).value.toFixed(3)); });
      lines.push(cols.join(','));
    });
    return lines.join('\r\n');
  }
  window.__buildCsv = buildCsv; // for tests

  async function exportCsv(sid, share) {
    var sd = await sessionData(sid);
    var csv = buildCsv(sd.meta, sd.rows, settings.units);
    var fname = sd.meta.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') + '.csv';
    var blob = new Blob([csv], { type: 'text/csv' });
    if (share && navigator.canShare) {
      var file = new File([blob], fname, { type: 'text/csv' });
      if (navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: fname }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    }
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('Saved ' + fname);
  }

  // ---------------- Codes ----------------
  async function pauseLive() { var was = state.live && !state.recording; if (was) await stopLive(); return was; }

  $('#btn-read-dtc').onclick = async function () {
    if (!requireConn()) return;
    if (state.recording) { toast('Stop recording first'); return; }
    var resume = await pauseLive();
    $('#dtc-lists').innerHTML = '<div class="card">Reading…</div>';
    var mon = await state.obd.readMonitor();
    var d = await state.obd.readDtcs();
    var mil = $('#mil-line');
    if (mon) { mil.className = 'mil ' + (mon.mil ? 'on' : 'offc'); mil.textContent = (mon.mil ? 'Check engine light ON' : 'Check engine light off') + ' · ECU reports ' + mon.count + ' stored'; }
    var veh = (state.vin && /^(JA3|JA4|4A3|4A4|ML3|JMB|JMY)/.test(state.vin)) ? ' Mitsubishi' : '';
    var section = function (title, key, note) {
      var s = d[key];
      return '<div class="card"><h2>' + title + '</h2>' + (s.error ? '<div class="empty">Not available: ' + esc(s.error) + '</div>' :
        s.codes.length ? s.codes.map(function (c) {
          return '<div class="dtc"><div><div class="code">' + c + '</div><div class="desc">' + esc(DTC.describe(c) || 'No generic description') + '</div></div>' +
            '<a target="_blank" rel="noopener" href="https://www.google.com/search?q=' + encodeURIComponent(c + veh) + '">Look up ↗</a></div>';
        }).join('') : '<div class="empty">None</div>') + (note ? '<p class="hint">' + note + '</p>' : '') + '</div>';
    };
    $('#dtc-lists').innerHTML = section('Stored (mode 03)', 'stored') + section('Pending (mode 07)', 'pending', 'Pending = failed once this drive cycle, not yet confirmed.') + section('Permanent (mode 0A)', 'permanent', 'Permanent codes cannot be cleared with a scan tool; they self-clear after the monitor passes.');
    if (resume) startLive();
  };

  $('#btn-clear-dtc').onclick = async function () {
    if (!requireConn()) return;
    if (state.recording) { toast('Stop recording first'); return; }
    var ok = await confirmDlg('Clear codes?', 'This erases stored and pending codes, freeze frame data and resets all readiness monitors (the car will show "not ready" for emissions until a drive cycle completes). Engine should be OFF, key ON.', 'Clear codes');
    if (!ok) return;
    var resume = await pauseLive();
    try { var r = await state.obd.clearDtcs(); toast(r ? 'Codes cleared' : 'ECU did not confirm clear', 3000); } catch (e) { toast('Clear failed: ' + e.message); }
    if (resume) startLive();
    $('#btn-read-dtc').click();
  };

  $('#btn-freeze').onclick = async function () {
    if (!requireConn()) return;
    if (state.recording) { toast('Stop recording first'); return; }
    var resume = await pauseLive();
    var el = $('#freeze'); el.classList.remove('hidden'); el.innerHTML = 'Reading freeze frame…';
    var ff = null;
    try { ff = await state.obd.readFreezeFrame(); } catch (e) { log('warn', e.message); }
    if (!ff || !ff.dtc) el.innerHTML = '<h2>Freeze frame</h2><div class="empty">No freeze frame stored.</div>';
    else {
      el.innerHTML = '<h2>Freeze frame · ' + esc(ff.dtc) + '</h2><table class="ff">' + Object.keys(ff.values).map(function (pid) {
        var d = PIDS.get(pid); var disp = PIDS.toDisplay(pid, ff.values[pid], settings.units);
        return '<tr><td>' + esc(d.name) + '</td><td>' + PIDS.format(disp.value, disp.unit) + ' ' + esc(disp.unit) + '</td></tr>';
      }).join('') + '</table>';
    }
    if (resume) startLive();
  };

  // ---------------- Console ----------------
  var QUICK = ['ATI', 'ATRV', 'ATDPN', 'ATDP', '0100', '0101', '010C', '0105', '0902', '03', 'ATZ'];
  $('#con-quick').innerHTML = QUICK.map(function (c) { return '<button class="btn small mono" data-q="' + c + '">' + c + '</button>'; }).join('');
  $('#con-quick').querySelectorAll('[data-q]').forEach(function (b) { b.onclick = function () { sendManual(b.dataset.q); }; });
  async function sendManual(cmd) {
    cmd = (cmd || '').trim().toUpperCase(); if (!cmd) return;
    if (!requireConn()) return;
    try { var r = await state.session.send(cmd, 8000); log('info', 'Response: ' + JSON.stringify(r)); } catch (e) { log('warn', cmd + ': ' + e.message); }
  }
  $('#con-send').onclick = function () { sendManual($('#con-input').value); $('#con-input').value = ''; };
  $('#con-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#con-send').click(); });
  $('#con-clear').onclick = function () { logLines = []; scheduleConsole(); };
  $('#con-copy').onclick = async function () {
    var txt = 'OBD Scanner ' + APP_VERSION + ' log ' + new Date().toISOString() + '\nUA: ' + navigator.userAgent + '\n' + logLines.map(function (l) { return l.line; }).join('\n');
    try { await navigator.clipboard.writeText(txt); toast('Log copied'); } catch (e) {
      var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' })); a.download = 'obd-log.txt'; a.click(); toast('Log downloaded');
    }
  };

  // ---------------- Utils & boot ----------------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fmtDur(ms) { var s = Math.floor(ms / 1000); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0'); }

  window.addEventListener('beforeunload', function (e) { if (state.recording) { flush(); e.preventDefault(); e.returnValue = ''; } });
  bindSettings(); renderProfileSelect(); renderTiles();
  if ($('#app-ver')) $('#app-ver').textContent = APP_VERSION;
  log('info', 'App loaded ' + APP_VERSION + '. Web Bluetooth ' + (Transport.BleTransport.isSupported() ? 'available' : 'NOT available'));
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});
  window.__app = { state: state, connect: connect, settings: settings, version: APP_VERSION };
})();
