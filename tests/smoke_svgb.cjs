/* 冒烟测试 build.py 打出的单文件产物 svgb_beautifier.html：
 *   - 零 pageerror / 零失败请求（含 rotate.svg 是否解析到 vendor/）
 *   - UI 就绪、四视图可画、一键美化可跑
 * 用法：NODE_PATH=.svgbuild/node_modules node tests/smoke_svgb.cjs
 */
const { chromium } = require('playwright-core');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const url = 'file:///' + path.resolve(ROOT, 'svgb_beautifier.html').replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const errs = [], failed = [];
  page.on('pageerror', e => errs.push('pageerror: ' + (e.stack || e.message).slice(0, 300)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
  page.on('requestfailed', r => failed.push(r.url().slice(0, 120) + ' :: ' + (r.failure() ? r.failure().errorText : '?')));

  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__out && window.__out.stage !== 'start', null, { timeout: 120000 }).catch(() => {});
  await sleep(500);

  const out = { stage: await page.evaluate(() => window.__out.stage), loadMs: Date.now() - t0, errs, failed };
  if (out.stage !== 'ready') { out.fatal = await page.evaluate(() => window.__out.fatal || null); console.log(JSON.stringify(out, null, 1)); await browser.close(); return; }

  out.imgPath = await page.evaluate(() => Runtime.canvas.curConfig.imgPath);
  out.samples = await page.evaluate(() => UI.samples.length);

  const shaBeforeViews = await page.evaluate(() => UI.snapshot().sha256);
  out.views = await page.evaluate(async () => {
    const r = [];
    for (const v of ['original', 'wireframe', 'diagnostic', 'proposed']) {
      UI.setView(v); await new Promise(x => setTimeout(x, 25));
      const s = UI.snapshot();
      r.push({ view: v, drawn: s.drawn, level: s.level, ovlNodes: s.ovlChildren });
    }
    return r;
  });

  /* 四视图遍历之后内容字符串必须一字不变（「view 不是 mutation」的最简断言） */
  const shaAfterViews = await page.evaluate(() => UI.snapshot().sha256);
  out.viewsNoninvasive = { before: shaBeforeViews, afterViews: shaAfterViews, same: shaBeforeViews === shaAfterViews };

  out.beautify = await page.evaluate(async () => {
    const i = UI.samples.findIndex(s => (s.defects || []).length >= 3);
    UI.select(i); await new Promise(x => setTimeout(x, 100));
    UI.run('beautify');
    await new Promise(res => { const t = setInterval(() => { if (!UI.busy) { clearInterval(t); res(); } }, 30); });
    const r = UI.lastResult;
    return { id: UI.samples[i].id, ok: r.ok, before: r.before.score, after: r.after.score, delta: r.delta,
             rounds: r.ledger.length, ms: r.ms, sha: UI.snapshot().sha256 };
  });

  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
