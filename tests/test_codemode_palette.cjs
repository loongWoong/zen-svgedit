const { chromium } = require('playwright-core');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const url = 'file:///' + path.resolve(ROOT, 'ui.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const b = await chromium.launch({ executablePath: EDGE, headless: true });
  const p = await b.newPage();
  const pageErrors = [];
  p.on('pageerror', e => pageErrors.push(e.message));
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__out && window.__out.stage === 'ready', null, { timeout: 60000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 600));

  // 载入一个真实样例，便于测试配色切换
  const setup = await p.evaluate(async () => {
    const smp = UI.samples.find(s => s.id.indexOf('real-02') >= 0);
    if (smp) await UI.select(UI.samples.indexOf(smp));
    return {
      hasPalette: typeof Palette !== 'undefined',
      hasCodeMode: typeof CodeMode !== 'undefined',
      paletteNames: (typeof Palette !== 'undefined') ? Palette.names().length : 0,
      selPaletteOpts: document.querySelectorAll('#selPalette option').length
    };
  });

  // 1) 代码模式开关
  const codeToggle = await p.evaluate(() => {
    document.getElementById('btnCode').click();
    const on = document.getElementById('mid').classList.contains('codemode');
    const ta = document.getElementById('codeArea').value || '';
    return { on, taLen: ta.length, taHasSvg: /<svg[\s>]/i.test(ta) };
  });

  // 2) 代码编辑实时生效：把文本框写成一个简单红矩形 SVG，应用后预览应包含它
  const codeEdit = await p.evaluate(async () => {
    const ta = document.getElementById('codeArea');
    ta.value = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120"><rect x="10" y="10" width="80" height="60" fill="#ff0000"/></svg>';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const exported = Runtime.exportString();
    return { exportedHasRect: /rect/i.test(exported), exportedHasRed: /#?ff0000|rgb\(255,\s*0,\s*0\)/i.test(exported) };
  });

  // 3) 关闭代码模式
  const codeClose = await p.evaluate(() => {
    document.getElementById('btnCode').click();
    return { off: !document.getElementById('mid').classList.contains('codemode') };
  });

  // 4) 配色切换：切到 dark_cyber，验证舞台底色、形状填充、文字可读（不残留 nav>暗色）
  const palette = await p.evaluate(async () => {
    // 重新载入样例以有内容
    const smp = UI.samples.find(s => s.id.indexOf('real-02') >= 0);
    await UI.select(UI.samples.indexOf(smp));
    const before = Runtime.exportString();
    const sel = document.getElementById('selPalette');
    sel.value = 'dark_cyber';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const after = Runtime.exportString();
    const stageBg = document.getElementById('stage').style.background;
    const root = Runtime.root();
    let cyanish = 0, textInk = 0, darkTextOnDark = 0;
    let titleStyleFill = null;
    const mTitle = after.match(/\.title\{[^}]*fill:\s*(#[0-9a-fA-F]{6})/);
    if (mTitle) titleStyleFill = mTitle[1].toLowerCase();
    if (root) root.querySelectorAll('*').forEach(el => {
      const tag = (el.tagName || '').toLowerCase();
      const f = (el.getAttribute('fill') || '').toLowerCase();
      if (f.indexOf('#00a8ff') >= 0 || f.indexOf('#00ffe0') >= 0 || f.indexOf('#8a5cff') >= 0) cyanish++;
      if (tag === 'text' || tag === 'tspan') {
        // 文字可读前景：cyber 应接近白；若仍残留 nav>暗蓝(#0b3b82/#1769e0) 则视为不可读
        if (f.indexOf('#0b3b82') >= 0 || f.indexOf('#1769e0') >= 0) darkTextOnDark++;
        else textInk++;
      }
    });
    // 背景矩形应变为 cyber bg
    const bgM = after.match(/id="svg_2"[^>]*fill="(#[0-9a-fA-F]{6})"/);
    const bgFill = bgM ? bgM[1].toLowerCase() : null;
    return { before, after, stageBg, cyanish, textInk, darkTextOnDark, titleStyleFill, bgFill,
      changed: before !== after };
  });

  // 5) 切换回原图后配色应还原（无残留），且无 pageerror
  const paletteReset = await p.evaluate(async () => {
    const sel = document.getElementById('selPalette');
    sel.value = '__original__';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const after = Runtime.exportString();
    const hasNavy = /fill="#0b3b82"/i.test(after);
    return { restored: hasNavy, changedFromCyber: !/#050B14/i.test(after) };
  });

  console.log(JSON.stringify({ setup, codeToggle, codeEdit, codeClose, palette, paletteReset, pageErrors }, null, 1));
  await b.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
