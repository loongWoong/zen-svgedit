/* =============================================================================
 * SVG Beautifier · 02 SVG 运行时（包 @svgedit/svgcanvas）
 *
 * 职责边界（与设计文档 §31 一致）：
 *   svgcanvas = SVG Runtime：解析载入 / 活 DOM / 导出 / 历史 / 缩放
 *   本层      = 补齐 svgcanvas 没做的两件事：
 *     ① 世界坐标：getStrokedBBox 对嵌套 transform 返回局部坐标（实测），
 *        这里用 screenCTM 比值重建「元素 → 根用户空间」的完整变换链。
 *     ② 文本测量：Canvas measureText + computed style 组成字体串。
 *   ★ 本层不做任何美化决策，也不改内容，只读。
 * ===========================================================================*/
'use strict';

const Runtime = {
  canvas: null,
  host: null,
  lib: null,
  ready: false,
  lastError: null,
  zoom: 1,
  lastW: 0,
  lastH: 0,

  /* 只读几何的元素类型（不参与节点/边推断，原样保留） */
  PRESERVE_TAGS: ['image', 'foreignobject', 'use', 'symbol', 'filter', 'mask',
                  'clippath', 'pattern', 'lineargradient', 'radialgradient',
                  'animate', 'animatetransform', 'animatemotion', 'script', 'style'],

  mount(hostEl, dims, opts) {
    const o = opts || {};
    const NS = (typeof window !== 'undefined') && window.SVGCanvasLib;
    if (!NS) { this.lastError = 'vendor/svgcanvas.min.js 未加载（window.SVGCanvasLib 缺失）'; return false; }
    const C = NS.default || NS.SvgCanvas;
    if (typeof C !== 'function') { this.lastError = 'svgcanvas 构造函数不可用'; return false; }
    this.lib = C;
    this.host = hostEl;
    try {
      this.canvas = new C(hostEl, {
        canvasName: 'svgcanvas',
        dimensions: [dims[0], dims[1]],
        /* ★ 必须显式给 baseUnit：svgcanvas 默认 curConfig 里没有这一项，
         * 导出时 svgToString 会走 `baseUnit !== 'px'` 分支做 E(w, undefined) + undefined，
         * 把根元素写成 width="NaN" / height="NaN"（实测往返后画布塌成 100×100）。
         * 它同时也是属性序列化正则 `^-?[\d\.]+<unit>$` 的组成部分，缺失会连带影响 px 值的输出。 */
        baseUnit: 'px',
        /* ★ imgPath 必须指向一个真实存在 rotate.svg 的目录：
         * svgcanvas 构造函数会**无条件**建选择手柄组，其中
         *   cursor:url(`${imgPath}/rotate.svg`) 12 12, auto;
         * 以及 lastGoodImgUrl = `${imgPath}/logo.svg`。
         * imgPath 为空串时这两条会请求站点根（file:// 下即 file:///C:/rotate.svg），
         * 让页面带着一条 ERR_FILE_NOT_FOUND 上线 —— 实测已被 ui_probe 抓到。
         * 该路径是**相对当前页面 URL** 解析的，不是相对本脚本：`ui.html` 与产物
         * `svgb_beautifier.html` 都在 `svgedit/` 下、`vendor/` 也是它的同级子目录，
         * 所以两者同为 'vendor'。仍然保留 `window.__SVGB_IMGPATH` 注入 ——
         * 一旦将来产物被搬到别处（例如作为单文件分发到 CDN），构建期注入即可覆盖，
         * 不必回改源码。 */
        imgPath: o.imgPath !== undefined
          ? o.imgPath
          : ((typeof window !== 'undefined' && window.__SVGB_IMGPATH) || 'vendor'),
        initFill: { color: 'ffffff', opacity: 1 },
        initStroke: { width: 1, color: '000000', opacity: 1 },
        showlayers: false, no_save_warning: true,
        selectNew: false, gridSnapping: false
      });
    } catch (e) {
      this.lastError = 'svgcanvas 初始化失败: ' + (e && e.message);
      return false;
    }
    /* ★ 关闭 svgcanvas 内置「选中/新建文字即进入画布内文本编辑」的行为。
     * 该行为在选中 <text> 时由 svgcanvas 内部的 selected 事件处理器触发
     * （dist/svgcanvas.js：if (tagName==='text' && mode!=='textedit') textActions.select(r,…)），
     * 会立即把模式切成 'textedit'、隐藏选择抓手（showGrips(false)），
     * 并调用 textActions.init()，而 init() 第一件事就是 this.#textinput.focus()。
     * 同样的 this.#textinput 还被 setFontSize/setFontFamily 等字体 API 末尾的
     * setCursor() 读取（this.#textinput.value / .focus()）。
     * 本宿主**从未调用过** textActions.setInputElem()，#textinput 恒为 null，
     * 于是抛  Cannot read properties of null (reading 'focus'/'value')，
     * 异常中断选中/改字体的链路 —— 现象即「选中（文字）元素报错、无法选中」。
     * 本产品用侧栏面板（#eText）→ Editor.setText 做文本编辑，根本不需要画布内编辑器，
     * 因此：① 把一个隐藏 input 注入 textActions，确保任何 .focus()/.value 访问都不崩溃；
     *      ② 把 select/start/init/setCursor 改造成「不进入编辑态、不画光标」的空实现，
     *         使文字元素像普通元素一样被正常选中（显示抓手、填充属性面板）。 */
    this._neutralizeBuiltinTextEditor();
    this.ready = true;
    return true;
  },

  /* 让 svgcanvas 的画布内文本编辑器在定制宿主里「哑火」：不进入编辑态、不画光标、
   * 也不因 #textinput 为 null 而崩溃。文本编辑改走产品自己的侧栏面板（Editor.setText）。 */
  _neutralizeBuiltinTextEditor() {
    const c = this.canvas;
    if (!c || !c.textActions) return;
    const ta = c.textActions;
    /* ① 安全网：提供一个隐藏输入框，避免 textActions 内部对 #textinput 的
     *    .focus()/.value 访问在 null 上崩溃（即便仍有其它路径触发 init/setCursor）。 */
    try {
      if (typeof ta.setInputElem === 'function') {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.tabIndex = -1;
        inp.style.position = 'absolute';
        inp.style.left = '-9999px';
        inp.style.top = '-9999px';
        inp.style.opacity = '0';
        inp.style.pointerEvents = 'none';
        inp.setAttribute('aria-hidden', 'true');
        (this.host || document.body).appendChild(inp);
        ta.setInputElem(inp);
      }
    } catch (e) { /* 安全网装不上也不影响主修复（下列方法已拦截） */ }
    /* ② 主修复：拦截画布内文本编辑的四条入口。
     *   select   —— 由 selected 事件触发（点选文字元素）；置空 → 文字元素像普通元素一样被选中。
     *   start    —— 由新建 text 元素触发；本产品不创建 text 元素，置空无害。
     *   init     —— 进入编辑态时调用；置空 → 不 focus、不算字符盒、不画光标。
     *   setCursor—— 字体 API 末尾对「空文本」兜底调用；置空 → 不 focus、不生成闪烁光标线。
     * 这四条之外的 mouseDown/move/up/toEditMode/toSelectMode 只在 textedit 模式下才被调用，
     * 既然 select/start 已不会进入该模式，它们不会被触发，无需逐个改写。 */
    const noop = function () {};
    try {
      if (ta.select && ta.select !== noop) ta.select = noop;
      if (ta.start && ta.start !== noop) ta.start = noop;
      if (ta.init && ta.init !== noop) ta.init = noop;
      if (ta.setCursor && ta.setCursor !== noop) ta.setCursor = noop;
    } catch (e) { /* 个别方法不可写则放过，由第①步的安全网兜底 */ }
  },

  /* 把任意 SVG 文本规范化成「带确定尺寸」的形式：svgcanvas 需要可解析的 width/height */
  normalize(text) {
    let doc;
    try { doc = new DOMParser().parseFromString(text, 'image/svg+xml'); }
    catch (e) { return { ok: false, err: 'XML 解析异常: ' + e.message }; }
    if (!doc || !doc.documentElement) return { ok: false, err: 'XML 解析失败' };
    if (tagOf(doc.documentElement) === 'parsererror' || doc.querySelector('parsererror'))
      return { ok: false, err: 'XML 格式错误，无法解析为 SVG' };
    const root = doc.documentElement;
    if (tagOf(root) !== 'svg') return { ok: false, err: '根元素不是 <svg>' };

    const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const hasVB = vb.length === 4 && vb.every(v => isFinite(v)) && vb[2] > 0 && vb[3] > 0;
    const wAttr = root.getAttribute('width') || '';
    const hAttr = root.getAttribute('height') || '';
    const badW = !wAttr || /%|auto/.test(wAttr);
    const badH = !hAttr || /%|auto/.test(hAttr);
    let W, H;
    if (badW || badH) {
      if (hasVB) { W = vb[2]; H = vb[3]; }
      else { W = 800; H = 600; }
      root.setAttribute('width', String(W));
      root.setAttribute('height', String(H));
    } else { W = parseFloat(wAttr); H = parseFloat(hAttr); }
    if (!hasVB) root.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', SVGNS);

    /* 移除脚本，防止载入不可控代码 */
    let stripped = 0;
    root.querySelectorAll('script').forEach(s => { s.parentNode.removeChild(s); stripped++; });

    return {
      ok: true, doc, root, w: W, h: H, viewBox: hasVB ? vb : [0, 0, W, H],
      normalized: (badW || badH), strippedScripts: stripped,
      text: new XMLSerializer().serializeToString(root)
    };
  },

  load(svgText) {
    if (!this.ready) return { ok: false, err: this.lastError || '运行时未就绪' };
    const n = this.normalize(svgText);
    if (!n.ok) return n;
    let ok = false;
    try { ok = this.canvas.setSvgString(n.text); }
    catch (e) { return { ok: false, err: 'setSvgString 抛错: ' + e.message }; }
    if (!ok) return { ok: false, err: 'setSvgString 返回 false' };
    /* svgcanvas 载入后会重建 DOM：等一帧确保布局完成再读 getScreenCTM */
    const root = this.root();
    if (!root) return { ok: false, err: '载入后找不到 <svg> 根' };
    const cw = parseFloat(this.canvas.contentW), ch = parseFloat(this.canvas.contentH);
    const gw = (isFinite(cw) && cw > 0) ? cw : n.w, gh = (isFinite(ch) && ch > 0) ? ch : n.h;
    /* 记下真实画布尺寸，供导出的数值兜底使用 */
    this.lastW = gw; this.lastH = gh;
    /* setSvgString 内部会 setZoom(1)：同步内部状态，并把新的 contentW/H 落到 DOM 上
     * （含 #selectorParentGroup 的居中位移），避免上一次缩放留下的偏移残留。 */
    this.zoom = 1;
    this.relayout();
    return {
      ok: true, root, w: gw, h: gh,
      viewBox: n.viewBox, normalized: n.normalized, strippedScripts: n.strippedScripts
    };
  },

  root() {
    try { return this.canvas ? this.canvas.getSvgRoot() : null; } catch (e) { return null; }
  },

  /* svgcanvas 把绘图内容放在 <g id="svgcontent">；取不到时退回根下第一个 g */
  contentGroup() {
    const root = this.root();
    if (!root) return null;
    let g = null;
    try { g = root.querySelector('#svgcontent'); } catch (e) { /* ignore */ }
    if (g) return g;
    for (const c of root.children) if (tagOf(c) === 'g') return c;
    return root;
  },

  exportString() {
    let s = '';
    try { s = this.canvas.getSvgString() || ''; } catch (e) { return ''; }
    return this.repairDims(s, this.lastW, this.lastH);
  },

  /* 导出兜底：对根 <svg> 的 width/height 做一次数值校验。
   * 只有当它们非法（缺失 / 空 / 非有限数，如 "NaN" "100%"）时，才回钉到已知画布尺寸。
   * 这是「导出物必须能被再次载入」的硬保证 —— 回滚快照走的正是这条路径。
   * 另补 viewBox：svgcanvas 把 viewBox 写在嵌套的 #svgcontent 上，导出的根 <svg>
   * 只有 width/height，丢失了原始 viewBox（源图是 `0 0 1920 1080`）。
   * 缺 viewBox 的 SVG 无法等比缩放，也会让「导出物 ≠ 源图」—— 在数值一致时补回
   * `0 0 W H` 是纯无损操作（1 用户单位仍然 = 1px）。 */
  repairDims(svg, w, h) {
    if (!svg || svg.indexOf('<svg') < 0) return svg;
    const bad = v => (v === null || v === undefined || String(v).trim() === '' || !isFinite(parseFloat(v)));
    const W = (isFinite(w) && w > 0) ? r2(w) : 800;
    const H = (isFinite(h) && h > 0) ? r2(h) : 600;
    return svg.replace(/<svg\b([^>]*)>/, (m, attrs) => {
      let a = attrs;
      const mw = /\bwidth="([^"]*)"/.exec(a);
      const mh = /\bheight="([^"]*)"/.exec(a);
      const vw = (mw && !bad(mw[1])) ? mw[1] : String(W);
      const vh = (mh && !bad(mh[1])) ? mh[1] : String(H);
      if (mw) a = a.replace(/\bwidth="[^"]*"/, 'width="' + vw + '"'); else a = ' width="' + vw + '"' + a;
      if (mh) a = a.replace(/\bheight="[^"]*"/, 'height="' + vh + '"'); else a = ' height="' + vh + '"' + a;
      if (!/\bviewBox="/.test(a)) a += ' viewBox="0 0 ' + vw + ' ' + vh + '"';
      return '<svg' + a + '>';
    });
  },

  /* ----------------------------- 视图缩放 -----------------------------
   * svgcanvas 的 `setZoom(e){ this.zoom = e }` **只存一个数字，不做任何布局**
   * （压缩源实测 @1106503）。真正把 zoom 落到 DOM 的是它自己的 `updateCanvas(w,h)`
   * （压缩源实测 @184826）：
   *     #svgcontent          width = contentW·z, height = contentH·z,
   *                          x = (w − contentW·z)/2, y = (h − contentH·z)/2,
   *                          viewBox = "0 0 contentW contentH"
   *     #selectorParentGroup transform = "translate(x, y)"
   * 这条关系是选择框/抓手能对齐的前提：Selector 内部把 bbox 乘 getZoom() 再画进
   * selectorParentGroup，于是「元素屏幕 px = 用户单位 × zoom + (x, y)」。
   *
   * 少了这一步（本层修复前的状态）会同时坏两件事：
   *   ① 选择框与抓手按 z 倍画出、并整体偏移 —— 实测 z=1.9 时偏差 dx=133 dy=35、
   *      尺寸正好 1.9 倍（align_probe.cjs）；即「选中了但框在别处」。
   *   ② 缩放档位成为死控件 —— 改 zoom 不产生任何视觉变化（layout_probe.cjs：
   *      zoomSel 从 0.5 到 2，svgroot/svgcontent/CTM 逐位不变）。
   * 所以 setZoom 与 setResolution 之后都必须补一次 relayout()。 */
  relayout() {
    if (!this.ready) return false;
    const root = this.root();
    const host = root && root.parentNode;
    if (!host) return false;
    const hostW = Math.round(host.clientWidth || 0), hostH = Math.round(host.clientHeight || 0);
    if (!(hostW > 0 && hostH > 0)) return false;
    const z = (isFinite(this.zoom) && this.zoom > 0) ? this.zoom : 1;
    const num = v => { const n = parseFloat(v); return isFinite(n) && n > 0 ? n : NaN; };
    let cw = num(this.canvas.contentW), ch = num(this.canvas.contentH);
    if (!isFinite(cw) || !isFinite(ch)) { cw = hostW / z; ch = hostH / z; }
    /* 根视口取「容器尺寸」与「内容×zoom」的较大者：
     * 内容放大到超过容器时，updateCanvas 会算出负的居中位移 (w−cw·z)/2 < 0，
     * 而负位移的部分既被 <svg> 自己的视口裁掉、也无法通过滚动到达（永久盲区）。
     * 让根等于内容尺寸后 x≈0，超出的部分交给 #host（overflow:auto）滚动。 */
    const W = Math.max(hostW, Math.round(cw * z));
    const H = Math.max(hostH, Math.round(ch * z));
    try { this.canvas.updateCanvas(W, H); } catch (e) { return false; }
    return true;
  },

  setZoom(z) {
    this.zoom = clamp(z, 0.1, 8);
    try { this.canvas.setZoom(this.zoom); } catch (e) { /* ignore */ }
    /* 必须紧跟 relayout：把 zoom 落到 #svgcontent 与 #selectorParentGroup 上 */
    this.relayout();
    return this.zoom;
  },

  /* 改画布尺寸：走 svgcanvas 原生 setResolution（同时维护 #svgcontent 的
   * width/height/viewBox 与 contentW/contentH），而不是自己去写属性 ——
   * 否则 contentW 与 DOM 会不一致，导出与 getResolution 又会对不上。
   * 注意：svgcanvas 也会把这一改动记入 undo 历史，所以调用方须在回滚快照之后使用。 */
  setResolution(w, h) {
    if (!this.ready) return false;
    const W = Math.max(1, r2(w)), H = Math.max(1, r2(h));
    try { this.canvas.setResolution(W, H); }
    catch (e) { return false; }
    this.lastW = W; this.lastH = H;
    /* setResolution 把 #svgcontent 写成 width=W / viewBox="0 0 W H"（即 1:1），
     * 一旦当前 zoom≠1，这个尺寸与 svgcanvas 的 zoom 就又不一致了 → 立刻重组一次。
     * 典型场景：几何引擎为「内容盒超出画布」扩画布之后。 */
    this.relayout();
    return true;
  },

  /* 读当前画布尺寸（**用户单位**，不是屏幕 px）。
   * 注意：zoom 生效后 #svgcontent 的 width 属性是「contentW×zoom」，
   * 直接读它会把缩放算进去，所以优先用 svgcanvas 的 getResolution()
   * （其定义就是 width/zoom），再退回 contentW/contentH。 */
  canvasSize() {
    const c = this.canvas;
    if (!c) return { w: 0, h: 0 };
    const tryNum = v => { const n = parseFloat(v); return isFinite(n) && n > 0 ? n : NaN; };
    let w = NaN, h = NaN;
    try {
      const r = c.getResolution && c.getResolution();
      if (r) { w = tryNum(r.w); h = tryNum(r.h); }
    } catch (e) { /* ignore */ }
    if (!isFinite(w)) {
      const z = (isFinite(this.zoom) && this.zoom > 0) ? this.zoom : 1;
      try {
        const g = c.getSvgContent && c.getSvgContent();
        if (g) { w = tryNum(g.getAttribute('width')); h = tryNum(g.getAttribute('height')); }
      } catch (e) { /* ignore */ }
      if (isFinite(w)) w = w / z;
      if (isFinite(h)) h = h / z;
    }
    if (!isFinite(w)) w = tryNum(c.contentW);
    if (!isFinite(h)) h = tryNum(c.contentH);
    return { w: isFinite(w) ? r2(w) : this.lastW, h: isFinite(h) ? r2(h) : this.lastH };
  },

  /* --------------------- 坐标：元素 → 画布用户空间 ---------------------
   * 基准是 svgcanvas 的**内容容器** `#svgcontent`（实测是个嵌套 <svg>，depth 1），
   * 不是最外层 `<svg id="svgroot">`。zoom≠1 时这个区别是致命的：
   *   updateCanvas 把 #svgcontent 写成 width=contentW·zoom / viewBox="0 0 contentW contentH"，
   *   于是 1 用户单位 = zoom 个根 px。以 root 为基准量出的几何会整体乘 zoom
   *   （实测 zoom=1.9 时「位移 2 用户单位」被量成 3.8），而 IR 的 canvas.w/h 是
   *   contentW/contentH（用户单位）→ 两者不同量纲，打分与几何判断全部失真。
   * 以 #svgcontent 为基准则与 zoom 无关：坐标恒等于 SVG 文档的用户单位，
   * 且 contentW ≠ 0 时 root 空间与内容空间重合，历史数值不受影响。 */
  elemCTM(el) {
    const base = this.contentGroup();
    if (!el || !base) return M.id();
    if (el === base) return M.id();
    try {
      const a = el.getScreenCTM && el.getScreenCTM();
      const b = base.getScreenCTM && base.getScreenCTM();
      if (a && b) {
        const m = M.mul(M.inv({ a: b.a, b: b.b, c: b.c, d: b.d, e: b.e, f: b.f }), a);
        return m;
      }
    } catch (e) { /* 退回逐级累乘 */ }
    /* 兜底：沿祖先链累乘 transform 属性（拿不到 CTM 的场景；此路径不含
     * 嵌套 <svg> 的 viewBox 视口映射，仅用于无布局信息的退化情形） */
    const chain = [];
    let cur = el;
    while (cur && cur !== base) { chain.push(cur); cur = cur.parentNode; }
    if (cur !== base) return M.id();
    chain.push(base);
    let m = M.id();
    for (let i = chain.length - 1; i >= 0; i--) m = M.mul(m, M.fromString(chain[i].getAttribute && chain[i].getAttribute('transform')));
    return m;
  },

  strokeWidth(el) {
    const direct = el.getAttribute && el.getAttribute('stroke-width');
    let sw = parseFloat(direct);
    if (!isFinite(sw)) sw = parseFloat(cssPrio(el, 'stroke-width'));
    if (!isFinite(sw)) sw = 1;
    if (el.getAttribute && el.getAttribute('vector-effect') === 'non-scaling-stroke') return { sw, nonScaling: true };
    return { sw, nonScaling: false };
  },

  /* 就近取「事件元素」的最近祖先（用于点到分组的归一） */
  closestAncestorWithin(el, stopEl) {
    let cur = el;
    while (cur && cur !== stopEl) {
      const p = cur.parentNode;
      if (!p || p === stopEl) break;
      cur = p;
    }
    return cur;
  },

  /* 世界坐标视觉包围盒（默认含 stroke 外扩）。
   * 这是对 svgcanvas.getStrokedBBox 的**补齐**：后者对嵌套 transform 返回局部坐标。 */
  worldBBox(el, opts) {
    const o = opts || {};
    const m = this.elemCTM(el);
    let local;
    try { local = el.getBBox(); } catch (e) { return null; }
    if (!local || (!local.width && !local.height)) return null;
    let r = R.mk(local.x, local.y, local.width, local.height);
    const s = M.scaleOf(m);
    if (o.stroke !== false) {
      const st = this.strokeWidth(el);
      /* stroke-width 定义在元素的局部用户空间，先按局部单位外扩，再由 CTM 变换到世界坐标。
       * 若写成 sw×scale/2 再变换，会把缩放计入两次（实测嵌套 scale(1.5) 下外扩 1.125 而非期望的 0.75）。 */
      const localHalf = st.nonScaling
        ? st.sw / Math.max(1e-6, Math.max(s.sx, s.sy)) / 2
        : st.sw / 2;
      r = R.expand(r, localHalf, localHalf);
    }
    const w = R.transform(r, m);
    return { x: r2(w.x), y: r2(w.y), w: r2(w.w), h: r2(w.h), local: R.mk(local.x, local.y, local.width, local.height), scale: s };
  },

  /* 形状自身的几何（不含 stroke），用于精确改 width/height/x/y */
  shapeGeom(el) {
    const t = tagOf(el);
    if (t === 'rect') return { kind: 'rect', x: numA(el, 'x', 0), y: numA(el, 'y', 0), w: numA(el, 'width', 0), h: numA(el, 'height', 0), rx: numA(el, 'rx', 0) };
    if (t === 'circle') { const cx = numA(el, 'cx', 0), cy = numA(el, 'cy', 0), r = numA(el, 'r', 0); return { kind: 'circle', x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, cx, cy, r }; }
    if (t === 'ellipse') { const cx = numA(el, 'cx', 0), cy = numA(el, 'cy', 0), rx = numA(el, 'rx', 0), ry = numA(el, 'ry', 0); return { kind: 'ellipse', x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry, cx, cy, rx, ry }; }
    if (t === 'polygon' || t === 'polyline') {
      const pts = (getA(el, 'points', '')).trim().split(/[\s,]+/).map(Number);
      const P = [];
      for (let i = 0; i + 1 < pts.length; i += 2) P.push({ x: pts[i], y: pts[i + 1] });
      return { kind: t, pts: P, ...R.fromPoints(P) };
    }
    return null;
  },

  /* 把 path/line/polyline 采样成折线（局部坐标） */
  polyline(el) {
    const t = tagOf(el);
    if (t === 'line') {
      return [{ x: numA(el, 'x1', 0), y: numA(el, 'y1', 0) }, { x: numA(el, 'x2', 0), y: numA(el, 'y2', 0) }];
    }
    if (t === 'polyline' || t === 'polygon') {
      const pts = (getA(el, 'points', '')).trim().split(/[\s,]+/).map(Number);
      const P = [];
      for (let i = 0; i + 1 < pts.length; i += 2) P.push({ x: pts[i], y: pts[i + 1] });
      return P;
    }
    if (t === 'path') {
      /* 用浏览器原生 path 采样：对 C/S/Q/T/A 全部适用，避免自写解析器出错 */
      let total = 0, len = 0;
      try { total = el.getTotalLength(); } catch (e) { return []; }
      if (!isFinite(total) || total <= 0) return [];
      const n = clamp(Math.ceil(total / 6), 2, 400);
      const P = [];
      for (let i = 0; i <= n; i++) {
        try { const p = el.getPointAtLength(total * i / n); P.push({ x: p.x, y: p.y }); }
        catch (e) { break; }
      }
      len = total;
      return P;
    }
    return [];
  },

  toWorld(pts, m) { return pts.map(p => M.apply(m, p)); },

  /* ------------------------------- 文本测量 ------------------------------- */
  _ctx: null,
  ctx2d() {
    if (!this._ctx) this._ctx = document.createElement('canvas').getContext('2d');
    return this._ctx;
  },
  fontString(el) {
    const cs = (el && getComputedStyle(el)) || {};
    const style = cs.fontStyle || 'normal';
    const weight = cs.fontWeight || '400';
    const size = parseFloat(cs.fontSize) || 14;
    const fam = cs.fontFamily || 'sans-serif';
    return { css: `${style} ${weight} ${size}px ${fam}`, size, weight, fam, style };
  },
  measure(text, cssFont) {
    const ctx = this.ctx2d();
    ctx.font = cssFont;
    const m = ctx.measureText(text || '');
    const asc = (m.actualBoundingBoxAscent !== undefined && isFinite(m.actualBoundingBoxAscent)) ? m.actualBoundingBoxAscent : (parseFloat(cssFont) || 14) * 0.8;
    const desc = (m.actualBoundingBoxDescent !== undefined && isFinite(m.actualBoundingBoxDescent)) ? m.actualBoundingBoxDescent : (parseFloat(cssFont) || 14) * 0.2;
    return { w: r2(m.width), ascent: r2(asc), descent: r2(desc), h: r2(asc + desc) };
  },
  /* 对一个 text 元素按其 computed 字体算期望宽度 */
  measureElem(el) {
    const f = this.fontString(el);
    const t = textOf(el);
    const r = this.measure(t, f.css);
    return { ...r, text: t, fontSize: f.size, css: f.css };
  },

  /* --------------------------- overlay 坐标映射 ---------------------------
   * 返回把「**内容用户空间**」画到 overlay 元素本地的矩阵：
   *   overlayLocal = contentUserMatrix − overlayRect.origin
   * 基准必须与 elemCTM / worldBBox 一致（都是 #svgcontent），否则 zoom≠1 时
   * 叠加层会与画面差一个 zoom 倍；同时因为 contentCTM 本身含 zoom，
   * 叠加层会随缩放一起放大，与画面保持贴合。
   * 用于非侵入叠加层（诊断 / 提案视图），不改动内容 DOM。 */
  overlayMatrix(overlayEl) {
    const base = this.contentGroup();
    if (!base || !overlayEl) return M.id();
    const sm = base.getScreenCTM && base.getScreenCTM();
    const rect = overlayEl.getBoundingClientRect();
    if (!sm) return M.id();
    return { a: sm.a, b: sm.b, c: sm.c, d: sm.d, e: sm.e - rect.left, f: sm.f - rect.top };
  },

  /* svgcanvas 能力探针：哪些方法确实存在（供报告与降级用） */
  probeApi() {
    const c = this.canvas, names = ['getStrokedBBox', 'getBBox', 'getIntersectionList', 'getVisibleElements',
      'recalculateDimensions', 'sanitizeSvg', 'changeSelectedAttribute', 'changeSelectedAttributeNoUndo',
      'alignSelectedElements', 'getSvgString', 'setSvgString', 'getSvgRoot', 'getSvgContent',
      'getResolution', 'setResolution', 'getContentW', 'getContentH', 'setZoom', 'undo', 'redo'];
    const out = {};
    for (const n of names) out[n] = c ? typeof c[n] : 'no-canvas';
    out['undoMgr.undo'] = (c && c.undoMgr) ? typeof c.undoMgr.undo : 'no-undoMgr';
    out['undoMgr.redo'] = (c && c.undoMgr) ? typeof c.undoMgr.redo : 'no-undoMgr';
    return out;
  }
};
