const { chromium } = require('playwright-core');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const url = 'file:///' + path.resolve(ROOT, 'ui.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const b = await chromium.launch({ executablePath: EDGE, headless: true });
  const p = await b.newPage();
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__out && window.__out.stage === 'ready', null, { timeout: 60000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 500));
  const r = await p.evaluate(async () => {
    const smp = UI.samples.find(s => s.id.indexOf('real-onto_platform') >= 0);
    Runtime.load(smp.svg);
    let ir = IR.build(Runtime, {});
    let an = Analyzer.run(ir, {});
    const oc = an.raw.occlusion.items[0];
    if (!oc) return { err: 'no occlusion item' };
    const t = oc.textRef, m = oc.shapeRef;
    const tP = t.elem.parentNode, mP = (m.shapeElem || m.elem).parentNode;
    const info = {
      textDesc: oc.textDesc, shapeDesc: oc.shapeDesc, cover: oc.cover, centerIn: oc.centerIn,
      textTag: t.elem.tagName, shapeTag: (m.shapeElem || m.elem).tagName,
      sameParent: tP === mP,
      tParentTag: tP && tP.tagName, tParentId: tP && tP.id,
      mParentTag: mP && mP.tagName, mParentId: mP && mP.id,
      tGrandParentTag: tP && tP.parentNode && tP.parentNode.tagName,
      mGrandParentTag: mP && mP.parentNode && mP.parentNode.tagName
    };
    const nudge = Geo.opNudgeText(ir, an, oc, 'nudge_text', {});
    const raise = Geo.opRaiseText(ir, an, oc, 'raise_text', {});
    return { info, nudgeMade: !!nudge, raiseMade: !!raise };
  });
  console.log(JSON.stringify(r, null, 1));
  await b.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
