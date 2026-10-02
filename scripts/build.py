"""Builds dist/ from src/nitori.js with no Node toolchain.

- dist/nitori.mjs      the ESM file as is
- dist/nitori.umd.js   the same source without `export`, wrapped in UMD (window.Nitori)
"""
import re
from pathlib import Path

root = Path(__file__).resolve().parent.parent
src = (root / "src" / "nitori.js").read_text(encoding="utf-8")
dist = root / "dist"
dist.mkdir(exist_ok=True)

(dist / "nitori.mjs").write_text(src, encoding="utf-8", newline="\n")

names = re.findall(r"^export (?:class|function|const) (\w+)", src, flags=re.M)
body = re.sub(r"^export ", "", src, flags=re.M)
umd = (
    "(function (root, factory) {\n"
    "  if (typeof define === 'function' && define.amd) define([], factory);\n"
    "  else if (typeof module === 'object' && module.exports) module.exports = factory();\n"
    "  else root.Nitori = factory();\n"
    "}(typeof self !== 'undefined' ? self : this, function () {\n"
    "'use strict';\n"
    + body
    + "\nreturn { " + ", ".join(names) + " };\n"
    "}));\n"
)
(dist / "nitori.umd.js").write_text(umd, encoding="utf-8", newline="\n")
print("dist ok:", ", ".join(names))
