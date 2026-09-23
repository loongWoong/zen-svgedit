/* =============================================================================
 * SVG Beautifier · 01 基础工具
 * 纯函数，无依赖：转义 / 数值 / 矩阵 / 矩形 / 折线 / 随机
 * ===========================================================================*/
'use strict';

const SVGNS = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = (v, d) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(d === undefined ? 2 : d) : '—';
const pct = v => (typeof v === 'number' && isFinite(v)) ? (v * 100).toFixed(1) + '%' : '—';
const r2 = v => Math.round(v * 100) / 100;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const isFn = f => typeof f === 'function';

/* mulberry32：同一 seed 完全可复现（与仓库既有场景一致） */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

/* ------------------------------- 2×3 仿射矩阵 -------------------------------
 * {a,b,c,d,e,f} 对应 SVG matrix(a,b,c,d,e,f)
 *   x' = a·x + c·y + e
 *   y' = b·x + d·y + f
 * -------------------------------------------------------------------------*/
const M = {
  id: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  /* m 后接 n：先 n 再 m */
  mul(m, n) {
    return {
      a: m.a * n.a + m.c * n.b,
      b: m.b * n.a + m.d * n.b,
      c: m.a * n.c + m.c * n.d,
      d: m.b * n.c + m.d * n.d,
      e: m.a * n.e + m.c * n.f + m.e,
      f: m.b * n.e + m.d * n.f + m.f
    };
  },
  apply(m, p) { return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }; },
  det: m => m.a * m.d - m.b * m.c,
  inv(m) {
    const dt = M.det(m);
    if (!dt) return M.id();
    return {
      a: m.d / dt, b: -m.b / dt, c: -m.c / dt, d: m.a / dt,
      e: (m.c * m.f - m.d * m.e) / dt, f: (m.b * m.e - m.a * m.f) / dt
    };
  },
  /* 两轴缩放因子（用于 stroke 视觉外扩、overlay 线宽补偿） */
  scaleOf(m) { return { sx: Math.hypot(m.a, m.b), sy: Math.hypot(m.c, m.d) }; },
  fromString(s) {
    if (!s) return M.id();
    const nums = String(s).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
    if (!nums) return M.id();
    const v = nums.map(Number);
    if (/matrix/.test(s) && v.length >= 6) return { a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5] };
    if (/translate/.test(s)) return { a: 1, b: 0, c: 0, d: 1, e: v[0] || 0, f: v[1] || 0 };
    if (/scale/.test(s)) return { a: v[0], b: 0, c: 0, d: v.length > 1 ? v[1] : v[0], e: 0, f: 0 };
    return M.id();
  },
  isIdentity(m, tol) {
    const t = tol === undefined ? 1e-6 : tol;
    return Math.abs(m.a - 1) < t && Math.abs(m.b) < t && Math.abs(m.c) < t &&
           Math.abs(m.d - 1) < t && Math.abs(m.e) < t && Math.abs(m.f) < t;
  }
};

/* --------------------------------- 矩形 R --------------------------------- */
const R = {
  mk: (x, y, w, h) => ({ x, y, w, h }),
  fromPoints(pts) {
    if (!pts.length) return R.mk(0, 0, 0, 0);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return R.mk(x0, y0, x1 - x0, y1 - y0);
  },
  /* 世界坐标下把矩形按矩阵变换后的轴对齐包围盒 */
  transform(rect, m) {
    const p = [
      M.apply(m, { x: rect.x, y: rect.y }),
      M.apply(m, { x: rect.x + rect.w, y: rect.y }),
      M.apply(m, { x: rect.x + rect.w, y: rect.y + rect.h }),
      M.apply(m, { x: rect.x, y: rect.y + rect.h })
    ];
    return R.fromPoints(p);
  },
  right: r => r.x + r.w,
  bottom: r => r.y + r.h,
  cx: r => r.x + r.w / 2,
  cy: r => r.y + r.h / 2,
  area: r => Math.max(0, r.w) * Math.max(0, r.h),
  isEmpty: r => !(r.w > 0 && r.h > 0),
  expand(r, dx, dy) { return R.mk(r.x - dx, r.y - (dy === undefined ? dx : dy), r.w + 2 * dx, r.h + 2 * (dy === undefined ? dx : dy)); },
  union(list) {
    const s = (list || []).filter(Boolean).filter(r => isFinite(r.x) && isFinite(r.w));
    if (!s.length) return null;
    const x0 = Math.min(...s.map(r => r.x)), y0 = Math.min(...s.map(r => r.y));
    const x1 = Math.max(...s.map(r => R.right(r))), y1 = Math.max(...s.map(r => R.bottom(r)));
    return R.mk(x0, y0, x1 - x0, y1 - y0);
  },
  intersect(a, b) {
    const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
    const x1 = Math.min(R.right(a), R.right(b)), y1 = Math.min(R.bottom(a), R.bottom(b));
    if (x1 <= x0 || y1 <= y0) return null;
    return R.mk(x0, y0, x1 - x0, y1 - y0);
  },
  /* 交集面积占两者较小面积的比例：1 = 完全覆盖（视为包含，不算碰撞） */
  coverRatio(a, b) {
    const inter = R.intersect(a, b);
    if (!inter) return 0;
    const m = Math.min(R.area(a), R.area(b));
    return m > 0 ? R.area(inter) / m : 0;
  },
  /* 轴对齐间距：a 在前 b 在后时沿 axis 的空隙（可为负 = 重叠） */
  gap(a, b, axis) {
    return axis === 'x' ? b.x - R.right(a) : b.y - R.bottom(a);
  },
  /* 点到矩形的距离（在矩形内为 0） */
  distToPoint(r, p) {
    const dx = Math.max(r.x - p.x, 0, p.x - R.right(r));
    const dy = Math.max(r.y - p.y, 0, p.y - R.bottom(r));
    return Math.hypot(dx, dy);
  },
  /* 矩形是否包含点 */
  has(r, p) { return p.x >= r.x && p.x <= R.right(r) && p.y >= r.y && p.y <= R.bottom(r); },
  fmt(r) { return r ? `[${r2(r.x)},${r2(r.y)} ${r2(r.w)}×${r2(r.h)}]` : '—'; }
};

/* --------------------------------- 折线/线段 ------------------------------- */
const Seg = {
  len(pts) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return s;
  },
  /* 线段相交（含端点共线判定），返回交点或 null */
  cross(p1, p2, p3, p4) {
    const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d2x = p4.x - p3.x, d2y = p4.y - p3.y;
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-12) return null;          // 平行 / 共线：按不相交计
    const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
    const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / den;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    return { x: p1.x + t * d1x, y: p1.y + t * d1y, t, u };
  },
  /* 折线是否穿过矩形：只计算「进入」次数，端点贴边不计 */
  hitsRect(pts, rect, slack) {
    const rs = slack ? R.expand(rect, -slack) : rect;
    if (R.isEmpty(rs)) return 0;
    let n = 0;
    const inside = p => R.has(rs, p);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const aIn = inside(a), bIn = inside(b);
      if (aIn && bIn) { n++; continue; }             // 整段在框内
      if (aIn !== bIn) { n++; continue; }            // 跨越边界
      // 两端都在外：检查是否与矩形四边相交两次（穿过）
      const corners = [
        { x: rs.x, y: rs.y }, { x: R.right(rs), y: rs.y },
        { x: R.right(rs), y: R.bottom(rs) }, { x: rs.x, y: R.bottom(rs) }
      ];
      let cnt = 0;
      for (let k = 0; k < 4; k++) if (Seg.cross(a, b, corners[k], corners[(k + 1) % 4])) cnt++;
      if (cnt >= 2) n++;
    }
    return n;
  },
  simplifyOrtho(pts, eps) {
    const e = eps === undefined ? 0.5 : eps;
    const out = [];
    for (const p of pts) {
      const l = out[out.length - 1];
      if (l && Math.hypot(p.x - l.x, p.y - l.y) < e) continue;
      out.push({ x: r2(p.x), y: r2(p.y) });
    }
    /* 合并共线点 */
    const res = [];
    for (let i = 0; i < out.length; i++) {
      const a = res[res.length - 1], b = out[i], c = out[i + 1];
      if (a && c) {
        const collinear = (Math.abs(a.x - b.x) < e && Math.abs(b.x - c.x) < e) ||
                          (Math.abs(a.y - b.y) < e && Math.abs(b.y - c.y) < e);
        if (collinear) { res[res.length - 1] = c; continue; }
      }
      res.push(b);
    }
    return res;
  },
  toPathD(pts) {
    if (!pts || pts.length < 2) return '';
    return 'M' + pts.map(p => `${r2(p.x)} ${r2(p.y)}`).join(' L');
  }
};

/* ------------------------------ SVG 元素小工具 ----------------------------- */
function mkEl(tag) { return document.createElementNS(SVGNS, tag); }
function setA(el, name, value) { if (el) el.setAttribute(name, String(value)); }
function getA(el, name, dflt) {
  const v = el && el.getAttribute ? el.getAttribute(name) : null;
  return (v === null || v === '') ? dflt : v;
}
function numA(el, name, dflt) {
  const v = parseFloat(getA(el, name, dflt));
  return isFinite(v) ? v : dflt;
}
const tagOf = el => (el && el.tagName ? String(el.tagName).toLowerCase() : '');
function classOf(el) { return (el.getAttribute && el.getAttribute('class')) || ''; }
function hasClass(el, c) { return classOf(el).split(/\s+/).indexOf(c) >= 0; }
function textOf(el) {
  if (!el) return '';
  let s = '';
  for (const n of el.childNodes) {
    if (n.nodeType === 3) s += n.nodeValue;
    else if (tagOf(n) === 'tspan') s += textOf(n) + ' ';
  }
  return s.replace(/\s+/g, ' ').trim();
}
function cssPrio(el, prop) {
  try { return getComputedStyle(el).getPropertyValue(prop) || ''; } catch (e) { return ''; }
}

/* --------------------------- SHA-256（纯前端） ---------------------------
 * 用途单一但关键：给「内容是否被改动」提供可断言的判据。
 *   · 四视图叠加层是非侵入的 → 切视图前后 exportString() 的 sha256 必须一字不变
 *   · 编辑层每次改动后用它判断「这次操作到底有没有真的改到 DOM」，
 *     没变的操作不记进变更轨迹（避免噪声污染编辑台账）
 * 放在 util 里（而不是 ui.html 的内联脚本里）是因为 09_editor.js 也要用同一份实现。
 * ------------------------------------------------------------------------*/
const _shaCache = {};
function sha256Hex(str) {
  if (_shaCache[str] !== undefined) return _shaCache[str];
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const rr = (x, n) => (x >>> n) | (x << (32 - n));
  const bytes = []; const enc = new TextEncoder().encode(str);
  for (const b of enc) bytes.push(b);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push((bitLen / Math.pow(2, i * 8)) & 0xff);
  let H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const w = new Array(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (bytes[off+i*4] << 24) | (bytes[off+i*4+1] << 16) | (bytes[off+i*4+2] << 8) | bytes[off+i*4+3];
    for (let i = 16; i < 64; i++) {
      const s0 = rr(w[i-15], 7) ^ rr(w[i-15], 18) ^ (w[i-15] >>> 3);
      const s1 = rr(w[i-2], 17) ^ rr(w[i-2], 19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
    }
    let [a,b,c,d,e,f,g,h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rr(e,6) ^ rr(e,11) ^ rr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rr(a,2) ^ rr(a,13) ^ rr(a,22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H = [ (H[0]+a)|0, (H[1]+b)|0, (H[2]+c)|0, (H[3]+d)|0, (H[4]+e)|0, (H[5]+f)|0, (H[6]+g)|0, (H[7]+h)|0 ];
  }
  const out = H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  _shaCache[str] = out;
  return out;
}
