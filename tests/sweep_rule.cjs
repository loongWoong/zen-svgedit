/* 全量样例 × rule 策略 的一键美化扫描（非回归基线）。
 * 输出 {id, before, after, delta, acc, rej, ms} 列表，可与 .svgbuild/st3.json
 * 的 matrix.rows[].by.rule 逐条对照 —— 任何维度改动都必须先过这道门。
 * 用法：NODE_PATH=.svgbuild/node_modules node tests/sweep_rule.cjs > sweep_rule.json
 */
const { chromium } = require('playwright-core');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const url = 'file:///' + path.resolve(ROOT, 'ui.html').replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true
  });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__out && window.__out.stage === 'ready', null, { timeout: 120000 }).catch(() => {});
  await sleep(700);

  const out = await page.evaluate(async () => {
    const res = [];
    for (let i = 0; i < UI.samples.length; i++) {
      const smp = UI.samples[i];
      /* 美化的输入必须是样板的**原始 SVG 文本**，不能借用 UI 当前 DOM，
       * 否则上一条样例的残留状态会污染下一条。 */
      let rec;
      try {
        rec = await Pipeline.beautify(Runtime, smp.svg, { strategy: 'rule', temp: 3, maxRounds: 4, sopt: {} });
      } catch (e) {
        res.push({ id: smp.id, crash: String(e && e.message || e).slice(0, 160) });
        continue;
      }
      if (!rec || !rec.ok) { res.push({ id: smp.id, err: (rec && rec.err) || 'no result' }); continue; }
      const led = rec.ledger || [];
      res.push({
        id: smp.id, defects: (smp.defects || []).join('+'),
        before: rec.before.score, after: rec.after.score, delta: rec.delta,
        acc: led.reduce((a, x) => a + (x.accepted || 0), 0),
        rej: led.reduce((a, x) => a + (x.rejected || 0), 0),
        rounds: led.length, ms: rec.ms
      });
      await new Promise(r => setTimeout(r, 0));
    }
    return res;
  });

  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
