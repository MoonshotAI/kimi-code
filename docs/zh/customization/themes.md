# 自定义主题

Kimi Code CLI 可以使用内置配色，也可以使用自定义 JSON 主题文件。自定义文件放在主题目录下，会和内置选项一起出现在 `/theme` 里。

## 内置颜色 token

自定义主题可以覆盖下面这些 token。`dark` 和 `light` 两列展示内置值；`auto` 会在启动时解析为其中一个调色板，如果无法检测终端背景，则回退到 `dark`。

| Token | `dark` | `light` | 控制什么 |
| --- | --- | --- | --- |
| `primary` | `#4FA8FF` | `#1565C0` | 最常用色。链接、行内代码、几乎所有对话框的选中项、编辑器聚焦边框、Plan/运行中徽章、spinner |
| `accent` | `#5BC0BE` | `#00838F` | 次级强调。审批 `▶` 前缀、设备码框、图片占位、BTW/队列面板、注册表导入 |
| `text` | `#E0E0E0` | `#1A1A1A` | 正文。对话框正文、todo 标题、footer 模型名、Markdown 标题、助手/工具消息子弹头、列表符号 |
| `textStrong` | `#F5F5F5` | `#1A1A1A` | 加粗强调文字。输入类对话框、状态消息 |
| `textDim` | `#888888` | `#454545` | 次级、变暗文字。思考、提示、描述、已完成 todo、Markdown 引用、footer 状态栏 |
| `textMuted` | `#6B6B6B` | `#5F5F5F` | 最浅文字。计数、滚动信息、描述、Markdown 链接 URL、代码块边框 |
| `border` | `#5A5A5A` | `#737373` | 面板与编辑器的普通边框、Markdown 分隔线 |
| `borderFocus` | `#E8A838` | `#92660A` | 聚焦/注意边框，目前仅审批面板使用 |
| `success` | `#4EC87E` | `#0E7A38` | 成功态。`✓`、已启用、完成 |
| `warning` | `#E8A838` | `#92660A` | 警告态。auto/yolo 徽章、过期标记、Plan 模式提示 |
| `error` | `#E85454` | `#B91C1C` | 错误态。错误信息、失败的工具输出 |
| `diffAdded` | `#4EC87E` | `#0E7A38` | diff 新增行 |
| `diffRemoved` | `#E85454` | `#B91C1C` | diff 删除行 |
| `diffAddedStrong` | `#7AD99B` | `#0E7A38` | diff 行内改动的新增词（加粗高亮） |
| `diffRemovedStrong` | `#F08585` | `#B91C1C` | diff 行内改动的删除词（加粗高亮） |
| `diffGutter` | `#6B6B6B` | `#737373` | diff 行号槽 |
| `diffMeta` | `#888888` | `#5F5F5F` | diff 元信息 / hunk 头 |
| `roleUser` | `#FFCB6B` | `#9A4A00` | 用户消息的子弹头与文字、技能激活名 |
| `shellMode` | `#BD93F9` | `#7C3AED` | Shell 模式（`!`）的提示符、编辑器边框，以及回显的 `$ 命令` 行 |

## 使用 custom-theme skill

你不需要手写 JSON。运行内置 `/custom-theme [附加文本]` skill 命令进入自定义主题流程；这个 skill 可以帮你选颜色，把文件写到 `~/.kimi-code/themes/`，校验十六进制色值，并告诉你如何应用。

调用示例：

- `/custom-theme Create a warm dark theme with amber accents.`
- `/custom-theme Make a light theme based on Solarized, but keep errors easy to see.`
- `/custom-theme Tweak my ember theme so diffs have higher contrast.`

激活后，skill 通常会先问你想用浅色还是深色基准、偏好的风格或调色板，以及是否有必须包含的精确颜色。如果你用它编辑已有主题，请确保它先读取并备份文件，再覆盖写入。

## 创建一个主题

在主题目录下新建一个 `.json` 文件即可。主题目录是：

- `~/.kimi-code/themes/`
- 如果设置了 `KIMI_CODE_HOME` 环境变量，则是 `$KIMI_CODE_HOME/themes/`

目录不存在就自己建一个。**文件名就是主题名**：`ember.json` 会在 `/theme` 里显示为 `Custom: ember`。

一个最小的主题只需要写你想改的颜色，其余自动沿用**基准调色板**（默认是 `dark`）：

```json
{
  "name": "ember",
  "colors": {
    "primary": "#83A598",
    "accent": "#FE8019"
  }
}
```

字段说明：

- `name`（必填）：主题的标识名。
- `displayName`（可选）：人类可读的名字。
- `base`（可选）：未指定的 token 沿用哪个内置调色板——`"dark"`（默认）或 `"light"`。做**浅色**主题时设为 `"base": "light"`，这样你没写的 token 在浅色背景上仍然可读（否则会回退到 dark 调色板）。
- `colors`（可选）：要覆盖的颜色 token，值是 6 位十六进制色值（如 `#FE8019`）。

使用 [内置颜色 token](#内置颜色-token) 里的 token 名。没有写到的 token 会自动回退到所选基准调色板的对应值，所以你完全可以只覆盖一部分：

```json
{
  "name": "just-blue",
  "colors": {
    "primary": "#3B82F6",
    "roleUser": "#3B82F6"
  }
}
```

## 选用主题

两种方式：

1. **`/theme` 命令**（推荐）：打开主题选择器，自定义主题会以 `Custom: <文件名>` 出现。选择器**每次打开都会重新扫描主题目录**，所以你新加的主题文件**无需重启**就能看到。
2. **`tui.toml`**：把 `theme` 设成你的主题名：

   ```toml
   # ~/.kimi-code/tui.toml
   theme = "ember"
   ```

## 出错时会怎样

自定义主题的设计原则是"尽量别打断你"：

- **某个色值不合法**（不是 `#` 加 6 位十六进制）：静默跳过这一项，并回退到所选基准调色板，其余颜色照常生效。
- **写了无法识别的 token**：忽略，不影响其它颜色。
- **自定义主题文件不存在或 JSON 损坏**：静默回退到内置 `dark` 调色板，不会再尝试 `auto`。

## 编辑正在使用的主题

如果你修改的是**当前正在生效**的那个主题文件，改动不会自动重新加载。让新颜色生效有两种办法：

- 运行 `/reload-tui`——它会重新读取 `tui.toml` 并重新应用当前主题（包括重新读取主题文件）；
- 或者在 `/theme` 里先切到另一个主题，再切回来。

::: warning 注意
在 `/theme` 里**重新选中同一个主题**不会触发重载（只会提示 “Theme unchanged”）。要重载已激活主题的改动，用上面两种办法之一。
:::
