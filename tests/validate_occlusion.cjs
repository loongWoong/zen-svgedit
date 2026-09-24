const { chromium } = require('playwright-core');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const url = 'file:///' + path.resolve(ROOT, 'ui.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const b = await chromium.launch({ executablePath: EDGE, headless: true });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERR: ' + (e && e.message || e)));
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__out && window.__out.stage === 'ready', null, { timeout: 60000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 500));

  const rows = await p.evaluate(async () => {
    const occCount = (svg) => {
      const load = Runtime.load(svg);
      if (!load.ok) return -1;
      const ir = IR.build(Runtime, {});
      if (!ir.ok) return -1;
      const an = Analyzer.run(ir, {});
      return an.raw.occlusion.count;
    };
    const out = [];
    const samples = UI.samples.filter(s => s.id.indexOf('real-') === 0);
    for (const smp of samples) {
      let rec, e = null;
      try { rec = await Pipeline.beautify(Runtime, smp.svg, { strategy: 'rule', temp: 3, maxRounds: 4, sopt: {} }); }
      catch (x) { e = x.message; }
      if (e) { out.push({ id: smp.id, err: e }); continue; }
      out.push({
        id: smp.id,
        occBefore: occCount(rec.beforeSvg),
        occAfter: occCount(rec.finalSvg),
        scoreBefore: rec.before.score,
        scoreAfter: rec.after.score,
        delta: r2(rec.after.score - rec.before.score)
      });
    }
    return out;
  });

  console.log(JSON.stringify({ rows, pageErrors: errs }, null, 1));
  await b.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
