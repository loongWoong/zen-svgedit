/* 包含性审计：直接量用户可见事实 —— 有多少标签的 bbox 越出了它所属背景容器的边界。
 * 这是 #1「背景图形宽高不适配文字 / 文字超出」与 #2「文字被背景遮挡」的验收口径（不看分数）。
 * 用法：NODE_PATH=.svgbuild/node_modules node tests/contain_audit.cjs real-01
 */
const { chromium } = require('playwright-core');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const url = 'file:///' + path.resolve(ROOT, 'ui.html').replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const want = process.argv[2] || 'real-01';

const AUDIT = () => {
  const rr = R;
  const ir = IR.build(Runtime, {});
  const out = { canvas: [ir.canvas.w, ir.canvas.h], nodes: ir.nodes.length, rows: [] };
  for (const n of ir.nodes) {
    if (!n.labels || !n.labels.length) continue;
    const g = n.geomBox;
    let worst = 0, wl = null;
    for (const l of n.labels) {
      const over = Math.max(
        g.x - l.bbox.x,
        rr.right(l.bbox) - rr.right(g),
        g.y - l.bbox.y,
        rr.bottom(l.bbox) - rr.bottom(g)
      );
      if (over > worst) { worst = over; wl = l; }
    }
    if (worst > 0.5) out.rows.push({
      container: n.describe, id: n.id, geom: [Math.round(g.x), Math.round(g.y), Math.round(g.w), Math.round(g.h)],
      label: wl ? (wl.text || '').slice(0, 18) : '', overrun: +worst.toFixed(2)
    });
  }
  out.nOverrun = out.rows.length;
  out.maxOverrun = out.rows.reduce((m, r) => Math.max(m, r.overrun), 0);
  out.rows.sort((a, b) => b.overrun - a.overrun);
  return out;
};

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true
  });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__out && window.__out.stage === 'ready', null, { timeout: 120000 }).catch(() => {});
  await sleep(700);

  const i = await page.evaluate((w) => UI.samples.findIndex(s => s.id.indexOf(w) >= 0), want);
  await page.evaluate((k) => UI.select(k), i);
  await sleep(600);

  const before = await page.evaluate(AUDIT);
  await page.evaluate(async (k) => {
    const smp = UI.samples[k];
    const rec = await Pipeline.beautify(Runtime, smp.svg, { strategy: 'rule', temp: 3, maxRounds: 4, sopt: {} });
    window.__lastRec = rec;
    return rec.delta;
  }, i);
  const after = await page.evaluate(AUDIT);

  const fmt = (o) => `nOverrun=${o.nOverrun}  maxOverrun=${o.maxOverrun}px`;
  console.log('sample:', want, ' canvas', JSON.stringify(after.canvas), ' nodes', after.nodes);
  console.log('BEFORE ', fmt(before));
  console.log('AFTER  ', fmt(after));
  console.log('--- BEFORE top overruns ---');
  for (const r of before.rows.slice(0, 8)) console.log('  ' + String(r.overrun).padStart(7) + 'px  ' + r.container + '  «' + r.label + '»');
  console.log('--- AFTER top overruns ---');
  for (const r of after.rows.slice(0, 8)) console.log('  ' + String(r.overrun).padStart(7) + 'px  ' + r.container + '  «' + r.label + '»');
  await browser.close();
})();
