#!/usr/bin/env python3
"""给 Markdown 列表项之间加空行（学习文档系列格式约定：相邻列表项不挤在一起）。

规则：
- 相邻两行都是列表项（`- ` 或 `1. ` 开头）→ 中间插一个空行；
- 代码围栏（``` 包起来）内的行一律不动；
- 表格行（| 开头）和"加粗标题＋段落"式（**1. …** 开头）不匹配，天然不受影响；
- 可重复跑：已加过空行的列表项不再相邻，第二次跑插入数为 0。

用法：
    python3 列表项间加空行.py                    # 默认刷 源码详解/ 下六篇
    python3 列表项间加空行.py a.md b.md          # 指定文件
"""

import re
import sys
from pathlib import Path

LIST_ITEM = re.compile(r"^(- |\d+\. )")  # 列表项行：- 或 1. 开头
FENCE = "```"                             # 代码围栏标记

DEFAULT_FILES = [
    "源码详解/01-webview与Bridge通信.md",
    "源码详解/02-BridgeHandler方法详解.md",
    "源码详解/03-KimiRuntime方法详解.md",
    "源码详解/04-BaselineManager方法详解.md",
    "源码详解/05-SessionRuntime方法详解.md",
    "源码详解/dive-chain-broadcast链条详解.md",
]


def spread_list_items(text: str) -> tuple[str, int]:
    """在相邻列表项之间插入空行，返回 (新文本, 插入数)。"""
    lines = text.split("\n")
    out = []
    inserted = 0
    in_code = False  # 是否在代码围栏内

    for i, line in enumerate(lines):
        if line.startswith(FENCE):
            in_code = not in_code
        out.append(line)

        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        # 当前是列表项、下一行也是列表项、且两者都不在围栏内 → 插空行
        # （下一行若是围栏开头，说明当前项后面紧跟代码块，也不插）
        if (
            not in_code
            and LIST_ITEM.match(line)
            and LIST_ITEM.match(nxt)
            and not nxt.startswith(FENCE)
        ):
            out.append("")
            inserted += 1

    return "\n".join(out), inserted


def main() -> None:
    args = sys.argv[1:]
    files = args if args else DEFAULT_FILES
    root = Path(__file__).parent

    for name in files:
        path = Path(name) if Path(name).is_absolute() else root / name
        text = path.read_text(encoding="utf-8")
        new_text, inserted = spread_list_items(text)
        if inserted:
            path.write_text(new_text, encoding="utf-8")
        print(f"{path.name}: 插入 {inserted} 个空行")


if __name__ == "__main__":
    main()
