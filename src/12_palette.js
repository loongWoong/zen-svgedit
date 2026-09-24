/* =============================================================================
 * SVG Beautifier · 12 配色风格一键切换引擎（Palette）
 *
 * 职责：把任意 SVG 的配色「移植」到一套目标风格色系（角色化重着色）。
 *   —— 用户需求：一键切换几类常用风格系列（企业科技蓝 / 白底商务 / 深色未来科技 /
 *      Palantir 本体 / AI 大模型平台 / 金融政企 / AWS 云原生）。
 *
 * 设计要点（更健壮普适）：
 *   · 全部在 SVG 的「活 DOM」（svgcanvas #svgcontent）上操作，getBBox 可用，
 *     因此能可靠识别「铺满画布的背景矩形」与形状的面积级别。
 *   · 角色识别：背景（覆盖 >50% 画布的最大填充元素）、文字（<text>/<tspan>）、
 *     形状（其余实心填充元素）。
 *   · 形状配色：收集所有实心填充/描边的「不同色」，按亮度升序排序 → 依次映射到
 *     目标色系的 accents 数组（暗者取首、亮者取末，循环复用）。
 *     这样「暗形状仍暗、亮形状仍亮」语义在目标色系家族内保持，普适于任意源图。
 *   · 文字配色：仅当文字当前为「中性色」（亮度极高 >0.85 或极低 <0.15，即黑/白/灰）
 *     才改成目标 text 色；落在彩色按钮/胶囊上的饱和色文字（如蓝底白字）保持不动，
 *     避免「白字变黑字」导致不可读。
 *   · 渐变 / url(#..) / none / currentColor / 命名色无法稳定映射的，一律原样保留。
 * ===========================================================================*/
'use strict';

const Palette = {
  /* 常用风格色系。bg=背景, text=正文文字(可读前景), panel=浅灰面板/表面,
   * accents=形状/强调色（按亮度升序，用于「暗→首、亮→末」的角色映射）。 */
  PRESETS: {
    ent_tech_dark: { name: '企业科技蓝·深底', bg: '#0B1628', text: '#F5F5F5', panel: '#16324F', accents: ['#1677FF', '#13C2C2', '#52C41A', '#FA8C16', '#69B1FF'] },
    biz_white:     { name: '白底商务蓝',     bg: '#FFFFFF', text: '#1A1A1A', panel: '#F2F6FC', accents: ['#1677FF', '#13C2C2', '#52C41A', '#FA8C16', '#91CAFF'] },
    dark_cyber:    { name: '深色未来科技',   bg: '#050B14', text: '#FFFFFF', panel: '#0E1B2E', accents: ['#00A8FF', '#00FFE0', '#8A5CFF', '#FF4ECD'] },
    palantir:      { name: 'Palantir 本体', bg: '#F8FAFC', text: '#0F172A', panel: '#EEF2F7', accents: ['#2563EB', '#64748B', '#F97316', '#9333EA', '#16A34A'] },
    ai_platform:   { name: 'AI 大模型平台',  bg: '#FFFFFF', text: '#111827', panel: '#F4F5FF', accents: ['#6366F1', '#A855F7', '#06B6D4', '#14B8A6', '#F59E0B'] },
    finance_gov:   { name: '金融政企',       bg: '#F2F4F7', text: '#1A1A1A', panel: '#E3E8EE', accents: ['#003366', '#C8A951', '#008060', '#002B45'] },
    aws_cloud:     { name: 'AWS 云原生',     bg: '#FFFFFF', text: '#16191F', panel: '#F1F3F5', accents: ['#FF9900', '#1E8900', '#2E73B8', '#8C4FFF', '#D13212'] }
  },

  names() { return Object.keys(this.PRESETS); },

  label(name) { const p = this.PRESETS[name]; return p ? p.name : name; },

  /* 把任意颜色归一为 #rrggbb；无法稳定映射（none/url/var/命名色解析失败）返回 null。 */
  toHex(color) {
    if (!color) return null;
    let c = String(color).trim().toLowerCase();
    if (!c || c === 'none' || c === 'transparent' || c === 'currentcolor') return null;
    if (c.indexOf('url(') === 0 || c.indexOf('var(') === 0) return null;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c)) {
      if (c.length === 4) return '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
      return c.slice(0, 7);
    }
    try {                                   /* 命名色 → 借 canvas 解析为 hex */
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.fillStyle = c;
      const h = ctx.fillStyle;
      if (/^#[0-9a-f]{6}$/i.test(h)) return h;
    } catch (e) { /* ignore */ }
    return null;
  },

  hexToRgb(hex) {
    const h = (hex || '').replace('#', '');
    if (h.length < 6) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  },

  /* 感知亮度 0..1（sRGB 加权），用于角色排序 */
  luminance(hex) {
    const rgb = this.hexToRgb(hex); if (!rgb) return 0.5;
    return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  },

  _bbox(el) {
    try { const b = el.getBBox(); if (b && isFinite(b.width) && isFinite(b.height)) return b; } catch (e) { /* ignore */ }
    return null;
  },

  /* 文本角色类（在 <style> 里定义、专用于文字的 fill）：一律映射到目标 text 色，
   * 保证任意主题下标题/正文/标签都可读。其余颜色类视为形状/表面色。 */
  TEXT_ROLE: /^(title|subtitle|h1|h2|h3|h4|body|small|tiny|text|head|heading|label|caption|desc|note|lead|p|cap|t\d*|white|black)$/i,

  /* 统一把单个颜色值按目标色系重着色。
   *   isText=true  → 文字角色：一律目标 text 色（可读性优先）。
   *   isText=false → 形状/表面：按亮度落到 bg / panel / accents（暗→首亮→末），
   *                  保持「暗仍暗、亮仍亮」的语义在目标色系家族内。 */
  _recolor(c, p, isText) {
    const h = this.toHex(c); if (!h) return null;
    if (isText) return p.text;
    const L = this.luminance(h);
    if (L < 0.04) return p.bg;                                  /* 近黑 → 背景 */
    if (L > 0.9) return p.panel;                                /* 近白/浅灰 → 表面面板 */
    const n = p.accents.length;                                 /* 彩色 → 按亮度取 accents 位 */
    const idx = Math.max(0, Math.min(n - 1, Math.round(((L - 0.04) / 0.86) * (n - 1))));
    return p.accents[idx];
  },

  /* 重着色一段 CSS 文本（<style> 内容）：按「规则」逐块处理——先判定该规则的选择器
   * 是否文本角色，再对其 body 内所有颜色按角色/亮度重着色。比「向前 40 字符回溯」更稳健，
   * 不受美化后 <style> 换行缩进影响。 */
  _recolorCss(css, p) {
    return css.replace(/([^{}]*)\{([^{}]*)\}/g, (m, selPart, body) => {
      const name = (selPart || '').trim().replace(/^\./, '').split(/[\s,>:+~]/)[0];
      const isText = this.TEXT_ROLE.test(name);
      const newBody = body.replace(/#[0-9a-fA-F]{3,8}\b/g, (c) => {
        const hex = (c.length === 4)
          ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]
          : c.slice(0, 7);
        return this._recolor(hex, p, isText) || c;
      });
      return selPart + '{' + newBody + '}';
    });
  },

  /* 在活 DOM 上就地重着色；返回 true 表示已应用。调用方负责重渲染/导出。 */
  apply(rt, name) {
    const p = this.PRESETS[name]; if (!p) return false;
    if (!rt || typeof rt.contentGroup !== 'function') return false;
    const root = rt.contentGroup(); if (!root) return false;
    const svgRoot = (typeof rt.root === 'function') ? rt.root() : null;
    const canvas = svgRoot || root;
    const cb = this._bbox(canvas);
    const cbArea = cb ? cb.width * cb.height : 0;

    const shapes = [];          /* 非文字实心元素 */
    const bgCands = [];          /* 背景候选（覆盖 >50% 画布） */

    const walk = root.querySelectorAll('*');
    for (const el of walk) {
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'style') continue;                            /* <style> 由下方 svgRoot 统一处理 */
      if (tag === 'text' || tag === 'tspan') {                  /* 文字：强制可读前景 */
        el.setAttribute('fill', p.text);
        continue;
      }
      const f = this.toHex(el.getAttribute('fill'));
      const s = this.toHex(el.getAttribute('stroke'));
      const bb = this._bbox(el);
      const area = bb ? bb.width * bb.height : 0;
      if (f || s) shapes.push({ el, fill: f, stroke: s, area });
      if (f && cbArea > 0 && area > 0.5 * cbArea) bgCands.push({ el, fill: f, area });
    }

    /* <style> 可能挂在 svg 根而非 contentGroup 下：在整棵 svg 上统一重着色一次 */
    for (const st of (svgRoot || root).querySelectorAll('style')) {
      const txt = st.textContent || '';
      const out = this._recolorCss(txt, p);
      if (out !== txt) st.textContent = out;
    }

    /* 背景 = 覆盖画布最大面积的元素（强制为目标 bg，优先级最高） */
    let bgEl = null;
    if (bgCands.length) { bgCands.sort((a, b) => b.area - a.area); bgEl = bgCands[0].el; }

    if (bgEl) bgEl.setAttribute('fill', p.bg);
    for (const o of shapes) {
      if (o.el === bgEl) continue;
      if (o.fill) { const t = this._recolor(o.fill, p, false); if (t) o.el.setAttribute('fill', t); }
      if (o.stroke) { const t = this._recolor(o.stroke, p, false); if (t) o.el.setAttribute('stroke', t); }
    }
    return true;
  }
};
