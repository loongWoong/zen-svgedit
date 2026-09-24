/* 全量样例 × rule 策略 的一键美化扫描（非回归基线）。
 * 输出 {fingerprint, rows:[{id, before, after, delta, acc, rej, ms}]}
 *   · rows        —— 可与 .svgbuild/st3.json 的 matrix.rows[].by.rule 逐条对照
 *   · fingerprint —— ★F10 基线卫生：被测**源码集合**的 sha256。
 *     为什么需要它：实测同一份 ui.html 在代码漂移后给出 46.3→69.25，而旧基线记录
 *     58.8→58.8（差异可精确解释为遮挡项 46.3+0.25×(96−46)=58.8），二者被当成
 *     "同一基线"比较过。指纹不匹配时必须**报错而不是静默比较**。
 * 用法：NODE_PATH=.svgbuild/node_modules node tests/sweep_rule.cjs > sweep_rule.json
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const url = 'file:///' + path.resolve(ROOT, 'ui.html').replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 指纹 = ui.html + 它按文档顺序引用的全部 <script src> 的内容哈希。
 * 这正是 build.py 内联进产物的集合，因此代码任何一处改动都会改变指纹。 */
function fingerprint() {
  const htmlPath = path.join(ROOT, 'ui.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const srcs = [];
  const re = /<script\s+src="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) srcs.push(m[1]);
  const h = crypto.createHash('sha256');
  h.update(html);
  const files = ['ui.html'].concat(srcs);
  let hashed = 0;
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    h.update(f); h.update(fs.readFileSync(p));
    hashed++;
  }
  return { sha256: h.digest('hex').slice(0, 16), segments: srcs.length, filesHashed: hashed };
}

(async () => {
  /* ★F10：指纹必须在**加载页面之前**算好并固定下来。
   * 若在页面跑完后再算，期间任何源码改动都会让指纹描述"改后的代码"，
   * 而实际被测的是"改前的代码" —— 指纹就成了错误证据（实测踩到过一次）。 */
  const fp = fingerprint();
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
        /* ★F1/F7 观测项：按 item 增量提交生效的次数、以及被 item 级拉黑数 */
        itemMode: led.reduce((a, x) => a + (x.steps || []).filter(s => s.mode === 'item' && s.accept).length, 0),
        unitsTried: led.reduce((a, x) => a + (x.steps || []).reduce((b, s) => b + ((s.units || []).length), 0), 0),
        unitsOk: led.reduce((a, x) => a + (x.steps || []).reduce((b, s) => b + ((s.units || []).filter(u => u.accept).length), 0), 0),
        tiny: rec.before.raw && rec.before.raw.tiny,
        rounds: led.length, ms: rec.ms
      });
      await new Promise(r => setTimeout(r, 0));
    }
    return res;
  });

  console.log(JSON.stringify({ fingerprint: fingerprint(), rows: out }, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
