/* Persistence: settings + profiles in localStorage, recorded sessions in IndexedDB. */
(function (root) {
  'use strict';
  var LS_SETTINGS = 'obd.settings.v1', LS_PROFILES = 'obd.profiles.v1';
  var DEFAULT_SETTINGS = { units: 'imperial', protocol: '0', multiPid: true, fastResponse: true, writeMode: 'auto', timeout: 2500, activeProfile: 'preset-quick' };

  function loadSettings() {
    try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}')); } catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
  }
  function saveSettings(s) { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); }

  function loadProfiles() {
    var raw = localStorage.getItem(LS_PROFILES);
    if (!raw) { var p = JSON.parse(JSON.stringify(root.PIDS.PRESETS)); saveProfiles(p); return p; }
    try { return JSON.parse(raw); } catch (e) { return JSON.parse(JSON.stringify(root.PIDS.PRESETS)); }
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

  root.Store = { loadSettings: loadSettings, saveSettings: saveSettings, loadProfiles: loadProfiles, saveProfiles: saveProfiles, restorePresets: restorePresets,
    putSession: putSession, addRows: addRows, listSessions: listSessions, getRows: getRows, deleteSession: deleteSession };
})(this);
