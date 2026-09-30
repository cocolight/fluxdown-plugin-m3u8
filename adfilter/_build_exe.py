#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""_build_exe.py —— 用 Nuitka 把 m3u8_adclean_server.py 编译为 Windows 可执行文件。

本地构建工具，不入库（本仓库 .gitignore 忽略 `_build*.py`）。

前置：
  - Python 3.9+（本项目用 3.13）
  - Nuitka：   pip install nuitka
  - C 编译器，按机器实际情况选择（见 --compiler）：
      msvc   ：Visual Studio 的「使用 C++ 的桌面开发」工作负载 + Windows SDK
      zig    ：无需预装，Nuitka 自动下载 Zig 并编译（**Python 3.13 上的推荐路线**）
      mingw64：Nuitka 自动下载 MinGW64，但**仅支持 Python 3.12 及以下**

用法：
  python _build_exe.py                 # 默认 auto：先试 MSVC，不可用则自动回退 zig
  python _build_exe.py --compiler zig  # 直接指定编译器后端
  python _build_exe.py --standalone    # 目录版：启动更快、杀软误报更少
  python _build_exe.py --keep          # 保留中间产物，不清理（排查编译错误用）

产物：dist/m3u8_adclean_server.exe

分发：把 dist/ 下的 exe 与 ad_patterns.txt 放同一目录即可（规则文件缺失时
      exe 会按内置模板自动生成一份）。
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "m3u8_adclean_server.py")
OUTDIR = os.path.join(HERE, "dist")
NAME = "m3u8_adclean_server"

# 与仓库发版号保持一致，便于「插件包 ↔ 清洗服务」对应交付
FILE_VERSION = "1.2.0"
AUTHOR = "cocolight"

# 各编译器后端对应的 Nuitka 参数
COMPILER_FLAGS = {
    "msvc": [],
    "zig": ["--zig"],
    "mingw64": ["--mingw64"],
}
# Nuitka 找不到编译器时的报错特征串，用于 auto 模式判断是否回退
NO_COMPILER_MARK = "cannot locate suitable C compiler"
BUILD_ARTIFACTS = ("*.build", "*.dist", "*.onefile-build", "*.dist.tmp")


def build_cmd(args, compiler):
    cmd = [
        args.python, "-m", "nuitka",
        "--assume-yes-for-downloads",
        "--output-dir=" + OUTDIR,
        "--output-filename=" + NAME + ".exe",
        "--windows-console-mode=force",        # 双击时可看到日志输出
        "--company-name=" + AUTHOR,
        "--product-name=m3u8_adclean",
        "--file-description=FluxDown m3u8 ad-clean local service",
        "--file-version=" + FILE_VERSION,
        "--product-version=" + FILE_VERSION,
        "--copyright=MIT (c) 2026 " + AUTHOR,
        # 明确排除本程序用不到的重量级标准库，缩小体积
        "--nofollow-import-to=tkinter,unittest,doctest,test",
        "--standalone" if args.standalone else "--onefile",
    ]
    cmd += COMPILER_FLAGS[compiler]
    cmd.append(SCRIPT)
    return cmd


def run_build(cmd):
    """执行 Nuitka，实时回显同时收集输出，返回 (返回码, 全部输出)。"""
    print("\n>>>", " ".join(cmd), flush=True)
    proc = subprocess.Popen(
        cmd, cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    lines = []
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        lines.append(line)
    proc.wait()
    return proc.returncode, "".join(lines)


def clean_build_dirs():
    """清掉中间产物。

    注意：这里不用 Nuitka 自带的 --remove-output —— 在 Windows 上它偶尔会因
    文件被占用/只读而抛 WinError 5。先去掉只读属性再删，稳妥。
    """
    for pat in BUILD_ARTIFACTS:
        for p in glob.glob(os.path.join(OUTDIR, pat)):
            for root, dirs, files in os.walk(p):
                for name in files:
                    try:
                        os.chmod(os.path.join(root, name), 0o666)
                    except OSError:
                        pass
            shutil.rmtree(p, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description="Nuitka 编译 m3u8_adclean_server")
    ap.add_argument("--standalone", action="store_true",
                    help="编译为独立目录（--standalone）而非单文件（--onefile）")
    ap.add_argument("--compiler", choices=["auto", "msvc", "zig", "mingw64"],
                    default="auto",
                    help="C 编译器后端；auto=先试 MSVC，不可用则自动回退 zig")
    ap.add_argument("--keep", action="store_true",
                    help="保留中间产物（排查编译错误用），默认编译成功后清理")
    ap.add_argument("--python", default=sys.executable, help="用于构建的 Python 解释器")
    args = ap.parse_args()

    if not os.path.isfile(SCRIPT):
        print("找不到源文件：", SCRIPT, file=sys.stderr)
        return 2

    # 每次编译前先清残留：上次中断的 build 目录会让 Nuitka 删除失败而崩掉
    clean_build_dirs()

    order = [args.compiler] if args.compiler != "auto" else ["msvc", "zig"]
    ok = False
    for idx, compiler in enumerate(order):
        rc, out = run_build(build_cmd(args, compiler))
        if rc == 0:
            ok = True
            break
        more = idx < len(order) - 1
        if more and NO_COMPILER_MARK in out:
            print(f"\n[build] {compiler} 后端不可用（未找到可用 C 编译器），"
                  f"自动改用 {order[idx + 1]} 重试 ...", flush=True)
            clean_build_dirs()
            continue
        print(f"\n构建失败（后端 {compiler}），Nuitka 退出码：{rc}", file=sys.stderr)
        return rc

    if not ok:
        return 1

    exe = os.path.join(OUTDIR, NAME + ".exe")
    if not os.path.isfile(exe):
        print("构建结束但未找到产物：", exe, file=sys.stderr)
        return 3

    size = os.path.getsize(exe)
    print("\n产物：%s  (%d bytes = %.1f MB)" % (exe, size, size / 1048576))

    # 顺手把规则文件放到产物旁，方便整目录分发（已存在则不覆盖用户改动）
    dst_rules = os.path.join(OUTDIR, "ad_patterns.txt")
    src_rules = os.path.join(HERE, "ad_patterns.txt")
    if os.path.isfile(src_rules) and not os.path.isfile(dst_rules):
        shutil.copyfile(src_rules, dst_rules)
        print("附带规则文件：", dst_rules)

    # 清理中间产物放最后，且失败不影响「编译已成功」的结论
    if not args.keep:
        try:
            clean_build_dirs()
        except Exception as e:
            print("提示：中间产物未能自动清理（可手动删除 dist\\*.build、dist\\*.onefile-build）：",
                  e, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
