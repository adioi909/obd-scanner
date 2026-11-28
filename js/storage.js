/* Persistence: settings + profiles in localStorage, recorded sessions in IndexedDB. */
(function (root) {
  'use strict';
  var LS_SETTINGS = 'obd.settings.v1', LS_PROFILES = 'obd.profiles.v1';
  var DEFAULT_SETTINGS = { units: 'imperial', protocol: '0', multiPid: true, fastResponse: true, writeMode: 'auto', notifyChar: 'auto', timeout: 2500, cvtSt: 'FF', activeProfile: 'preset-quick' };

  function loadSettings() {
    try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}')); } catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
  }
  function saveSettings(s) { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); }

  var LS_PRESETS_SEEN = 'obd.presetsSeen.v1';
  function loadProfiles() {
    var raw = localStorage.getItem(LS_PROFILES);
    var all = root.PIDS.PRESETS.map(function (p) { return p.id; });
    if (!raw) { var p = JSON.parse(JSON.stringify(root.PIDS.PRESETS)); saveProfiles(p); localStorage.setItem(LS_PRESETS_SEEN, JSON.stringify(all)); return p; }
    var list;
    try { list = JSON.parse(raw); } catch (e) { return JSON.parse(JSON.stringify(root.PIDS.PRESETS)); }
    // v1.7.0: add presets introduced after this phone first ran the app (once; a preset you delete stays deleted).
    var seen;
    try { seen = JSON.parse(localStorage.getItem(LS_PRESETS_SEEN) || 'null'); } catch (e) { seen = null; }
    if (!seen) seen = ['preset-quick', 'preset-cooling', 'preset-fuel', 'preset-air', 'preset-cat', 'preset-elec'];
    var added = false;
    root.PIDS.PRESETS.forEach(function (pr) {
      if (seen.indexOf(pr.id) < 0 && !list.some(function (x) { return x.id === pr.id; })) { list.push(JSON.parse(JSON.stringify(pr))); added = true; }
    });
    // v1.7.1: refresh a stored preset that still has exactly the old default PID list.
    (root.PIDS.PRESET_UPGRADES || []).forEach(function (u) {
      var pr = list.find(function (x) { return x.id === u.id; });
      if (pr && JSON.stringify(pr.pids) === JSON.stringify(u.from)) { pr.pids = u.to.slice(); added = true; }
    });
    if (added) saveProfiles(list);
    localStorage.setItem(LS_PRESETS_SEEN, JSON.stringify(all));
    return list;
  }
  function saveProfiles(list) { localStorage.setItem(LS_PROFILES, JSON.stringify(list)); }
  function restorePresets(list) {
    root.PIDS.PRESETS.forEach(function (pr) {
      var i = list.findIndex(function (p) { return p.id === pr.id; });
      var copy = JSON.parse(JSON.stringify(pr));
      if (i >= 0) list[i] = copy; else list.push(copy);
    });
    saveProfiles(list); return list;
  }

  // ---- IndexedDB ----
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open('obdscanner', 1);
      req.onupgradeneeded = function () {
        var d = req.result;
        d.createObjectStore('sessions', { keyPath: 'id' });
        var rows = d.createObjectStore('rows', { autoIncrement: true });
        rows.createIndex('sid', 'sid');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }
  function tx(stores, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(stores, mode);
        var result;
        t.oncomplete = function () { resolve(result); };
        t.onerror = function () { reject(t.error); };
        result = fn(t);
      });
    });
  }
  function putSession(meta) { return tx(['sessions'], 'readwrite', function (t) { t.objectStore('sessions').put(meta); }); }
  function addRows(rows) { return tx(['rows'], 'readwrite', function (t) { var s = t.objectStore('rows'); rows.forEach(function (r) { s.add(r); }); }); }
  function listSessions() {
    return tx(['sessions'], 'readonly', function (t) {
      var out = []; var req = t.objectStore('sessions').openCursor();
      req.onsuccess = function () { var c = req.result; if (c) { out.push(c.value); c.continue(); } };
      return out;
    }).then(function (l) { return l.sort(function (a, b) { return b.start - a.start; }); });
  }
  function getRows(sid) {
    return tx(['rows'], 'readonly', function (t) {
      var out = []; var req = t.objectStore('rows').index('sid').openCursor(IDBKeyRange.only(sid));
      req.onsuccess = function () { var c = req.result; if (c) { out.push(c.value); c.continue(); } };
      return out;
    }).then(function (rows) { return rows.sort(function (a, b) { return a.t - b.t; }); });
  }
  function deleteSession(sid) {
    return tx(['sessions', 'rows'], 'readwrite', function (t) {
      t.objectStore('sessions').delete(sid);
      var req = t.objectStore('rows').index('sid').openCursor(IDBKeyRange.only(sid));
      req.onsuccess = function () { var c = req.result; if (c) { c.delete(); c.continue(); } };
    });
  }

  /**
   * v1.7.0: in-memory buffer for recorded rows. One IndexedDB transaction per batch instead of per poll:
   * flushes every maxRows samples or every intervalMs, and on demand (Stop recording, tab hidden, pagehide).
   * Flushes are chained so two transactions never race; a failed write puts the rows back for the next try.
   */
  function createRowBuffer(opts) {
    opts = opts || {};
    var write = opts.write || addRows;
    var maxRows = opts.maxRows || 25, intervalMs = opts.intervalMs != null ? opts.intervalMs : 3000;
    var onError = opts.onError || function () {};
    var onFlushed = opts.onFlushed || function () {};
    var buf = [], chain = Promise.resolve(), timer = null, stopped = false;
    var stats = { flushes: 0, rows: 0 };
    function flush(reason) {
      var rows = buf; buf = []; // snapshot now, so each batch is its own transaction
      chain = chain.then(function () {
        if (!rows.length) return;
        return Promise.resolve(write(rows)).then(function () {
          stats.flushes++; stats.rows += rows.length; onFlushed(rows.length, reason || 'manual');
        }, function (e) { buf = rows.concat(buf); onError(e); });
      });
      return chain;
    }
    function push(row) {
      if (stopped) return;
      buf.push(row);
      if (buf.length >= maxRows) flush('batch');
    }
    if (intervalMs > 0) timer = setInterval(function () { flush('timer'); }, intervalMs);
    function stop() { stopped = true; if (timer) clearInterval(timer); timer = null; return flush('stop'); }
    return { push: push, flush: flush, stop: stop, pending: function () { return buf.length; }, stats: stats };
  }

  root.Store = { loadSettings: loadSettings, saveSettings: saveSettings, loadProfiles: loadProfiles, saveProfiles: saveProfiles, restorePresets: restorePresets,
    putSession: putSession, addRows: addRows, createRowBuffer: createRowBuffer, listSessions: listSessions, getRows: getRows, deleteSession: deleteSession };
})(this);
