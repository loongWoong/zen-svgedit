/* =============================================================================
 * 09_editor.js —— 编辑层（P0「闭环优先」）
 *
 * 参考件：https://unpkg.com/svgedit@7.4.2/dist/editor/index.html
 *   那个页面是个 1796 字节的壳，真身是 dist/editor/（Editor.js 2.76 MB / iife-Editor.js
 *   2.22 MB + svgedit.css + images 261 文件 / 277 KB + extensions 152 文件 / 695 KB）。
 *   它 bundle 的内核就是本仓库已 vendor 的 @svgedit/svgcanvas@7.4.2 ——
 *   也就是说**编辑能力本身我们早已具备**，缺的只是接线与产品化。
 *   因此本层不引入任何新依赖，只把内核已有的语义操作接成 UI，并接上本产品
 *   独有的东西：**质量评分模型**。
 *
 * 本层与官方 svg-edit 的差别（也是它做不到的）：
 *   1. 每一次改动后立刻重算 IR + Analyzer，把「分数变了多少」记进变更轨迹 ——
 *      svg-edit 没有任何质量模型，改完不知道是变好了还是变丑了。
 *   2. 选中元素即可看到它命中的诊断 issue，把「手改」与「自动美化」放进同一个闭环。
 *   3. 编辑模式与四视图共用同一个 DOM 与同一份 IR；视图层仍是非侵入的。
 *
 * 架构契约：
 *   · 编辑是**唯一**允许改动内容 DOM 的入口，且每次改动都必须经 svgcanvas 的语义 API
 *     （自动进 undo 栈），本层不直接 setAttribute。
 *   · 「切视图不改内容」这条非侵入断言在编辑模式下**依然成立**（视图层没变）。
 *   · 选择手柄 `#selectorParentGroup` 是 `#svgroot` 的直接子节点，与 `#svgcontent` 平级。
 *     实测：选中前后 score / nodes / edges / labels / decorations 全不变，
 *     进 IR 的 grip 元素数为 0 —— 编辑辅助 DOM 不污染分析器。
 *
 * ★ API 事实（读未压缩源码 core/*.js 得到。官方 svgcanvas.d.ts 与实际 IIFE 构建
 *   **不一致**，一律以源码与运行时实测为准）：
 *   - 事件：'selected'([elems]) / 'changed'([elems]) / 'transition'([elems])
 *           / 'zoomed' / 'zoomDone' / 'contextset' / 'sourcechanged'
 *   - undo/redo **不在 canvas 上**，在 canvas.undoMgr.undo() / .redo()，
 *     配套 getUndoStackSize / getRedoStackSize / getNextUndoCommandText / getNextRedoCommandText
 *     （.d.ts 里写的 canvas.undo()/redo() 在 IIFE 构建里是 undefined）
 *   - 属性：setColor(type,val,preventUndo) / setStrokeWidth(val) / setStrokeAttr(attr,val)
 *           / setPaint(type,paint) / setRectRadius(val) / changeSelectedAttribute(attr,val,elems)
 *   - 文本：setTextContent(val)（内部走 changeSelectedAttribute('#text', val)，属性名是 '#text'）
 *           / setFontSize(val) / setFontFamily(val) / setFontColor(val) / setBold(b)
 *           / setItalic(i) / setTextAnchor(value)
 *   - 几何：moveSelectedElements(dx,dy,undoable=true) / setRotationAngle(val,preventUndo)
 *           （**只作用于 selectedElements[0]**）/ flipSelectedElements(scaleX,scaleY)
 *           / alignSelectedElements(type, relativeTo)，
 *             type ∈ l|c|r|t|m|b（亦接受 left/center/right/top/middle/bottom），
 *             relativeTo ∈ selected|largest|smallest|page
 *   - 选择：selectOnly([elems], showGrips) / addToSelection(elems) / clearSelection(noCall) / getSelectedElements()
 *           ★ showGrips 在 .d.ts 里是可选的，但在 IIFE 构建里**不传就不生成抓手**
 *             （只画选择框 selectedBox0）；真实鼠标点击内部传的是 true。见 select() 注释。
 *   - 层级：moveToTopSelectedElement() / moveToBottomSelectedElement() / moveUpDownSelected('Up'|'Down')
 *   - 其他：cloneSelectedElements(x,y) / copySelectedElements() / pasteElements(type,x,y)
 *           / groupSelectedElements(type,urlArg) / ungroupSelectedElement() / deleteSelectedElements()
 * ===========================================================================*/
'use strict';

const Editor = {
  /* ------------------------------- 状态 ------------------------------- */
  on: false,          /* 编辑模式开关 */
  rt: null,           /* Runtime（含 canvas 实例） */
  sel: [],            /* 当前选中的元素（真 DOM 引用） */
  entryScore: null,   /* 进入编辑模式时的分数（Δ 的基准） */
  entrySha: null,     /* 进入编辑模式时的内容 sha256（**逐字节**判据，见 cancelAll） */
  entryUndo: null,    /* 进入编辑模式时的撤销栈深度（「回到基线」的撤销目标） */
  entryNodes: null,   /* 进入编辑模式时的 IR 节点数（与分数一起构成「回到基线」的语义判据） */
  prevScore: null,    /* 上一条轨迹时的分数（单步 Δ 的基准） */
  track: [],          /* 变更轨迹：[{ n, label, score, delta, total, canvas, sha, undo, t, diff, struct, cancelled }] */
  ir: null, an: null, /* 最近一次重算的 IR / 分析结果 */
  lastErr: null,
  _sha: null,         /* 最近一次「已知内容」的 sha256 */
  _lastSvg: null,     /* 上一步的 SVG 文本（用于算「这一步到底改了哪些属性」的差量） */
  _t: null,           /* 防抖定时器 */
  _noTrack: false,    /* 本次 flush 不回填清单（取消/回退是「对清单的操作」，不是新的编辑动作） */
  _label: null,       /* 下一个待记录动作的标签 */
  _pendingDelta: null,
  _bound: false, _boundC: null,
  _notify: null,
  _guard: null, _guardStage: null, _guardLog: null,
  _ctrl: null,        /* Ctrl 多选：本次手势的判定 { el, mode:'add'|'remove'|'blank' } */

  /* --------------------------- 能力探测（诚实） --------------------------- */
  /* NAMES 只列本层真的会调用、且**必须存在**的名字；probe 的返回直接进报告，
   * 缺什么一目了然。
   * EXPECTED_ABSENT 是「官方 .d.ts 声明了、但 IIFE 构建里其实没有」的名字——
   * 它们不算缺失，而是**必须被证伪**的证据，所以单独列、不进 missing。 */
  NAMES: [
    'getSelectedElements', 'selectOnly', 'addToSelection', 'clearSelection',
    'changeSelectedAttribute', 'setColor', 'setStrokeWidth', 'setStrokeAttr', 'setPaint',
    'setRectRadius', 'setFontSize', 'setFontFamily', 'setBold', 'setItalic', 'setTextAnchor',
    'moveSelectedElements', 'setRotationAngle', 'flipSelectedElements', 'alignSelectedElements',
    'cloneSelectedElements', 'copySelectedElements', 'pasteElements', 'groupSelectedElements',
    'ungroupSelectedElement', 'deleteSelectedElements',
    'moveToTopSelectedElement', 'moveToBottomSelectedElement', 'moveUpDownSelected',
    'getSvgString', 'exportPDF'
  ],
  EXPECTED_ABSENT: ['undo', 'redo'],
  /* 存在于 canvas 上、但在本宿主里**不可用**的 API。同样不进 missing（存在性是好的），
   * 但编辑层刻意绕开它们，probe 上报以便报告里能一眼看到原因。 */
  KNOWN_BROKEN: ['setTextContent'],

  probe(rt) {
    const c = (rt || this.rt || {}).canvas;
    if (!c) return { noCanvas: true };
    const out = {}; const missing = [];
    for (const n of this.NAMES) { out[n] = typeof c[n]; if (typeof c[n] !== 'function') missing.push(n); }
    for (const n of this.EXPECTED_ABSENT) out[n] = typeof c[n];
    for (const n of this.KNOWN_BROKEN) out[n] = typeof c[n];
    const um = c.undoMgr || null;
    out['undoMgr.getUndoStackSize'] = um ? typeof um.getUndoStackSize : 'no-undoMgr';
    out['undoMgr.getRedoStackSize'] = um ? typeof um.getRedoStackSize : 'no-undoMgr';
    out['undoMgr.undo'] = um ? typeof um.undo : 'no-undoMgr';
    out['undoMgr.redo'] = um ? typeof um.redo : 'no-undoMgr';
    out['undoMgr.getNextUndoCommandText'] = um ? typeof um.getNextUndoCommandText : 'no-undoMgr';
    out['undoMgr.getNextRedoCommandText'] = um ? typeof um.getNextRedoCommandText : 'no-undoMgr';
    /* setText 依赖这两个官方撤销命令类；缺了就只能改内容、进不了撤销栈 */
    const H = c.history || null;
    out['history.BatchCommand'] = H ? typeof H.BatchCommand : 'no-history';
    out['history.ChangeElementCommand'] = H ? typeof H.ChangeElementCommand : 'no-history';
    return {
      out, missing,
      hasUndoOnCanvas: typeof c.undo === 'function',
      hasUndoMgr: !!um,
      hasHistoryClasses: !!(H && H.BatchCommand && H.ChangeElementCommand)
    };
  },

  /* --------------------------- 非编辑模式的输入守卫 ---------------------------
   * 目标：不进编辑模式时，用户点画布**不产生任何选中/拖拽**，也就无从误改。
   *
   * 必须拦在父节点的**捕获阶段**，不能拦在 #host 自己身上：
   *   去压缩源码 svgcanvas.js 里是
   *     container.addEventListener('mousedown', this.mouseDownEvent)
   *   即 svgcanvas 把处理器注册在 **container（= 我们传进去的 #host）自身**上。
   *   同一节点上的监听器之间用 stopPropagation 无法互相阻断（需要
   *   stopImmediatePropagation 且受注册顺序决定，而 svgcanvas 的注册早于我们）。
   *   挂在父节点 #stage 的捕获阶段则必然先触发，事件根本到不了 #host。
   *
   * 只 stopPropagation、不 preventDefault：原生滚动条拖动不经 JS 监听器，
   * 因此非编辑模式下仍可正常滚动，只是不能编辑。
   * -------------------------------------------------------------------------*/
  GUARD_EVENTS: ['mousedown', 'mousemove', 'mouseup', 'dblclick', 'click', 'contextmenu'],

  armGuard(stageEl) {
    if (!stageEl) return false;
    /* Ctrl 多选 / 守卫拦截的事件类型日志。
     * 自初始化而不是等外部注入 —— 之前它一直是 null，于是「Ctrl 手势到底走了
     * 加选 / 取消 / 点空白 哪条分支」在运行时完全不可观测（探针只能看结果态）。
     * 定长裁剪：长时间编辑不会把内存吃满。 */
    if (!Array.isArray(this._guardLog)) this._guardLog = [];
    if (this._guard && this._guardStage === stageEl) return true;
    if (this._guard) this.disarmGuard();
    this._guardStage = stageEl;
    this._guard = e => {
      /* 编辑模式：守卫退场，但同一位置改由「Ctrl 多选手势」接管（#3）。
       * 两者共用同一个捕获阶段监听器是有意的 —— 免得再往 #stage 上多挂一份，
       * 也保证「非编辑完全封禁」与「编辑内 Ctrl 加选」互斥且都有唯一定义。 */
      if (this.on) { this._multiSelEv(e); return; }
      e.stopPropagation();
      this._glog(e.type);
    };
    for (const t of this.GUARD_EVENTS) stageEl.addEventListener(t, this._guard, true);
    return true;
  },

  disarmGuard() {
    if (!this._guard || !this._guardStage) return false;
    for (const t of this.GUARD_EVENTS) this._guardStage.removeEventListener(t, this._guard, true);
    this._guard = null; this._guardStage = null;
    return true;
  },

  guardArmed() { return !!this._guard; },

  _glog(what) {
    if (!Array.isArray(this._guardLog)) this._guardLog = [];
    this._guardLog.push(what);
    if (this._guardLog.length > 60) this._guardLog.splice(0, this._guardLog.length - 60);
  },

  /* ========================= Ctrl 多选（#3） =========================
   * 诉求：同类元素（三张图标卡片的正文、一行里的多个标签…）要能 Ctrl 多选之后
   *       **同时**改颜色 / 字号 / 位置。
   *
   * ★ 内核事实（读 vendor/svgcanvas.min.js 的 select 分支得到，并已实测）：
   *     case"select": A.includes(B) || (t.shiftKey || k.clearSelection(!0),
   *                                    k.addToSelection([B]), k.setJustSelected(B), …)
   *   即 svgcanvas 原生累加选择**只认 Shift**，Ctrl / Meta 根本没被绑定；
   *   而且「命中的元素已经在选择里」时它**直接 return**（为了支持"按住拖拽整组"），
   *   不会取消 —— 这恰好是 Ctrl 多选需要的「再点一次取消」的缺口。
   *
   * 本层因此走**最小侵入 + 完全复用**：
   *   · Ctrl+点**未选中**元素 → 在捕获阶段把事件就地改写成 Shift 语义
   *       Object.defineProperty(evt, 'shiftKey', { value: true })
   *     事件对象沿 捕获→目标→冒泡 是**同一条实例**，后面 svgcanvas 的处理器
   *     读 t.shiftKey 就得到 true，于是走它自己的 addToSelection 全链路
   *     （选择框、justSelected、多选拖拽、selectionChanged 全部一致），零重实现。
   *   · Ctrl+点**已选中**元素 → 内核只会 return，所以本层把这次手势整个拦下
   *     （mousedown/mouseup 都不放行，避免内核进入拖拽态），在 mouseup 时调内核的
   *     removeFromSelection([el]) —— 仍是语义 API，照旧进 selected 事件。
   *   · Ctrl+点**空白** → 内核在 shift 语义下会 addToSelection([svgroot])，
   *     把整张画布选进来（实测 getMouseTarget 在空白返回 svg#svgroot），
   *     不是用户预期，同样拦掉、保持原选择。
   *
   * 命中判定直接借内核自己的 getMouseTarget(evt)：
   *   实测（.svgbuild/_mt.cjs，real-01）3/3 个采样点与真实点击后的 Editor.sel[0]
   *   **完全一致**（点 text#svg_12 → 选中 g#svg_9；点 rect#svg_2 → 选中 rect#svg_2），
   *   空白点稳定返回 svg#svgroot ⇒ 不必自己猜选择粒度。
   * -------------------------------------------------------------------------*/

  hitTest(e) {
    const c = this.rt && this.rt.canvas;
    if (!c) return null;
    let t = null;
    try { t = typeof c.getMouseTarget === 'function' ? c.getMouseTarget(e) : null; } catch (x) { t = null; }
    if (!t) {
      /* 兜底：elementFromPoint + 上溯到 svgcontent 的直接子元素（= 内核的选择粒度） */
      let n = null;
      try { n = document.elementFromPoint(e.clientX, e.clientY); } catch (x) { n = null; }
      if (!n) return null;
      const content = (() => {
        try { return (c.getSvgContent && c.getSvgContent()) || document.getElementById('svgcontent'); }
        catch (x) { return null; }
      })();
      if (!content || !content.contains(n)) return null;
      while (n && n.parentNode && n.parentNode !== content) n = n.parentNode;
      t = (n && n.parentNode === content) ? n : null;
    }
    if (!t) return null;
    let root = null;
    try { root = c.getSvgRoot(); } catch (x) { root = null; }
    if (root && t === root) return null;                        /* 空白：svgroot 本身 */
    if (/^(svgroot|svgcontent|selectorParentGroup|canvasBackground|svgcanvas)$/.test(t.id || '')) return null;
    if (!t.tagName || t.tagName === 'svg') return null;
    return t;
  },

  _multiSelEv(e) {
    /* ★ 任何 mousedown 都让上一次的判定作废：
     *   用户可能 Ctrl+按下之后把指针拖到画布外松开，此时 #stage 收不到 mouseup，
     *   _ctrl 会残留 —— 若不主动清，下一次**普通** mouseup 就会被误当成
     *   「取消该元素」而删掉选择。这条清理是所有边界里最要紧的一个。 */
    if (e.type === 'mousedown') this._ctrl = null;

    /* ★ mouseup 的分支必须在 Ctrl 判定**之前**：
     *   真实操作里用户可能先松开 Ctrl 再松开鼠标键（mouseup 时 ctrlKey 已是 false），
     *   若先判 Ctrl 就会漏掉收尾。只认「本层记过的手势」即可。
     * ★ 这里**只记账、不再 stopPropagation**（与 mousedown 不对称是有意的）：
     *   · mode='add' —— mousedown 放行过，内核自己 setStarted(true) 了，
     *     它的 mouseUpEvent 还要做多选的 selector resize 收尾，拦掉会让手柄位置不刷新；
     *   · mode='remove'/'blank' —— mousedown 被拦，内核从未 setStarted，
     *     它的 mouseUpEvent 开头 `if (… || !k.getStarted()) return` 自己就会退出，放行无害。
     *   即「拦 mousedown 足够，mouseup 一律放行」是两侧都安全的那一个选择。 */
    if (e.type === 'mouseup') {
      const st = this._ctrl;
      if (!st) return;
      this._ctrl = null;
      this._glog('ctrl-end');
      if (st.mode === 'remove' && st.el) {
        try { this.rt.canvas.removeFromSelection([st.el]); }
        catch (x) { this.lastErr = 'Ctrl 取消选择失败: ' + (x && x.message); }
        this.refreshSel();
        this._fire('sel');
      }
      return;
    }

    /* 只接管 Ctrl / Meta；Shift 原生的多选保持原样可用；
     * 带 Alt 的一律不碰（避免与其它手势/系统组合键冲突）。 */
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    /* Ctrl+双击：内核会给 text 进编辑态（本宿主没有 svgedit 的编辑 UI，会抛错）→ 直接拦掉 */
    if (e.type === 'dblclick') { e.stopPropagation(); e.preventDefault(); return; }
    if (e.type !== 'mousedown') return;

    const t = this.hitTest(e);
    if (!t) {                                                  /* 空白 → 保持原选择 */
      this._ctrl = { el: null, mode: 'blank' };
      e.stopPropagation(); e.preventDefault();
      this._glog('ctrl-blank');
      return;
    }
    if (this.sel.indexOf(t) >= 0) {                             /* 已选中 → 手势结束时取消它 */
      this._ctrl = { el: t, mode: 'remove' };
      e.stopPropagation(); e.preventDefault();
      this._glog('ctrl-remove');
      return;
    }
    /* 未选中 → 改写为 Shift 语义，交给内核走它自己的 addToSelection 全链路 */
    try { Object.defineProperty(e, 'shiftKey', { value: true, configurable: true }); }
    catch (x) { this.lastErr = 'Ctrl 多选：事件属性改写失败（' + (x && x.message) + '）'; }
    this._ctrl = { el: t, mode: 'add' };
    this._glog('ctrl-add');
  },

  /* 程序化加选 / 取消（探针与「同类元素」批量选择的入口；与鼠标 Ctrl 语义一致） */
  addSelEl(el) {
    const c = this.rt && this.rt.canvas;
    if (!c || !el) return { ok: false, err: '加选：元素不存在' };
    if (this.sel.indexOf(el) >= 0) return { ok: true, n: this.sel.length, already: true };
    try { c.addToSelection([el], true); } catch (x) { return { ok: false, err: 'addToSelection 失败: ' + x.message }; }
    this.refreshSel(); this._fire('sel');
    return { ok: true, n: this.sel.length };
  },

  removeSelEl(el) {
    const c = this.rt && this.rt.canvas;
    if (!c || !el) return { ok: false, err: '取消选择：元素不存在' };
    if (this.sel.indexOf(el) < 0) return { ok: true, n: this.sel.length, absent: true };
    try { c.removeFromSelection([el]); } catch (x) { return { ok: false, err: 'removeFromSelection 失败: ' + x.message }; }
    this.refreshSel(); this._fire('sel');
    return { ok: true, n: this.sel.length };
  },

  /* 多选时各项属性是否一致 —— UI 据此把输入框标成「多值」而不是假装它们是同一个值。
   * 颜色/线宽取「各选中元素自己的 computed」；字号取 fontTargets（含 <g> 内后代），
   * 与属性面板实际会写到的目标集合完全一致。 */
  mixed() {
    const n = this.sel.length;
    if (n <= 1) return null;
    const uq = a => a.filter((v, i) => v !== '' && v !== null && a.indexOf(v) === i);
    const fh = this.sel.map(e => this._hex(this._effStr(e, 'fill')));
    const sh = this.sel.map(e => this._hex(this._effStr(e, 'stroke')));
    const sw = this.sel.map(e => r2(parseFloat(this._effStr(e, 'stroke-width')) || 0));
    const ft = this.fontTargets();
    const fs = ft.map(e => r2(parseFloat(this._effStr(e, 'font-size')) || NaN)).filter(v => isFinite(v));
    const F = uq(fh), S = uq(sh), W = uq(sw), Z = uq(fs);
    /* 选区并集盒子：多选时「元素框」应显示它，而不是 sel[0] 的框 ——
     * 后者只代表一个元素，在多选语境下会误导「我这次改的到底是哪几个」。 */
    let U = null;
    for (const e of this.sel) {
      let b = null; try { b = Runtime.worldBBox(e); } catch (x) { b = null; }
      if (!b) continue;
      const bb = R.mk(b.x, b.y, b.w, b.h);
      U = U ? R.union([U, bb]) : bb;
    }
    return {
      n, nFontTgt: ft.length,
      fillMixed: F.length > 1, fillHex: F.length ? F[0] : '',
      strokeMixed: S.length > 1, strokeHex: S.length ? S[0] : '',
      swMixed: W.length > 1, sw: W.length ? W[0] : null,
      fsMixed: Z.length > 1, fs: Z.length ? Z[0] : null,
      box: U ? { x: r2(U.x), y: r2(U.y), w: r2(U.w), h: r2(U.h) } : null
    };
  },

  _effStr(e, prop) { try { return getComputedStyle(e).getPropertyValue(prop) || ''; } catch (x) { return ''; } },

  /* ------------------------------- 装配 ------------------------------- */
  attach(rt, notify) {
    const c = rt && rt.canvas;
    if (!c) { this.lastErr = 'canvas 不存在'; return false; }
    this.rt = rt; this._notify = notify || this._notify;
    if (this._bound && this._boundC === c) return true;
    const onSel = () => { this.refreshSel(); this._fire('sel'); };
    /* 'changed' 由所有语义 API 与鼠标拖拽共同触发；防抖后统一重算，避免掉帧 */
    const onChg = () => { if (this.on) this.schedule(); };
    try {
      c.bind('selected', onSel);
      c.bind('changed', onChg);
    } catch (e) { this.lastErr = 'bind 失败: ' + (e && e.message); return false; }
    this._bound = true; this._boundC = c;
    return true;
  },

  _fire(what, extra) { if (isFn(this._notify)) { try { this._notify(what, extra); } catch (e) { /* UI 侧异常不影响编辑 */ } } },

  /* ---------------------------- 进入 / 退出 ---------------------------- */
  /* 契约：enable/disable 本身**不得**改动内容（探针会比对 sha256） */
  enable(rt) {
    if (!rt || !rt.canvas) return false;
    if (!this.attach(rt, this._notify)) return false;
    this.on = true;
    this.track = [];
    this.ir = IR.build(rt, {});
    this.an = this.ir.ok ? Analyzer.run(this.ir, {}) : null;
    this.entryScore = this.an ? this.an.score : null;
    this.entryNodes = this.ir.ok ? this.ir.nodes.length : null;
    this.prevScore = this.entryScore;
    /* 以「当前内容」为已知基线：避免把首次导出的空白规范化误记成一次变更 */
    this._sha = sha256Hex(rt.exportString());
    this.entrySha = this._sha;
    this._lastSvg = rt.exportString();
    this.entryUndo = this.undoSize();
    this.refreshSel();
    this._fire('mode', { on: true });
    return true;
  },

  disable(rt) {
    const c = (rt || this.rt || {}).canvas;
    this.on = false;
    if (this._t) { clearTimeout(this._t); this._t = null; }
    /* 退出时清掉选择，否则手柄会留在画面上（非编辑模式不该看到编辑痕迹） */
    try { c && c.clearSelection(); } catch (e) { /* 忽略 */ }
    this.sel = [];
    this._sha = null;
    this._lastSvg = null;
    this._ctrl = null;
    this._fire('mode', { on: false });
    this._fire('sel');
    return true;
  },

  /* 换样例 / 重跑美化后，内容被整体替换：重置基线，轨迹清空 */
  reset(rt) {
    this.rt = rt || this.rt;
    const c = this.rt && this.rt.canvas;
    this.sel = []; this.track = []; this._sha = null;
    if (this._t) { clearTimeout(this._t); this._t = null; }
    if (!this.on) return;
    this.ir = IR.build(this.rt, {});
    this.an = this.ir.ok ? Analyzer.run(this.ir, {}) : null;
    this.entryScore = this.an ? this.an.score : null;
    this.entryNodes = this.ir.ok ? this.ir.nodes.length : null;
    this.prevScore = this.entryScore;
    try { c && c.clearSelection(); } catch (e) { /* 忽略 */ }
    this._sha = sha256Hex(this.rt.exportString());
    this.entrySha = this._sha;
    this._lastSvg = this.rt.exportString();
    this.entryUndo = this.undoSize();
    this._fire('track');
  },

  /* ------------------------------- 选择 ------------------------------- */
  refreshSel() {
    const c = this.rt && this.rt.canvas;
    let els = [];
    try { els = (c && c.getSelectedElements()) || []; } catch (e) { els = []; }
    this.sel = els.filter(Boolean);
    return this.sel;
  },

  select(elems) {
    const c = this.rt && this.rt.canvas;
    if (!c || !elems || !elems.length) return [];
    /* ★ 第二个参数 showGrips 必须显式传 true（实测，grip_hook.cjs 调用序列为证）：
     *   selectOnly(e,A){ this.clearSelection(!0), this.addToSelection(e,A) }   // 第二参一路透传
     *   addToSelection 末尾： A.length===1 && requestSelector(A[0]).showGrips(e)
     *   showGrips(e){ …selectorGripsGroup.setAttribute("display", e?"inline":"none"); this.hasGrips=e }
     * 省略即 e===undefined → 抓手组的 display 被设成 "none"（10 个 circle 仍在 DOM 里，
     * 但 getBoundingClientRect 全 0×0），选择框 path#selectedBox0 照画 ——
     * 现象就是「选中了却看不到手柄」。真实鼠标点击走 selectOnly([c],!0) 所以有抓手。
     * 官方 .d.ts 把它标为可选，在本宿主的语义里是**实质必需**。 */
    try { c.selectOnly([].concat(elems), true); } catch (e) { this.lastErr = 'selectOnly 失败: ' + e.message; }
    this.refreshSel();
    this._fire('sel');
    return this.sel;
  },

  clearSel() {
    const c = this.rt && this.rt.canvas;
    try { c && c.clearSelection(); } catch (e) { /* 忽略 */ }
    this.sel = [];
    this._fire('sel');
  },

  /* 可见手柄数 —— 判据必须是**渲染盒子非零**，不能看 visibility/display。
   * 实测（edit_diag2.cjs）：svgcanvas 未选中时把 grip 的几何整个置零，
   *   10 个 selectorGrip* 的 visibility 全是 visible、display 全是 inline，
   *   但 getBoundingClientRect() 全是 0×0；
   * 选中之后 9 个盒子非零（8 个 resize 角/边柄 + 1 个 rotate 柄；
   *   rotateconnector 是条 width=0 的连线，本就不算手柄，会被自动排除）。
   * 按样式判会恒报 10 —— 于是「未选中却显示可见手柄」这种假阳性会误导属性面板。 */
  grips() {
    const c = this.rt && this.rt.canvas;
    const root = c && c.getSvgRoot && c.getSvgRoot();
    if (!root) return 0;
    let n = 0;
    for (const el of root.querySelectorAll('[id^="selectorGrip"]')) {
      let r = null;
      try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
      if (r && r.width > 0 && r.height > 0) n++;
    }
    return n;
  },

  /* --------------------------- 选中元素的属性 --------------------------- */
  _hex(v) {
    if (!v) return '';
    const s = String(v).trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s.slice(1).split('').map(x => x + x).join('').toLowerCase();
    const m = s.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (m) return '#' + [1, 2, 3].map(i => clamp(parseInt(m[i], 10), 0, 255).toString(16).padStart(2, '0')).join('');
    return '';
  },

  props() {
    const e = this.sel[0];
    if (!e) return null;
    const own = n => e.getAttribute(n);
    const eff = n => { try { return getComputedStyle(e).getPropertyValue(n) || ''; } catch (x) { return ''; } };
    const effNum = n => { const v = parseFloat(eff(n)); return isFinite(v) ? v : null; };
    const txt = (() => { try { return this.rt.canvas.getText ? String(this.rt.canvas.getText() || '') : textOf(e); } catch (x) { return textOf(e); } })();
    let bb = null; try { bb = Runtime.worldBBox(e); } catch (x) { bb = null; }
    return {
      n: this.sel.length,
      tag: tagOf(e), id: e.id || '',
      own: { fill: own('fill'), stroke: own('stroke'), sw: own('stroke-width'), fontSize: own('font-size') },
      eff: {
        fill: eff('fill'), stroke: eff('stroke'),
        sw: effNum('stroke-width'), fontSize: effNum('font-size'),
        fillHex: this._hex(eff('fill')), strokeHex: this._hex(eff('stroke'))
      },
      text: txt,
      rot: this.rotation(),
      bbox: bb ? { x: r2(bb.x), y: r2(bb.y), w: r2(bb.w), h: r2(bb.h) } : null,
      isText: tagOf(e) === 'text' || tagOf(e) === 'tspan',
      isGroup: tagOf(e) === 'g',
      /* 多选（#3）：各项是否一致，UI 据此显示「多值」并标明统一写入的落点 */
      multi: this.mixed()
    };
  },

  rotation() {
    const e = this.sel[0]; if (!e) return null;
    try {
      const l = e.transform.baseVal;
      for (let i = 0; i < l.numberOfItems; i++) { const it = l.getItem(i); if (it.type === 4) return r2(it.angle); }
    } catch (x) { /* 无 transform */ }
    return null;
  },

  /* 选中元素命中的诊断 issue（只读提示，供「手改 vs 自动修」对照） */
  selIssues() {
    const an = (this.on ? this.an : null) || null;
    if (!an || !this.sel.length) return [];
    const keys = new Set();
    for (const e of this.sel) { if (e.id) keys.add(e.id); keys.add(String(this.sel.indexOf(e))); }
    /* IR 的 domId 就是元素 id（无 id 时为空），所以按 id 匹配即可 */
    return (an.issues || []).filter(it => {
      const tg = it.targets || [];
      return tg.some(t => keys.has(t)) ||
        (it.evidence && ((it.evidence.aRef && keys.has(it.evidence.aRef)) || (it.evidence.bRef && keys.has(it.evidence.bRef))));
    }).map(it => ({ id: it.id, type: it.type, priority: it.priority, fixable: it.fixable, targets: it.targets }));
  },

  /* ------------------------------- 执行 ------------------------------- */
  /* 统一入口：打标签 → 执行 → 交给防抖 flush 记录轨迹 */
  mark(label) { this._label = label || null; },

  run(label, fn) {
    if (!this.on) return { ok: false, err: '未进入编辑模式' };
    const c = this.rt && this.rt.canvas;
    if (!c) return { ok: false, err: 'canvas 不存在' };
    this.mark(label);
    let err = null;
    try { fn(c); } catch (e) { err = label + ' 失败: ' + (e && e.message); this.lastErr = err; }
    /* ★ 无论成败都要冲刷。svgedit 里有「先把 DOM 改了、再抛异常」的 API
     * （setTextContent 就是典型，见下方 setText 注释），失败时若直接 return，
     * 就会出现「DOM 已变、分数轨迹没记、撤销栈也不同步」的静默背离。 */
    const rec = this.flushNow();
    return err ? { ok: false, err, changed: !!rec } : { ok: true, changed: !!rec };
  },

  schedule() {
    if (this._t) return;
    this._t = setTimeout(() => { this._t = null; this.flush(); }, 80);
  },

  flushNow() { if (this._t) { clearTimeout(this._t); this._t = null; } return this.flush(); },

  /* 重算 IR + Analyzer，并把「这一动作改了多少分」记进轨迹。
   * 用 sha256 判「到底有没有真的改到 DOM」：没变就不记，免得轨迹被噪声灌满。 */
  flush() {
    const rt = this.rt;
    if (!this.on || !rt || !rt.canvas) return null;
    let svg = '';
    try { svg = rt.exportString() || ''; } catch (e) { svg = ''; }
    const sha = svg ? sha256Hex(svg) : '';
    if (!sha || sha === this._sha) { this._label = null; return null; }
    this._sha = sha;

    const ir = IR.build(rt, {});
    const an = ir.ok ? Analyzer.run(ir, {}) : null;
    const score = an ? an.score : null;
    const delta = (score !== null && this.prevScore !== null) ? r2(score - this.prevScore) : null;
    const total = (score !== null && this.entryScore !== null) ? r2(score - this.entryScore) : null;
    this.ir = ir;
    this.an = an;
    this.prevScore = score;
    /* ★ 记下「这一步到底改了哪些属性」——「改动清单可取消」的全部依据。
     *   为什么必须存差量而不是只存快照：撤销栈是**线性**的，
     *   「取消第 k 步」若走 undoTo 会把 k+1..n 一起回退（用户要的是只取消这一条）。
     *   有了属性级差量就能**定向还原**：把这一步写进去的值改回旧值，后续步骤原地不动。 */
    const diff = this._lastSvg ? this.diffSvg(this._lastSvg, svg) : null;
    this._lastSvg = svg;
    /* ★ 「取消某一步 / 全部回退」是对清单本身的操作，不该再往清单里追加一条记录 ——
     *   否则清单会自我繁殖（多出 #4 = "取消 #2"），行号与用户认知彻底错位
     *   （实测：取消 #2 之后清单变成 4 行，汇总还写着 3 项已应用）。
     *   这里仍更新 _sha/_lastSvg/ir/an/score（否则下一次差分会拿旧基线，
     *   属性面板也拿不到新分数），只是不 push 记录。 */
    if (this._noTrack) { this._label = null; this._fire('track'); return null; }
    const rec = {
      n: this.track.length + 1,
      label: this._label || '画布变更',
      score, delta, total,
      canvas: ir.ok ? [ir.canvas.w, ir.canvas.h] : null,
      issues: an ? an.issues.length : null,
      sha: sha.slice(0, 12),
      undo: this.undoSize(),
      t: Date.now(),
      /* 差量 + 是否含结构变更（增/删元素）—— 含结构变更的步骤无法做属性级定向还原，
       * 取消时只能整段回退，UI 据此给出正确提示而不是假装能单步取消。 */
      diff: diff || [],
      struct: !!(diff && diff.some(d => d.add || d.remove)),
      cancelled: false
    };
    this.track.push(rec);
    if (this.track.length > 200) this.track.shift();
    this._label = null;
    this._fire('track', rec);
    return rec;
  },

  /* --------------------------- 属性 / 文本 --------------------------- */
  /* ★ 文本类属性必须先自验作用域，且**只看顶层选中元素、绝不下钻**。
   * 压缩源依据（vendor/svgcanvas.min.js）：
   *   setFontSize → XS=t=>{ let e=gi(), A=ma(e,'font-size',t);
   *                        St.setCurText('font_size',t),
   *                        A.length>0 && St.changeSelectedAttribute('font-size',t,A),
   *                        e.some(r=>r.textContent) || St.textActions.setCursor() }
   *   setTextContent → JS=t=>{ St.changeSelectedAttribute('#text',t), St.textActions.init(t), ... }
   *   gi() 只筛「顶层选中元素里的 text」，**不下钻 <g>**。因此：
   *     1) 选中一个「内部装着 text 的 g」去设字号：gi() 返回空 → 字号不生效，
   *        并且走到 setCursor() 抛 "Cannot read properties of null (reading 'value')"。
   *     2) 更危险的是 setTextContent：它对 g 直接 `elem.textContent = val`
   *        —— **会把 g 的所有子元素一次性抹掉**，然后 setCursor() 才抛。
   *        实测（探针 B3b）正是这条把 document 改坏了：守卫若下钻放行，
   *        调用方看到的是「失败」但 DOM 已经被毁。
   *   ⇒ 所以守卫必须与 gi() 同语义：任一顶层选中元素不是 text/tspan 就不放行。 */
  _textEls() {
    return this.sel.filter(e => e && (tagOf(e) === 'text' || tagOf(e) === 'tspan'));
  },
  _textGuard(label) {
    if (!this.sel.length) return label + '：未选中元素';
    if (!this._textEls().length) {
      return label + '：选中项里没有文本元素（顶层为 ' + this.sel.map(tagOf).join(',')
        + '）。该操作只作用于直接选中的 text/tspan，不支持下钻到 g 内部'
        + '（svgcanvas 对 g 执行会破坏其子元素）';
    }
    return null;
  },

  setFill(v) { return this.run('填充 ' + v, c => { c.setColor('fill', v); }); },
  setStroke(v) { return this.run('描边 ' + v, c => { c.setColor('stroke', v); }); },
  setStrokeWidth(v) {
    const n = parseFloat(v);
    if (!isFinite(n) || n < 0) return { ok: false, err: '线宽非法' };
    return this.run('线宽 ' + n, c => { c.setStrokeWidth(n); });
  },
  /* --------------------------- 文本目标解析（#1 的关键） ---------------------------
   * ★ 用户反馈「选中一个元素无法修改字号大小并生效」的根因：
   *   svgcanvas 的 `setFontSize` 内部用 gi() 取文本，而 gi() **只筛顶层选中的 text**、
   *   不下钻 <g>。而真实画布上用户点到的绝大多数是「卡片底板」或包着文字的 <g>
   *   （实测 real-01：点「业务数据」选中 g#svg_9，其内部有 10 个 text），
   *   于是 gi() 返回空 → 字号改不动，还顺带走到 setCursor() 抛错。
   *   之前本层用 `_textGuard` 直接**拒绝**了这种情况，用户体验就是「输入框是灰的、改不了」。
   *
   * 正确做法是照抄 svgcanvas 自己给 stroke-width 写的下钻逻辑：
   *   setStrokeWidth → 遍历选中项，g 用 eo() 收集所有非 g 后代，再
   *   changeSelectedAttribute('stroke-width', v, elems)
   * 即「下钻由调用方负责，属性写入由 changeSelectedAttribute 负责」。
   * 这里对 font-size 做同一件事：先解析出真正要改字号的 text/tspan 列表，再写属性。
   * 这样既拿到了「选中卡片就能改里面文字字号」的自由度，又完全不偏离内核语义。 */
  fontTargets() {
    const out = [];
    const push = e => { if (e && out.indexOf(e) < 0) out.push(e); };
    for (const e of this.sel) {
      if (!e) continue;
      const t = tagOf(e);
      if (t === 'text' || t === 'tspan') { push(e); continue; }
      if (t === 'g') {
        let list = [];
        try { list = Array.prototype.slice.call(e.querySelectorAll('text,tspan')); } catch (x) { list = []; }
        for (const q of list) push(q);
        continue;
      }
      /* ★ 点到「卡片底板」时，文字往往是它的**兄弟节点**而不是子节点
       *   （real-01 实测：点「企业知识来源」选中 rect#svg_2，
       *     DOM 下钻得到 0 个 text，于是字号框又被停用）。
       *   但 IR 已经知道「这块底板对应哪些标签」（node.labels）——
       *   这是本产品相对 svg-edit 的独有信息（有质量模型就有语义关联），
       *   直接用它把文字找回来，用户不需要先手动下钻。 */
      for (const l of this._irLabelElems(e)) push(l);
    }
    return out;
  },

  /* 按 IR 的元素↔标签关联找回文字元素（DOM 上够不到时用） */
  _irLabelElems(e) {
    const ir = (this.ir && this.ir.ok) ? this.ir : null;
    if (!ir || !e) return [];
    const out = [];
    for (const n of ir.nodes) {
      const same = (n.shapeElem === e) || (n.elem === e) || (e.id && n.domId === e.id);
      if (!same) continue;
      for (const l of (n.labels || [])) if (l.elem) out.push(l.elem);
    }
    return out;
  },

  /* 元素上是否有该属性的**内联 style 声明**。
   * ★ 这是字号改不动（只改一半）的真正原因：SVG 的层叠顺序里
   *   style 属性的优先级高于 font-size 这类表现属性，
   *   而内核 changeSelectedAttribute 只写 `setAttribute('font-size', v)`
   *   （压缩源 jC/db：`let o = s.getAttribute(t); o !== String(e) && s.setAttribute(t,...)`），
   *   于是 `style="font-size:19px"` 的元素 compute 出来纹丝不动 ——
   *   实测 real-01 同一批 4 个文字里，有 style 的两个留在 19px、没有的变成 29px。 */
  _hasInline(e, cssProp) {
    try { return !!(e.style && e.style.getPropertyValue(cssProp)); } catch (x) { return false; }
  },

  /* 只写「表现属性」够不够？不够就必须补内联样式。
   * ★ SVG 的层叠顺序：内联 style > 作者样式表 <style> 里的类规则 > 表现属性。
   *   内核 changeSelectedAttribute 只写表现属性（db: `s.setAttribute(t,...)`），
   *   所以遇到**作者样式表**时同样失效 —— real-01 是 Illustrator 导出的，
   *   文字字号写在 `<style>` 的 `.st0{font-size:24px}` 这类规则里，
   *   实测把 47 个 text 的 font-size 属性全写成 37，compute 出来仍是 54/24/30。
   * 判定用「试写 + 还原」：写进去后 compute 有没有变成目标值，
   *   变不了就说明被样式表压过，必须落到内联样式（内联优先级高于作者样式表）。
   * 数值型（font-size / font-weight）这样探；字符串型属性无法可靠比对
   *   computed（font-family 会被规范化、text-anchor 继承值可能为空），
   *   采取保守策略：属性值不等于目标就补内联样式（补了也不会有副作用）。 */
  _needInline(e, attr, str) {
    let cs0 = '';
    try { cs0 = getComputedStyle(e).getPropertyValue(attr) || ''; } catch (x) { cs0 = ''; }
    const numeric = /^(font-size|font-weight|letter-spacing|word-spacing)$/.test(attr);
    if (numeric) {
      const n0 = parseFloat(cs0), nt = parseFloat(str);
      if (isFinite(n0) && isFinite(nt) && Math.abs(n0 - nt) < 0.01) return false;   /* 已是目标 */
      const had = e.getAttribute(attr);
      e.setAttribute(attr, str);
      let cs1 = '';
      try { cs1 = getComputedStyle(e).getPropertyValue(attr) || ''; } catch (x) { cs1 = ''; }
      if (had === null) e.removeAttribute(attr); else e.setAttribute(attr, had);
      const n1 = parseFloat(cs1);
      return !(isFinite(n1) && isFinite(nt) && Math.abs(n1 - nt) < 0.01);
    }
    return e.getAttribute(attr) !== str;
  },

  /* 选区里真正生效的字号：取「出现次数最多」的那个值（卡片内主文案通常是多数派），
   * 并列时取较大者。旧实现直接读 `getComputedStyle(sel[0]).font-size` ——
   * 选中 <g> 时读到的是 g 的继承值（real-01 实测 22px），与卡内实际字号无关，
   * 面板填一个错的数，用户更不敢改。 */
  effFontSize() {
    const els = this.fontTargets();
    if (!els.length) return null;
    const tally = new Map();
    for (const e of els) {
      let v = null;
      try { v = parseFloat(getComputedStyle(e).getPropertyValue('font-size')); } catch (x) { v = null; }
      if (!isFinite(v)) { v = parseFloat(numA(e, 'font-size', NaN)); }
      if (!isFinite(v)) continue;
      v = r2(v);
      tally.set(v, (tally.get(v) || 0) + 1);
    }
    if (!tally.size) return null;
    let best = null, bn = -1;
    for (const [v, n] of tally) { if (n > bn || (n === bn && v > best)) { best = v; bn = n; } }
    return best;
  },

  setFontSize(v) {
    const n = parseFloat(v);
    if (!isFinite(n) || n <= 0) return { ok: false, err: '字号非法' };
    return this._textProp('font-size', n, '字号 ' + n, c => c.setFontSize(n));
  },

  /* 文本类属性的统一通道（字号 / 粗体 / 斜体 / 对齐 / 字体）。
   * ★ 五个 API 在内核里是同一个模子（见下方 minified 证据），同一个坑也一模一样：
   *   IS (setBold)  : gi() → ma(e,'font-weight',A) → changeSelectedAttribute(...) → 空则 setCursor() 抛错
   *   OS (setItalic): gi() → ma(e,'font-style',A)  → 同上
   *   HS (anchor)   : ma(gi(),'text-anchor',t)     → 同上
   *   XS (setFontSize): gi() → ma(e,'font-size',t) → 同上
   *   gi() 只取**顶层选中的 text**，所以选中 <g>（真实画布上最常见）时全部失效并抛错。
   * 统一处理：先解析出真正该改的 text/tspan（含 g 内后代），
   *   全选中项都是文本 → 走原生 API（保持与官方完全一致的事件/撤销语义）；
   *   否则 → changeSelectedAttribute(attr, val, 显式元素表)，与内核给 stroke-width
   *   写的下钻手法同源。 */
  _textProp(attr, val, label, native) {
    if (!this.sel.length) return { ok: false, err: label + '：未选中元素' };
    const els = this.fontTargets();
    if (!els.length) {
      return { ok: false, err: label + '：选中项（' + this.sel.map(tagOf).join(',') + '）里没有文本' };
    }
    const allText = this.sel.length === els.length && this.sel.every(e => {
      const t = tagOf(e); return t === 'text' || t === 'tspan';
    });
    const str = String(val);
    const needInline = els.some(e => this._needInline(e, attr, str));
    if (!needInline) {
      if (allText && isFn(native)) return this.run(label, c => native(c));
      return this.run(label + '（' + els.length + ' 个文本）', c => {
        c.changeSelectedAttribute(attr, val, els);
      });
    }
    /* 有内联样式 / 作者样式表压着 → 表现属性写不进 compute 值，
     * 必须**属性 + 内联样式双写**（内联优先级高于作者样式表与表现属性）。
     * 撤销用内核自己的 BatchCommand + ChangeElementCommand，把
     * **属性旧值**与**整条 style 旧值**一起记下来；
     * ChangeElementCommand.unapply 对 null/"" 走 removeAttribute，
     * 所以「原本没有这个属性 / 原本没有 style」也能精确还原。 */
    return this.run(label + '（' + els.length + ' 个文本 · 属性+内联样式）', c => {
      const H = c.history || {};
      const old = els.map(e => ({ a: e.getAttribute(attr), s: e.getAttribute('style') }));
      let n = 0;
      for (const e of els) {
        let touched = false;
        try {
          if (this._hasInline(e, attr)) e.style.removeProperty(attr);
          e.style.setProperty(attr, str);
          touched = true;
        } catch (x) { /* style 不可用则退回纯属性 */ }
        if (e.getAttribute(attr) !== str) { e.setAttribute(attr, str); touched = true; }
        if (touched) n++;
      }
      if (!n) return;
      if (H.BatchCommand && H.ChangeElementCommand && c.undoMgr && c.undoMgr.addCommandToHistory) {
        const b = new H.BatchCommand(label);
        els.forEach((e, i) => {
          if (b.addSubCommand) b.addSubCommand(new H.ChangeElementCommand(e, { [attr]: old[i].a, style: old[i].s }));
        });
        c.undoMgr.addCommandToHistory(b);
      } else {
        this.lastErr = label + '：已改内容但未入撤销栈（history 类缺失）';
      }
    });
  },

  setFontFamily(v) { return this._textProp('font-family', v, '字体 ' + v, c => c.setFontFamily(v)); },

  /* ---- 文本内容：不用 canvas.setTextContent，改走 svgcanvas 官方的撤销命令类 ----
   * 实测（.svgbuild/text_diag3.cjs，每个用例独立重载页面）：
   *   canvas.setTextContent('T1')                 → 抛 "reading 'value'"（尾部
   *       textActions.setCursor() 依赖 svgcanvas 自带编辑器 UI，本宿主没有），
   *       **但 DOM 已经被改成 T1**；undo 栈不增长（2→2），撤销回不去。
   *   canvas.changeSelectedAttribute('#text','T2') → 不抛、DOM 改成 T2，
   *       undo 栈同样不增长。原因是 svgcanvas 走 getAttribute('#text') 取旧值，
   *       文本节点没有这个属性、恒得 null，finishUndoableChange() 得到空命令不入栈
   *       （见压缩源 jC：`n.isEmpty() || addCommandToHistory(n)`）。
   *   而它的**撤销命令类本身是好的**：
   *       new BatchCommand('Change Text') + new ChangeElementCommand(el, {'#text': old})
   *       → undo 栈 +1、标签 'Change Text'、undo 精确还原、redo 重放。实测通过。
   * ⇒ 这里自己改 textContent（唯一偏离「只走语义 API」契约的地方，理由如上），
   *   但入栈用的是 svgcanvas 官方类，保证与其它操作同源、同栈、标签可读。 */
  setText(v) {
    const bad = this._textGuard('文本内容'); if (bad) return { ok: false, err: bad };
    const s = String(v);
    return this.run('文本内容', c => {
      const els = this._textEls();
      const changed = els.filter(e => String(e.textContent) !== s);
      if (!changed.length) return;
      const old = changed.map(e => String(e.textContent));
      const H = c.history || {};
      for (const e of changed) e.textContent = s;
      if (H.BatchCommand && H.ChangeElementCommand && c.undoMgr && c.undoMgr.addCommandToHistory) {
        const b = new H.BatchCommand('Change Text');
        changed.forEach((e, i) => {
          if (b.addSubCommand) b.addSubCommand(new H.ChangeElementCommand(e, { '#text': old[i] }));
        });
        c.undoMgr.addCommandToHistory(b);
      } else {
        this.lastErr = '文本内容：svgcanvas 未暴露 BatchCommand/ChangeElementCommand，已改内容但未入撤销栈';
      }
    });
  },
  setBold(b) {
    return this._textProp('font-weight', b ? 'bold' : 'normal', b ? '加粗' : '取消加粗', c => c.setBold(!!b));
  },
  setItalic(i) {
    return this._textProp('font-style', i ? 'italic' : 'normal', i ? '斜体' : '取消斜体', c => c.setItalic(!!i));
  },
  setTextAnchor(v) {
    return this._textProp('text-anchor', v, '对齐方式 ' + v, c => c.setTextAnchor(v));
  },
  setAttr(k, v) { return this.run(k + ' = ' + v, c => { c.changeSelectedAttribute(k, v); }); },

  /* ------------------------------- 几何 ------------------------------- */
  /* ★ moveSelectedElements 的单位是个坑（源码 selected-elem.js 内）：
   *     if (!Array.isArray(dx)) { dx /= zoom; dy /= zoom }
   *   即**标量入参是屏幕像素**（内部再除以 zoom），**数组入参是用户单位**（不除）。
   *   要「移动 N 个 SVG 用户单位」必须走数组形式，否则结果会随当前缩放漂移。
   *   数组长度必须等于选中元素个数（实现里按 dx[i] 取值）。 */
  move(dx, dy) {
    const ux = r2(dx), uy = r2(dy);
    return this.run('位移 ' + ux + ',' + uy + ' 单位', c => {
      const n = Math.max(1, this.sel.length);
      c.moveSelectedElements(new Array(n).fill(ux), new Array(n).fill(uy), true);
    });
  },
  /* ★ setRotationAngle 只作用于 selectedElements[0]，UI 会明确标注 */
  rotate(deg) {
    const n = parseFloat(deg);
    if (!isFinite(n)) return { ok: false, err: '角度非法' };
    return this.run('旋转 ' + r2(n) + '°', c => { c.setRotationAngle(n); });
  },
  flip(sx, sy) {
    const l = (sx ? '水平' : '') + (sy ? '垂直' : '');
    return this.run('翻转 ' + l, c => { c.flipSelectedElements(!!sx, !!sy); });
  },
  align(type, rel) { return this.run('对齐 ' + type, c => { c.alignSelectedElements(type, rel || 'selected'); }); },

  /* --------------------------- 结构 / 层级 --------------------------- */
  group() { return this.run('成组', c => { c.groupSelectedElements(); }); },
  ungroup() { return this.run('解组', c => { c.ungroupSelectedElement(); }); },
  toTop() { return this.run('置顶', c => { c.moveToTopSelectedElement(); }); },
  toBottom() { return this.run('置底', c => { c.moveToBottomSelectedElement(); }); },
  up() { return this.run('上移一层', c => { c.moveUpDownSelected('Up'); }); },
  down() { return this.run('下移一层', c => { c.moveUpDownSelected('Down'); }); },
  clone() { return this.run('复制副本', c => { c.cloneSelectedElements(12, 12); }); },
  /* 删除（#4）：删之前把「要删什么」写进标签，让轨迹与撤销栈读得懂。
   * 选中 <g> 会连带删掉它内部的全部形状 —— 实测 real-01 删一个 g 使节点数 25→20，
   * 这在轨迹里必须能看出来，否则用户回不到「刚才删了什么」。 */
  del() {
    if (!this.sel.length) return { ok: false, err: '删除：未选中元素' };
    const desc = this.sel.map(e => tagOf(e) + (e.id ? '#' + e.id : '')).join(',');
    const inner = this.sel.reduce((a, e) => a + (e.querySelectorAll ? e.querySelectorAll('*').length : 0), 0);
    const r = this.run('删除 ' + desc + (inner ? '（含 ' + inner + ' 个子元素）' : ''), c => { c.deleteSelectedElements(); });
    /* 删完选择必然为空（元素已不在 DOM 里），显式清一次，避免属性面板停在幽灵元素上 */
    this.sel = [];
    this._fire('sel');
    return r;
  },
  copy() { return this.run('拷贝到剪贴板', c => { c.copySelectedElements(); }); },
  paste() { return this.run('粘贴', c => { c.pasteElements(); }); },

  /* ---------------------------- 撤销 / 重做 ---------------------------- */
  undoSize() { try { return this.rt.canvas.undoMgr.getUndoStackSize(); } catch (e) { return -1; } },
  redoSize() { try { return this.rt.canvas.undoMgr.getRedoStackSize(); } catch (e) { return -1; } },
  undoLabel() { try { return this.rt.canvas.undoMgr.getNextUndoCommandText() || ''; } catch (e) { return ''; } },
  redoLabel() { try { return this.rt.canvas.undoMgr.getNextRedoCommandText() || ''; } catch (e) { return ''; } },

  undo() { return this.run('撤销', c => { c.undoMgr.undo(); }); },
  redo() { return this.run('重做', c => { c.undoMgr.redo(); }); },

  /* ★ 撤销到「轨迹第 n 步之后」的状态（#5：变更列表点击可回退）。
   * 依据是 undoMgr 的栈深而不是时间：轨迹第 n 条记录写入时 undo 栈深 = rec.undo，
   * 所以把栈深退到 rec.undo 就精确回到那一刻的内容。
   * 三条护栏（都会在真实交互里遇到）：
   *   ① 只允许后退，不允许用 redo 前进 —— 轨迹行点完就 undo，语义单一可预期；
   *   ② 上界 MAX 防止栈异常时无限循环（undo 到 0 仍不为空说明栈被外部改过）；
   *   ③ 最终以「轨迹被截断到 n」收尾，避免列表里留下已回退掉的记录。
   * 回退动作本身也走 canvas 语义 API（undoMgr.undo），所以每条都自动进重做栈，
   * 用户点错了还能 Ctrl+Y 回来。 */
  undoTo(n) {
    const tgt = this.track.find(r => r.n === n);
    if (!tgt) return { ok: false, err: '轨迹 #' + n + ' 不存在' };
    if (!this.on) return { ok: false, err: '未进入编辑模式' };
    const c = this.rt && this.rt.canvas;
    if (!c || !c.undoMgr) return { ok: false, err: 'undoMgr 不可用' };
    const want = tgt.undo;
    let cur = this.undoSize();
    if (cur <= want) return { ok: false, err: '已在 #' + n + ' 之后的状态（undo 栈 ' + cur + ' ≤ ' + want + '）' };
    this.mark('撤销到 #' + n + '（' + tgt.label + '）');
    let guard = 0;
    try {
      while (cur > want && guard++ < 200) { c.undoMgr.undo(); const nx = this.undoSize(); if (nx >= cur) break; cur = nx; }
    } catch (e) { this.lastErr = '撤销到 #' + n + ' 失败: ' + (e && e.message); }
    /* 轨迹截断：被回退掉的那些记录不再代表当前内容。
     * 回退本身**不回填清单**（_noTrack）—— 它是对清单的操作，不是一次新的编辑改动。 */
    this.track = this.track.filter(r => r.n <= n);
    this._noTrack = true; this.flushNow(); this._noTrack = false;
    this.track = this.track.filter(r => r.n <= n);
    this._fire('track');
    return { ok: true, undone: tgt.n, label: tgt.label };
  },

  /* 返回「撤销到某步」是否可用 —— 供 UI 决定行的可点状态与提示 */
  canUndoTo(n) {
    const tgt = this.track.find(r => r.n === n);
    return !!(tgt && this.on && this.undoSize() > tgt.undo);
  },

  /* ========================= 改动清单 · 属性级差量 =========================
   * 把两步之间的 SVG 文本比成一张「改了哪些属性」的表：
   *   [{ id, tag, attr, from, to }]，结构变更另记 { add } / { remove }。
   * 这是「取消单步」能做到 **不牵连后续步骤** 的唯一依据（见 flush 内注释）。
   * 匹配策略：优先按元素 id；无 id 的元素按「文档顺序序号 + 标签名」兜底。
   * 无 id 且中间发生过结构变化时匹配可能错位 —— 所以含结构变更的步骤
   * 一律标记 rec.struct=true，走整段回退，不假装能定向还原。 */
  diffSvg(a, b) {
    let A, B;
    try {
      A = new DOMParser().parseFromString(a, 'image/svg+xml');
      B = new DOMParser().parseFromString(b, 'image/svg+xml');
    } catch (e) { return []; }
    if (!A || !B) return [];
    if (A.getElementsByTagName('parsererror').length || B.getElementsByTagName('parsererror').length) return [];
    const list = doc => {
      const out = []; const root = doc.documentElement; if (!root) return out;
      const w = doc.createTreeWalker(root, 1 /* SHOW_ELEMENT */, null);
      let n = w.nextNode();
      while (n) { out.push(n); n = w.nextNode(); }
      return out;
    };
    const keyOf = (el, i) => { const id = el.getAttribute && el.getAttribute('id'); return id ? '#' + id : '~' + i + ':' + el.tagName; };
    const la = list(A), lb = list(B);
    const ka = new Map(); la.forEach((e, i) => ka.set(keyOf(e, i), e));
    const kb = new Set(); lb.forEach((e, i) => kb.add(keyOf(e, i)));
    const out = [];
    lb.forEach((eb, i) => {
      const k = keyOf(eb, i), ea = ka.get(k);
      if (!ea) { out.push({ add: true, tag: eb.tagName, id: eb.getAttribute('id') || '' }); return; }
      const at = ea.attributes, seen = new Set();
      for (let j = 0; j < at.length; j++) {
        const nm = at[j].name; seen.add(nm);
        const v2 = eb.getAttribute(nm);
        if (v2 !== at[j].value) out.push({ id: eb.getAttribute('id') || k, tag: eb.tagName, attr: nm, from: at[j].value, to: v2 });
      }
      const bt = eb.attributes;
      for (let j = 0; j < bt.length; j++) {
        if (!seen.has(bt[j].name)) out.push({ id: eb.getAttribute('id') || k, tag: eb.tagName, attr: bt[j].name, from: null, to: bt[j].value });
      }
      const ta = ea.textContent || '', tb = eb.textContent || '';
      if (ta !== tb) out.push({ id: eb.getAttribute('id') || k, tag: eb.tagName, attr: '#text', from: ta, to: tb });
    });
    la.forEach((ea, i) => { const k = keyOf(ea, i); if (!kb.has(k)) out.push({ remove: true, id: ea.getAttribute('id') || k, tag: ea.tagName }); });
    return out;
  },

  /* 全部回退：把编辑改动整体退回到「进入编辑模式」时的状态，清单清空。
   * 目标深度用 entryUndo（进编辑时记录的撤销栈深度），所以不会把进编辑之前的历史也退掉。 */
  cancelAll() {
    if (!this.on) return { ok: false, err: '未进入编辑模式' };
    const c = this.rt && this.rt.canvas;
    if (!c || !c.undoMgr) return { ok: false, err: 'undoMgr 不可用' };
    const want = (this.entryUndo === null ? 0 : this.entryUndo);
    let cur = this.undoSize(), guard = 0, undone = 0;
    try {
      while (cur > want && guard++ < 400) {
        c.undoMgr.undo();
        const nx = this.undoSize();
        if (nx >= cur) break;          /* 栈没降说明已到底，防死循环 */
        undone++; cur = nx;
      }
    } catch (e) { this.lastErr = '全部回退失败: ' + (e && e.message); }
    this.track = [];
    this._label = null;
    this._sha = null;                  /* 强制重算：把回退后的内容确认为新的「已知内容」 */
    this._noTrack = true;
    this.flushNow();                   /* 刷新 ir/an/score；不回填清单 */
    this._noTrack = false;
    this.track = [];
    this.prevScore = this.entryScore;
    const sem = this.sameAsEntry();
    this._fire('track');
    return { ok: true, undone, score: sem.score, entryScore: this.entryScore,
             shaSame: sem.shaSame, nodesSame: sem.nodesSame, scoreSame: sem.scoreSame,
             nodes: sem.nodes, entryNodes: sem.entryNodes,
             atEntry: sem.atEntry };
  },

  /* 「现在的内容 == 进入编辑模式时的内容」的判据。
   * ★ 不能只看 sha（逐字节）：undo 走的是 ChangeElementCommand.unapply，
   *   它会**替换 DOM 元素**，DOM 往返一次后属性顺序 / 空白可能与原始文本不同 ——
   *   实测 real-01 全部回退后分数与结构完全回到基线，sha 却不相同。
   *   所以判据取「结构计数 + 分数」双等（语义相等），
   *   并把 shaSame 一并如实报出，让人能看到差别是「文本层」还是「语义层」。 */
  sameAsEntry() {
    const shaSame = !!(this._sha && this.entrySha && this._sha === this.entrySha);
    const nodes = (this.ir && this.ir.ok) ? this.ir.nodes.length : null;
    const score = this.an ? this.an.score : null;
    const nodesSame = (nodes !== null && this.entryNodes !== null) ? nodes === this.entryNodes : null;
    const scoreSame = (score !== null && this.entryScore !== null) ? Math.abs(score - this.entryScore) < 1e-9 : null;
    return { shaSame, nodes, entryNodes: this.entryNodes, nodesSame, score, scoreSame,
             atEntry: shaSame || (nodesSame === true && scoreSame === true) };
  },

  /* 「取消单步」是否可行 + 会牵连多少后续步骤（UI 用它决定 checkbox 的可点性与提示） */
  canCancel(n) {
    const rec = this.track.find(r => r.n === n);
    if (!rec || !this.on || rec.cancelled) return { ok: false };
    if (rec.struct) {
      const later = this.track.filter(r => r.n > n && !r.cancelled).length;
      return { ok: this.undoSize() > (rec.undo || 0) - 1, mode: 'rollback', later, reason: '含结构变更 → 整段回退' };
    }
    const live = (rec.diff || []).filter(d => !d.add && !d.remove);
    return { ok: live.length > 0, mode: 'targeted', later: 0, n: live.length };
  },

  /* 取消单步改动。两种模式：
   *   targeted —— 定向还原：把该步写进去的属性值改回旧值，后续步骤原地不动。
   *     只还原「当前值仍等于该步写入值」的属性：若被后续步骤再改过，
   *     直接写回旧值会把后续改动一起吃进来 —— 宁可跳过并如实报告，不可改错。
   *   rollback —— 含结构变更（增/删元素）时无法定向还原，整段回退到该步之前，
   *     并明确报告其后 N 步一并回退（undoTo 语义）。 */
  cancelStep(n) {
    const rec = this.track.find(r => r.n === n);
    if (!rec) return { ok: false, err: '改动 #' + n + ' 不存在' };
    if (!this.on) return { ok: false, err: '未进入编辑模式' };
    if (rec.cancelled) return { ok: false, err: '#' + n + ' 已经取消过了' };
    const c = this.rt && this.rt.canvas;
    if (!c) return { ok: false, err: 'canvas 不存在' };
    const chk = this.canCancel(n);

    if (chk.mode === 'rollback') {
      const later = chk.later;
      const target = n - 1;
      if (target >= 1) {
        const r = this.undoTo(target);
        if (!r.ok) return r;
        rec.cancelled = true;
      } else {
        /* 第 1 步就是结构变更 → 回到进入编辑时的基线 */
        this.mark('取消 #1（含结构变更，回到进入编辑时的状态）');
        let cur = this.undoSize(), guard = 0;
        const want = (this.entryUndo === null ? 0 : this.entryUndo);
        try { while (cur > want && guard++ < 400) { c.undoMgr.undo(); const nx = this.undoSize(); if (nx >= cur) break; cur = nx; } }
        catch (e) { this.lastErr = '回到基线失败: ' + (e && e.message); }
        this.track = [];
        this._noTrack = true; this.flushNow(); this._noTrack = false;
      }
      return { ok: true, mode: 'rollback', undone: n, label: rec.label, later };
    }

    /* ---- 定向还原 ---- */
    const root = (() => { try { return c.getSvgRoot(); } catch (e) { return null; } })();
    if (!root) return { ok: false, err: '找不到 svg root' };
    const byId = new Map();
    const w = root.ownerDocument.createTreeWalker(root, 1, null);
    let nd = w.nextNode();
    while (nd) { if (nd.id) byId.set(nd.id, nd); nd = w.nextNode(); }
    this.mark('取消 #' + n + '（' + rec.label + '）');
    let back = 0, skip = 0;
    for (const d of rec.diff || []) {
      if (d.add || d.remove) { skip++; continue; }
      const el = byId.get(String(d.id).replace(/^#/, ''));
      if (!el) { skip++; continue; }
      let cur;
      try { cur = d.attr === '#text' ? (el.textContent || '') : el.getAttribute(d.attr); } catch (e) { cur = undefined; }
      if (String(cur) !== String(d.to)) { skip++; continue; }     /* 已被后续步骤改写 → 不动 */
      try {
        if (d.attr === '#text') el.textContent = d.from === null ? '' : d.from;
        else if (d.from === null) el.removeAttribute(d.attr);
        else el.setAttribute(d.attr, d.from);
        back++;
      } catch (e) { skip++; }
    }
    if (!back) { this._label = null; return { ok: false, mode: 'targeted', err: '该步的全部属性都已被后续改动覆盖，未做任何还原' }; }
    rec.cancelled = true;
    /* 取消本身不回填清单（见 flush 的 _noTrack 说明）：
     * 否则清单会多出一行「取消 #n」，把行号与用户认知搅乱。 */
    this._noTrack = true; this.flushNow(); this._noTrack = false;
    return { ok: true, mode: 'targeted', undone: n, label: rec.label, reverted: back, skipped: skip };
  },

  /* --------------------------- 选择层级（自由度） ---------------------------
   * svg-edit 的同类能力：一次点击选到的是光标下**最外层**的分组，
   * 想改组内文字必须能往下钻。这里给两个显式入口，不做隐式猜测。
   *   selectDeeper() —— 在当前选中项里挑一个「还没被选中的子元素」纳入选择
   *                     （优先 text/tspan，因为这是最常被需要的目标）
   *   selectParent() —— 把选择上提到父节点（去重后合并） */
  selectDeeper() {
    const c = this.rt && this.rt.canvas;
    if (!c || !this.sel.length) return { ok: false, err: '未选中元素' };
    const have = new Set(this.sel);
    for (const e of this.sel) {
      let kids = [];
      try { kids = Array.prototype.slice.call(e.children || []); } catch (x) { kids = []; }
      const pick = kids.find(k => /^(text|tspan)$/.test(tagOf(k))) || kids[0];
      if (pick && !have.has(pick)) { have.add(pick); }
      else {
        /* 没有未选中的直接子级 → 往下找一个更深的后代文本 */
        let deep = null;
        try { deep = e.querySelector && e.querySelector('text,tspan'); } catch (x) { deep = null; }
        if (deep && !have.has(deep)) have.add(deep);
      }
    }
    const next = Array.from(have);
    if (next.length === this.sel.length) return { ok: false, err: '没有可下钻的子元素' };
    this.select(next);
    return { ok: true, n: next.length };
  },

  /* --------------------------- 选同类（#3 的便利入口） ---------------------------
   * 用户原话是「同类元素应该支持 ctrl 多选同时调整」——Ctrl 多选解决的是「能同时改」，
   * 这里解决「选起来省事」：选中一个元素，一次把同类的全选上。
   * 三张图标卡片要改同一处样式时不必 Ctrl 点三次（而且手动点还容易漏掉被遮挡的那个）。
   *
   * 判据按 tag 分档，只做「用户眼里显然同类」的定义，不做语义猜测：
   *   · text / tspan → 同字号（±0.5px）；两者互为同类（同一段文字的两种承载方式）
   *   · 其余形状 → 同 tag 且宽高相近（±2px 或 ±2%，取大者）
   * ★ 搜索范围是 **svgcontent 的整棵子树**，不是「只有同一层级」——
   *   实测 real-01 的 svgcontent 只有 3 个直接子元素（三个无 id 的顶层 <g>），
   *   真实可点的卡片底板 rect / 文字组 g 全都嵌套在里面；而内核的选择粒度是
   *   **命中元素本身**（实测点 rect#svg_2 就选中 rect#svg_2，并不上溯到那个顶层 g）。
   *   最初按「同层级」找，结果在 real-01 上一组都凑不出来（0 组），与用户预期完全不符。
   * 命中上限 40：复杂图上一次选中几百个元素，选择框手柄会把画面糊满，反而没法用。 */
  selectSimilar() {
    const c = this.rt && this.rt.canvas;
    if (!c || !this.sel.length) return { ok: false, err: '选同类：未选中元素' };
    const content = (() => {
      try { return c.getSvgContent() || document.getElementById('svgcontent'); }
      catch (e) { return null; }
    })();
    if (!content) return { ok: false, err: '选同类：找不到内容层' };
    /* 整棵子树的元素表（排除元数据类节点）—— 见上方注释：不能只看直接子元素 */
    const kids = [];
    try {
      const w = content.ownerDocument.createTreeWalker(content, 1 /* SHOW_ELEMENT */, null);
      let nd = w.nextNode();
      while (nd) {
        const t = tagOf(nd);
        if (t !== 'title' && t !== 'desc' && t !== 'defs' && t !== 'style'
          && t !== 'metadata' && t !== 'svg') kids.push(nd);
        nd = w.nextNode();
      }
    } catch (e) { /* 退化到直接子元素 */ }
    if (!kids.length) kids.push.apply(kids, Array.prototype.slice.call(content.children || []));
    if (!kids.length) return { ok: false, err: '选同类：内容层没有可选元素' };
    const seed = this.sel[0];
    const t0 = tagOf(seed);
    const isTxt = e => /^(text|tspan)$/.test(tagOf(e));
    const near = (a, b) => isFinite(a) && isFinite(b)
      && Math.abs(a - b) <= Math.max(2, 0.02 * Math.max(Math.abs(a), Math.abs(b)));
    const geom = e => { try { return Runtime.worldBBox(e); } catch (x) { return null; } };
    const fs = e => { try { return parseFloat(getComputedStyle(e).getPropertyValue('font-size')); } catch (x) { return NaN; } };
    const b0 = geom(seed), fs0 = fs(seed), text0 = isTxt(seed);
    const same = e => {
      if (isTxt(e) !== text0) return false;
      if (text0) return Math.abs(fs(e) - fs0) <= 0.5;
      if (tagOf(e) !== t0) return false;
      if (!b0) return false;
      const b = geom(e);
      return !!b && near(b.w, b0.w) && near(b.h, b0.h);
    };
    let list = kids.filter(same);
    if (list.length > 40) list = list.slice(0, 40);
    if (list.length <= 1) {
      return { ok: false, err: '选同类：没找到与 ' + t0 + '#' + (seed.id || '') + ' 同类的元素'
        + (text0 ? '（按字号 ' + fs0 + 'px 匹配）' : '（按同 tag + 相近宽高匹配）') };
    }
    const n = this.select(list);
    return { ok: true, n: n.length, of: kids.length, text: text0, seed: t0 + (seed.id ? '#' + seed.id : '') };
  },

  selectParent() {
    if (!this.sel.length) return { ok: false, err: '未选中元素' };
    const out = [];
    for (const e of this.sel) {
      const p = e.parentNode;
      if (!p || tagOf(p) === 'svg' || p === document) { if (out.indexOf(e) < 0) out.push(e); continue; }
      if (out.indexOf(p) < 0) out.push(p);
    }
    if (!out.length || (out.length === this.sel.length && out.every(e => this.sel.indexOf(e) >= 0))) {
      return { ok: false, err: '已到最外层' };
    }
    this.select(out);
    return { ok: true, n: out.length };
  },

  /* ------------------------------- 汇总 ------------------------------- */
  stats() {
    const last = this.track.length ? this.track[this.track.length - 1] : null;
    return {
      on: this.on,
      guard: this.guardArmed(),
      entryScore: this.entryScore,
      entryNodes: this.entryNodes,
      entrySha: this.entrySha ? this.entrySha.slice(0, 16) : null,
      curScore: last ? last.score : this.entryScore,
      total: last ? last.total : 0,
      atEntry: this.sameAsEntry().atEntry,
      shaSame: this.sameAsEntry().shaSame,
      nSel: this.sel.length,
      nText: this._textEls().length,
      /* nFontTgt：可改字号的文本数（含选中 <g> 内部的后代）——
       * 旧版只报 _textEls()（顶层 text），选中卡片时恒为 0，
       * 属性面板据此把字号输入框停用，正是用户反馈 #1 的直接原因。 */
      nFontTgt: this.fontTargets().length,
      effFontSize: this.effFontSize(),
      /* 多选（#3）：一致性快照 + Ctrl 手势日志（探针据此断言「Ctrl 加选真的走了内核通道」） */
      multi: this.mixed(),
      ctrlLog: this._guardLog ? this._guardLog.slice(-12) : null,
      nSelTxt: this._textEls().length,
      selTag: this.sel[0] ? tagOf(this.sel[0]) : null,
      selId: this.sel[0] ? (this.sel[0].id || '') : null,
      grips: this.grips(),
      changes: this.track.length,
      undoSize: this.undoSize(), redoSize: this.redoSize(),
      undoLabel: this.undoLabel(), redoLabel: this.redoLabel(),
      sha: this._sha ? this._sha.slice(0, 16) : null,
      track: this.track.slice(-8),
      lastErr: this.lastErr
    };
  }
};
