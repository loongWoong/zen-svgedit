/* 诊断 real-02 的「文字被遮挡」修复是否生效。
 * 1) 原始 SVG：标题是否被满版背景板吞成标签？是否检出 occlusion？
 * 2) 一键美化后：occlusion 是否归零？标题相对海军蓝胶囊的文档顺序 / 包围盒是否不再遮挡？
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
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e)));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__out && window.__out.stage === 'ready', null, { timeout: 120000 }).catch(() => {});
  await sleep(700);

  const out = await page.evaluate(async () => {
    const smp = UI.samples.find(s => s.id.indexOf('real-02') >= 0);
    if (!smp) return { err: 'sample real-02 not found' };

    // --- 原始分析 ---
    let load = Runtime.load(smp.svg);
    const ir0 = IR.build(Runtime, {});
    const an0 = Analyzer.run(ir0, {});
    // 定位标题文字（含“训练场”）
    const titleT = (ir0.texts || []).find(t => t.text && t.text.indexOf('训练场') >= 0)
      || ir0.nodes.flatMap(n => n.labels).find(l => l.text && l.text.indexOf('训练场') >= 0);
    const titleInfo = titleT ? {
      id: titleT.id, text: titleT.text, attachedTo: titleT.attachedTo || null,
      ownerIsBg: titleT.attachedTo ? (ir0.nodes.find(n => n.id === titleT.attachedTo) || {}).isBg : null
    } : null;
    const occ0 = an0.raw.occlusion.items.map(it => ({
      textDesc: it.textDesc, shapeDesc: it.shapeDesc, cover: it.cover, centerIn: it.centerIn
    }));

    // --- 一键美化（rule）---
    const rec = await Pipeline.beautify(Runtime, smp.svg, { strategy: 'rule', temp: 3, maxRounds: 4, sopt: {} });

    // --- 美化后重新分析当前 DOM ---
    const ir2 = IR.build(Runtime, {});
    const an2 = Analyzer.run(ir2, {});
    const occ2 = an2.raw.occlusion.count;

    // 标题相对海军蓝胶囊的文档顺序（提升图层后是 FOLLOWING；平移后包围盒不再交叠）
    let domOrder = null, stillOverlap = null;
    try {
      const all = Array.from(Runtime.contentGroup().querySelectorAll('text,rect'));
      const titleEl = all.find(e => (e.textContent || '').indexOf('训练场') >= 0 && e.tagName.toLowerCase() === 'text');
      const pillEl = all.find(e => e.tagName.toLowerCase() === 'rect' && (e.getAttribute('fill') || '').toLowerCase() === '#0b3b82');
      if (titleEl && pillEl) {
        const rel = titleEl.compareDocumentPosition(pillEl);
        domOrder = { titleAfterPill: (rel & Node.DOCUMENT_POSITION_PRECEDING) !== 0 }; // pill 在 title 之前 = title 在其后
        const tb = titleEl.getBBox ? null : null;
        // 包围盒交叠判定
        const tb2 = titleEl.getBoundingClientRect(), pb2 = pillEl.getBoundingClientRect();
        const ix = Math.max(0, Math.min(tb2.right, pb2.right) - Math.max(tb2.left, pb2.left));
        const iy = Math.max(0, Math.min(tb2.bottom, pb2.bottom) - Math.max(tb2.top, pb2.top));
        stillOverlap = (ix > 1 && iy > 1);
      }
    } catch (e) { domOrder = { err: String(e.message || e) }; }

    return {
      titleInfo,
      occBefore: an0.raw.occlusion.count, occItemsBefore: occ0,
      scoreBefore: rec.before.score, scoreAfter: rec.after.score, delta: rec.delta,
      ledger: (rec.ledger || []).map(l => ({ round: l.round, accepted: l.accepted, rejected: l.rejected, commit: l.commit })),
      occlusionAfter: occ2, domOrder, stillOverlap
    };
  });

  console.log(JSON.stringify({ out, pageErrors: errors }, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
