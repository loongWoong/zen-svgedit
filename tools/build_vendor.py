#!/usr/bin/env python3
"""可复现地生成 vendor/svgcanvas.min.js。

@svgedit/svgcanvas 只发布一个 ~1.4MB 的未压缩 ESM 包（dist/svgcanvas.js）。
本脚本把它经 esbuild 打成浏览器可直接 <script src> 的 IIFE 全局 `SVGCanvasLib`，
并打印体积与 sha256，便于回归比对。

用法:
    python tools/build_vendor.py            # 缺 dist 时自动 npm install
    python tools/build_vendor.py --force    # 强制重装依赖后重打

需要：node + npm（registry 指向 npmmirror 亦可）。
"""
import argparse
import hashlib
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VENDOR = os.path.join(ROOT, "vendor")
SCRATCH = os.path.join(ROOT, ".svgbuild")
PKG = "@svgedit/svgcanvas"
VER = "7.4.2"
ENTRY = "import SVGCanvas from '@svgedit/svgcanvas';\nexport default SVGCanvas;\n"


def run(cmd, cwd, check=True):
    p = subprocess.run(cmd, cwd=cwd, shell=(os.name == "nt"),
                       capture_output=True, text=True)
    if check and p.returncode != 0:
        raise SystemExit("命令失败: %s\n%s\n%s" % (cmd, p.stdout[-2000:], p.stderr[-2000:]))
    return p


def node_bin():
    """优先用托管 node，其次 PATH 上的 node。"""
    cands = [
        os.path.expanduser(r"~\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"),
        os.path.expanduser(r"~\.workbuddy\binaries\node\versions\22.22.2-3\bin\node"),
        shutil.which("node") or "node",
    ]
    for c in cands:
        if c and (os.path.exists(c) or c == "node"):
            return c
    raise SystemExit("未找到 node")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="强制重装依赖")
    args = ap.parse_args()

    os.makedirs(VENDOR, exist_ok=True)
    os.makedirs(SCRATCH, exist_ok=True)

    dist = os.path.join(SCRATCH, "node_modules", "@svgedit", "svgcanvas", "dist", "svgcanvas.js")
    if args.force or not os.path.exists(dist):
        print(f"[vendor] npm install {PKG}@{VER} esbuild …")
        if not os.path.exists(os.path.join(SCRATCH, "package.json")):
            run(["npm", "init", "-y"], SCRATCH)
        run(["npm", "install", f"{PKG}@{VER}", "esbuild", "--no-audit", "--no-fund"], SCRATCH)

    with open(os.path.join(SCRATCH, "entry.js"), "w", encoding="utf-8") as f:
        f.write(ENTRY)

    npx = os.path.join(SCRATCH, "node_modules", ".bin", "esbuild")
    if os.name == "nt":
        npx += ".cmd"
    if not os.path.exists(npx):
        npx = "esbuild"
    out = os.path.join(VENDOR, "svgcanvas.min.js")
    print("[vendor] esbuild --bundle --format=iife --minify …")
    run([npx, "entry.js", "--bundle", "--format=iife", "--global-name=SVGCanvasLib",
         "--minify", "--outfile=" + out, "--log-level=warning"], SCRATCH)

    raw = os.path.join(SCRATCH, "node_modules", "@svgedit", "svgcanvas", "dist", "svgcanvas.js")
    sz = os.path.getsize(out)
    with open(out, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()[:16]
    print(f"[vendor] {os.path.relpath(out, ROOT)}  {sz:,} B  ({sz/1048576:.2f} MiB)  sha256:{sha}…")
    print(f"[vendor] upstream 未压缩 ESM  {os.path.getsize(raw):,} B")
    print("[vendor] 注意：vendor/svgcanvas.LICENSE.txt 记录上游 MIT 许可与打包命令，发行时需一并保留。")


if __name__ == "__main__":
    main()
