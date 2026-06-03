# TUI 设计规范（Design Spec）

> 本目录所有 dialog / selector / 输入框的**单一真值源**。新增或改造交互组件前先读本文件，提交前对照文末「自查清单」。
> 基准组件：`components/dialogs/model-selector.ts`（`/model`）。所有列表型 dialog 的头部、hint、搜索、选中/当前态都以它为准对齐。

---

## 1. 视觉状态

| 语义 | 规范 | 常量 / token |
|---|---|---|
| 选中项指针 | `❯ `（`primary`） | `constant/symbols.ts` → `SELECT_POINTER` |
| 选中项文字 | `primary` + bold | `chalk.hex(colors.primary).bold` |
| 当前 / 激活项 | 行尾 ` ← current`（`success`） | `constant/symbols.ts` → `CURRENT_MARK` |
| 危险项 / 操作 | `error`（选中再加 bold） | `chalk.hex(colors.error)` |
| 危险确认 `[y/N]` | `warning` + bold | `chalk.hex(colors.warning)` |
| 开关项状态：开 | 名称后 `  enabled`（`success`） | `chalk.hex(colors.success)` |
| 开关项状态：关 | 名称后 `  disabled`（`textDim`） | `chalk.hex(colors.textDim)` |
| 列表 / 选择器边框 | 平直 `─`（`primary`），仅顶/底各一条 | — |
| 输入框边框 | 圆角 `╭ ╮ ╰ ╯`（`primary`） | — |

- **不要**自造选中指针（`>` / `▶` / `→` 等）；统一用 `SELECT_POINTER`。
- **不要**用 `● ` / `(current)` 表示当前项；统一用 `CURRENT_MARK`（行尾、`success`、前置一个空格）。
- 当前项与选中项**互相独立**：当前项是「现在生效的值」（行尾 marker），选中项是「光标所在行」（指针 + 高亮）；两者可同时落在同一行。

## 2. 颜色

- 一律使用**语义 token**：`chalk.hex(colors.<token>)`。仓库 `chalk-named-color-guard` 已强制此约定，**禁止** `chalk.red` / `chalk.gray` 等 named color。
- `ThemeStyles`（`state.theme.styles.*()`）是可选的便捷封装；用与不用都可，但颜色必须来自 `ColorPalette` token。
- 可用语义 token 见 `theme/colors.ts`：`primary` `accent` `text` `textStrong` `textDim` `textMuted` `border` `borderFocus` `success` `warning` `error` `status` …
- **hint 行不做键位高亮**：整行 `textMuted`，不给 `Enter` / `Esc` / `D` 等键位单独上色。

## 3. 列表 dialog 标准布局

以 `model-selector` 为准，自上而下逐行固定为：

```
─────────────────────────────────────────  ① 顶部边框（primary，整宽 ─）
 Select a model  (type to search)          ② 标题（primary+bold）+ 可搜索且无 query 时的后缀（textMuted）
 ↑↓ navigate · Enter select · Esc cancel    ③ hint（textMuted，紧贴标题，无键位高亮）
                                            ④ 空行
 Search: gpt                                ⑤ 搜索行：仅在有 query 时出现（` Search: ` primary + query text）
  ❯ GPT-5            openai                  ⑥ 列表项：指针 + 名称（左）+ 次要列（右，textMuted）
    Kimi K2          Kimi Code ← current        当前项行尾 ` ← current`（success）
                                            ⑦ 空行
 ▼ 3 more                                   ⑧ 滚动 / 匹配指示：无 query 时 `▼ N more`，有 query 时 `x / y`
─────────────────────────────────────────  ⑨ 底部边框（primary，整宽 ─）
```

硬性约定：

- **头部只有顶部一条 `─`**。标题下方紧跟 hint，**不得**再插一条 `─`。整个 dialog 全宽 `─` 仅 2 条（顶 + 底）。
- **`(type to search)` 只出现在标题后缀**（可搜索且 query 为空时）；hint 行**不再**重复出现「type to search」。
- **`Search:` 行在空行之下、列表之上**，只在有 query 时渲染。
- hint 紧贴标题（中间无空行）；hint 与正文之间有 1 空行。
- 每行最终经 `truncateToWidth(line, width)`，CJK / 窄终端不超宽。

## 4. hint 行与文案词汇（英文 UI）

每段 hint 形如「**键位 + 描述**」，段间用 ` · `（单空格中点）分隔。

| 动作 | 键位 token | 描述词 | 完整片段 |
|---|---|---|---|
| 移动 | `↑↓` | navigate | `↑↓ navigate` |
| 翻页 | `←→` 或 `PgUp/PgDn` | page | `←→ page` |
| 确认 / 选中 | `Enter` | select | `Enter select` |
| 取消 / 关闭 | `Esc` | cancel | `Esc cancel` |
| 删除 | `D` | delete | `D delete` |
| 清空搜索 | `Backspace` | clear | `Backspace clear` |
| 切 provider | `Tab` | toggle provider | `Tab toggle provider` |
| 搜索（标题后缀） | 打字 | — | `(type to search)` |

- **键位 token 首字母大写**（`Enter` / `Esc` / `Tab` / `Backspace` / `D`），**描述词全小写**（navigate / select / cancel / page / delete / clear）；方向符 `↑↓` / `←→` 原样。
- 方向符统一 `↑↓`（不用 `▲/▼`）。
- 「离开对话框」统一只说 `cancel`（不混用 close / back / exit / dismiss）。业务语义（如审批的 reject）例外。
- hint 随状态精简：可搜索列表无 query 时，「type to search」在标题后缀已出现，hint 不重复；有 query 时 hint 追加 `Backspace clear`。

## 5. Tab 条（`/model` 的 provider 切换）

`tabbed-model-selector` 在 flat `model-selector` 外包一层 provider tab，样式对齐 **AskUserQuestion** 的 tab：

```
 Select a model  (type to search)
 Tab toggle provider · ↑↓ navigate · Enter select · Esc cancel   ← hint 首项即 Tab 切换
                                            ← 空行
 All   Kimi Code   openai                   ← tab 条：激活项填充背景（primary 底 + text 字 + bold），其余 textMuted
                                            ← 空行
  ❯ ...
```

- tab 条位置：**在 hint 行下方**，且**上下各一空行**（与 hint、与列表都隔开）。
- 激活 tab：`chalk.bgHex(colors.primary).hex(colors.text).bold(\` ${label} \`)`；非激活：`chalk.hex(colors.textMuted)`。两者可见宽度一致，切换不抖动。
- 第一个 tab 恒为 `All`（聚合所有 provider）；**默认停在 `All`**。仅当显式传 `initialTabId`（如 `/provider` 新增完跳转）才停在指定 provider tab。
- `Tab` / `Shift+Tab` 循环切换；hint 行首项即 `Tab toggle provider`。
- 当前模型在所在 tab 内仍以 `❯` + ` ← current` 标记，切 tab 不丢失定位。

## 6. 键位

| 动作 | 键 | 判定方式 |
|---|---|---|
| 移动 | `↑` / `↓` | `matchesKey(data, Key.up/down)` |
| 翻页 | `PgUp` / `PgDn` | `matchesKey(data, Key.pageUp/pageDown)` |
| 确认 / 选中 | `Enter` | `matchesKey(data, Key.enter)` |
| 取消 / 关闭 | `Esc` | `matchesKey(data, Key.escape)` |
| 删除 | `D` | `printableChar(data) === 'D'`（也接受 `'d'`） |
| 搜索 | 打字 | `printableChar(data)` |

- **字符比较必须经 `printableChar()`**（Kitty 协议），由 `printable-key-guard` 强制；功能键用 `matchesKey(data, Key.*)`。
- **`Esc` 两段式**：有 query 时先清空 query（`list.clearQuery()`），无 query 时才 `onCancel()`。
- `←` / `→` 不固定语义：无翻页结构的组件里承担「值切换」（如 `/model` 的 thinking on/off）；`choice-picker` 这类无横向值的列表里用作翻页。**不要**在有 thinking 切换的组件里又拿 `←→` 翻页。
- **删除键统一用字母 `D`**（`/provider`、`/plugins` 一致）。字母键要求该列表**不可 type-to-search**（否则会打进搜索框）——当前所有带删除动作的列表都不可搜索；若某列表既要搜索又要删除，删除须改用非打印键。

## 7. 开关列表与多选（toggle / multi-select）

适用于「每行可独立开 / 关」的列表（如 `/plugins` 的已装插件、MCP server 列表）。区别于单选（`Enter` 选中即提交并关闭），开关列表用 `Space` 就地切换每行状态，dialog 不关闭。

```
 Plugins
 ↑↓ navigate · Space toggle · Enter details · Esc cancel
                                            ← 空行
 Installed plugins (2)                      ← 分区标题（textStrong / 加粗）
  ❯ Kimi Datasource  enabled                ← 选中行（❯ + primary+bold 名称）+ 状态标签（success）
    id kimi-datasource · 1 skill · MCP 1/1 · via code.kimi.com · official   ← 次要信息行（textMuted，` · ` 分隔）
    Superpowers  disabled                   ← 未选中行（text 名称）+ 关态标签（textDim）
    id superpowers · 14 skills · via code.kimi.com · curated
```

约定：

- **`Space` 切换当前行状态**（开 ↔ 关），即时生效、dialog 保持打开；hint 含 `Space toggle`。
- **状态标签**紧跟名称、空 2 格：开 ` enabled`（`success`）、关 ` disabled`（`textDim`）。其它语义（如 `installed`=success、`install…`=primary）按 `statusStyle` 同源处理。
- `Enter` 在开关列表里另作他用（如「查看详情」`Enter details`），不承担 toggle。
- 多套独立动作时（toggle / 详情 / 删除 / 进子菜单），hint 逐项列全，键位首字母大写：`Space toggle · Enter details · D remove`（参照第 4 节大小写规则）。
- 行下可附 1 行次要信息（id / 数量 / 来源 / 信任级），`textMuted`、` · ` 分隔。

## 8. Thinking 控件（`/model` 专属）

列表下方展示当前选中模型的 thinking 三态，外观固定 `[ On ] Off` 段式：

- 标题：`Thinking  (←→ to switch)`（仅 `toggle` 态显示括号提示）；其余态只显示 `Thinking`。
- `toggle`：`[ On ]  Off` / `On  [ Off ]`，激活段 `primary+bold`。
- `always-on`：`[ Always on ]`。
- `unsupported`：`[ Off ]` + `unsupported`（textMuted）。
- `←` / `→` 翻转草稿；提交时经 `effectiveThinking()` 归一（always-on→true、unsupported→false）。

## 9. 输入框（多字段）

- 圆角盒 `╭ ╮ ╰ ╯`（`primary`）。
- 字段切换：`Tab` / `Shift+Tab` / `↑` / `↓`。
- `Enter`：非末段→推进到下一字段；末段→提交。
- 取消：`Esc` / `Ctrl+C` / `Ctrl+D`。
- footer 随焦点动态：非末段显示 `Enter next`，末段显示 `Enter submit`。
- 必填校验按字段顺序定位（如 custom-registry：URL 空→定位 URL，token 空→定位 token），错误用对应的子提示态。

## 10. 共享组件（优先复用，不另起炉灶）

| 形态 | 组件 |
|---|---|
| 列表光标 / 搜索 / 翻页状态机 | `utils/searchable-list.ts` → `SearchableList` |
| 分页视图 | `utils/paging.ts` → `pageView` |
| Kitty 可打印字符 | `utils/printable-key.ts` → `printableChar` / `isPrintableChar`（含 guard） |
| 选中指针 / 当前项标记 | `constant/symbols.ts` → `SELECT_POINTER` / `CURRENT_MARK` |

新列表组件**必须复用 `SearchableList`**（光标 / 搜索 / 翻页），并手工对齐本文件第 3–8 节的布局、键位、文案。

## 11. 新增 / 改造 dialog 自查清单

- [ ] 头部按第 3 节：顶部一条 `─`、标题（+`(type to search)` 后缀）、hint、空行、`Search:` 行、列表、底部一条 `─`；标题下**无**内层 `─`。
- [ ] hint 整行 `textMuted`，**不**做键位高亮；键位首字母大写、描述词小写、` · ` 分隔。
- [ ] 选中指针用 `SELECT_POINTER`，当前项用 `CURRENT_MARK`，未自造 `>` / `▶` / `→` / `● ` / `(current)`。
- [ ] 颜色全部来自 `colors.<token>`，无 named color。
- [ ] 键位：`↑↓` 移动、`PgUp/PgDn` 翻页、`Enter` 确认、`Esc` 取消（可搜索列表 `Esc` 两段式：先清 query 再关闭）、`D` 删除；字符比较经 `printableChar()`。
- [ ] 「离开对话框」只说 `cancel`，不混用 close / back / exit / dismiss。
- [ ] 开关列表用 `Space toggle` 就地切换、不关闭；状态标签 ` enabled`(`success`) / ` disabled`(`textDim`) 紧跟名称空 2 格（见第 7 节）。
- [ ] 长列表有滚动 / 翻页指示（`▼ N more` 或 `x / y`），空态文案明确（`No matches` 等）。
- [ ] 每行经 `truncateToWidth(line, width)`，CJK / 窄终端下不超宽。
- [ ] 复用 `SearchableList`；输入框圆角盒，多字段支持 `Tab/↑↓` 切换、Enter 推进 / 末段提交。
- [ ] 有对应的组件测试（render 快照 + handleInput 键行为）。
