// 无头 Edge 跑 dev.html 并回读 window.__out
const { chromium } = require('playwright-core');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const target = process.argv[2] || 'dev.html';
const ROOT = path.resolve(__dirname, '..');
const url = 'file:///' + path.resolve(ROOT, target).replace(/\\/g, '/');

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + (e.stack || e.message).slice(0, 300)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 300)); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__out && window.__out.stage === 'done' || window.__out.stage === 'fatal' || window.__out.stage === 'no-vendor', null, { timeout: 120000 }).catch(() => {});
  const out = await page.evaluate(() => window.__out || { err: 'no __out' });
  await browser.close();
  console.log(JSON.stringify({ out, pageErrs: errs }, null, 1));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
