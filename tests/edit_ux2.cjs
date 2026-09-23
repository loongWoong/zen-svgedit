/* 编辑模式 5 项能力端到端验收（真实无头 Edge + 真实 svgcanvas）
 *   V1 选中卡片（<g>）后改字号 → 必须真的生效（含撤销入栈）
 *   V2 点另一个元素 → 选择切换
 *   V3 下钻到 text 后改字号 → 生效
 *   V4 删除选中元素 → DOM 真删 + 轨迹与撤销栈同步
 *   V5 变更轨迹行点击 → 回退到该步（撤销栈真的减小、内容真的变）
 *   V6 美化改动清单：预览出列表 → 取消一项 → 应用勾选项时该项不执行
 * 用法：NODE_PATH=.svgbuild/node_modules node tests/edit_ux2.cjs [real-01]
 *       SVGB_TARGET=svgb_beautifier.html node edit_ux2.cjs
 */
const { chromium } = require('playwright-core');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const TARGET = process.env.SVGB_TARGET || 'ui.html';
const url = 'file:///' + path.resolve(ROOT, TARGET).replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const want = process.argv[2] || 'real-01';

const chk = [];
const ok = (name, pass, detail) => chk.push({ name, pass: !!pass, detail: detail === undefined ? null : detail });

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true
  });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + (e.stack || e.message).slice(0, 300)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__out && ['ready', 'fatal'].includes(window.__out.stage), null, { timeout: 120000 }).catch(() => {});
  await sleep(600);

  await page.evaluate((w) => { const i = UI.samples.findIndex(s => s.id.indexOf(w) >= 0); UI.select(i); }, want);
  await sleep(800);
  await page.evaluate(() => UI.toggleEdit());
  await sleep(800);

  /* 只挑「真实命中可见元素」的标签点（elementFromPoint 返回 svg = 空白，点不中） */
  const hud = async () => page.evaluate(() => {
    const ir = IR.build(Runtime, {});
    const root = Runtime.canvas.getSvgRoot();
    const out = [];
    for (const n of ir.nodes) for (const l of (n.labels || [])) {
      const m = root.getScreenCTM();
      const p = root.createSVGPoint(); p.x = l.bbox.x + l.bbox.w / 2; p.y = l.bbox.y + l.bbox.h / 2;
      const s = p.matrixTransform(m);
      const top = (document.elementFromPoint(s.x, s.y) || {}).tagName || null;
      out.push({ text: String(l.text || '').slice(0, 12), id: l.elem.id, x: s.x, y: s.y, top });
    }
    return out.filter(o => o.top && o.top !== 'svg');
  });
  const sel = () => page.evaluate(() => {
    const st = Editor.stats(), p = Editor.props();
    return { n: st.nSel, tag: st.selTag, id: st.selId, nFontTgt: st.nFontTgt, effFS: st.effFontSize,
      eFSdisabled: (document.getElementById('eFS') || {}).disabled, eFSval: (document.getElementById('eFS') || {}).value,
      isText: p ? p.isText : null, track: st.changes, undo: st.undoSize, canvas: Runtime.exportString().length };
  });

  const spots = await hud();
  ok('harness: 可点击标签点 ≥2', spots.length >= 2, { n: spots.length });

  // ---------- V1：选中 <g> 后改字号 ----------
  const a = spots[0], b = spots[1];
  await page.mouse.click(a.x, a.y); await sleep(450);
  const sA = await sel();
  const v1 = await page.evaluate(async () => {
    const eFS = document.getElementById('eFS');
    const before = { disabled: eFS.disabled, tag: Editor.sel[0] ? Editor.sel[0].tagName : null,
      nFontTgt: Editor.stats().nFontTgt, eff: Editor.stats().effFontSize,
      sizes: Editor.fontTargets().map(e => parseFloat(getComputedStyle(e).getPropertyValue('font-size'))) };
    const old = before.sizes.slice(0, 3);
    eFS.value = '37';
    eFS.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    const now = Editor.fontTargets().map(e => parseFloat(getComputedStyle(e).getPropertyValue('font-size')));
    return { before, old, after: now.slice(0, 3), all37: now.length > 0 && now.every(v => Math.abs(v - 37) < 0.6),
      svgHas37: Runtime.exportString().indexOf('font-size="37"') >= 0 || /font-size:\s*37/.test(Runtime.exportString()),
      track: Editor.stats().changes, undo: Editor.stats().undoSize, err: Editor.lastErr };
  });
  ok('V1 选中 g 时字号输入框可用', !v1.before.disabled && v1.before.nFontTgt > 0, { nFontTgt: v1.before.nFontTgt, eff: v1.before.eff });
  ok('V1 改字号真的生效（全部目标变 37）', v1.all37, { old: v1.old, after: v1.after });
  ok('V1 字号改动进了撤销栈与轨迹', v1.undo > sA.undo && v1.track > 0, { undo: v1.undo, track: v1.track, err: v1.err });

  // ---------- V2：点另一个元素 ----------
  await page.mouse.click(b.x, b.y); await sleep(450);
  const sB = await sel();
  ok('V2 点击另一个元素可切换选择', sB.n > 0 && (sB.id !== sA.id || sB.tag !== sA.tag),
    { first: sA.tag + '#' + sA.id, second: sB.tag + '#' + sB.id });

  // ---------- V3：下钻 ----------
  const d0 = await sel();
  await page.evaluate(() => document.getElementById('eDown1').click()); await sleep(450);
  const d1 = await sel();
  const v3 = await page.evaluate(async () => {
    const eFS = document.getElementById('eFS');
    eFS.value = '29';
    eFS.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    const ft = Editor.fontTargets();
    const sizes = ft.map(e => parseFloat(getComputedStyle(e).getPropertyValue('font-size')));
    return { tag: Editor.sel[0] ? Editor.sel[0].tagName : null, sizes: sizes.slice(0, 4),
      ok29: sizes.length > 0 && sizes.every(v => Math.abs(v - 29) < 0.6), err: Editor.lastErr };
  });
  ok('V3 下钻后选中 text 且字号生效', d1.tag !== d0.tag && v3.ok29, { from: d0.tag + '#' + d0.id, to: d1.tag + '#' + d1.id, sizes: v3.sizes, err: v3.err });

  // ---------- V4：删除 ----------
  const v4 = await page.evaluate(async () => {
    const el = Editor.sel[0];
    const n0 = IR.build(Runtime, {}).stats.nodes;
    const u0 = Editor.stats().undoSize;
    document.getElementById('eDel').click();
    await new Promise(r => setTimeout(r, 500));
    const n1 = IR.build(Runtime, {}).stats.nodes;
    return { selTag: el ? el.tagName : null, inDom: el ? document.contains(el) : null,
      n0, n1, u0, u1: Editor.stats().undoSize, track: Editor.stats().changes,
      label: Editor.track.length ? Editor.track[Editor.track.length - 1].label : null,
      nSelAfter: Editor.stats().nSel, err: Editor.lastErr };
  });
  ok('V4 删除真的从 DOM 移除', v4.inDom === false, { selTag: v4.selTag, nodes: v4.n0 + '→' + v4.n1 });
  ok('V4 删除进撤销栈且轨迹标签可读', v4.u1 > v4.u0 && /删除/.test(String(v4.label)), { u: v4.u0 + '→' + v4.u1, label: v4.label });
  ok('V4 删除后选择被清空（不残留幽灵选中）', v4.nSelAfter === 0, { nSel: v4.nSelAfter });

  // ---------- V5：轨迹行点击回退 ----------
  const v5 = await page.evaluate(async () => {
    const rows = Array.from(document.querySelectorAll('#eTrack .etrk'));
    const clickable = rows.filter(r => r.classList.contains('clickable'));
    const first = clickable[clickable.length - 1] || rows[rows.length - 1];
    const info = { nRows: rows.length, nClickable: clickable.length, cursor: first ? getComputedStyle(first).cursor : null,
      hasHand: first ? /↶/.test(first.textContent) : null };
    const u0 = Editor.stats().undoSize, t0 = Editor.track.length, len0 = Runtime.exportString().length;
    if (first) first.click();
    await new Promise(r => setTimeout(r, 700));
    return Object.assign(info, { u0, u1: Editor.stats().undoSize, t0, t1: Editor.track.length,
      len0, len1: Runtime.exportString().length, track: Editor.track.length, err: Editor.lastErr });
  });
  ok('V5 可回退的轨迹行有手型与 ↶ 提示', v5.nClickable > 0 && v5.cursor === 'pointer' && v5.hasHand === true,
    { rows: v5.nRows, clickable: v5.nClickable, cursor: v5.cursor });
  ok('V5 点击轨迹行真的回退（撤销栈减小 + 内容变化）', v5.u1 < v5.u0 && v5.len1 !== v5.len0,
    { undo: v5.u0 + '→' + v5.u1, len: v5.len0 + '→' + v5.len1, track: v5.t0 + '→' + v5.t1 });

  // ---------- V6：美化改动清单勾选 ----------
  const v6a = await page.evaluate(async () => {
    document.getElementById('btnPreview').click();
    await new Promise(r => setTimeout(r, 2500));
    const rows = Array.from(document.querySelectorAll('#opList .oprow'));
    return { nOps: rows.length, nCount: document.getElementById('nOps').textContent,
      panelOn: document.getElementById('opPanel').classList.contains('on'),
      firstLabel: rows.length ? rows[0].querySelector('b').textContent : null,
      firstWhy: rows.length ? rows[0].querySelector('span').textContent.slice(0, 80) : null,
      allChecked: rows.length ? rows.every(r => r.querySelector('input').checked) : null };
  });
  ok('V6 预览后出改动清单（可勾选）', v6a.nOps > 0 && v6a.allChecked === true,
    { n: v6a.nOps, count: v6a.nCount, first: v6a.firstLabel });
  ok('V6 每项带「为什么改」说明', !!v6a.firstWhy && v6a.firstWhy.length > 6, { why: v6a.firstWhy });

  const v6b = await page.evaluate(async () => {
    /* 取消勾选**一整组**（同一 strategy），然后应用，验证该组真的不执行 */
    const rows = Array.from(document.querySelectorAll('#opList .oprow'));
    const sig = o => String(o.strategy || '') + '|' + String(o.label || '');
    // 找项数最多的一组
    const cnt = new Map();
    for (const o of UI.propOps) cnt.set(o.strategy, (cnt.get(o.strategy) || 0) + 1);
    let best = null, bn = -1;
    for (const [k, v] of cnt) if (v > bn) { bn = v; best = k; }
    const victimLabels = new Set(UI.propOps.filter(o => o.strategy === best).map(sig));
    let unchecked = 0;
    for (const r of rows) {
      const i = r.querySelector('input');
      const idx = rows.indexOf(r);
      if (victimLabels.size && UI.propOps[idx] && UI.propOps[idx].strategy === best && i.checked) { i.click(); unchecked++; }
    }
    await new Promise(r => setTimeout(r, 300));
    const deny = UI.opDenySet();
    return { strategy: best, nGroup: bn, unchecked, deny: deny.length, nCount: document.getElementById('nOps').textContent,
      onClick: document.getElementById('opApply').onclick !== null };
  });
  ok('V6 取消勾选可生效（deny 集合非空）', v6b.unchecked > 0 && v6b.deny > 0,
    { strategy: v6b.strategy, group: v6b.nGroup, unchecked: v6b.unchecked, deny: v6b.deny, count: v6b.nCount });

  const v6c = await page.evaluate(async () => {
    const deny = UI.opDenySet();
    document.getElementById('opApply').click();
    await new Promise(r => setTimeout(r, 4000));
    const logs = UI.logLines.slice(-3).join(' | ');
    return { deny: deny.length, logs, applied: (UI.lastResult && UI.lastResult.ledger) ? UI.lastResult.ledger.reduce((a, x) => a + (x.applied || 0), 0) : null,
      strategies: UI.lastResult && UI.lastResult.ledger ? Array.from(new Set(UI.lastResult.ledger.flatMap(x => (x.steps && x.steps[0] && x.steps[0].strategy) || []))) : null };
  });
  ok('V6 应用时按勾选过滤（日志出现「已按清单取消 N 项」）',
    /已按清单取消 \d+ 项/.test(v6c.logs), { logs: v6c.logs.slice(-220), deny: v6c.deny });

  console.log(JSON.stringify({ target: TARGET, sample: want, errs, checks: chk,
    pass: chk.filter(c => c.pass).length, total: chk.length }, null, 1));
  await browser.close();
})();
