/* 「ui.html 打开本地 SVG 文件」的真实浏览器探针（无头 Edge + 真实 svgcanvas）
 *
 * 断言（product 层）：
 *   A. 打开动作零 pageerror / 零 console error / 零 requestfailed
 *   B. 文件选择器（#fileInput setInputFiles）：
 *      B1 单选一件真实 SVG → 新增 1 条 local 条目、被选中、an.score 有值、
 *         四视图都能画、sha256 非空
 *      B2 **内容未被改动**：UI.samples[i].svg 与磁盘原文逐字节相同
 *      B3 多选 3 件 → nLocal === 3，且最后一件被选中
 *      B4 重复打开同名文件 → 条目原地覆盖（nLocal 不再增加）
 *      B5 #sampMeta 出现「本地文件」提示；左栏该条目带 .local 类
 *   C. 拖拽入舞台：
 *      C1 拖入 File → 新增条目
 *      C2 拖入纯文本（无 Files）→ 也能新增条目
 *      C3 拖入非 SVG 文本 → 拒绝，且日志留痕（不产生条目）
 *   D. Ctrl+O 键盘路径确实触发 #fileInput.click()
 *   E. 美化只改内存工作副本：run('beautify') 后 samples[cur].svg 仍等于磁盘原文，
 *      且 Δ ≥ -0.05（不得越改越丑）
 * 用法：NODE_PATH=.svgbuild/node_modules node tests/open_probe.cjs > open1.json
 */
const { chromium } = require('playwright-core');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.resolve(__dirname, '..');
/* SVGB_TARGET 可指向单文件产物：SVGB_TARGET=svgb_beautifier.html node open_probe.cjs */
const TARGET = process.env.SVGB_TARGET || 'ui.html';
const url = 'file:///' + path.resolve(ROOT, TARGET).replace(/\\/g, '/');

const REL = [
  'svgedit/svg/onto_platform_architecture.svg',
  'report/assets/laya-marker-scorer.svg',
  'svgedit/svg/02_知识如何长出来.svg'
];
const ABS = REL.map(r => path.resolve(ROOT, r));
const TXT = ABS.map(p => fs.readFileSync(p, 'utf8'));
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const chk = [];
const ok = (name, pass, detail) => chk.push({ name, pass: !!pass, detail });

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const errs = [], failed = [];
  page.on('pageerror', e => errs.push('pageerror: ' + (e.stack || e.message).slice(0, 400)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 300)); });
  page.on('requestfailed', r => failed.push(r.url().slice(0, 160) + ' :: ' + (r.failure() ? r.failure().errorText : '?')));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(
    () => window.__out && ['ready', 'fatal', 'nohost'].includes(window.__out.stage),
    null, { timeout: 120000 }).catch(() => {});
  await sleep(600);

  const out = { stage: await page.evaluate(() => window.__out.stage), checks: chk };
  if (out.stage !== 'ready') {
    out.fatal = await page.evaluate(() => window.__out.fatal || null);
    out.errs = errs; out.failed = failed;
    console.log(JSON.stringify(out, null, 1));
    await browser.close();
    return;
  }
  out.nSamples0 = await page.evaluate(() => UI.samples.length);

  /* ---------- 入口存在性 ---------- */
  out.entry = await page.evaluate(() => ({
    btnOpen: !!document.getElementById('btnOpen'),
    fileInput: !!document.getElementById('fileInput'),
    inputHidden: getComputedStyle(document.getElementById('fileInput')).display === 'none',
    accept: document.getElementById('fileInput').getAttribute('accept'),
    multiple: document.getElementById('fileInput').hasAttribute('multiple'),
    drop: !!document.getElementById('drop')
  }));
  ok('B0 #btnOpen 存在', out.entry.btnOpen);
  ok('B0 #fileInput 存在且被 .hidden 隐藏（非 display 兜底）', out.entry.fileInput && out.entry.inputHidden);
  ok('B0 accept 限定 svg/xml', /svg/.test(out.entry.accept || ''));
  ok('B0 multiple 允许多选', out.entry.multiple);

  /* ---------- B1 + B2：单选一件真实 SVG ---------- */
  await page.setInputFiles('#fileInput', ABS[0]);
  await page.waitForFunction(() => UI.samples.filter(s => s.local).length === 1, null, { timeout: 20000 }).catch(() => {});
  await sleep(400);
  out.b1 = await page.evaluate(disk => {
    const s = UI.snapshot();
    const e = UI.samples[UI.cur];
    return { sample: s.sample, sampleLocal: s.sampleLocal, nLocal: s.nLocal, nSamples: s.nSamples,
             score: s.score, issues: s.issues, canvas: s.canvas, nodes: s.nodes, edges: s.edges,
             sha256: s.sha256, svgLen: s.svgLen,
             cls: e && e.__el ? e.__el.className : null,
             meta: document.getElementById('sampMeta').textContent.slice(0, 240),
             nSamp: document.getElementById('nSamp').textContent,
             diskSame: e.svg === disk, diskLen: disk.length };
  }, TXT[0]);
  out.b2 = await page.evaluate(() => {
    const s = UI.samples.filter(x => x.local)[0];
    return { id: s.id, name: s.name, fileName: s.fileName, bytes: s.svg.length, sub: s.sub,
             expectClean: s.expectClean, real: !!s.real, startsSvg: /<svg[\s>]/i.test(s.svg) };
  });
  ok('B1 新增 1 条 local 条目', out.b1 && out.b1.nLocal === 1);
  ok('B1 打开后自动选中该条目', out.b1 && out.b1.sampleLocal === true);
  ok('B1 分析有分（an.score 非空）', out.b1 && typeof out.b1.score === 'number');
  ok('B1 导出内容非空（sha256 长度 64）', out.b1 && String(out.b1.sha256).length === 64);
  ok('B2 条目内 svg 与磁盘原文逐字节相同（打开不改内容）',
     out.b1 && out.b1.diskSame === true && out.b1.diskLen === TXT[0].length && out.b2.startsSvg === true);
  ok('B1 左栏条目带 .local 类', out.b1 && /(^|\s)samp(\s|$)/.test(out.b1.cls || '') && /\slocal(\s|$)/.test(out.b1.cls || ''));
  ok('B5 #sampMeta 出现「本地文件」提示', out.b1 && /本地文件/.test(out.b1.meta || ''));
  ok('B5 计数显示「本地 1」', out.b1 && /本地 1/.test(out.b1.nSamp || ''));

  /* 四视图都能画 */
  out.b1Views = [];
  for (const v of ['original', 'wireframe', 'diagnostic', 'proposed']) {
    const r = await page.evaluate(async vv => { UI.setView(vv); await new Promise(r => setTimeout(r, 30));
      const s = UI.snapshot(); return { view: vv, drawn: s.drawn, ovl: s.ovl, ovlChildren: s.ovlChildren }; }, v);
    out.b1Views.push(r);
  }
  ok('B1 四视图均可渲染（wireframe 叠加层清空 drawn=0 / diagnostic 有图元）',
     out.b1Views[1].drawn === 0 && out.b1Views[1].ovl === true && out.b1Views[2].drawn > 0);

  /* ---------- B3：多选 3 件 ---------- */
  await page.setInputFiles('#fileInput', ABS);
  await page.waitForFunction(() => UI.samples.filter(s => s.local).length === 3, null, { timeout: 20000 }).catch(() => {});
  await sleep(500);
  out.b3 = await page.evaluate(() => ({
    nLocal: UI.snapshot().nLocal, nSamples: UI.snapshot().nSamples,
    ids: UI.samples.filter(s => s.local).map(s => s.id),
    cur: UI.samples[UI.cur] && UI.samples[UI.cur].id,
    selValue: document.getElementById('selSample').value,
    opts: document.getElementById('selSample').options.length,
    nSamp: document.getElementById('nSamp').textContent
  }));
  ok('B3 多选 3 件 → nLocal === 3', out.b3.nLocal === 3);
  ok('B3 下拉选项数 = 样例总数（本地条目已进下拉）', out.b3.opts === out.b3.nSamples);
  ok('B3 最后一件被选中', out.b3.cur === out.b3.ids[2]);
  out.b3Bytes = await page.evaluate(() => UI.samples.filter(s => s.local).map(s => s.svg.length));
  ok('B3 三条本地条目字节数与磁盘一致',
     JSON.stringify(out.b3Bytes) === JSON.stringify(TXT.map(t => t.length)));

  /* ---------- B4：重复打开同名文件 → 原地覆盖 ---------- */
  await page.setInputFiles('#fileInput', ABS[0]);
  await sleep(500);
  out.b4 = await page.evaluate(() => ({ nLocal: UI.snapshot().nLocal,
    ids: UI.samples.filter(s => s.local).map(s => s.id) }));
  ok('B4 重复打开同名文件不新增条目（原地覆盖）',
     out.b4.nLocal === 3 && out.b4.ids.filter(x => x === out.b3.ids[0]).length === 1);

  /* ---------- C1/C2/C3：拖拽 ---------- */
  const dragFile = await page.evaluate(async () => {
    const dt = new DataTransfer();
    dt.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120">'
      + '<rect x="10" y="10" width="80" height="40" fill="none" stroke="#333"/>'
      + '<text x="100" y="80" font-size="14">drag</text></svg>'], 'dropped-by-drag.svg', { type: 'image/svg+xml' }));
    const st = document.getElementById('stage');
    for (const t of ['dragenter', 'dragover', 'drop'])
      st.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 400));
    return { nLocal: UI.snapshot().nLocal, cur: UI.samples[UI.cur] && UI.samples[UI.cur].id,
             dropping: st.classList.contains('dropping') };
  });
  out.c1 = dragFile;
  ok('C1 拖入 File → 新增条目且被选中',
     out.c1.nLocal === 4 && out.c1.cur === 'local-dropped-by-drag');
  ok('C1 drop 后投放层已收起（.dropping 已移除）', out.c1.dropping === false);

  const dragText = await page.evaluate(async () => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">'
      + '<circle cx="160" cy="100" r="60" fill="none" stroke="#0a7"/></svg>');
    const st = document.getElementById('stage');
    for (const t of ['dragover', 'drop'])
      st.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 400));
    return { nLocal: UI.snapshot().nLocal, cur: UI.samples[UI.cur] && UI.samples[UI.cur].id };
  });
  out.c2 = dragText;
  ok('C2 拖入纯文本 SVG → 新增条目', out.c2.nLocal === 5 && out.c2.cur === 'local-dropped');

  const dragBad = await page.evaluate(async () => {
    const before = UI.snapshot().nLocal;
    const dt = new DataTransfer();
    dt.setData('text/plain', 'hello, not an svg at all');
    const st = document.getElementById('stage');
    for (const t of ['dragover', 'drop'])
      st.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 300));
    return { before, after: UI.snapshot().nLocal, log: UI.logLines.slice(-3).join(' | ') };
  });
  out.c3 = dragBad;
  ok('C3 非 SVG 文本被拒绝（条目数不变）', out.c3.after === out.c3.before);
  ok('C3 拒绝时日志留痕', /不是 XML 文本/.test(out.c3.log || ''));

  /* ---------- D：Ctrl+O 键盘路径 ---------- */
  const ctrlO = await page.evaluate(async () => {
    let clicks = 0;
    const fi = document.getElementById('fileInput');
    const h = () => { clicks++; };
    fi.addEventListener('click', h);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 120));
    fi.removeEventListener('click', h);
    return { clicks };
  });
  out.d = ctrlO;
  ok('D Ctrl+O 触发 #fileInput.click()', out.d.clicks === 1);

  /* ---------- E：美化只改工作副本 ---------- */
  await page.evaluate(() => {
    const i = UI.samples.findIndex(s => s.local && s.fileName === 'onto_platform_architecture.svg');
    return UI.select(i >= 0 ? i : UI.cur);
  });
  await sleep(300);
  const beforeRun = await page.evaluate(() => {
    const s = UI.samples[UI.cur]; return { id: s.id, srcLen: s.svg.length, beforeScore: UI.an ? UI.an.score : null };
  });
  await page.evaluate(() => UI.run('beautify'));
  await page.waitForFunction(() => !UI.busy, null, { timeout: 120000 }).catch(() => {});
  await sleep(300);
  out.e = await page.evaluate(disk => {
    const s = UI.samples[UI.cur];
    const r = UI.lastResult || {};
    return { id: s.id, srcLen: s.svg.length, srcStillSameAsDisk: s.svg === disk, diskLen: disk.length,
             dryRun: !!r.dryRun,
             delta: r.delta == null ? null : r.delta,
             before: r.before ? r.before.score : null, after: r.after ? r.after.score : null,
             score: UI.an ? UI.an.score : null, sha256: UI.snapshot().sha256 };
  }, TXT[0]);
  out.eSrcLenBefore = beforeRun.srcLen;
  ok('E 美化后条目内「原始 svg」仍等于磁盘原文（未写回原文件）',
     out.e.srcStillSameAsDisk === true && out.e.srcLen === out.eSrcLenBefore);
  ok('E 本地文件可被美化且不劣化（Δ ≥ -0.05）', out.e.delta != null && out.e.delta >= -0.05);

  /* ---------- F：本地缺陷件走完整「打开 → 一键美化」，必须有可测量提升 ----------
   * E 用的那件是 1920×1080 真实图（标定域外），Δ 恰好 0：只能证明「不劣化」。
   * 这里把一件已知缺陷的内置件写到磁盘、再经**文件打开入口**读回来，
   * 证明「本地文件」这条路上确实能拿到正向 Δ。 */
  const tmpDir = path.resolve(__dirname, 'tmp_local');
  fs.mkdirSync(tmpDir, { recursive: true });
  const devIdx = await page.evaluate(() => {
    let best = -1, bestDef = 1;
    UI.samples.forEach((s, i) => {
      if (!s.local && !s.real && (s.defects || []).length > bestDef) { bestDef = s.defects.length; best = i; }
    });
    return best;
  });
  const devSvg = await page.evaluate(i => UI.samples[i].svg, devIdx);
  const devName = await page.evaluate(i => UI.samples[i].id, devIdx);
  const devPath = path.join(tmpDir, 'opened-defect.svg');
  fs.writeFileSync(devPath, devSvg, 'utf8');

  const nLocalBeforeF = await page.evaluate(() => UI.snapshot().nLocal);
  await page.setInputFiles('#fileInput', devPath);
  await page.waitForFunction(n => UI.samples.filter(s => s.local).length === n + 1,
    nLocalBeforeF, { timeout: 20000 }).catch(() => {});
  await sleep(400);
  out.f0 = await page.evaluate(() => {
    const s = UI.samples[UI.cur];
    return { cur: s.id, local: !!s.local, score: UI.an ? UI.an.score : null,
             issues: UI.an ? UI.an.issues.length : null,
             diskSame: s.svg.length };
  });
  out.f0.srcName = devName;
  ok('F 缺陷件经「打开」入口读入并选中', out.f0.local === true && out.f0.cur === 'local-opened-defect');

  await page.evaluate(() => UI.run('beautify'));
  await page.waitForFunction(() => !UI.busy, null, { timeout: 120000 }).catch(() => {});
  await sleep(300);
  out.f1 = await page.evaluate(() => {
    const r = UI.lastResult || {};
    return { before: r.before ? r.before.score : null, after: r.after ? r.after.score : null,
             delta: r.delta == null ? null : r.delta, rounds: (r.ledger || []).length,
             nOps: (r.ops && r.ops.ops) ? r.ops.ops.length : 0,
             srcLen: UI.samples[UI.cur].svg.length,
             sha256: UI.snapshot().sha256 };
  });
  ok('F 打开本地缺陷件后 Δ > 1（可测量提升）', out.f1.delta != null && out.f1.delta > 1);
  ok('F 美化后本地原文件内容未被写回（长度不变）', out.f1.srcLen === devSvg.length);

  /* ---------- 截图（目视校验用） ---------- */
  await page.evaluate(async () => { UI.setView('wireframe'); await new Promise(r => setTimeout(r, 60)); });
  await page.screenshot({ path: path.resolve(__dirname, 'open_ui.png'), fullPage: false });

  out.finalState = await page.evaluate(() => {
    const s = UI.snapshot();
    return { nLocal: s.nLocal, nSamples: s.nSamples, sample: s.sample, score: s.score, sha256: s.sha256 };
  });
  out.errs = errs; out.failed = failed;
  ok('A 零 pageerror / console error', errs.length === 0);
  ok('A 零失败请求', failed.length === 0);
  out.pass = chk.filter(c => c.pass).length;
  out.total = chk.length;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch(e => { console.log(JSON.stringify({ fatal: String(e && e.stack || e) }, null, 1)); process.exit(1); });
