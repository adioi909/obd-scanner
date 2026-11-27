/* Headless browser smoke test in mock (Demo) mode. Usage: node tests/e2e-mock.js [url]
   Needs: npm i --no-save puppeteer-core, and Chrome at /usr/bin/google-chrome (or CHROME env). */
const puppeteer = require('puppeteer-core');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

(async () => {
  let url = process.argv[2], server;
  if (!url) {
    server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
      const f = path.join(root, p);
      if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
    }).listen(0);
    url = 'http://127.0.0.1:' + server.address().port + '/';
  }
  const shots = path.join(root, 'test-shots'); fs.mkdirSync(shots, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const check = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); console.log('ok -', msg); };
  const wait = ms => new Promise(r => setTimeout(r, ms));

  await page.goto(url, { waitUntil: 'networkidle0' });
  check(await page.$('#btn-connect') !== null, 'page loads');
  const ver = await page.$eval('#app-ver', e => e.textContent);
  check(ver === 'v1.7.0', 'visible version is v1.7.0, got ' + ver);
  await page.screenshot({ path: path.join(shots, '1-connect.png') });

  await page.click('#btn-mock');
  await page.waitForFunction(() => document.querySelector('#status').classList.contains('on'), { timeout: 15000 });
  const vin = await page.$eval('#i-vin', e => e.textContent);
  check(/^[A-Z0-9]{17}$/.test(vin), 'VIN read in demo mode: ' + vin);
  check((await page.$eval('#i-proto', e => e.textContent)).includes('CAN'), 'protocol shown');
  check((await page.$eval('#i-mil', e => e.textContent)).includes('MIL ON'), 'MIL status shown');
  await page.screenshot({ path: path.join(shots, '2-connected.png') });

  // Live
  await page.click('.tabs [data-view=live]');
  await page.click('#btn-live');
  await wait(2500);
  const tileVal = async (id) => page.$eval('#tile-' + id + ' .val', e => e.textContent);
  const rpm = await tileVal('0C');
  check(rpm !== '--' && +rpm > 300, 'live RPM tile updates: ' + rpm);
  for (const id of ['0C', '0D', '05', '04', '42', '11']) {
    const v = await tileVal(id);
    check(v !== '--' && v !== '' && !isNaN(parseFloat(v)), 'Quick look tile ' + id + ' has a value: ' + v);
  }
  const rate = parseFloat(await page.$eval('#st-rate', e => e.textContent));
  check(rate > 1, 'live rate ' + rate + ' Hz');
  await page.screenshot({ path: path.join(shots, '3-live.png') });

  // Mid-live profile switch must rebuild the poll list (v1.6: was stuck on the start-live PID set)
  await page.select('#live-profile', 'preset-air');
  await wait(2500);
  for (const id of ['10', '0B', '0F', '33', '11', '0C', '04']) {
    const v = await tileVal(id);
    check(v !== '--' && v !== '' && !isNaN(parseFloat(v)), 'Air intake tile ' + id + ' after mid-live switch: ' + v);
  }
  const switched = await page.evaluate(() => (window.__livePids ? window.__livePids().join(',') : ''));
  check(switched === '10,0B,0F,33,11,0C,04', 'livePids rebuilt after switch: ' + switched);
  await page.screenshot({ path: path.join(shots, '3b-live-air.png') });

  // Record (with a simulated 6 s background gap in the middle: v1.7 must log it, keep it in meta and keep polling)
  await page.click('#btn-rec');
  await wait(1500);
  await page.evaluate(() => { window.__bg.onHidden(); window.__bg.state.hiddenAt = Date.now() - 6000; window.__bg.onVisible(); });
  const before = await page.evaluate(() => window.__app.state.recording.meta.samples);
  await wait(2000);
  const gapInfo = await page.evaluate(() => ({ gaps: window.__app.state.recording.meta.gaps, samples: window.__app.state.recording.meta.samples }));
  check(gapInfo.gaps && gapInfo.gaps.length === 1 && gapInfo.gaps[0].seconds >= 6, 'background gap stored in session meta: ' + JSON.stringify(gapInfo.gaps));
  check(gapInfo.samples > before + 3, 'polling resumed after the gap: ' + before + ' -> ' + gapInfo.samples);
  await page.click('#btn-rec');
  await wait(500);
  await page.click('#btn-live');
  await page.click('.tabs [data-view=logs]');
  await page.waitForSelector('[data-view-s]');
  check(true, 'session saved');
  await page.click('[data-view-s]');
  await page.waitForSelector('canvas[data-chart]');
  const charts = await page.$$('canvas[data-chart]');
  check(charts.length >= 4, 'charts rendered: ' + charts.length);
  await wait(300);
  await page.screenshot({ path: path.join(shots, '4-session.png'), fullPage: true });
  const csv = await page.evaluate(async () => {
    const list = await Store.listSessions(); const rows = await Store.getRows(list[0].id);
    return { csv: window.__buildCsv(list[0], rows, 'imperial'), pids: list[0].pids, keys: Object.keys((rows[0] && rows[0].v) || {}) };
  });
  const lines = csv.csv.split('\r\n');
  check(lines[0].startsWith('timestamp,elapsed_s'), 'CSV header: ' + lines[0].slice(0, 120));
  check(lines.length > 5, 'CSV rows: ' + (lines.length - 1));
  // Recording happens after the mid-live switch to Air intake, so every air-intake PID must appear with a value
  for (const id of ['10', '0B', '0F', '33', '11', '0C', '04']) {
    check(csv.pids.includes(id), 'recorded meta.pids includes ' + id + ': ' + csv.pids.join(','));
    check(lines[0].includes('[01' + id + ']'), 'CSV header has 01' + id);
    const col = lines[0].split(',').findIndex(h => h.includes('[01' + id + ']'));
    const filled = lines.slice(1).filter(l => l && l.split(',')[col] !== '');
    check(filled.length > 0, 'CSV has values for PID ' + id + ' in ' + filled.length + ' rows');
  }

  // Long drive: 4000-sample session -> charts downsampled (500-800 points) but stats exact
  const longInfo = await page.evaluate(async () => {
    const sid = 's-long'; const start = Date.now() - 400000; const rows = [];
    for (let i = 0; i < 4000; i++) rows.push({ sid, t: start + i * 100, v: { '0C': 800 + (i % 200) * 10 + (i === 2345 ? 5000 : 0) } });
    await Store.putSession({ id: sid, name: 'zz long drive', profile: 'Quick look', pids: ['0C'], start, end: start + 400000, samples: 4000, vin: null, adapter: 'mock' });
    await Store.addRows(rows);
    let sum = 0, mn = Infinity, mx = -Infinity; rows.forEach(r => { const v = r.v['0C']; sum += v; mn = Math.min(mn, v); mx = Math.max(mx, v); });
    return { avg: sum / rows.length, mn, mx };
  });
  await page.$eval('#sd-close', el => el.click());
  await page.click('.tabs [data-view=logs]');
  await page.waitForSelector('[data-view-s="s-long"]');
  await page.$eval('[data-view-s="s-long"]', el => el.click());
  await page.waitForFunction(() => { const d = document.querySelector('#session-detail'); return d && !d.classList.contains('hidden') && d.textContent.includes('zz long drive') && d.querySelector('canvas[data-chart="0C"][data-plotted]'); }, { timeout: 10000 });
  const ds = await page.$eval('canvas[data-chart="0C"]', c => ({ plotted: +c.dataset.plotted, samples: +c.dataset.samples, lbl: c.parentElement.querySelector('.lbl span').textContent }));
  check(ds.samples === 4000 && ds.plotted >= 500 && ds.plotted <= 800, 'long session downsampled for drawing: ' + ds.plotted + '/' + ds.samples);
  check(ds.lbl.includes('max ' + longInfo.mx) && ds.lbl.includes('min ' + longInfo.mn) && ds.lbl.includes('avg ' + Math.round(longInfo.avg)), 'stats from full data: ' + ds.lbl + ' (expected min ' + longInfo.mn + ' avg ' + longInfo.avg + ' max ' + longInfo.mx + ')');
  const longCsv = await page.evaluate(async () => { const list = await Store.listSessions(); const m = list.find(s => s.id === 's-long'); return window.__buildCsv(m, await Store.getRows('s-long'), 'imperial').split('\r\n').length - 1; });
  check(longCsv === 4000, 'CSV export keeps all 4000 rows: ' + longCsv);
  await page.$eval('#sd-close', el => el.click());

  // Experimental Mitsubishi CVT preset in demo mode (simulated TCM on 7E1/7E9)
  await page.click('.tabs [data-view=live]');
  await page.select('#live-profile', 'preset-mitsu-cvt');
  await page.click('#btn-live');
  await page.waitForFunction(() => { const e = document.querySelector('#tile-MCVT .val'); return e && e.textContent !== '--'; }, { timeout: 10000 });
  const cvt = await page.evaluate(() => ({ t: document.querySelector('#tile-MCVT .val').textContent, lbl: document.querySelector('#tile-MCVT .lbl').textContent, rpm: document.querySelector('#tile-0C .val').textContent }));
  check(/\(Exp\)/.test(cvt.lbl) && !isNaN(parseFloat(cvt.t)) && !isNaN(parseFloat(cvt.rpm)), 'CVT (Exp) tile ' + cvt.lbl + ' = ' + cvt.t + ', RPM = ' + cvt.rpm);
  await page.click('#btn-live');
  await wait(400);
  const hdr = await page.evaluate(() => ({ adapter: window.__app.state.obd.adapter.header, mock: window.__app.state.transport.txHeader, cra: window.__app.state.transport.rxFilter }));
  check(hdr.mock === '7DF' && hdr.cra === null && hdr.adapter.tx === '7DF', 'header back on 7DF after live stops: ' + JSON.stringify(hdr));
  await page.click('.tabs [data-view=console]');
  await wait(500);
  const conTxt = await page.$eval('#console', e => e.textContent);
  check(/EXP 7E1\/7E9 2103 raw \(20 data bytes\)/.test(conTxt), 'raw CVT bytes logged in Console');
  await page.select('#live-profile', 'preset-quick').catch(() => {});

  // Codes
  await page.click('.tabs [data-view=codes]');
  await page.click('#btn-read-dtc');
  await page.waitForFunction(() => document.querySelectorAll('.dtc .code').length >= 3, { timeout: 10000 });
  const codes = await page.$$eval('.dtc .code', els => els.map(e => e.textContent));
  check(codes.includes('P0133') && codes.includes('P0442') && codes.includes('P0171'), 'DTCs: ' + codes.join(','));
  await page.click('#btn-freeze');
  await page.waitForFunction(() => document.querySelector('#freeze').textContent.includes('P0133'), { timeout: 15000 });
  check(true, 'freeze frame read');
  await page.screenshot({ path: path.join(shots, '5-codes.png'), fullPage: true });
  await page.click('#btn-clear-dtc');
  await page.waitForSelector('dialog[open]');
  await page.click('#dlg-ok');
  await page.waitForFunction(() => document.querySelectorAll('#dtc-lists .card')[0] && document.querySelectorAll('#dtc-lists .card')[0].textContent.includes('None'), { timeout: 10000 });
  check(true, 'clear codes (with confirm) works');
  await page.click('#btn-freeze');
  await page.waitForFunction(() => (document.querySelector('#freeze') || {}).textContent.includes('No freeze frame stored'), { timeout: 15000 });
  const ff = await page.$eval('#freeze', e => e.textContent);
  check(ff.includes('only pending codes') || ff.includes('No freeze frame stored'), 'freeze frame empty state: ' + ff.slice(0, 80));

  await page.waitForFunction(() => !document.querySelector('#toast.show'), { timeout: 8000 });

  // Profiles
  await page.click('.tabs [data-view=profiles]');
  await page.click('#btn-new-prof');
  await page.type('#pe-name', 'Test profile');
  await page.$eval('[data-pid="05"]', el => el.click());
  await page.$eval('[data-pid="5C"]', el => el.click());
  await page.$eval('#pe-save', el => el.click());
  const names = await page.$$eval('#profile-list b', els => els.map(e => e.textContent));
  check(names.includes('Test profile'), 'profile created');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('obd.profiles.v1')).find(p => p.name === 'Test profile').pids);
  check(stored.join() === '05,5C', 'profile persisted in localStorage');
  await page.screenshot({ path: path.join(shots, '6-profiles.png') });

  // Console
  await page.click('.tabs [data-view=console]');
  await page.click('#con-clear');
  await page.click('#con-input', { clickCount: 3 });
  await page.type('#con-input', 'ATI');
  await page.click('#con-send');
  await page.waitForFunction(() => (document.querySelector('#console') || {}).textContent.includes('ELM327'), { timeout: 8000 });
  const con = await page.$eval('#console', e => e.textContent);
  check(con.includes('ELM327 v1.5'), 'console shows raw traffic');

  // v1.7 write interlock: Mode 04 typed in the Console asks first; Cancel (default) sends nothing
  await page.evaluate(() => { window.__app.state.transport.dtcs['03'] = ['0300']; });
  await page.type('#con-input', '04');
  await page.click('#con-send');
  await page.waitForSelector('dialog[open]');
  const dlg = await page.evaluate(() => ({ title: document.querySelector('#dlg-title').textContent, focus: document.activeElement && document.activeElement.value }));
  check(/write/i.test(dlg.title) && dlg.focus === 'cancel', 'write interlock dialog, Cancel focused by default: ' + JSON.stringify(dlg));
  await page.keyboard.press('Escape');
  await wait(300);
  const stillThere = await page.evaluate(() => window.__app.state.transport.dtcs['03'].length);
  check(stillThere === 1, 'cancelled 04 was not sent (stored code still present)');
  await page.type('#con-input', '2EF19041');
  await page.click('#con-send');
  await page.waitForSelector('dialog[open]');
  await page.$eval('dialog button[value=cancel]', b => b.click());
  await wait(300);
  const sent2E = await page.$eval('#console', e => e.textContent.includes('→ 2EF19041'));
  check(!sent2E, 'cancelled UDS 2E write never transmitted');
  // Confirm path: explicit "Send anyway" goes through
  await page.type('#con-input', '04');
  await page.click('#con-send');
  await page.waitForSelector('dialog[open]');
  await page.$eval('#dlg-ok', b => b.click());
  await page.waitForFunction(() => window.__app.state.transport.dtcs['03'].length === 0, { timeout: 5000 });
  check(true, 'confirmed 04 is sent');

  // Dirty adapter: a manual ATH1 shows the banner; Re-run init clears it
  check(await page.$eval('#dirty-banner', e => e.classList.contains('hidden')), 'no dirty banner before manual AT');
  await page.type('#con-input', 'ATH1');
  await page.click('#con-send');
  await page.waitForFunction(() => !document.querySelector('#dirty-banner').classList.contains('hidden'), { timeout: 5000 });
  check((await page.$eval('#dirty-cmds', e => e.textContent)).includes('ATH1'), 'dirty banner names ATH1');
  await page.type('#con-input', 'ATDPN');
  await page.click('#con-send');
  await wait(300);
  check(await page.evaluate(() => window.__app.state.obd.adapter.dirtyCmds.join()) === 'ATH1', 'ATDPN (read-only) does not mark dirty');
  await page.$eval('#btn-dirty-reinit', b => b.click());
  await page.waitForFunction(() => document.querySelector('#dirty-banner').classList.contains('hidden'), { timeout: 15000 });
  check(true, 'Re-run init clears the dirty banner');
  // Live auto re-syncs after a manual ATS1
  await page.type('#con-input', 'ATS1');
  await page.click('#con-send');
  await page.waitForFunction(() => !document.querySelector('#dirty-banner').classList.contains('hidden'), { timeout: 5000 });
  await page.click('.tabs [data-view=live]');
  await page.select('#live-profile', 'preset-quick');
  await page.click('#btn-live');
  await page.waitForFunction(() => document.querySelector('#dirty-banner').classList.contains('hidden'), { timeout: 10000 });
  await wait(1500);
  const rpm2 = await tileVal('0C');
  check(!isNaN(parseFloat(rpm2)), 'live re-synced the adapter and RPM updates: ' + rpm2);
  await page.click('#btn-live');
  await page.screenshot({ path: path.join(shots, '7-console.png') });

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); if (server) server.close();
  console.log('E2E PASS');
})().catch(e => { console.error(e); process.exit(1); });
