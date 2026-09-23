"""把真实产出 SVG 内联为 src/11_realsvgs.js 里的 REAL_SVGS。

为什么内联而不是 fetch：产品页要能在 file:// 下直接双击打开（无服务端），
fetch 本地文件会被 CORS 拦掉；内联后 10_samples.js#buildSampleTable 能直接把
它们当「干净回归件」纳入样例表。

输入都取自**本子项目内部**（`svg/` 与 `assets/`），因此产物可复现、且不依赖仓库外部路径。
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent          # → svgedit/
SOURCES = [
    (ROOT / "svg", "真实目标图"),
    (ROOT / "assets", "报告配图"),
]
OUT = ROOT / "src" / "11_realsvgs.js"

items = []
for d, label in SOURCES:
    if not d.is_dir():
        print(f"[skip] {d} 不存在")
        continue
    for p in sorted(d.glob("*.svg")):
        txt = p.read_text(encoding="utf-8")
        items.append({
            "id": f"real-{p.stem}",
            "name": f"{p.stem} · {label}",
            "file": str(p.relative_to(ROOT)).replace("\\", "/"),
            "bytes": len(txt.encode("utf-8")),
            "svg": txt,
        })

lines = [
    "/* =============================================================================",
    " * SVG Beautifier · 11 真实产出图（由 tests/gen_realsvgs.py 生成，勿手改）",
    " *",
    " * 这些是真实的 AI 生成技术图（1920x1080 / 带 <style> 类），作为「不得越改越丑」",
    " * 的回归件进入 buildSampleTable()。它们被声明为干净件（expectClean），",
    " * 因此任何美化都必须保持其 100 分不被拉低 —— 这是产品可交付性的硬底线。",
    " *",
    f" * 共 {len(items)} 件，合计 {sum(i['bytes'] for i in items)} 字节。",
    " * ===========================================================================*/",
    "'use strict';",
    "",
    "const REAL_SVGS = [",
]
for it in items:
    lines.append("  {")
    lines.append(f"    id: {json.dumps(it['id'], ensure_ascii=False)},")
    lines.append(f"    name: {json.dumps(it['name'], ensure_ascii=False)},")
    lines.append(f"    file: {json.dumps(it['file'], ensure_ascii=False)},")
    lines.append(f"    bytes: {it['bytes']},")
    lines.append(f"    svg: {json.dumps(it['svg'], ensure_ascii=False)}")
    lines.append("  },")
lines.append("];")
lines.append("")

OUT.write_text("\n".join(lines), encoding="utf-8")
print(f"[ok] {OUT}  件数={len(items)}  合计={sum(i['bytes'] for i in items)}B")
for it in items:
    print(f"   - {it['id']:38s} {it['bytes']:>7d}B  {it['file']}")
