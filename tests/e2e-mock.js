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
  check(ver === 'v1.4', 'visible version is v1.4, got ' + ver);
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
  const rpm = await page.$eval('#tile-0C .val', e => e.textContent);
  check(rpm !== '--' && +rpm > 300, 'live RPM tile updates: ' + rpm);
  const rate = parseFloat(await page.$eval('#st-rate', e => e.textContent));
  check(rate > 1, 'live rate ' + rate + ' Hz');
  await page.screenshot({ path: path.join(shots, '3-live.png') });

  // Record
  await page.click('#btn-rec');
  await wait(3500);
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
    return window.__buildCsv(list[0], rows, 'imperial');
  });
  const lines = csv.split('\r\n');
  check(lines[0].startsWith('timestamp,elapsed_s,Engine RPM (rpm)'), 'CSV header: ' + lines[0].slice(0, 80));
  check(lines.length > 5, 'CSV rows: ' + (lines.length - 1));

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

  // Profiles
  await page.click('.tabs [data-view=profiles]');
  await page.click('#btn-new-prof');
  await page.type('#pe-name', 'Test profile');
  await page.click('[data-pid="05"]'); await page.click('[data-pid="5C"]');
  await page.click('#pe-save');
  const names = await page.$$eval('#profile-list b', els => els.map(e => e.textContent));
  check(names.includes('Test profile'), 'profile created');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('obd.profiles.v1')).find(p => p.name === 'Test profile').pids);
  check(stored.join() === '05,5C', 'profile persisted in localStorage');
  await page.screenshot({ path: path.join(shots, '6-profiles.png') });

  // Console
  await page.click('.tabs [data-view=console]');
  await page.type('#con-input', 'ATI'); await page.click('#con-send');
  await wait(600);
  const con = await page.$eval('#console', e => e.textContent);
  check(con.includes('ELM327 v1.5'), 'console shows raw traffic');
  await page.screenshot({ path: path.join(shots, '7-console.png') });

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); if (server) server.close();
  console.log('E2E PASS');
})().catch(e => { console.error(e); process.exit(1); });
