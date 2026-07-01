# 接手文档：kimi-web 聊天表格宽度

> **当前状态（未提交，用户先用着）**：表格在阅读列（≈760px）内**单元格换行**显示——
> 不横向滚动、不溢出、不裁切，但**没有比正文更宽**。这是目前效果最干净、可以先用的版本。
>
> **仍未达成的目标**：让宽表格像 Manus 那样**突破到比正文更宽的列**再换行。两次突破尝试
> （容器单位 `cqw`、固定 px `@container` 断点）都没做出满意效果，已回退/停用，见 §4、§6。
>
> **只改了 1 个文件**：`apps/kimi-web/src/components/chat/Markdown.vue`（表格样式块）。
> typecheck / check:style 通过。

## 1. 背景与目标

`apps/kimi-web` 聊天里 markstream 渲染的 markdown 表格，默认被钉在阅读列宽内
（`width:100%` + `table-layout:fixed`），宽表格要么被挤成很窄的列、要么表格内横向滚动。

用户想要的最终效果（参照 Manus 截图）：

1. 表格**比正文阅读列更宽**（横向铺开），但
2. 单元格**换行**，所以表格**永不横向滚动**（表格自身和对话面板都不滚），且
3. 正文 / 代码 / diff / 工具块 / thinking 等其它块仍限在 760px 阅读列内。

> 第 1 点（撑得比正文宽）目前**没做到**——见 §6。当前上线的是"列内换行"的降级版。

## 2. 当前实现（列内换行版，正在用）

`Markdown.vue` `<style scoped>` 表格块：

```css
.md :deep(.table-node) {              /* <table>：列宽按内容、可换行 */
  width: auto !important;
  max-width: 100% !important;
  table-layout: auto !important;
}
/* 表格在阅读列内换行；装不下（不可断的长内容）才滚动兜底 */
.md :deep(.table-node-wrapper) {
  width: max-content;
  max-width: 100% !important;         /* 100% = 阅读列宽，封顶 → 换行 */
  overflow-x: auto !important;
}
.md :deep(.table-node th),
.md :deep(.table-node td) {
  text-align: left;
  vertical-align: top;
}
```

要点：
- **换行靠的是"去掉旧代码的 `white-space:nowrap`"**。markstream 单元格默认就是
  `white-space:normal`（见 `node_modules/markstream-vue/dist/index.px.css`），旧代码特意加
  `nowrap !important` 才不换行；现在不设 white-space，就回到 markstream 默认的换行。
- `max-content` + `max-width:100%`：列宽按内容撑，但整体不超过阅读列 → 到列宽就换行。
- `.a-msg` 保持 HEAD 的 `width:94%`；`.content-wrap` 保持 `max-width:760px`，都没动。

## 3. DOM / CSS 结构与关键约束

```
.con (container-type:inline-size; position:relative)            ← 不裁剪；@container 的查询根
 └ .chat-layout
    └ .panes.chat-scroll { overflow-y:auto }                    ← 决定性裁剪点
       └ .content-wrap { max-width:760px; margin:auto }         ← 居中阅读列（桌面恒 align-center）
          └ .chat (flex column; padding:16px 14px)
             └ .a-msg (width:94%; align-self:flex-start)        ← 左对齐
                ├ .msg → Markdown(.md) → .markdown-renderer
                │     └ .node-slot   { width:100% }             ← markstream，不裁剪
                │       └ .node-content { width:100% }          ← markstream，不裁剪
                │         └ .table-node-wrapper                 ← 表格（突破点，若要撑宽）
                │           └ table.table-node
                └ .think / .tool-group / .tool / .a-msg-ft
```

**两条硬约束（踩过的坑）：**

1. **`.panes` 是裁剪点。** 它有 `overflow-y:auto`，按 CSS 规则另一方向的 `visible` 会被强制算成
   `auto`，所以 `.panes` 实际两个方向都裁剪。表格若比面板宽，`.panes` 就会横向滚动
   （macOS 悬浮滚动条静止时看不见，容易误以为是"被裁掉"）。后代无法靠 CSS 逃出它
   （`position:fixed` 除外，但脱流、不随消息滚动，不可用）。
2. **`.node-content` / `.node-slot` 不裁剪**（只有 `width:100%`，无 overflow），所以更宽的表格
   wrapper 能正常"顶出"它们向右显示——如果 wrapper 宽度真的生效的话（见 §4 两次失败）。

markstream 的 `.table-node-wrapper` 原始样式：
`{ position:relative; max-width:100%; overflow-x:auto; ... }`，所以覆盖它的 `max-width` / `overflow-x`
需要 `!important`。

## 4. 撑宽尝试为什么失败（避免重复试错）

目标是"表格突破 760 列、显示得比正文宽、再换行"。试过两种给 wrapper 更大宽度的写法，都不行：

1. **容器单位 `cqw`**：`max-width: calc((100cqw + 760px)/2 - 48px)`。
   `cqw`（容器宽度单位）在本仓库**别处从没用过**，实测**没生效**——`max-width` 没卡住，
   `width:max-content` 就一路撑到不换行的完整宽度、溢出面板（`.panes` 横滚）。
   （注意：更早还踩过 `(100cqw+760)/2` 里 `760` 不带单位 → `长度+纯数字` 非法 → 整条声明被丢弃，
   但即便修正带单位，`cqw` 依旧没做出效果。）
2. **固定 px `@container (min-width)` 断点**：`@container (min-width:960px){ ... max-width:800px }`
   等按面板宽分档给固定上限。容器查询本身在本仓库可靠（Sidebar 等在用），语法也过了 lint，
   但实际视觉效果用户仍不满意（表格没有明显变宽 / 或档位不合适），已撤掉。

> 结论：单纯改 `.table-node-wrapper` 的 `max-width` 这条路，没能稳定做出"比正文宽且换行填满"的效果。
> 下次重做建议换思路（见 §6）。

## 5. 涉及文件

| 文件 | 关键位置 |
|---|---|
| `apps/kimi-web/src/components/chat/Markdown.vue` | `<style scoped>` 内 `.table-node` / `.table-node-wrapper` / 单元格块（**本任务唯一改动**） |
| `apps/kimi-web/src/components/chat/ConversationPane.vue` | `.con { container-type:inline-size; --read-max:760px }`、`.content-wrap`、`.panes`（裁剪源）——**未改** |
| `apps/kimi-web/src/components/chat/ChatPane.vue` | `.a-msg { width:94% }`——**未改**（本任务） |

## 6. 若要重做"撑得比正文宽"

难点：让表格 wrapper 拿到一个"比 760 列宽、但不超过面板"的宽度，且这个宽度要**真的生效**并触发换行。
几个可试方向（按推荐度）：

| 方向 | 说明 | 风险 |
|---|---|---|
| A. 撑开 `.a-msg` + 让表格 `max-content` | `.a-msg` 改 `width:fit-content; min-width:100%`，其余直接子元素限 760px；表格 `max-content` 顶宽。曾实现过，问题是超面板时 `.panes` 横滚、且正文与宽表格同屏排版怪。 | 中：需解决"超面板横滚"和排版 |
| B. JS 量面板宽写进 CSS 变量 | `ResizeObserver` 量 `.con` 宽度，写 `--pane-w`，表格 `max-width: calc((var(--pane-w)+760px)/2 - …)`。绕开 `cqw` 不生效的问题。 | 中：引入 JS，但最可控 |
| C. Teleport 到 `.panes` 外 | 宽表格用 Vue Teleport 渲到滚动容器外、JS 定位覆盖到消息处。 | 高：定位+滚动同步脆；且表格是 markstream 第三方 DOM，流式重渲染会打架 |
| D. 页面级滚动重构 | 去掉 `.panes` 内滚动，整页纵向滚。 | 高：要重写滚动到底/加载更多/新消息提示等 |

**重做第一步**：先在浏览器量清楚——用户常见宽表格的自然宽度、以及侧栏展开/收起时
`.con`（面板）实际多宽。若表格自然宽度基本 ≤ 面板宽，方向 A/B 就够；否则必然要在
"表格内滚动 / 面板滚动 / 换行压缩"三者里选一个让步（§3 硬约束决定纯 CSS 无法三者全免）。

## 7. 验证

```bash
export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
pnpm --filter kimi-web typecheck    # 通过
pnpm --filter kimi-web check:style  # baseline，本文件无新增告警
```

浏览器肉眼（本环境不能渲染）：
- 让 agent 输出一个多列宽表格。
- 当前版本预期：表格在阅读列内**换行**显示，不横向滚动、不溢出；但**不会比正文宽**。
- macOS 是悬浮滚动条，判断"有没有横滚"别只看静止截图，拖一下或缩小窗口确认。

## 8. 与本任务无关的未提交改动（不要误改 / 误回退）

`git diff` 里还有这些**非本任务**的改动：

- `ConversationPane.vue`：平滑滚动守卫（`smoothScrollUntil` / `handleEditMessage` / `scrollToBottom` 调整）。
- `ChatPane.vue`：`.u-copy` 的 `justify-content:center` + `.u-copy svg` 的 `translateY(1.3px)`。
- `apps/kimi-web/src/i18n/…`、`lib/desktopFlag.ts`、`components/chat/ConversationToc.vue` 等仓库里早已存在的杂项。

## 9. 收尾

表格改动只在 `Markdown.vue` 一个文件。若就用当前"列内换行"版收尾，按 `gen-changesets` 技能
生成 changeset（scope: web，描述：markdown 表格单元格换行、避免被挤成窄列）即可。
