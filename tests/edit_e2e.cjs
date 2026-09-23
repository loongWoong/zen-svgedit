/* 「编辑能力」端到端探针（真实无头 Edge + 真实 @svgedit/svgcanvas@7.4.2）
 *
 * 断言分组：
 *   A 模式边界：非编辑模式点画布不产生选中/手柄（输入守卫）；进入/退出本身不改内容
 *   B 操作生效：属性/位移/旋转/翻转/对齐/层级/复制/删除/成组 各自真的改到 DOM 且各记一条分数轨迹
 *   C 撤销重做：与 svgcanvas 的 undoMgr 同源，undo 到底能回到进入编辑时的内容
 *   D 非侵入性：「切视图不改内容」在编辑模式下依然成立
 *   E 可交付：编辑结果进入导出；退出编辑后内容保留、守卫恢复
 *   F 诚实性：探测证明 undo/redo 不在 canvas 上而在 undoMgr 上（.d.ts 与实际不符）
 *
 * ★ 两条必须遵守的探针契约（都是实测踩出来的，不是理论担忧）：
 *   1. **屏幕坐标必须在切换编辑模式之后重算。** 工具条在 #mid 的流里，展开后把
 *      #stage 从 y128/高862 推到 y204/高786（实测 edit_diag2.cjs）。任何在 toggleEdit
 *      之前算好的、指向画布的屏幕坐标，之后都会偏 76px，点击落到空白处。
 *   2. **不要预设「点到的会是哪个元素」。** 点是落在光标下的最上层元素上，常见结果
 *      是文本所属的 <g> 而不是我们事先挑的那个 rect。断言一律以 Editor.sel[0] 为准。
 *
 * 用法：NODE_PATH=.svgbuild/node_modules node tests/edit_e2e.cjs > edit2.json
 *       SVGB_TARGET=svgb_beautifier.html node edit_e2e.cjs   # 验单文件产物
 */
const { chromium } = require('playwright-core');
const crypto = require('crypto');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const TARGET = process.env.SVGB_TARGET || 'ui.html';
const url = 'file:///' + path.resolve(ROOT, TARGET).replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const chk = [];
const ok = (name, pass, detail) => chk.push({ name, pass: !!pass, detail: detail === undefined ? null : detail });

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const errs = [], failed = [];
  page.on('pageerror', e => errs.push('pageerror: ' + (e.stack || e.message).slice(0, 400)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 300)); });
  page.on('requestfailed', r => failed.push(r.url().slice(0, 160) + ' :: ' + (r.failure() ? r.failure().errorText : '?')));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__out && ['ready', 'fatal', 'nohost'].includes(window.__out.stage), null, { timeout: 120000 }).catch(() => {});
  await sleep(600);

  const out = { target: TARGET, stage: await page.evaluate(() => window.__out.stage), checks: chk };
  if (out.stage !== 'ready') {
    out.fatal = await page.evaluate(() => window.__out.fatal || null);
    out.errs = errs; out.failed = failed;
    console.log(JSON.stringify(out, null, 1)); await browser.close(); return;
  }

  /* ---------- 工具 ---------- */
  /* 每次调用现算：画布内某个 rect 节点的中心 → 视口坐标。
   * 拿不到节点时返回 null（辅助函数不该抛异常；IR 在重跑美化后可能短暂为空）。 */
  const pt = () => page.evaluate(() => {
    let ir = UI.ir;
    let why = '';
    if (!ir || !ir.nodes || !ir.nodes.length) {
      why = 'UI.ir 空(' + (ir ? (ir.nodes || []).length : 'null') + ')';
      try { ir = IR.build(Runtime, {}); } catch (e) { ir = null; why += ' / IR.build 抛 ' + e.message; }
    }
    if (!ir || !ir.nodes || !ir.nodes.length) {
      return { fail: true, why: why + ' → IR.build 后仍 ' + (ir ? (ir.nodes || []).length : 'null') + ' 个节点',
               irOk: !!(ir && ir.ok), stats: ir ? ir.stats : null,
               uiIr: UI.ir ? { ok: UI.ir.ok, n: (UI.ir.nodes || []).length } : null };
    }
    const nd = ir.nodes.find(n => n.shape === 'rect' && n.elem.tagName === 'rect')
            || ir.nodes.find(n => n.shape === 'rect') || ir.nodes[0];
    if (!nd || !nd.elem || !nd.geomBox) return { fail: true, why: 'nd/elem/geomBox 缺失' };
    const b = nd.geomBox;
    const root = Runtime.canvas.getSvgRoot();
    const m = root.getScreenCTM(); const p = root.createSvgPoint ? root.createSvgPoint() : root.createSVGPoint();
    p.x = b.x + b.w / 2; p.y = b.y + b.h / 2;
    const s = p.matrixTransform(m);
    const el = document.elementFromPoint(s.x, s.y);
    return { x: s.x, y: s.y, hit: el ? (el.tagName + (el.id ? '#' + el.id : '')) : null,
             nodeId: nd.domId || '', nodeTag: nd.elem.tagName };
  });
  /* 在画布上真实点一次并返回点（无节点可用时返回 null） */
  const clickCanvas = async () => {
    const p = await pt();
    if (!p || p.fail) return null;
    await page.mouse.click(p.x, p.y);
    await sleep(250);
    return p;
  };
  const sel = () => page.evaluate(() => ({
    n: Editor.sel.length, tag: Editor.sel[0] ? Editor.sel[0].tagName : null,
    id: Editor.sel[0] ? (Editor.sel[0].id || '') : null, grips: Editor.grips(),
    on: Editor.on, editing: UI.editing, mode: Runtime.canvas.getMode(), err: Editor.lastErr
  }));
  const snap = () => page.evaluate(() => ({
    sha: UI.snapshot().sha256, score: UI.an ? UI.an.score : null,
    n: Editor.track.length, last: Editor.track.length ? Editor.track[Editor.track.length - 1] : null
  }));
  /* 每步都包一层：单点异常只让该断言失败，不整轮中断 */
  const step = async (label, fn) => {
    try { return await fn(); }
    catch (e) { ok(label + '（无异常）', false, 'EXCEPTION: ' + String(e && e.message || e).slice(0, 220)); return null; }
  };

  /* ---------- F 能力探测（诚实性） ---------- */
  out.probe = await page.evaluate(() => Editor.probe(Runtime));
  ok('F 探测到 canvas.undo 在 IIFE 构建里不存在（.d.ts 与实际不符）',
     out.probe.hasUndoOnCanvas === false && out.probe.out['undoMgr.undo'] === 'function'
     && out.probe.hasUndoMgr === true,
     JSON.stringify({ hasUndoOnCanvas: out.probe.hasUndoOnCanvas, undoMgrUndo: out.probe.out['undoMgr.undo'] }));
  ok('F 编辑所需 API 无缺失（expected-absent 的 undo/redo 不计入）',
     (out.probe.missing || []).length === 0, JSON.stringify(out.probe.missing));
  ok('F svgcanvas 的官方撤销命令类可用（setText 依赖它入栈）',
     out.probe.hasHistoryClasses === true,
     JSON.stringify({ BatchCommand: out.probe.out['history.BatchCommand'], ChangeElementCommand: out.probe.out['history.ChangeElementCommand'] }));
  ok('F setTextContent 存在但被标为 KNOWN_BROKEN（存在性照报，不进 missing）',
     out.probe.out.setTextContent === 'function'
     && (out.probe.missing || []).indexOf('setTextContent') < 0,
     JSON.stringify({ type: out.probe.out.setTextContent }));

  /* 选一件缺陷件（有多个 rect + text，便于逐项操作） */
  const pick = await page.evaluate(() => UI.samples.findIndex(s => !s.real && (s.defects || []).length >= 3));
  await page.evaluate(i => UI.select(i), pick);
  await sleep(400);
  out.sample = await page.evaluate(() => UI.samples[UI.cur].id);
  out.uiPresence = await page.evaluate(() => ({
    btnEdit: !!document.getElementById('btnEdit'),
    editbar: !!document.getElementById('editbar'),
    editPanel: !!document.getElementById('editPanel'),
    editbarHiddenInitially: getComputedStyle(document.getElementById('editbar')).display === 'none',
    panelHiddenInitially: getComputedStyle(document.getElementById('editPanel')).display === 'none',
    btns: ['eFill','eStroke','eSW','eFS','eText','eBold','eItalic','eL','eR','eUp','eDn','eRot','eRotGo',
           'eAlign','eFlipH','eFlipV','eGroup','eUngroup','eLayerUp','eLayerDn','eTop','eBottom','eClone',
           'eDel','eUndo','eRedo'].filter(id => !document.getElementById(id))
  }));
  ok('A UI 元素齐备', out.uiPresence.btnEdit && out.uiPresence.editbar && out.uiPresence.editPanel
     && out.uiPresence.btns.length === 0 && out.uiPresence.editbarHiddenInitially && out.uiPresence.panelHiddenInitially,
     JSON.stringify(out.uiPresence.btns));

  /* ---------- A 模式边界 ---------- */
  out.a0 = await page.evaluate(() => ({ on: Editor.on, guard: Editor.guardArmed(), editing: UI.editing }));
  ok('A2 初始未进入编辑模式且守卫已挂', out.a0.on === false && out.a0.guard === true && out.a0.editing === false,
     JSON.stringify(out.a0));

  const shaBeforeGuard = await page.evaluate(() => UI.snapshot().sha256);
  const p0 = await clickCanvas();
  out.a1 = { pt: p0 };
  ok('A3a 能在画布上定位到可点节点', !!p0, JSON.stringify(p0));
  out.a1.afterClick = await page.evaluate(() => ({
    sel: Editor.sel.length, canvasSel: Runtime.canvas.getSelectedElements().length,
    grips: Editor.grips(), sha: UI.snapshot().sha256, on: Editor.on
  }));
  ok('A3 非编辑模式点击 → 未选中、无手柄、内容不变（输入守卫生效）',
     out.a1.afterClick.sel === 0 && out.a1.afterClick.canvasSel === 0
     && out.a1.afterClick.grips === 0 && out.a1.afterClick.sha === shaBeforeGuard,
     JSON.stringify(out.a1.afterClick));

  /* 手柄计数判据自检：grips() 必须看渲染盒，不能看 visibility */
  out.gripJudge = await page.evaluate(() => {
    const root = Runtime.canvas.getSvgRoot();
    const els = Array.from(root.querySelectorAll('[id^="selectorGrip"]'));
    const styleSaysVisible = els.filter(e => { const c = getComputedStyle(e); return c.visibility !== 'hidden' && c.display !== 'none'; }).length;
    const boxSaysVisible = els.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length;
    return { total: els.length, styleSaysVisible, boxSaysVisible };
  });
  ok('A3b 未选中时 grips()=0（按渲染盒判定；按 visibility 会误报 10）',
     out.gripJudge.boxSaysVisible === 0 && out.gripJudge.styleSaysVisible > 0,
     JSON.stringify(out.gripJudge));

  /* 进入编辑模式本身不得改内容 */
  const shaBeforeEnable = await page.evaluate(() => UI.snapshot().sha256);
  await page.evaluate(() => UI.toggleEdit());
  await sleep(350);
  out.a4 = await page.evaluate(() => ({ on: Editor.on, editing: UI.editing, sha: UI.snapshot().sha256,
    barOn: document.getElementById('editbar').classList.contains('on'),
    panelOn: document.getElementById('editPanel').classList.contains('on'),
    entry: Editor.entryScore, undoSize: Editor.undoSize() }));
  out.a4.shaBeforeEnable = shaBeforeEnable;
  /* 进入编辑模式那一刻的 SVG 原文（C3 用来定位「撤不回去」到底差在哪） */
  const entrySvg = await page.evaluate(() => Runtime.exportString());
  ok('A4 进入编辑模式本身不改内容', out.a4.sha === shaBeforeEnable, out.a4.sha + ' vs ' + shaBeforeEnable);
  ok('A4 进入后工具条/面板显示、基线分数就绪', out.a4.barOn && out.a4.panelOn && typeof out.a4.entry === 'number');

  /* 进入编辑后 layout 变化量（这是「坐标必须重算」的实证） */
  out.layout = await page.evaluate(() => {
    const r = document.getElementById('stage').getBoundingClientRect();
    return { stageY: r.y, stageH: r.height, barH: document.getElementById('editbar').getBoundingClientRect().height };
  });

  /* ★ 关键：进入编辑模式之后再取坐标 */
  const p1 = await clickCanvas();
  out.a5pt = p1;
  out.a5 = await sel();
  out.a5.selInfo = await page.evaluate(() => document.getElementById('selInfo').textContent);
  ok('A5 编辑模式点击 → 选中且手柄可见（坐标在进入编辑后重算）',
     out.a5.n > 0 && out.a5.grips > 0, JSON.stringify(out.a5));
  /* 面板上的手柄数必须与真实渲染盒一致：svgcanvas 的手柄在 'selected' 之后才渲染，
   * 同帧取值会得到 0（曾经出现「面板 0 / 实际 9」）。 */
  const m5 = /可见手柄\s*(\d+)/.exec(String(out.a5.selInfo || ''));
  ok('A5b 面板「可见手柄」数与实际渲染盒一致（非同帧陈旧值）',
     !!m5 && Number(m5[1]) === out.a5.grips,
     JSON.stringify({ selInfo: out.a5.selInfo, grips: out.a5.grips, parsed: m5 ? Number(m5[1]) : null }));

  /* ---------- A6 ★ 程序化选中同样必须生成抓手（本轮新增的回归防线） ----------
   * 修复前 `Editor.select()` 调的是 `selectOnly([el])`，**省略了第二个参数 showGrips**。
   * 压缩源：`XC=(t,e)=>{ ... A.length===1 && ke.selectorManager.requestSelector(A[0]).showGrips(e) }`
   *   —— e 为 undefined 时 showGrips(undefined) 不建任何抓手，只画选择框 path#selectedBox0；
   * 而真实鼠标点击走的是 `k.selectOnly([c],!0)`，所以会建抓手。
   * 后果：A5 这种「走点击」的用例永远绿，而所有走 Editor.select() 的 UI 路径
   *       （点画布对象列表 / 点 Issue / 撤销后重选）都看不到手柄 —— 一个只在
   *       程序化路径上出现的可见性缺陷。
   * 为了让这条断言**自证有牙**，下面同页跑两组对照：
   *   raw    = 直接 c.selectOnly([el])（故意省略第二参）= 修复前的行为
   *   editor = Editor.select([el])（内部传 true）
   * 只有 raw 计数为 0、editor 计数非 0，才说明断言真的能分辨这两种实现。 */
  const selectGrips = (mode) => page.evaluate(async (m) => {
    const c = Runtime.canvas, root = c.getSvgRoot();
    const prev = Editor.sel.slice();
    /* 只在 #svgcontent 里找、且**屏幕盒必须非零、且不在 defs 里**：
     * 本样例的 #svgcontent 第一个带 id 的元素是 defs 里一个 0×0 的 path#svg_1，
     * 选中它时抓手同样是 0×0 —— 断言会假失败（这一步踩过，见 grip_diag2.cjs）。 */
    const content = root.querySelector('#svgcontent') || root;
    const cands = Array.from(content.querySelectorAll('rect,circle,ellipse,path,polygon,line'))
      .filter(e => e.id && !e.closest('defs'));
    const el = cands.find(e => {
      const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    }) || null;
    if (!el) return { fail: true, why: '找不到屏幕盒非零的可选中元素（候选 ' + cands.length + '）' };
    Editor.clearSel();
    if (m === 'editor') Editor.select([el]); else c.selectOnly([el]);   /* raw 故意省略第二参 */
    /* 抓手在 'selected' 之后才渲染：必须等两帧，否则拿到同帧陈旧值 0 */
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const g = root.querySelector('#selectorGroup0');
    const gg = c.selectorManager.selectorGripsGroup;
    const rec = {
      fail: false, mode: m, id: el.id, nSel: Editor.sel.length,
      grips: Editor.grips(), box: !!root.querySelector('#selectedBox0'),
      gripsGroupDisp: gg ? gg.getAttribute('display') : null,
      hasGripsFlag: (() => { const s = c.selectorManager.selectors.find(x => x && x.selectedElement === el); return s ? s.hasGrips : null; })(),
      groupKids: g ? Array.from(g.children).map(x => x.tagName + (x.id ? '#' + x.id : '')) : null
    };
    /* 复原 A5 的选中，避免污染后续用例 */
    const back = prev.filter(e => e && e.isConnected);
    if (back.length) Editor.select(back);
    return rec;
  }, mode);

  out.a6raw = await selectGrips('raw');
  out.a6 = await selectGrips('editor');
  ok('A6a 自证断言有效：省略 showGrips 时抓手组 display=none（raw 组）',
     !out.a6raw.fail && out.a6raw.grips === 0 && out.a6raw.box === true
       && out.a6raw.gripsGroupDisp === 'none',
     JSON.stringify(out.a6raw));
  ok('A6 ★ 程序化 Editor.select() 生成抓手（selectOnly 第二参 showGrips 必传）',
     !out.a6.fail && out.a6.nSel === 1 && out.a6.grips > 0 && out.a6.box
       && out.a6.gripsGroupDisp === 'inline' && out.a6.hasGripsFlag === true,
     JSON.stringify(out.a6));
  /* A6b 做个「反向对照」：裸调 selectOnly 时**选择框照样画**，只是抓手组 display=none。
   * 说明缺陷的精确边界是「抓手不可见」而非「完全没选中」——
   * 这也解释了为什么只截图不看 DOM 时容易误判成「点击没生效」。 */
  ok('A6b 反向对照：两组都画出选择框，差异仅在抓手组 display',
     !out.a6.fail && !out.a6raw.fail
       && out.a6.box === true && out.a6raw.box === true
       && out.a6.gripsGroupDisp === 'inline' && out.a6raw.gripsGroupDisp === 'none',
     JSON.stringify({
       editor: { box: out.a6.box, disp: out.a6.gripsGroupDisp, grips: out.a6.grips },
       raw: { box: out.a6raw.box, disp: out.a6raw.gripsGroupDisp, grips: out.a6raw.grips }
     }));

  /* ---------- B 操作生效 ---------- */
  out.b = {};
  const needSel = async (label) => {
    const s = await sel();
    if (s.n === 0) ok(label + '（前置：有选中元素）', false, JSON.stringify(s));
    return s.n > 0;
  };

  /* B1 填充 */
  const before1 = await snap();
  out.b.b1 = await step('B1 填充', async () => {
    if (!(await needSel('B1 填充'))) return { skipped: 'no-selection' };
    return page.evaluate(() => {
      const before = Runtime.exportString();
      const el = Editor.sel[0];
      const res = Editor.setFill('#ff5500');
      return { res, changed: before !== Runtime.exportString(),
               hasColor: /#ff5500/i.test(Runtime.exportString()),
               tag: el.tagName, id: el.id || '',
               ownFill: el.getAttribute('fill'),
               childFill: el.querySelector('[fill]') ? el.querySelector('[fill]').getAttribute('fill') : null,
               effFill: (() => { try { return getComputedStyle(el).fill; } catch (e) { return null; } })() };
    });
  });
  if (out.b.b1) {
    out.b.b1.before = before1;
    out.b.b1.after = await snap();
    ok('B1 填充：DOM 变化 + 记录一条轨迹 + 导出串含新色',
       out.b.b1.changed === true && out.b.b1.hasColor === true
       && out.b.b1.after.n === before1.n + 1,
       JSON.stringify(out.b.b1).slice(0, 420));
    ok('B1 轨迹带分数并可与进入时分数比较', !!(out.b.b1.after.last
       && typeof out.b.b1.after.last.score === 'number' && typeof out.b.b1.after.last.total === 'number'));
  }

  /* B2 位移（必须精确 2 个用户单位，验证 moveSelectedElements 的数组语义） */
  out.b.b2 = await step('B2 位移', async () => {
    if (!(await needSel('B2 位移'))) return { skipped: 'no-selection' };
    return page.evaluate(() => {
      const el = Editor.sel[0];
      const id = el.id || '';
      const ir0 = IR.build(Runtime, {});
      const n0 = ir0.nodes.find(n => n.elem === el) || ir0.nodes.find(n => n.domId === id);
      const b0 = n0 ? n0.geomBox : null;
      const res = Editor.move(2, 0);
      const ir1 = IR.build(Runtime, {});
      const n1 = ir1.nodes.find(n => n.elem === el) || ir1.nodes.find(n => n.domId === id);
      const b1 = n1 ? n1.geomBox : null;
      return { res, id, hasB0: !!b0, hasB1: !!b1,
               b0: b0 ? { x: r2(b0.x), y: r2(b0.y) } : null,
               b1: b1 ? { x: r2(b1.x), y: r2(b1.y) } : null,
               dx: (b0 && b1) ? r2(b1.x - b0.x) : null, dy: (b0 && b1) ? r2(b1.y - b0.y) : null,
               transform: el.getAttribute('transform') };
    });
  });
  if (out.b.b2) ok('B2 位移精确为 2 个用户单位（数组入参语义）',
    out.b.b2.dx === 2 && out.b.b2.dy === 0, JSON.stringify(out.b.b2));

  /* B3 字号 / 文本 —— 必须选**真正的 text 元素**（不是「带标签的节点」，
   * 后者的 elem 常常是包住 text 的 <g>；对 g 设字号在 svgcanvas 里会抛
   * "Cannot read properties of null (reading 'value')"，见 09_editor.js#_textGuard） */
  out.b.b3 = await step('B3 字号与文本', async () => {
    const nd = await page.evaluate(() => {
      const root = Runtime.canvas.getSvgRoot();
      const sc = root.querySelector('#svgcontent') || root;
      const els = Array.from(sc.querySelectorAll('text,tspan')).filter(e => String(e.textContent || '').trim());
      const el = els[0];
      if (!el) return null;
      Editor.select([el]);
      return { tag: el.tagName, id: el.id || '', text: String(el.textContent || '') };
    });
    if (!nd) return { noText: true };
    const r = await page.evaluate(() => {
      const el = Editor.sel[0];
      if (!el) return { noText: true, reason: 'select 后仍无选中' };
      const t0 = Editor.track.length;
      const fs0 = el.getAttribute('font-size');
      const r1 = Editor.setFontSize(23);
      const t1 = Editor.track.length;
      const fs1 = el.getAttribute('font-size');
      const r2r = Editor.setText('审计');
      const t2 = Editor.track.length;
      const t = el.tagName === 'text' ? el : (el.closest('text') || el);
      const sp = t.querySelector ? t.querySelector('tspan') : null;
      return { tag: el.tagName, id: el.id || '', fs0, fs1, r1, r2: r2r,
               track: { t0, t1, t2, entries: Editor.track.slice(t0).map(x => x.label) },
               own: String(t.textContent || ''), tspan: sp ? String(sp.textContent || '') : null,
               sel: Editor.sel.length, nText: Editor.stats().nText };
    });
    return Object.assign({ picked: nd }, r);
  });
  if (out.b.b3) ok('B3 字号可改（font-size 落到 text 元素属性）',
    out.b.b3.noText ? false : String(out.b.b3.fs1) === '23',
    JSON.stringify(out.b.b3).slice(0, 380));
  if (out.b.b3) ok('B3 文本可改（changeSelectedAttribute("#text") 命中 text/tspan）',
    out.b.b3.noText ? false : (out.b.b3.own === '审计' || out.b.b3.tspan === '审计'),
    JSON.stringify({ own: out.b.b3.own, tspan: out.b.b3.tspan }));
  /* B3d 文本对齐方式：要真的会变（样例里 anchor 已是 middle，得换个值） */
  out.b.b3d = await step('B3d 文本对齐', async () => {
    return page.evaluate(() => {
      const c = Runtime.canvas;
      const sc = c.getSvgRoot().querySelector('#svgcontent');
      const el = Array.from(sc.querySelectorAll('text')).filter(e => String(e.textContent || '').trim())[0];
      Editor.select([el]);
      const t0 = Editor.track.length, u0 = Editor.undoSize();
      const a0 = el.getAttribute('text-anchor');
      const res = Editor.setTextAnchor(a0 === 'start' ? 'middle' : 'start');
      return { res, id: el.id, a0, a1: el.getAttribute('text-anchor'),
               dTrack: Editor.track.length - t0, dUndo: Editor.undoSize() - u0,
               label: Editor.track.length ? Editor.track[Editor.track.length - 1].label : null };
    });
  });
  if (out.b.b3d) ok('B3d 文本对齐方式可改且落轨迹、进撤销栈',
    out.b.b3d.res && out.b.b3d.res.ok === true && out.b.b3d.a1 !== out.b.b3d.a0
    && out.b.b3d.dTrack === 1 && out.b.b3d.dUndo === 1,
    JSON.stringify(out.b.b3d).slice(0, 320));

  if (out.b.b3) ok('B3c 字号与文本各落一条分数轨迹（无静默丢失）',
    out.b.b3.noText ? false : (out.b.b3.track.t1 === out.b.b3.track.t0 + 1
      && out.b.b3.track.t2 === out.b.b3.track.t0 + 2),
    JSON.stringify(out.b.b3.track));

  /* B3b —— 语义已按用户需求 #1 变更（原断言已过时，会误报回归）。
   * 旧断言要求「字号 / 加粗 在 <g> 上必须被拒」——那正是用户报的
   * 「选中一个元素无法修改字号大小并生效」：真实画布上点到的就是卡片 <g>/rect。
   * 现在 字号·加粗·斜体·对齐·字体 会下钻到选中容器内部的文字（09_editor.js#_textProp），
   * 断言改为**新语义**：
   *   ① 字号与加粗必须成功（覆盖到容器内的文字）；
   *   ② 必须只动文字，**子元素一个不少**（守卫放宽后最怕的就是结构被破坏）；
   *   ③ 文本内容 setText 仍必须被拒 —— 它直写 textContent，对 <g> 会抹掉全部子元素。 */
  out.b.b3b = await step('B3b 容器选中：文本属性下钻生效且不破坏结构', async () => {
    return page.evaluate(() => {
      const ir = IR.build(Runtime, {});
      const withText = ir.nodes.map(n => n.elem)
        .filter(e => e && e.tagName === 'g' && e.querySelectorAll('text,tspan').length);
      const nd = (withText[0]) || (ir.nodes.find(n => n.shape === 'rect') || ir.nodes[0]).elem;
      if (!nd) return { noNodes: true };
      Editor.select([nd]);
      const before = Runtime.exportString();
      const c0 = nd.querySelectorAll('*').length;
      const nTgt = Editor.stats().nFontTgt;
      const a = Editor.setFontSize(30);
      const c2 = Editor.setBold(true);
      const b = Editor.setText('不该生效');
      const after = Runtime.exportString();
      return { tag: nd.tagName, nTgt, a, b, c: c2, err: Editor.lastErr,
               domTouched: before !== after,
               childCount0: c0, childCount1: nd.querySelectorAll('*').length,
               htmlHasText: /不该生效/.test(after),
               score: UI.an ? UI.an.score : null };
    });
  });
  if (out.b.b3b) ok('B3b 容器选中：字号/加粗下钻生效、setText 仍被拒、且子元素零损失',
    out.b.b3b.noNodes ? false
      : (out.b.b3b.nTgt > 0
         && out.b.b3b.a.ok === true && out.b.b3b.c.ok === true
         && out.b.b3b.domTouched === true
         && out.b.b3b.childCount1 === out.b.b3b.childCount0
         && out.b.b3b.htmlHasText === false
         && out.b.b3b.b.ok === false && /没有文本元素/.test(String(out.b.b3b.b.err))),
    JSON.stringify(out.b.b3b).slice(0, 460));

  /* B3c 真正「没有文字」的选中项：必须给可读错误、DOM 零改动。
   * 这一条守的是**另一头**：下钻放宽不能变成「什么都能改」。 */
  out.b.b3c = await step('B3c 无文字选中项仍被拒（零改动）', async () => {
    return page.evaluate(() => {
      const ir = IR.build(Runtime, {});
      let pick = null;
      for (const n of ir.nodes) {
        if (!n.elem || n.elem.tagName === 'g') continue;
        if ((n.labels || []).length) continue;
        if (n.elem.querySelectorAll && n.elem.querySelectorAll('text,tspan').length) continue;
        pick = n.elem; break;
      }
      if (!pick) return { noCandidate: true };
      Editor.select([pick]);
      const before = Runtime.exportString();
      const c0 = pick.querySelectorAll('*').length;
      const nTgt = Editor.stats().nFontTgt;
      const a = Editor.setFontSize(31);
      const c2 = Editor.setBold(true);
      const after = Runtime.exportString();
      return { tag: pick.tagName, nTgt, a, c: c2, err: Editor.lastErr,
               domUntouched: before === after,
               childCount0: c0, childCount1: pick.querySelectorAll('*').length };
    });
  });
  if (out.b.b3c) ok('B3c 无文字选中项：字号/加粗被拒、不抛异常、DOM 零改动',
    out.b.b3c.noCandidate ? true
      : (out.b.b3c.nTgt === 0 && out.b.b3c.a.ok === false && out.b.b3c.c.ok === false
         && out.b.b3c.domUntouched === true
         && out.b.b3c.childCount1 === out.b.b3c.childCount0),
    JSON.stringify(out.b.b3c).slice(0, 420));

  /* B4 旋转 */
  out.b.b4 = await step('B4 旋转', async () => {
    if (!(await needSel('B4 旋转'))) return { skipped: 'no-selection' };
    return page.evaluate(() => {
      const el = Editor.sel[0];
      const t0 = el.getAttribute('transform');
      const res = Editor.rotate(30);
      const t1 = el.getAttribute('transform');
      return { res, t0, t1, rot: Editor.rotation(), matches: /rotate\(\s*30[\s,)]/.test(String(t1)) };
    });
  });
  if (out.b.b4) ok('B4 旋转 30° 写入 transform 且可读回',
    out.b.b4.matches === true && out.b.b4.rot === 30, JSON.stringify(out.b.b4));

  /* B5 层级 / 复制 / 删除 / 翻转 / 对齐 / 成组解组 */
  out.b.b5 = await step('B5 结构操作', async () => {
    return page.evaluate(async () => {
      const r = {};
      /* 正确的 API 名是 getSvgContent（不是 getSVGContent）；拿不到就退回 DOM 查询 */
      const cnt = () => {
        try {
          const c = Runtime.canvas.getSvgContent();
          if (c && c.querySelectorAll) return c.querySelectorAll('*').length;
        } catch (e) { /* 忽略 */ }
        const sc = Runtime.canvas.getSvgRoot().querySelector('#svgcontent');
        return sc ? sc.querySelectorAll('*').length : -1;
      };
      const ir = IR.build(Runtime, {});
      const nd = ir.nodes.find(n => n.shape === 'rect') || ir.nodes[0];
      if (!nd) return { noNodes: true };
      Editor.select([nd.elem]);

      /* 翻转 */
      const s0 = Runtime.exportString();
      r.flipRes = Editor.flip(true, false);
      r.flip = { changed: s0 !== Runtime.exportString(), t: nd.elem.getAttribute('transform') };

      /* 层级：置顶 */
      const before = Runtime.exportString();
      r.toTopRes = Editor.toTop();
      r.toTop = { changed: before !== Runtime.exportString() };

      /* 复制副本 */
      const c0 = cnt(); r.cloneRes = Editor.clone(); r.clone = { from: c0, to: cnt(), sel: Editor.sel.length };
      /* 删除（此刻选中的应还是原元素；无论如何删都有东西可删） */
      const c1 = cnt(); r.delRes = Editor.del(); r.del = { from: c1, to: cnt() };

      /* 成组：选两个元素 */
      const ir2 = IR.build(Runtime, {});
      const two = ir2.nodes.slice(0, 2).map(n => n.elem).filter(Boolean);
      Editor.select(two);
      const g0 = cnt(); r.groupRes = Editor.group();
      r.group = { from: g0, to: cnt(), sel: Editor.sel.length, tag: Editor.sel[0] ? Editor.sel[0].tagName : null };
      const g1 = cnt(); r.ungroupRes = Editor.ungroup(); r.ungroup = { from: g1, to: cnt() };

      /* 对齐（多选时相对选区） */
      const ir3 = IR.build(Runtime, {});
      const three = ir3.nodes.slice(0, 3).map(n => n.elem).filter(Boolean);
      Editor.select(three);
      const a0 = Runtime.exportString(); r.alignRes = Editor.align('l', 'selected');
      r.align = { changed: a0 !== Runtime.exportString(), sel: Editor.sel.length };

      r.track = Editor.track.map(x => x.label);
      return r;
    });
  });
  if (out.b.b5) {
    ok('B5 翻转改变 transform', out.b.b5.flip && out.b.b5.flip.changed === true, JSON.stringify(out.b.b5.flip));
    ok('B5 置顶改变 DOM 顺序', out.b.b5.toTop && out.b.b5.toTop.changed === true, JSON.stringify(out.b.b5.toTop));
    ok('B5 复制副本增加元素', out.b.b5.clone && out.b.b5.clone.to > out.b.b5.clone.from, JSON.stringify(out.b.b5.clone));
    ok('B5 删除减少元素', out.b.b5.del && out.b.b5.del.to < out.b.b5.del.from, JSON.stringify(out.b.b5.del));
    ok('B5 成组后选中变成 g', out.b.b5.group && out.b.b5.group.sel >= 1 && out.b.b5.group.tag === 'g',
       JSON.stringify(out.b.b5.group));
    /* 解组 = 拆掉那个 g、把孩子提回父节点 → 元素数应回到**成组前**（少 1 个 g），
       而不是等于成组后。原先的断言写错了。 */
    ok('B5 解组回到成组前的元素数',
       out.b.b5.ungroup && out.b.b5.group && out.b.b5.ungroup.to === out.b.b5.group.from,
       JSON.stringify({ before: out.b.b5.group.from, afterGroup: out.b.b5.group.to, afterUngroup: out.b.b5.ungroup.to }));
    ok('B5 对齐改变内容', out.b.b5.align && out.b.b5.align.changed === true, JSON.stringify(out.b.b5.align));
    ok('B5 多类操作都进了轨迹（≥6 条）', (out.b.b5.track || []).length >= 6, JSON.stringify(out.b.b5.track));
  }

  /* ---------- C 撤销 / 重做 ---------- */
  out.c = {};
  /* ★ 基线要用 Editor.entrySha（进入编辑模式那一刻的内容），
   *   不能用 Editor._sha —— 后者是「最近一次已知内容」，每个动作都会推进，
   *   拿它当基线会让「撤回到基线」的循环在第一轮就 break（假通过）。 */
  const entrySha = await page.evaluate(() => Editor.entrySha);
  out.c.before = await page.evaluate(() => ({ sha: UI.snapshot().sha256, undo: Editor.undoSize(),
    redo: Editor.redoSize(), label: Editor.undoLabel(), score: UI.an ? UI.an.score : null,
    entryScore: Editor.entryScore, entrySha: Editor.entrySha, track: Editor.track.length }));
  out.c.entrySha = entrySha;
  ok('C0 基线 sha 与当前 sha 不同（轨迹确实推进过内容）',
     !!entrySha && entrySha !== out.c.before.sha,
     JSON.stringify({ entrySha: String(entrySha).slice(0, 16), cur: String(out.c.before.sha).slice(0, 16) }));

  out.c.undo1 = await step('C1 撤销', async () => page.evaluate(() => {
    const r = Editor.undo();
    return { res: r, sha: UI.snapshot().sha256, undo: Editor.undoSize(), redo: Editor.redoSize(),
             redoLabel: Editor.redoLabel(), score: UI.an ? UI.an.score : null, track: Editor.track.length,
             last: Editor.track[Editor.track.length - 1] || null };
  }));
  if (out.c.undo1) {
    ok('C1 撤销改变内容并进入重做栈',
       out.c.undo1.sha !== out.c.before.sha && out.c.undo1.redo === out.c.before.redo + 1,
       JSON.stringify({ beforeRedo: out.c.before.redo, afterRedo: out.c.undo1.redo, sameSha: out.c.undo1.sha === out.c.before.sha }));
  }

  out.c.redo1 = await step('C2 重做', async () => page.evaluate(() => {
    const r = Editor.redo();
    return { res: r, sha: UI.snapshot().sha256, undo: Editor.undoSize(), redo: Editor.redoSize() };
  }));
  if (out.c.redo1) ok('C2 重做回到撤销前的内容', out.c.redo1.sha === out.c.before.sha,
    JSON.stringify({ redoSha: out.c.redo1.sha, beforeSha: out.c.before.sha }));

  /* 一直撤销到「进入编辑模式时的内容」为止（不是撤空整个会话栈——那会把 load 也撤掉） */
  out.c.toEntry = await step('C3 撤回到进入编辑基线', async () => page.evaluate(entry => {
    let n = 0;
    while (n < 80) {
      let cur = ''; try { cur = sha256Hex(Runtime.exportString()); } catch (e) { cur = ''; }
      if (cur === entry) break;
      if (Editor.undoSize() <= 0) break;
      Editor.undo(); n++;
    }
    let cur = ''; try { cur = sha256Hex(Runtime.exportString()); } catch (e) { cur = ''; }
    return { undone: n, reachedEntry: cur === entry, sha: cur, entrySha: entry,
             undo: Editor.undoSize(), score: UI.an ? UI.an.score : null, entryScore: Editor.entryScore };
  }, entrySha));
  out.c.diff = await step('C3 diff', async () => page.evaluate((a) => {
    const b = Runtime.exportString();
    const na = String(a).split('>'), nb = String(b).split('>');
    const lines = [];
    for (let i = 0; i < Math.max(na.length, nb.length) && lines.length < 8; i++) {
      if (na[i] !== nb[i]) lines.push({ i, entry: String(na[i]).slice(-120), now: String(nb[i]).slice(-120) });
    }
    const cnt = (src) => {
      const d = new DOMParser().parseFromString(src, 'image/svg+xml');
      const c = d.querySelector('#svgcontent') || d.documentElement;
      return { els: c.querySelectorAll('*').length, nodes: c.querySelectorAll('rect,circle,ellipse,polygon').length, texts: c.querySelectorAll('text,tspan').length };
    };
    return { lenEntry: String(a).length, lenNow: String(b).length, firstDiffs: lines, sigEntry: cnt(a), sigNow: cnt(b) };
  }, entrySvg));
  if (out.c.diff) ok('C3d 全撤销后的内容与进入时结构一致（元素/图形/文本计数）',
    JSON.stringify(out.c.diff.sigEntry) === JSON.stringify(out.c.diff.sigNow),
    JSON.stringify(out.c.diff).slice(0, 700));

  if (out.c.toEntry) {
    ok('C3 撤销到底后回到编辑基线（内容 sha 与进入时一致）',
       out.c.toEntry.reachedEntry === true, JSON.stringify({ undone: out.c.toEntry.undone, reached: out.c.toEntry.reachedEntry, undoLeft: out.c.toEntry.undo }));
    ok('C3 分数也回到进入时的基线分', out.c.toEntry.score === out.c.toEntry.entryScore,
       JSON.stringify({ score: out.c.toEntry.score, entry: out.c.toEntry.entryScore }));
  }

  /* ---------- D 非侵入性在编辑模式下仍成立 ---------- */
  const dBase = await page.evaluate(() => UI.snapshot().sha256);
  out.d = [];
  for (const v of ['wireframe', 'diagnostic', 'proposed', 'original']) {
    const r = await page.evaluate(async vv => { UI.setView(vv); await new Promise(x => setTimeout(x, 40));
      return { view: vv, sha: UI.snapshot().sha256, drawn: UI.snapshot().drawn }; }, v);
    out.d.push(r);
  }
  ok('D 「切视图不改内容」在编辑模式下依然成立',
     out.d.every(x => x.sha === dBase), JSON.stringify(out.d.map(x => [x.view, x.sha === dBase])));

  /* ---------- E 可交付 ---------- */
  out.e = {};
  out.e.editThenExport = await step('E 编辑后导出', async () => page.evaluate(() => {
    const ir = IR.build(Runtime, {});
    const nd = ir.nodes.find(n => n.shape === 'rect') || ir.nodes[0];
    if (nd) Editor.select([nd.elem]);
    const r = Editor.setFill('#0d9488');
    const s = UI.exportSvg() || '';
    return { res: r, len: s.length, hasColor: s.indexOf('#0d9488') >= 0 || s.indexOf('#0D9488') >= 0,
             score: UI.an ? UI.an.score : null };
  }));
  if (out.e.editThenExport) ok('E 编辑结果进入导出字符串', out.e.editThenExport.hasColor === true,
    JSON.stringify(out.e.editThenExport).slice(0, 260));

  const shaBeforeExit = await page.evaluate(() => UI.snapshot().sha256);
  await page.evaluate(() => UI.toggleEdit());
  await sleep(350);
  out.e.exit = await page.evaluate(() => ({ on: Editor.on, editing: UI.editing, sha: UI.snapshot().sha256,
    sel: Editor.sel.length, canvasSel: Runtime.canvas.getSelectedElements().length, grips: Editor.grips(),
    barOn: document.getElementById('editbar').classList.contains('on'),
    panelOn: document.getElementById('editPanel').classList.contains('on'),
    badge: document.getElementById('statBadge').textContent }));
  out.e.exit.shaBefore = shaBeforeExit;
  ok('E 退出编辑：内容保留、选择清空、手柄消失、面板收起',
     out.e.exit.sha === shaBeforeExit && out.e.exit.on === false && out.e.exit.sel === 0
     && out.e.exit.grips === 0 && out.e.exit.canvasSel === 0
     && !out.e.exit.barOn && !out.e.exit.panelOn,
     JSON.stringify(out.e.exit));

  await page.evaluate(() => UI.run('beautify'));
  await page.waitForFunction(() => !UI.busy, null, { timeout: 120000 }).catch(() => {});
  await sleep(300);
  out.e.reBeautify = await page.evaluate(() => ({ ok: !!(UI.lastResult && UI.lastResult.ok),
    before: UI.lastResult ? UI.lastResult.before.score : null,
    after: UI.lastResult ? UI.lastResult.after.score : null,
    delta: UI.lastResult ? UI.lastResult.delta : null }));
  ok('E 退出后再跑「一键美化」正常（编辑成果可继续自动优化）', out.e.reBeautify.ok === true,
     JSON.stringify(out.e.reBeautify));

  /* 退出后守卫重新生效（坐标同样要重算——工具条已收起） */
  const shaAfterRe = await page.evaluate(() => UI.snapshot().sha256);
  const p2 = await clickCanvas();
  out.e.guardBack = await page.evaluate(() => ({ sel: Editor.sel.length,
    canvasSel: Runtime.canvas.getSelectedElements().length, grips: Editor.grips(), sha: UI.snapshot().sha256 }));
  out.e.guardBack.pt = p2;
  ok('E 退出后输入守卫生效（点击不选中、不改内容）',
     !!p2 && out.e.guardBack.sel === 0 && out.e.guardBack.canvasSel === 0 && out.e.guardBack.grips === 0
     && out.e.guardBack.sha === shaAfterRe,
     JSON.stringify(out.e.guardBack));

  /* ---------- 截图（进出编辑各一张，便于目视） ---------- */
  await page.screenshot({ path: path.resolve(__dirname, 'edit_ui_off.png') });
  await page.evaluate(() => UI.toggleEdit());
  await sleep(250);
  await page.evaluate(async () => {
    const ir = IR.build(Runtime, {});
    const nd = ir.nodes.find(n => n.shape === 'rect') || ir.nodes[0];
    if (nd) Editor.select([nd.elem]);
    await new Promise(r => setTimeout(r, 80));
  });
  await page.screenshot({ path: path.resolve(__dirname, 'edit_ui_on.png') });

  out.errs = errs; out.failed = failed;
  ok('A1 零 pageerror / console error', errs.length === 0, JSON.stringify(errs).slice(0, 400));
  ok('A1 零失败请求', failed.length === 0, JSON.stringify(failed).slice(0, 240));
  out.pass = chk.filter(c => c.pass).length;
  out.total = chk.length;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch(e => { console.log(JSON.stringify({ fatal: String(e && e.stack || e) }, null, 1)); process.exit(1); });
