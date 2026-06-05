# 自定义主题

Kimi Code CLI 内置了 `dark`、`light` 和 `auto`（跟随终端背景自动选择明暗）三种配色。除此之外，你还可以用一个 JSON 文件定义自己的配色——把它放进主题目录，就能在 `/theme` 里像内置主题一样选用。

## 创建一个主题

在主题目录下新建一个 `.json` 文件即可。主题目录是：

- `~/.kimi-code/themes/`
- 如果设置了 `KIMI_CODE_HOME` 环境变量，则是 `$KIMI_CODE_HOME/themes/`

目录不存在就自己建一个。**文件名就是主题名**：`ember.json` 会在 `/theme` 里显示为 `Custom: ember`。

一个最小的主题只需要写你想改的颜色，其余自动沿用 `dark`：

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
- `colors`（可选）：要覆盖的颜色 token，值是 6 位十六进制色值（如 `#FE8019`）。

> 提示：复制一份下面这样的完整示例来改，是最快的起点。

## 颜色 token 一览

`colors` 里可以设置下面这些 token。每个都标注了它实际控制 UI 的哪些地方，方便你预判改了会影响什么：

| Token | 控制什么 |
| --- | --- |
| `primary` | 最常用色。链接、行内代码、几乎所有对话框的选中项、编辑器聚焦边框、plan/运行中徽章、spinner |
| `accent` | 次级强调。审批 `▶` 前缀、设备码框、图片占位、BTW/队列面板、注册表导入 |
| `text` | 正文。对话框正文、todo 标题、footer 模型名、Markdown 标题、助手/工具消息子弹头、列表符号 |
| `textStrong` | 加粗强调文字。输入类对话框、状态消息 |
| `textDim` | 次级、变暗文字（用得最广）。思考、提示、描述、已完成 todo、Markdown 引用、footer 状态栏（cwd、git 徽章） |
| `textMuted` | 最浅文字。计数、滚动信息、描述、Markdown 链接 URL、代码块边框 |
| `border` | 边框。面板与编辑器的普通边框、Markdown 分隔线 |
| `borderFocus` | 聚焦/注意边框（目前仅审批面板使用） |
| `success` | 成功态。`✓`、已启用、完成 |
| `warning` | 警告态。auto/yolo 徽章、过期标记、plan 模式提示 |
| `error` | 错误态。错误信息、失败的工具输出 |
| `diffAdded` | diff 新增行 |
| `diffRemoved` | diff 删除行 |
| `diffAddedStrong` | diff 行内改动的新增词（加粗高亮） |
| `diffRemovedStrong` | diff 行内改动的删除词（加粗高亮） |
| `diffGutter` | diff 行号槽 |
| `diffMeta` | diff 元信息 / hunk 头 |
| `roleUser` | 用户消息的子弹头与文字、技能激活名 |

没有写到的 token 会自动回退到 `dark` 的对应值，所以你完全可以只覆盖一部分：

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

- **某个色值不合法**（不是 `#` 加 6 位十六进制）：跳过这一项并打印一条警告，其余颜色照常生效。
- **写了无法识别的 token**：忽略，不影响其它颜色。
- **文件不存在或 JSON 损坏**：静默回退到 `dark`。

## 编辑正在使用的主题

如果你修改的是**当前正在生效**的那个主题文件，改动不会自动重新加载。让新颜色生效有两种办法：

- 运行 `/reload-tui`——它会重新读取 `tui.toml` 并重新应用当前主题（包括重新读取主题文件）；
- 或者在 `/theme` 里先切到另一个主题，再切回来。

::: warning 注意
在 `/theme` 里**重新选中同一个主题**不会触发重载（只会提示 “Theme unchanged”）。要重载已激活主题的改动，用上面两种办法之一。
:::
