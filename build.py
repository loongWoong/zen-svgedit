#!/usr/bin/env python3
"""把 ui.html 打成单文件自包含产品页 svgb_beautifier.html。

原理：读 ui.html，按其中 `<script src="...">` 的**出现顺序**逐个读入源文件、
断言其不含 `</script`（否则会提前闭合标签），再就地内联回 HTML。
因此"载入顺序"只有一处维护 —— ui.html 自己的 script 标签顺序，
构建脚本不需要再看另一份清单（旧版在 labs/build.py 里，那份已随子项目独立而删除）。

两条非显然的记账口径（都实测过，不是推测）：

1. **体积一律按 UTF-8 字节数报**。源码混有大量 CJK，`len(str)` 是**码点数**，
   与磁盘字节数差 1.2~1.4 倍（`src/09_editor.js`：57 099 码点 / 71 541 B）。
   早期版本把码点数标成 `B`，读起来"像"体积其实是错的 —— 现在两个数都打出来。
2. **行尾必须全仓 LF，脚本会对漂移报警**。`read()` 走 Python 通用换行，
   所以 CRLF 源（历史上 `src/06_geometry.js` 等 5 个文件）内联进产物后会被规范成 LF。
   仓库已用 `.gitattributes`（`* text=auto eol=lf`）把口径钉死；此后
   **磁盘字节数应当恒等于内联字节数**，一旦不等就说明有人引入了 CRLF，
   脚本会当场打出 `⚠ 磁盘 N B ≠ 内联 M B` 而不静默吞掉。

用法:
    python build.py            # 产出 svgb_beautifier.html
    python build.py --check    # 只校验（源是否齐全 / 是否残留外链），不写文件
    python build.py --verify   # 构建到内存，断言产物与磁盘上那份逐字节一致（可复现性）

依赖：仅标准库。本子项目的构建**不需要 node**。
"""
import argparse
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "ui.html")
OUT = os.path.join(HERE, "svgb_beautifier.html")
SCRIPT_RE = re.compile(r'<script src="([^"]+)"></script>')


def read(p):
    with open(p, "r", encoding="utf-8") as f:
        return f.read()


def write(p, s):
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(s)


def inline_js(src_text):
    """把 JS 内联进 <script> 标签。

    安全前提（已实测校验）：所有待内联文件里都不含 `</script`（大小写不敏感）。
    这里仍做一次断言，把假设变成会失败的检查而不是静默产出坏页面。
    """
    if re.search(r"</script", src_text, re.I):
        raise SystemExit("待内联的 JS 含 `</script`，不能安全内联")
    return "<script>\n" + src_text + "\n</script>"


def resolve(rel):
    """相对页面 URL 解析到磁盘路径（与本子项目内的目录结构一一对应）。"""
    if rel.startswith("src/"):
        return os.path.join(HERE, rel)
    return os.path.normpath(os.path.join(HERE, rel))


def collect():
    page = read(PAGE)
    parts = []
    for rel in SCRIPT_RE.findall(page):
        p = resolve(rel)
        if not os.path.exists(p):
            raise SystemExit("内联源缺失: %s → %s" % (rel, p))
        js = read(p)
        # (相对路径, 内容, 码点数, UTF-8 字节数, 磁盘路径, 磁盘字节数)
        parts.append((rel, js, len(js), len(js.encode("utf-8")), p, os.path.getsize(p)))
    if not parts:
        raise SystemExit("ui.html 里没有找到任何 <script src>，构建无意义")
    return page, parts


def build():
    page, parts = collect()
    total_chars = sum(c for _r, _j, c, _b, _p, _d in parts)
    total_bytes = sum(b for _r, _j, _c, b, _p, _d in parts)

    html = page
    for rel, js, _c, _b, _p, _d in parts:
        html = html.replace('<script src="%s"></script>' % rel, inline_js(js))
    if SCRIPT_RE.search(html):
        left = SCRIPT_RE.findall(html)
        raise SystemExit("仍有未内联的 <script src>: %s" % left)

    # imgPath 钩子：源码与产物的默认值都是 'vendor'（两者同在 svgedit/ 下），
    # 这里注入只是为了「产物被搬到别处分发时」能在构建期覆盖而不必回改源码。
    anchor = "<script>\n/* =============================================================================\n * 产品页控制器"
    if anchor in html:
        html = html.replace(anchor,
            "<script>window.__SVGB_IMGPATH = 'vendor';</script>\n" + anchor, 1)
    else:
        html = html.replace("<script>",
            "<script>window.__SVGB_IMGPATH = 'vendor';</script>\n<script>", 1)
    if "__SVGB_IMGPATH" not in html:
        raise SystemExit("imgPath 注入失败：ui.html 的结构变了，请更新 build.py 的锚点")

    banner = ("<!-- 由 svgedit/build.py 生成，请勿手改（改动请落到 ui.html / src/*.js 后重新构建）\n"
              "     源: ui.html + %d 段脚本（含 vendor/svgcanvas.min.js）\n"
              "     构建: %s -->\n" % (len(parts), time.strftime("%Y-%m-%d %H:%M:%S")))
    html = banner + html

    return html, total_chars, total_bytes, parts


def report_parts(parts):
    for rel, _j, c, b, _p, d in parts:
        # 判据：磁盘字节数 vs 内联字节数。仓库口径是 LF，两者应恒等；
        # 不等即代表该文件带了 CRLF（read() 已把它规范化掉了）。
        note = "" if b == d else "   ⚠ 磁盘 %d B ≠ 内联 %d B（该文件含 CRLF，已规范化）" % (d, b)
        print("      · %-34s %8d 字 %8d B%s" % (rel, c, b, note))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只校验，不写文件")
    ap.add_argument("--verify", action="store_true",
                    help="构建到内存并与磁盘产物逐字节比对（不含 banner 时间戳）")
    args = ap.parse_args()

    html, total_chars, total_bytes, parts = build()

    if args.check:
        print("  OK  源齐全，%d 段，内联 JS %d 字 / %d B"
              % (len(parts), total_chars, total_bytes))
        report_parts(parts)
        return

    if args.verify:
        if not os.path.exists(OUT):
            raise SystemExit("--verify 需要已存在的产物：%s" % OUT)
        cur = read(OUT)
        # banner 里带构建时间戳，比对时把它剥掉（否则每次必然不同）
        strip = lambda s: s.split("-->\n", 1)[1] if s.startswith("<!-- 由 svgedit/build.py") else s
        same = strip(cur) == strip(html)
        print("  %s  产物可复现（剥离 banner 时间戳后逐字节一致）" % ("OK " if same else "FAIL"))
        if not same:
            a, b = strip(cur), strip(html)
            print("      磁盘 %d 字 / 内存 %d 字，首个差异 @%d"
                  % (len(a), len(b), next((i for i, (x, y) in enumerate(zip(a, b)) if x != y),
                                          min(len(a), len(b)))))
            raise SystemExit(1)
        return

    write(OUT, html)
    print("  %-26s %5d 行 %9d B   (内联 JS %d 字 / %d B / %d 段)"
          % (os.path.basename(OUT), len(html.splitlines()), os.path.getsize(OUT),
             total_chars, total_bytes, len(parts)))
    report_parts(parts)


if __name__ == "__main__":
    main()
