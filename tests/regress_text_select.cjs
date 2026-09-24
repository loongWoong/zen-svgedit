/* 回归探针：选中文字元素不应再抛  Cannot read properties of null (reading 'focus'/'value')

 * 复现场景（用户报告）：进入编辑模式后，选中（文字）元素编辑时，
 *   svgcanvas 内置的「选中文字即进入画布内文本编辑」逻辑会触发
 *   textActions.select → toEditMode → init → this.#textinput.focus()，
 *   而 #textinput 恒为 null（宿主从未 setInputElem），于是抛
 *   'focus'/'value' 空引用，中断选中链路，表现为「选中其它元素报错、无法选中」。
 *
 * 本探针做两件事：
 *   (a) 真实鼠标点击若干文字元素的屏幕中心（忠实复现用户点选）；
 *   (b) 直接调用崩溃函数 Runtime.canvas.textActions.select(textEl,0,0)
 *       （绕过事件 target 依赖，确定性地命中旧的崩溃入口；新版已被置空，安全）。
 *
 * 判定：全程不得出现 reading 'focus' / reading 'value' / Cannot read properties of null
 *       的 pageerror；并且至少一次真实点击能把文字元素正常选中（grips>0）。
 *
 * 用法：NODE_PATH=.svgbuild/node_modules node tests/regress_text_select.cjs
 *       SVGB_TARGET=svgb_beautifier.html node tests/regress_text_select.cjs
 */
const { chromium } = require('playwright-core');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const TARGET = process.env.SVGB_TARGET || 'svgb_beautifier.html';
const url = 'file:///' + path.resolve(ROOT, TARGET).replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true
  });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + (e.stack || e.message).slice(0, 500)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 300)); });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__out && ['ready', 'fatal', 'nohost'].includes(window.__out.stage), null, { timeout: 120000 }).catch(() => {});
  await sleep(500);
  const stage = await page.evaluate(() => window.__out.stage);
  if (stage !== 'ready') { console.log(JSON.stringify({ stage, errs })); await browser.close(); return; }

  // 进入编辑模式
  await page.evaluate(() => UI.toggleEdit());
  await sleep(400);

  // 载入一个带文字的真实 SVG，确保有可点的 text
  await page.evaluate(() => {
    const i = UI.samples.findIndex(s => s.real === true);
    if (i >= 0) UI.select(i);
  });
  await sleep(500);

  // (a) 真实点击文字元素中心
  const texts = await page.evaluate(() => {
    const root = Runtime.root();
    const content = root.querySelector('#svgcontent') || root;
    const arr = [];
    content.querySelectorAll('text').forEach(t => {
      try {
        const ctm = t.getScreenCTM(); const bb = t.getBBox();
        if (!ctm || !bb || !bb.width) return;
        const cx = ctm.a * (bb.x + bb.width / 2) + ctm.c * (bb.y + bb.height / 2) + ctm.e;
        const cy = ctm.b * (bb.x + bb.width / 2) + ctm.d * (bb.y + bb.height / 2) + ctm.f;
        arr.push({ cx, cy, id: t.id });
      } catch (e) {}
    });
    return arr;
  });

  let anyTextSel = false, clickCount = 0;
  for (const t of texts.slice(0, 15)) {
    await page.evaluate(() => Editor.clearSel());
    await page.mouse.click(t.cx, t.cy).catch(() => {});
    await sleep(120);
    clickCount++;
    const info = await page.evaluate(() => ({
      n: Editor.sel.length, grips: Editor.grips(),
      tag: Editor.sel[0] ? Editor.sel[0].tagName : null
    }));
    if (info.tag === 'text' || info.tag === 'tspan') anyTextSel = true;
  }

  // (b) 确定性命中旧的崩溃入口
  const prog = await page.evaluate(() => {
    const root = Runtime.root();
    const content = root.querySelector('#svgcontent') || root;
    const t = content.querySelector('text');
    if (!t) return { hasText: false };
    try { Runtime.canvas.textActions.select(t, 0, 0); return { hasText: true, crashed: false }; }
    catch (e) { return { hasText: true, crashed: true, msg: e.message }; }
  });

  const focusErr = errs.filter(e =>
    /reading 'focus'|reading 'value'|Cannot read properties of null/.test(e));
  const out = {
    target: TARGET,
    stage,
    nText: texts.length,
    clickCount,
    anyTextSel,
    progHasText: prog.hasText,
    progCrashed: prog.crashed || false,
    focusErrorCount: focusErr.length,
    focusErrors: focusErr.slice(0, 3),
    consoleErrSample: errs.filter(e => !/reading 'focus'|reading 'value'|Cannot read properties of null/.test(e)).slice(0, 5)
  };
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})();
