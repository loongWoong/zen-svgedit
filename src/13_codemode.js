/* =============================================================================
 * SVG Beautifier · 13 代码模式 + 配色切换系统（UI 接线）
 *
 * 两个功能：
 *   ① 代码模式：左侧预览（svgcanvas 实渲染）、右侧编辑 SVG 源码；输入实时（防抖）
 *      应用到预览，可「格式化 / 应用 / 关闭」。纯视觉编辑通道，不改文件落盘。
 *   ② 配色切换：下拉选一套风格色系 → 调 Palette.apply 在活 DOM 上重着色（仅改颜色，
 *      不改布局）；并把舞台底色一并切到该色系的背景色（Wireframe 模式强制白底）。
 *
 * 宪法约束（与 §22 / §23 一致）：这些都**不改内容语义**，只是视图/配色层；
 *  切视图 / 切配色前后 rt.exportString() 的几何字节不变（仅颜色/属性随之变）。
 * ===========================================================================*/
'use strict';

const CodeMode = {
  ui: null,
  area: null, status: null, mid: null, stage: null, selPalette: null, btnCode: null,
  _timer: 0, _lastText: '',

  init(ui) {
    this.ui = ui;
    this.mid = ui.$('mid');
    this.stage = ui.$('stage');
    this.area = ui.$('codeArea');
    this.status = ui.$('codeStatus');
    this.selPalette = ui.$('selPalette');
    this.btnCode = ui.$('btnCode');
    if (!this.area || !this.mid) return;

    /* 配色下拉：填充风格色系 */
    if (this.selPalette) {
      for (const k of Palette.names()) {
        const o = document.createElement('option');
        o.value = k; o.textContent = Palette.label(k);
        this.selPalette.appendChild(o);
      }
      this.selPalette.onchange = () => this.applyPalette(this.selPalette.value);
    }

    /* 代码模式开关 */
    if (this.btnCode) this.btnCode.onclick = () => this.toggleCode();

    /* 代码面板按钮 */
    const fmt = ui.$('codeFormat'), ap = ui.$('codeApply'), cl = ui.$('codeClose');
    if (fmt) fmt.onclick = () => { this.area.value = this.formatXml(Runtime.exportString()); this.status.textContent = '已格式化（导出当前画布）'; this.status.className = 'codeStatus ok'; };
    if (ap) ap.onclick = () => this.applyCode(this.area.value, true);
    if (cl) cl.onclick = () => this.toggleCode(false);

    /* 实时编辑：输入防抖应用到预览 */
    this.area.addEventListener('input', () => {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this.applyCode(this.area.value, false), 350);
    });
  },

  /* 切换代码模式：左预览 / 右编辑 */
  toggleCode(force) {
    const on = (force === undefined) ? !this.mid.classList.contains('codemode') : force;
    this.mid.classList.toggle('codemode', on);
    if (this.btnCode) this.btnCode.classList.toggle('on', on);
    if (on) {
      this.area.value = Runtime.exportString();
      this.status.textContent = '代码模式：编辑右侧源码，实时同步到左侧预览。';
      this.status.className = 'codeStatus';
      setTimeout(() => this.area.focus(), 30);
    }
  },

  /* 把文本框里的 SVG 应用到预览（preview = 不弹窗的实时应用） */
  applyCode(text, immediate) {
    const t = (text || '').trim();
    if (!t) { this.status.textContent = '空内容，无操作。'; this.status.className = 'codeStatus'; return; }
    if (!immediate && t === this._lastText) return;
    this._lastText = t;
    let r;
    try { r = Runtime.load(t); } catch (e) { r = { ok: false, err: (e && e.message) || '异常' }; }
    if (!r || !r.ok) {
      this.status.textContent = '✗ 应用失败：' + ((r && r.err) || '未知错误') + '（预览保持上一有效状态）';
      this.status.className = 'codeStatus err';
      return;
    }
    this.status.textContent = '✓ 已应用到预览';
    this.status.className = 'codeStatus ok';
    /* 内容被替换：重建分析态，刷新叠加层（非原图视图需要）；编辑基线同步重置 */
    if (this.ui.view !== 'original') {
      try { this.ui.ir = IR.build(Runtime, {}); this.ui.an = Analyzer.run(this.ui.ir, {}); this.ui.draw(); } catch (e) { /* 忽略 */ }
    }
    if (this.ui.editing && typeof Editor !== 'undefined' && Editor.reset) Editor.reset(Runtime);
  },

  /* 应用一套配色（仅重着色，不改布局）。
   * 首次切到某风格时，快照「切之前的画布」；选「原图」时回滚该快照，从而可无损还原。 */
  applyPalette(name) {
    if (!name || name === '__original__') {
      if (this._prePaletteSnapshot) {
        try { Runtime.load(this._prePaletteSnapshot); } catch (e) { /* 忽略 */ }
        this.ui.activePaletteBg = '';
        if (this.stage) this.stage.style.background = '';
        if (this.ui.view !== 'original') {
          try { this.ui.ir = IR.build(Runtime, {}); this.ui.an = Analyzer.run(this.ui.ir, {}); this.ui.draw(); } catch (e) { /* 忽略 */ }
        }
        this.syncCode();
      }
      this.status.textContent = '已恢复原始配色'; this.status.className = 'codeStatus';
      return;
    }
    const p = Palette.PRESETS[name];
    if (!p) { this.status.textContent = '✗ 未知配色：' + name; this.status.className = 'codeStatus err'; return; }
    if (!this._prePaletteSnapshot) this._prePaletteSnapshot = Runtime.exportString();  /* 首次：存原图 */
    const ok = Palette.apply(Runtime, name);
    if (!ok) { this.status.textContent = '✗ 配色应用失败'; this.status.className = 'codeStatus err'; return; }
    this.ui.activePaletteBg = p.bg;
    if (this.stage) this.stage.style.background = (this.ui.view === 'wireframe') ? '' : p.bg;
    if (this.ui.view !== 'original') {
      try { this.ui.ir = IR.build(Runtime, {}); this.ui.an = Analyzer.run(this.ui.ir, {}); this.ui.draw(); } catch (e) { /* 忽略 */ }
    }
    this.syncCode();
    this.status.textContent = '✓ 已应用配色：' + p.name; this.status.className = 'codeStatus ok';
  },

  /* 代码模式开启时，把当前画布导出同步进文本框（select/run/配色 后调用） */
  syncCode() {
    if (!this.area || !this.mid.classList.contains('codemode')) return;
    const cur = Runtime.exportString();
    if (cur && cur !== this.area.value) this.area.value = cur;
  },

  /* 轻量 XML 缩进格式化（足够 SVG 用；跳过标签间的纯空白文本节点） */
  formatXml(xml) {
    const re = /<[^>]+>|[^<]+/g;
    const toks = []; let mm;
    while ((mm = re.exec(xml))) toks.push(mm[0]);
    let depth = 0, out = '', first = true;
    for (const t of toks) {
      if (t[0] !== '<') { if (t.trim() === '') continue; out += t.trim(); continue; }
      const isClose = t.indexOf('</') === 0;
      const isSelf = /\/>$/.test(t) || t.indexOf('<?') === 0 || t.indexOf('<!--') === 0 || t.indexOf('<!') === 0;
      if (isClose) depth = Math.max(0, depth - 1);
      if (!first) out += '\n' + '  '.repeat(depth);
      out += t; first = false;
      if (!isClose && !isSelf) depth++;
    }
    return out;
  }
};
