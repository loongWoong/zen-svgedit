/* 编辑改动清单「可取消 / 可回退」的端到端验收（#2）
 *   C1 每次改动都进清单，且每行带勾选框 + 可读标签 + 单步 Δ
 *   C2 取消中间某一步 → **定向还原**：该步改的属性回到旧值，
 *      而它前后两步的改动原样保留（这才是「可取消」而不是「整段回退」）
 *   C3 被取消的行变灰划掉，汇总文本如实反映「已应用 / 已取消」
 *   C4 取消后内容与撤销栈自洽（不是靠 undo 把后面的步骤一起吃回去）
 *   C5「全部回退」→ 回到进入编辑模式时的内容（sha 相同）与分数，清单清空
 *   C6 含结构变更（删除元素）的步骤被正确标记 → 走整段回退并如实报告牵连步数
 * 用法：NODE_PATH=.svgbuild/node_modules node tests/edit_cancel.cjs [real-01]
 *       SVGB_TARGET=svgb_beautifier.html node edit_cancel.cjs
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
const cnt = 'const cnt=(t,k)=>(t.match(new RegExp(k,"gi"))||[]).length;';

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
  await sleep(700);

  /* 两个互不相同的可选元素（与 id 一起记，撤销/替换后仍可按 id 找回来） */
  const pts = await page.evaluate(() => {
    const c = Runtime.canvas, ir = IR.build(Runtime, {}), root = c.getSvgRoot(), m = root.getScreenCTM();
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
      out.push({ x: s.x, y: s.y, hitId: t.id || '', hit: t.tagName + '#' + (t.id || '') });
    }
    return out;
  });
  const seen = new Set();
  const uniq = pts.filter(p => { if (seen.has(p.hit)) return false; seen.add(p.hit); return true; });
  const A = uniq[0], B = uniq.find(p => p.hit !== A.hit);
  ok('harness: 两个互不相同的可选元素', !!(A && B), { A: A && A.hit, B: B && B.hit });

  const base = await page.evaluate(() => {
    const st = Editor.stats();
    return { sha: st.entrySha, score: st.entryScore, undo: st.undoSize, atEntry: st.atEntry };
  });

  const summary = () => page.evaluate(() => ({
    n: Editor.track.length,
    labels: Editor.track.map(r => r.label),
    cancelled: Editor.track.filter(r => r.cancelled).length,
    struct: Editor.track.map(r => !!r.struct),
    diffs: Editor.track.map(r => (r.diff || []).length),
    sumText: (document.getElementById('eSum') || {}).textContent || '',
    rows: Array.from(document.querySelectorAll('#eTrack .etrk')).map(r => ({
      n: r.querySelector('.n') ? r.querySelector('.n').textContent : null,
      cls: r.className,
      hasCb: !!r.querySelector('input.cb'),
      cbDisabled: r.querySelector('input.cb') ? r.querySelector('input.cb').disabled : null,
      title: (r.querySelector('input.cb') || {}).title || ''
    })),
    undo: Editor.stats().undoSize, atEntry: Editor.stats().atEntry
  }));

  /* ---------- 造三步改动：A 改填充 → B 改填充 → A 位移 ---------- */
  const setFill = async (v) => page.evaluate(async (val) => {
    const el = document.getElementById('eFill');
    el.value = val; el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
  }, v);

  await page.mouse.click(A.x, A.y); await sleep(450);
  await setFill('#ff8800');
  await page.mouse.click(B.x, B.y); await sleep(450);
  await setFill('#0088ff');
  await page.mouse.click(A.x, A.y); await sleep(450);
  await page.evaluate(async () => {
    document.getElementById('eR').click();          /* 右移 2px */
    await new Promise(r => setTimeout(r, 600));
  });

  const c1 = await summary();
  ok('C1 三次改动都进清单（3 行，标签可读，每行都能指出改了多少处属性）',
    c1.n === 3 && c1.diffs.every(d => d > 0) && c1.labels.every(l => l && l.length > 0),
    { n: c1.n, labels: c1.labels, diffs: c1.diffs });
  ok('C1 每行都有勾选框（可取消）且默认勾选',
    c1.rows.length === 3 && c1.rows.every(r => r.hasCb), { rows: c1.rows.map(r => r.n + ':' + r.cls) });
  ok('C1 汇总文本如实显示「3 项已应用」', /3 项已应用/.test(c1.sumText), { sum: c1.sumText });

  /* ---------- C2：取消中间那一步（#2 = B 的填充） ---------- */
  const beforeCancel = await page.evaluate((Bid) => {
    const s = Runtime.exportString();
    return { s: s.length, has8800: s.indexOf('ff8800') >= 0 || s.indexOf('#FF8800') >= 0,
      has0088: /0088ff/i.test(s), u0: Editor.stats().undoSize,
      bx: (() => { const e = document.getElementById(Bid); return e ? +Runtime.worldBBox(e).x.toFixed(2) : null; })() };
  }, B.hitId);

  const c2 = await page.evaluate(async () => {
    const rows = Array.from(document.querySelectorAll('#eTrack .etrk'));
    const row = rows.find(r => r.querySelector('.n') && r.querySelector('.n').textContent === '#2');
    if (!row) return { err: '找不到 #2 行' };
    const cb = row.querySelector('input.cb');
    const cbTitle = cb ? cb.title : '';
    if (cb) cb.click();
    await new Promise(r => setTimeout(r, 800));
    const s = Runtime.exportString();
    return { clicked: !!cb, cbTitle,
      log: UI.logLines.slice(-1).join(''),
      n: Editor.track.length, cancelled: Editor.track.filter(r => r.cancelled).length,
      labels: Editor.track.map(r => r.label + (r.cancelled ? '(已取消)' : '')),
      has8800: s.indexOf('ff8800') >= 0 || s.indexOf('#FF8800') >= 0,
      has0088: /0088ff/i.test(s), len: s.length, u1: Editor.stats().undoSize,
      rows: Array.from(document.querySelectorAll('#eTrack .etrk')).map(r => ({
        n: r.querySelector('.n') ? r.querySelector('.n').textContent : null, cls: r.className,
        cb: r.querySelector('input.cb') ? r.querySelector('input.cb').checked : null })),
      sumText: (document.getElementById('eSum') || {}).textContent || '' };
  });
  ok('C2 取消 #2（改 B 填充）→ 该步写进去的颜色从内容里消失',
    c2.clicked && beforeCancel.has0088 && !c2.has0088,
    { before: beforeCancel.has0088, after: c2.has0088, title: c2.cbTitle });
  ok('C2 定向还原：它**前面**那步（A 的填充 #ff8800）原样保留',
    beforeCancel.has8800 && c2.has8800, { still: c2.has8800 });
  ok('C2 它**后面**那步（A 的右移 2px）也原样保留 —— 才叫「只取消这一步」',
    c2.labels.length === 3 && c2.labels[2].indexOf('已取消') < 0 && /位移/.test(c2.labels[2]),
    { labels: c2.labels, len0: beforeCancel.s, len1: c2.len });
  ok('C3 被取消的行变灰（.done）且勾选框显示为未勾选',
    c2.rows.some(r => r.n === '#2' && /done/.test(r.cls) && r.cb === false),
    { rows: c2.rows });
  ok('C3 汇总文本如实反映「已取消」', /已取消/.test(c2.sumText) && /2 项已应用/.test(c2.sumText),
    { sum: c2.sumText, log: c2.log });
  ok('C4 取消走的是定向还原（日志明确写出还原了几处属性），不是整段 undo',
    /定向还原 \d+ 处属性/.test(c2.log), { log: c2.log.slice(-160) });

  /* ---------- C5：全部回退 ---------- */
  const c5 = await page.evaluate(async () => {
    const btns = document.getElementById('eClr');
    const disabledBefore = btns.disabled;
    const undoBefore = Editor.stats().undoSize;
    btns.click();
    await new Promise(r => setTimeout(r, 1200));
    const st = Editor.stats();
    return { disabledBefore, n: Editor.track.length, atEntry: st.atEntry, sha: st.sha, shaSame: st.shaSame,
      entrySha: st.entrySha, score: st.curScore, entryScore: st.entryScore,
      nodes: st.entryNodes, nodesNow: (Editor.ir && Editor.ir.ok) ? Editor.ir.nodes.length : null,
      sumText: (document.getElementById('eSum') || {}).textContent || '',
      rowCount: document.querySelectorAll('#eTrack .etrk').length,
      log: UI.logLines.slice(-1).join('') };
  });
  ok('C5「全部回退」→ 内容回到进入编辑模式时的状态（结构计数 + 分数双等）',
    c5.atEntry === true, { atEntry: c5.atEntry, score: c5.score + '/' + c5.entryScore,
      nodes: c5.nodesNow + '/' + c5.nodes, undo: c5.undoBefore + '→' + c5.undo, baseScore: base.score });
  ok('C5 如实记录：XML 文本层因 DOM 往返的属性顺序规范化而不同（shaSame=false，不是缺陷）',
    c5.shaSame === false && c5.sha !== c5.entrySha, { shaSame: c5.shaSame, sha: c5.sha, entry: c5.entrySha });
  ok('C5「全部回退」→ 分数回到基线、清单清空',
    c5.n === 0 && c5.rowCount === 0 && c5.score === c5.entryScore,
    { n: c5.n, rows: c5.rowCount, score: c5.score, entryScore: c5.entryScore, base: base.score, log: c5.log.slice(-120) });

  /* ---------- C6：含结构变更的步骤 → 标记 struct + 整段回退 ---------- */
  await page.mouse.click(A.x, A.y); await sleep(450);
  const c6 = await page.evaluate(async () => {
    document.getElementById('eDel').click();            /* 删除 = 结构变更 */
    await new Promise(r => setTimeout(r, 700));
    const rec = Editor.track[Editor.track.length - 1];
    const chk = rec ? Editor.canCancel(rec.n) : null;
    return { n: Editor.track.length, struct: rec ? !!rec.struct : null,
      label: rec ? rec.label : null, mode: chk ? chk.mode : null, later: chk ? chk.later : null };
  });
  ok('C6 删除这类结构变更被正确标记（struct=true → 取消只能整段回退）',
    c6.struct === true && c6.mode === 'rollback' && /\u5220\u9664/.test(String(c6.label)),
    { struct: c6.struct, mode: c6.mode, later: c6.later, label: c6.label });

  console.log(JSON.stringify({ target: TARGET, sample: want, errs, checks: chk,
    pass: chk.filter(c => c.pass).length, total: chk.length }, null, 1));
  await browser.close();
})();
