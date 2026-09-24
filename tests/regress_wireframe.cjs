/* 回归探针：Wireframe / 白板模式应把**真实内容**渲染为纯黑白（官方 SVG-Edit 语义）。
 *
 * 复现/判定（直接对齐用户原话「文字全黑、背景全白、只有黑白色」）：
 *   (a) 切到 wireframe：#stage 必须有 `wireframe` 类；
 *       #svgcontent **不得**被隐藏（visibility 不是 hidden）—— 内容是可见的去色版本。
 *   (b) 真实内容去色：#svgcontent 下所有图形元素（rect/circle/…/path/image）的计算
 *       样式 fill 必须为 'none'、stroke 必须为 'rgb(0, 0, 0)'；
 *       所有 text 元素 fill 必须为 'rgb(0, 0, 0)'、stroke 必须为 'none'。
 *       据此，wireframe 下不存在任何彩色 fill。
 *   (c) 切回 original：#stage 移除 `wireframe` 类，之前有彩色 fill 的元素恢复成原色
 *       （fill 不再是 'none'），证明只是视觉去色、内容 DOM 一个字节没改。
 *
 * 用法：NODE_PATH=... node tests/regress_wireframe.cjs
 *       SVGB_TARGET=svgb_beautifier.html node tests/regress_wireframe.cjs
 */
const { chromium } = require('playwright-core');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const TARGET = process.env.SVGB_TARGET || 'svgb_beautifier.html';
const url = 'file:///' + path.resolve(ROOT, TARGET).replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const GEOM = ['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'image'];

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true
  });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + (e.stack || e.message).slice(0, 400)));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__out && ['ready', 'fatal', 'nohost'].includes(window.__out.stage), null, { timeout: 120000 }).catch(() => {});
  await sleep(500);
  const stage0 = await page.evaluate(() => window.__out.stage);
  if (stage0 !== 'ready') { console.log(JSON.stringify({ stage: stage0, errs })); await browser.close(); return; }

  const result = await page.evaluate(async () => {
    const out = {};
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const GEOM = ['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'image'];
    const contentEls = () => {
      const root = Runtime.root && Runtime.root();
      const c = root && root.querySelector('#svgcontent');
      if (!c) return [];
      return Array.from(c.querySelectorAll(GEOM.join(',')));
    };
    const snap = () => contentEls().map(e => {
      const cs = getComputedStyle(e);
      return { tag: e.tagName.toLowerCase(), fill: cs.fill, stroke: cs.stroke };
    });
    const isColorFill = f => /^rgb/.test(f) && f !== 'rgb(0, 0, 0)' && f !== 'rgb(255, 255, 255)';

    // 载入一个真实样例（带彩色内容）以有可去色的素材；没有则取第一个
    const ri = UI.samples.findIndex(s => s.real === true);
    UI.select(ri >= 0 ? ri : 0);
    await sleep(400);

    // 记录 original 下的元素颜色，挑一个有彩色 fill 的元素做「恢复」对照
    const before = snap();
    const coloredIdx = before.findIndex(s => isColorFill(s.fill));
    out.original_hasColorFill = coloredIdx >= 0;
    out.original_colorFillSample = coloredIdx >= 0 ? before[coloredIdx] : null;

    // (a)(b) wireframe
    UI.setView('wireframe');
    await sleep(200);
    const stage = document.getElementById('stage');
    out.wf_hasClass = stage.classList.contains('wireframe');
    const c = Runtime.root().querySelector('#svgcontent');
    out.wf_contentHidden = c ? getComputedStyle(c).visibility === 'hidden' : 'no-content';

    const wf = snap();
    // 非文字图形元素：fill 必须为 none，stroke 必须为黑
    const nonText = wf.filter(s => s.tag !== 'text');
    out.wf_nonTextCount = nonText.length;
    out.wf_nonTextBadFill = nonText.filter(s => s.fill !== 'none').length;
    out.wf_nonTextBadStroke = nonText.filter(s => s.stroke !== 'rgb(0, 0, 0)').length;
    // 文字元素：fill 必须为黑，stroke 必须为 none
    const texts = wf.filter(s => s.tag === 'text');
    out.wf_textCount = texts.length;
    out.wf_textBadFill = texts.filter(s => s.fill !== 'rgb(0, 0, 0)').length;
    out.wf_textBadStroke = texts.filter(s => s.stroke !== 'none').length;
    // 任何元素都不允许出现彩色 fill
    out.wf_hasColorFill = wf.some(s => isColorFill(s.fill));

    // (c) 切回 original：类移除 + 彩色元素恢复
    UI.setView('original');
    await sleep(150);
    out.original_hasClass = stage.classList.contains('wireframe');
    const after = snap();
    out.original_restored = (coloredIdx >= 0 && after[coloredIdx] && isColorFill(after[coloredIdx].fill));

    // diagnostic 同样不应隐藏内容
    UI.setView('diagnostic');
    await sleep(150);
    const c2 = Runtime.root().querySelector('#svgcontent');
    out.diagnostic_contentHidden = c2 ? getComputedStyle(c2).visibility === 'hidden' : 'no-content';
    UI.setView('original');
    return out;
  });

  // 判定
  const checks = [
    ['wireframe 类已加', result.wf_hasClass === true],
    ['wireframe 下真实内容未隐藏', result.wf_contentHidden !== 'hidden'],
    ['wireframe 存在图形元素', result.wf_nonTextCount > 0],
    ['wireframe 图形 fill 全为 none', result.wf_nonTextBadFill === 0],
    ['wireframe 图形 stroke 全为黑', result.wf_nonTextBadStroke === 0],
    ['wireframe 存在文字元素', result.wf_textCount > 0],
    ['wireframe 文字 fill 全为黑', result.wf_textBadFill === 0],
    ['wireframe 文字 stroke 全为 none', result.wf_textBadStroke === 0],
    ['wireframe 无任何彩色 fill', result.wf_hasColorFill === false],
    ['original 移除了 wireframe 类', result.original_hasClass === false],
    ['original 彩色元素已恢复', result.original_restored === true],
    ['diagnostic 内容未隐藏', result.diagnostic_contentHidden !== 'hidden'],
    ['无 pageerror', errs.length === 0]
  ];
  const pass = checks.filter(c => c[1]).length;
  console.log(JSON.stringify({
    target: TARGET,
    result,
    pageErrors: errs.slice(0, 3),
    checks: checks.map(c => ({ name: c[0], pass: !!c[1] })),
    pass, total: checks.length
  }, null, 1));
  await browser.close();
})();
