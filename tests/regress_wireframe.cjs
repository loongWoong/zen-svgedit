/* 回归探针：Wireframe 视图应「只显示黑白」——隐藏原始彩色内容 + 骨架纯黑白灰。

 * 复现/判定：
 *   (a) 切到 wireframe：#svgcontent 必须 visibility:hidden（原始彩色内容不可见）；
 *       叠加层 wf 组里所有 stroke/fill 不得出现彩色 PAL 值
 *       （蓝 #2f6fed / 青 #0d9488 / 橙 #c2740a），只能是黑(#1f1f1f)/灰(#333/#555)/透明黑。
 *   (b) 切回 original / diagnostic / proposed：#svgcontent 恢复可见。
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

// 彩色 PAL（diagnostic/proposed 才用，wireframe 绝不允许出现）—— 在浏览器内联使用
const COLOR_PAL = ['#2f6fed', '#0d9488', '#c2740a', '#d64545', '#98a2b3'];

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
    const contentVis = () => {
      const c = Runtime.root() && Runtime.root().querySelector('#svgcontent');
      return c ? getComputedStyle(c).visibility : 'no-content';
    };
    // 载入一个真实样例（带内容）以有可隐藏的彩色内容
    const ri = UI.samples.findIndex(s => s.real === true);
    if (ri >= 0) UI.select(ri);
    await sleep(400);

    // (a) wireframe
    UI.setView('wireframe');
    await sleep(200);
    out.wf_contentVis = contentVis();
    const ovl = document.querySelector('#stage svg.svgb-ovl');
    const wf = ovl && ovl.querySelector('g.wf');
    out.wf_hasOverlay = !!wf;
    const colors = new Set();
    if (wf) wf.querySelectorAll('*').forEach(e => {
      ['stroke', 'fill'].forEach(a => { const v = e.getAttribute(a); if (v) colors.add(v.toLowerCase()); });
    });
    out.wf_strokeFillValues = Array.from(colors);
    const COLOR_PAL = ['#2f6fed', '#0d9488', '#c2740a', '#d64545', '#98a2b3'];
    out.wf_hasColor = out.wf_strokeFillValues.some(v => COLOR_PAL.includes(v));

    // (b) 切回 original
    UI.setView('original');
    await sleep(150);
    out.original_contentVis = contentVis();

    // (c) diagnostic 也须可见内容
    UI.setView('diagnostic');
    await sleep(150);
    out.diagnostic_contentVis = contentVis();
    UI.setView('original');
    return out;
  });

  // 判定
  const checks = [
    ['wireframe 下原始内容隐藏', result.wf_contentVis === 'hidden'],
    ['wireframe 叠加层存在', result.wf_hasOverlay === true],
    ['wireframe 骨架无彩色', result.wf_hasColor === false],
    ['切回 original 内容恢复', result.original_contentVis !== 'hidden'],
    ['diagnostic 内容仍可见', result.diagnostic_contentVis !== 'hidden'],
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
