/* Ctrl 多选 + 批量调整的端到端验收（#3）
 *   M1 单选 → Ctrl+点击另一个元素 → 真的变成 2 个选中（含元素引用核对）
 *   M2 Ctrl+再点已选中的元素 → 把它移出选择（回到 1 个）
 *   M3 Ctrl+点空白 → 保持当前选择不变（不清空、不选进画布）
 *   M4 多选后批量改**填充** → 全部选中元素同时变色，且只进 1 条撤销命令
 *   M5 撤销一次 → 刚才的批量填充整体回滚（证明合并为一条命令）
 *   M6 多选后批量改**字号** → 跨全部选中元素的文本一次统一
 *   M7 多选后批量**位移** → 全部选中元素同时移动相同距离
 *   M8 Shift 原生多选仍可用（本层只接管 Ctrl，不能把原生的弄坏）
 * 用法：NODE_PATH=.svgbuild/node_modules node tests/edit_multi.cjs [real-01]
 *       SVGB_TARGET=svgb_beautifier.html node edit_multi.cjs
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

  /* 取样：每个可点击标签点 → 它真正会选中的元素（用内核 getMouseTarget 判定） */
  const pts = await page.evaluate(() => {
    const c = Runtime.canvas;
    const ir = IR.build(Runtime, {});
    const root = c.getSvgRoot();
    const m = root.getScreenCTM();
    const out = [];
    for (const n of ir.nodes) for (const l of (n.labels || [])) {
      const p = root.createSVGPoint(); p.x = l.bbox.x + l.bbox.w / 2; p.y = l.bbox.y + l.bbox.h / 2;
      const s = p.matrixTransform(m);
      const el = document.elementFromPoint(s.x, s.y);
      if (!el || el.tagName === 'svg') continue;
      const evt = new MouseEvent('mousedown', { clientX: s.x, clientY: s.y, bubbles: true, view: window, button: 0 });
      try { Object.defineProperty(evt, 'target', { value: el, configurable: true }); } catch (e) { /* 忽略 */ }
      let t = null; try { t = c.getMouseTarget(evt); } catch (e) { t = null; }
      if (!t || !t.tagName || t.tagName === 'svg') continue;
      /* nf = 选中它之后「能改到几个文本」：g 走 DOM 下钻，非 g 走 IR 的元素↔标签关联。
         批量改字号要在有文字的同类元素上验证才有意义（real-01 的卡片底板 rect
         本身没有关联文本，选它测字号会得到 nF=0 的假失败）。 */
      let nf = 0;
      try {
        nf = (t.tagName === 'g') ? t.querySelectorAll('text,tspan').length
          : Editor._irLabelElems(t).length;
      } catch (e) { nf = 0; }
      out.push({ x: s.x, y: s.y, text: String(l.text || '').slice(0, 10), nf,
        hit: t.tagName + '#' + (t.id || ''), hitId: t.id || '', hitTag: t.tagName });
    }
    return out;
  });

  const uniq = [];
  const seen = new Set();
  for (const p of pts) { if (!seen.has(p.hit)) { seen.add(p.hit); uniq.push(p); } }
  /* A 优先取「有文字」的元素（批量字号那一组断言要在它身上才有意义） */
  const A = uniq.find(p => p.nf > 0) || uniq[0];
  /* B 优先取与 A 同类（同 tag）+ 同样有文字 —— 正是用户说的「同类元素」 */
  const B = uniq.find(p => p.hit !== A.hit && p.hitTag === A.hitTag && p.nf > 0)
    || uniq.find(p => p.hit !== A.hit && p.nf > 0)
    || uniq.find(p => p.hit !== A.hit && p.hitTag === A.hitTag)
    || uniq.find(p => p.hit !== A.hit);
  const C = uniq.find(p => p.hit !== A.hit && p.hit !== B.hit);
  ok('harness: 有三个互不相同的可选元素', !!(A && B && C), { n: uniq.length, A: A && A.hit, B: B && B.hit, C: C && C.hit });

  const grab = () => page.evaluate(() => {
    const st = Editor.stats();
    return {
      n: st.nSel, ids: Editor.sel.map(e => e.id || ''), tags: Editor.sel.map(e => e.tagName),
      nF: st.nFontTgt, effFS: st.effFontSize, undo: st.undoSize, track: st.changes,
      multi: st.multi, ctrlLog: (st.ctrlLog || []).slice(-6).join(','),
      eFSmixed: (document.getElementById('eFS') || {}).className || '',
      eFillmixed: (document.getElementById('eFill') || {}).className || '',
      selInfo: (document.getElementById('selInfo') || {}).textContent || '',
      err: Editor.lastErr
    };
  });
  /* 每个选中元素自己的「有效填充色」与「世界 bbox」——用于验证「批量真的落到每一个」 */
  const per = () => page.evaluate(() => {
    const hex = v => { const m = String(v).match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
      if (m) return '#' + [1, 2, 3].map(i => (+m[i]).toString(16).padStart(2, '0')).join('');
      return String(v || '').toLowerCase(); };
    return Editor.sel.map(e => {
      let b = null; try { b = Runtime.worldBBox(e); } catch (x) { b = null; }
      let f = ''; try { f = hex(getComputedStyle(e).getPropertyValue('fill')); } catch (x) { f = ''; }
      return { id: e.id || '', tag: e.tagName, fill: f,
        x: b ? +b.x.toFixed(2) : null, y: b ? +b.y.toFixed(2) : null,
        texts: e.querySelectorAll ? e.querySelectorAll('text,tspan').length : 0 };
    });
  });
  const ctrlClick = async (pt) => {
    await page.keyboard.down('Control');
    await page.mouse.click(pt.x, pt.y);
    await page.keyboard.up('Control');
    await sleep(420);
  };

  /* ---------- M1：Ctrl+点击可加选 ---------- */
  await page.mouse.click(A.x, A.y); await sleep(420);
  const s1 = await grab();
  await ctrlClick(B);
  const s2 = await grab();
  ok('M1 Ctrl+点击真的加选（1 → 2，且两个元素都在选中集里）',
    s1.n === 1 && s2.n === 2 && s2.ids.includes(A.hitId) && s2.ids.includes(B.hitId),
    { before: s1.n + '[' + s1.ids + ']', after: s2.n + '[' + s2.ids + ']', log: s2.ctrlLog, A: A.hit, B: B.hit });
  ok('M1 Ctrl 手势日志可追溯（走了 ctrl-add 通道）', /ctrl-add/.test(s2.ctrlLog), { log: s2.ctrlLog });

  /* ---------- M2：Ctrl+再点已选中元素 → 移出选择 ---------- */
  await ctrlClick(B);
  const s3 = await grab();
  ok('M2 Ctrl+再点已选中元素 → 把它移出选择（2 → 1）',
    s3.n === 1 && s3.ids.includes(A.hitId) && !s3.ids.includes(B.hitId),
    { n: s3.n, ids: s3.ids, log: s3.ctrlLog });

  /* ---------- M3：Ctrl+点空白 → 保持选择 ---------- */
  const blank = await page.evaluate(() => {
    const r = document.getElementById('host').getBoundingClientRect();
    const x = r.left + 12, y = r.bottom - 12;
    const el = document.elementFromPoint(x, y);
    return { x, y, isBlank: !!(el && el.tagName === 'svg') };
  });
  await ctrlClick(blank);
  const s4 = await grab();
  ok('M3 Ctrl+点空白 → 保持当前选择（不清空、不把画布选进来）',
    blank.isBlank && s4.n === 1 && s4.ids.includes(A.hitId),
    { blank: blank.isBlank, n: s4.n, ids: s4.ids, log: s4.ctrlLog });

  /* ---------- M4：多选后批量改填充（一条撤销命令） ---------- */
  await ctrlClick(B);
  const s5 = await grab();
  const fillBefore = await per();
  const v4 = await page.evaluate(async () => {
    const el = document.getElementById('eFill');
    const cls0 = el.className, val0 = el.value;
    const u0 = Editor.stats().undoSize, t0 = Editor.stats().changes;
    el.value = '#1f9d55';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const hex = v => { const m = String(v).match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
      if (m) return '#' + [1, 2, 3].map(i => (+m[i]).toString(16).padStart(2, '0')).join(''); return String(v || '').toLowerCase(); };
    const now = Editor.sel.map(e => hex(getComputedStyle(e).getPropertyValue('fill')));
    return { u0, u1: Editor.stats().undoSize, t0, t1: Editor.stats().changes, now, cls0, val0,
      nSel: Editor.stats().nSel, label: Editor.track.length ? Editor.track[Editor.track.length - 1].label : null,
      diff: Editor.track.length ? (Editor.track[Editor.track.length - 1].diff || []).length : 0,
      err: Editor.lastErr };
  });
  ok('M4 批量填充：全部选中元素同时变色',
    v4.now.length === 2 && v4.now.every(v => v === '#1f9d55'),
    { before: fillBefore.map(p => p.id + ':' + p.fill), after: v4.now, nSel: v4.nSel });
  ok('M4 批量填充只进 1 条撤销命令（不是 N 条）',
    v4.u1 === v4.u0 + 1 && v4.t1 === v4.t0 + 1,
    { undo: v4.u0 + '→' + v4.u1, track: v4.t0 + '→' + v4.t1, label: v4.label, diff: v4.diff });

  /* ---------- M5：撤销一次 → 批量填充整体回滚 ---------- *
   * ★ 这里不能再用 Editor.sel 取色：撤销（ChangeElementCommand.unapply）会
   *   **替换 DOM 元素**，旧引用随即失效、选择被内核清空 —— 实测撤销后 nSel=0。
   *   所以判据换成「导出内容里还找不找得到刚写进去的颜色 / 原底色回没回来」，
   *   它不依赖任何 DOM 引用，是更硬的事实。 */
  const v5 = await page.evaluate(async () => {
    const cnt = (t, k) => (t.match(new RegExp(k, 'gi')) || []).length;
    const u0 = Editor.stats().undoSize;
    const s0 = Runtime.exportString();
    document.getElementById('eUndo').click();
    await new Promise(r => setTimeout(r, 800));
    const s1 = Runtime.exportString();
    return { u0, u1: Editor.stats().undoSize, nSel: Editor.stats().nSel,
      green0: cnt(s0, '1f9d55'), green1: cnt(s1, '1f9d55'),
      back0: cnt(s0, 'f7fbff'), back1: cnt(s1, 'f7fbff') };
  });
  ok('M5 撤销一次 → 批量填充整体回滚（写入色消失、原底色回来、只退 1 步）',
    v5.u1 === v5.u0 - 1 && v5.green0 > 0 && v5.green1 === 0 && v5.back1 > 0,
    { undo: v5.u0 + '→' + v5.u1, green: v5.green0 + '→' + v5.green1, back: v5.back0 + '→' + v5.back1 });
  ok('M5 已记录行为：撤销会替换元素 → 选择被清空（不是缺陷，但后续步骤必须重建选择）',
    v5.nSel === 0, { nSelAfterUndo: v5.nSel });

  /* ---------- 重建多选（撤销清空了选择） ---------- */
  await page.mouse.click(A.x, A.y); await sleep(450);
  await ctrlClick(B);
  const s6 = await grab();
  ok('M5b 撤销后可重新建立 Ctrl 多选（再次 2 个）',
    s6.n === 2 && s6.ids.includes(A.hitId) && s6.ids.includes(B.hitId),
    { n: s6.n, ids: s6.ids, log: s6.ctrlLog });
  const v6 = await page.evaluate(async () => {
    const ft = Editor.fontTargets();
    const before = ft.map(e => +parseFloat(getComputedStyle(e).getPropertyValue('font-size')).toFixed(1));
    const eFS = document.getElementById('eFS');
    const mixedCls = eFS.className;
    eFS.value = '43';
    eFS.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 700));
    const now = Editor.fontTargets().map(e => +parseFloat(getComputedStyle(e).getPropertyValue('font-size')).toFixed(1));
    /* 每个选中元素**各自子树**内的文本是否都变了 —— 证明批量真的落到每一个元素 */
    const perEl = Editor.sel.map(e => {
      const t = Array.prototype.slice.call((e.querySelectorAll ? e.querySelectorAll('text,tspan') : []));
      return t.map(x => +parseFloat(getComputedStyle(x).getPropertyValue('font-size')).toFixed(1));
    });
    return { before, now, nF: ft.length, mixedCls, perEl,
      all43: now.length > 0 && now.every(v => Math.abs(v - 43) < 0.6),
      undo: Editor.stats().undoSize, err: Editor.lastErr };
  });
  ok('M6 批量字号：跨全部选中元素的文本一次统一（≥2 个文本变为 43）',
    v6.nF >= 2 && v6.all43, { before: v6.before, after: v6.now, nF: v6.nF, perEl: v6.perEl });
  ok('M6 多选时属性框如实标记「多值」：填充不一致 → eFill 带 mixed',
    !!(s6.multi && s6.multi.fillMixed === true && /mixed/.test(s6.eFillmixed)),
    { multi: s6.multi, cls: s6.eFillmixed, fsCls: v6.mixedCls });

  /* ---------- M7：多选后批量位移 ---------- */
  const beforeMv = await per();
  const v7 = await page.evaluate(async () => {
    const u0 = Editor.stats().undoSize;
    document.getElementById('eR').click();
    await new Promise(r => setTimeout(r, 700));
    return { u0, u1: Editor.stats().undoSize, err: Editor.lastErr,
      after: Editor.sel.map(e => { let b = null; try { b = Runtime.worldBBox(e); } catch (x) { b = null; }
        return { id: e.id || '', x: b ? +b.x.toFixed(2) : null, y: b ? +b.y.toFixed(2) : null }; }) };
  });
  const allMoved = v7.after.length >= 2 && v7.after.every((a, i) => {
    const b = beforeMv.find(z => z.id === a.id); return b && b.x !== null && Math.abs((a.x - b.x) - 2) < 0.31;
  });
  ok('M7 批量位移：全部选中元素同时右移 2px',
    allMoved && v7.u1 === v7.u0 + 1, { before: beforeMv.map(b => b.id + ':' + b.x), after: v7.after, undo: v7.u0 + '→' + v7.u1 });

  /* ---------- M8：Shift 原生多选仍可用（回归） ---------- */
  const v8 = await page.evaluate(async () => {
    Editor.clearSel();
    await new Promise(r => setTimeout(r, 200));
    return { n: Editor.stats().nSel };
  });
  await page.mouse.click(A.x, A.y); await sleep(350);
  const n0 = (await grab()).n;
  await page.keyboard.down('Shift');
  await page.mouse.click(C.x, C.y);
  await page.keyboard.up('Shift');
  await sleep(420);
  const s8 = await grab();
  ok('M8 Shift 原生多选仍然可用（本层只接管 Ctrl，没破坏内核能力）',
    n0 === 1 && s8.n === 2, { n0, n1: s8.n, ids: s8.ids, C: C.hit });

  /* ---------- M9：选同类（#3 便利入口） ---------- *
   * ★ 核验判据必须与 selectSimilar 的判据**一一对应**：
   *     形状 → 同 tag + 相近宽高；文本 → 同字号。
   *   第一版这里只按宽高核验，而 real-01 上 selectSimilar 会走「同字号」分支选出一堆
   *   宽度各异的 text（173 / 434.9 / 478.7…）→ 探针误报失败。判据不同源就是假失败。
   * ★ 种子要**主动找一组真有同类的元素**：拿「有文本的第一个命中」当种子会走到
   *   rect#svg_2（1921×1081 整画布底板）—— 它当然没有同类，只验证到"如实报告"分支。 */
  const m9 = await page.evaluate(async () => {
    const sleep2 = ms => new Promise(r => setTimeout(r, ms));
    const c = Runtime.canvas;
    const content = c.getSvgContent() || document.getElementById('svgcontent');
    const box = e => { try { return Runtime.worldBBox(e); } catch (x) { return null; } };
    const near = (a, b) => isFinite(a) && isFinite(b)
      && Math.abs(a - b) <= Math.max(2, 0.02 * Math.max(Math.abs(a), Math.abs(b)));
    const tolOf = (a, b) => Math.max(2, 0.02 * Math.max(Math.abs(a), Math.abs(b))) + 0.02;
    const isTxt = e => /^(text|tspan)$/.test(e.tagName);
    const fsOf = e => { try { return +parseFloat(getComputedStyle(e).getPropertyValue('font-size')).toFixed(2); }
      catch (x) { return NaN; } };
    /* 与 selectSimilar 同源：搜索整棵子树 */
    const subtree = [];
    (function walk(n) { for (const ch of Array.prototype.slice.call(n.children || [])) {
      if (!/^(title|desc|defs|style|metadata)$/.test(ch.tagName)) subtree.push(ch); walk(ch); } })(content);
    const cand = subtree.filter(e => box(e));

    /* 找形状种子：其同类（同 tag + 相近宽高）≥2 */
    let shapeSeed = null;
    for (const e of cand) {
      if (isTxt(e)) continue;
      const b0 = box(e);
      const grp = cand.filter(o => { if (isTxt(o) || o.tagName !== e.tagName) return false;
        const b = box(o); return !!b && near(b.w, b0.w) && near(b.h, b0.h); });
      if (grp.length >= 2) { shapeSeed = e; break; }
    }
    /* 找文本种子：其同类（同字号）≥2 */
    let txtSeed = null;
    for (const e of cand) {
      if (!isTxt(e)) continue;
      const f0 = fsOf(e);
      const grp = cand.filter(o => isTxt(o) && Math.abs(fsOf(o) - f0) <= 0.5);
      if (grp.length >= 2) { txtSeed = e; break; }
    }

    const run = async (seed, kind) => {
      if (!seed) return null;
      Editor.select([seed]);
      await sleep2(280);
      const u0 = Editor.stats().undoSize;
      const r = Editor.selectSimilar();
      await sleep2(420);
      const sel = Editor.sel.map(e => { const b = box(e);
        return { tag: e.tagName, id: e.id || '', w: b ? +b.w.toFixed(1) : null,
          h: b ? +b.h.toFixed(1) : null, fs: fsOf(e) }; });
      const okSame = sel.length >= 2 && sel.every(s => kind === 'text'
        ? Math.abs(s.fs - sel[0].fs) <= 0.51
        : (s.tag === sel[0].tag && Math.abs(s.w - sel[0].w) <= tolOf(s.w, sel[0].w)
           && Math.abs(s.h - sel[0].h) <= tolOf(s.h, sel[0].h)));
      const u1 = Editor.stats().undoSize;
      Editor.clearSel(); await sleep2(200);
      return { ok: r.ok, n: r.n, err: r.err, seed: seed.tagName + '#' + (seed.id || ''),
        sel, okSame, u0, u1, chosen: sel.length ? sel[0].tag : null };
    };

    const shape = await run(shapeSeed, 'shape');
    const text = await run(txtSeed, 'text');
    /* 反例：整画布级底板没有同类 → 必须如实报告，不能瞎选一堆 */
    const big = cand.filter(e => { const b = box(e); return b && (b.w > 1500 || b.h > 900); })[0] || null;
    let miss = null;
    if (big) { Editor.select([big]); await sleep2(250);
      const r2 = Editor.selectSimilar(); miss = { ok: r2.ok, err: r2.err, n: r2.n, tag: big.tagName }; }
    return { shape, text, miss, nCand: cand.length, nKids: content.children.length,
      log: UI.logLines.filter(l => l.indexOf('选同类') >= 0).slice(-1).join('') };
  });
  ok('M9 选同类·形状：同 tag + 相近宽高一次全选（逐项核验）',
    !!(m9.shape && m9.shape.ok === true && m9.shape.n >= 2 && m9.shape.okSame),
    { seed: m9.shape && m9.shape.seed, n: m9.shape && m9.shape.n, nCand: m9.nCand,
      sel: m9.shape ? m9.shape.sel.slice(0, 6) : null, err: m9.shape && m9.shape.err });
  ok('M9 选同类·文本：同字号一次全选（逐项核验）',
    !!(m9.text && m9.text.ok === true && m9.text.n >= 2 && m9.text.okSame),
    { seed: m9.text && m9.text.seed, n: m9.text && m9.text.n,
      fs: m9.text ? Array.from(new Set(m9.text.sel.map(s => s.fs))) : null });
  ok('M9 选同类是纯选择操作（不改内容、不进撤销栈）',
    (!m9.shape || m9.shape.u1 === m9.shape.u0) && (!m9.text || m9.text.u1 === m9.text.u0),
    { shape: m9.shape && m9.shape.u0 + '→' + m9.shape.u1, text: m9.text && m9.text.u0 + '→' + m9.text.u1 });
  ok('M9 反例：整画布级底板无同类 → 如实报告「没找到」而不是瞎选',
    !m9.miss || (m9.miss.ok === false && /没找到|找不到/.test(String(m9.miss.err))),
    { miss: m9.miss });

  console.log(JSON.stringify({ target: TARGET, sample: want, errs, checks: chk,
    pass: chk.filter(c => c.pass).length, total: chk.length }, null, 1));
  await browser.close();
})();
