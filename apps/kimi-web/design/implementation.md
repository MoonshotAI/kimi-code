# Kimi Web · UI 重新改造 · 实施交付文档

> 这是给**实施 agent** 的执行清单，也是给**验收 agent** 的验收合同。
> 配套视觉/令牌参考见同目录 [`design-system.html`](./design-system.html)（高保真设计稿，含设计原则、现状审计、令牌、组件预览、主题方案）。
> 基线：`main@` 当前 HEAD（实施前先 `git status` 确认在 `main` 且工作区干净）。

---

## 0. 目标与范围

**目标**：把 `apps/kimi-web` 现有 50 个组件里割裂的样式，收敛为一套 token 驱动、可主题化、可防劣化的统一设计系统，并把三套主题（terminal / modern / kimi）合并为一套可定制主题。

**最终交付物**：

1. `src/style.css` 补全 token 刻度（间距 / 圆角 / 层级 / 阴影 / 动效 / 字体），并完成主题合并。
2. `src/components/ui/` 下 8 个组件基元（Button / IconButton / Badge / Pill / Card / Input / Dialog / Spinner）。
3. 现有组件逐文件迁移到基元，删除 `style.css` 的「去终端化」全局覆盖层（约 440 行）。
4. 一个轻量「反模式检测」脚本，纳入本地校验。

**绝对不要做（Out of scope）**：

- ❌ 不要改业务逻辑、API、路由、i18n 文案（仅样式）。
- ❌ 不要新增依赖（尤其不要加 UI 框架 / 图标库 / CSS-in-JS）。图标用内联 SVG。
- ❌ 不要把月相 🌑…🌘 从「等待 Agent 响应」态移除（品牌特色，见 §6）。
- ❌ 不要改 `@fontsource` 已自托管的 Inter / JetBrains Mono（除非决定 Geist Mono 去留，见 §2）。
- ❌ 不要碰 `apps/kimi-web` 之外的包。

---

## 1. 验收总标准（验收 agent 按此打分）

每个 Phase 完成后都必须满足以下**通用门槛**，再进入下一阶段：

- [ ] `pnpm --filter @moonshot-ai/kimi-web typecheck` 通过（无新增类型错误）。
- [ ] `pnpm --filter @moonshot-ai/kimi-web build` 通过。
- [ ] 反模式检测脚本（Phase 3 后）对改动文件**无新增告警**。
- [ ] 视觉无回归：启动 dev server，对**聊天页 / 设置弹窗 / 登录弹窗 / 新建会话首屏 / 侧栏会话列表**截图，与改造前对比无明显错位、破版、暗色模式失效。
- [ ] 暗色模式（`data-color-scheme="dark"`）下改动区域正常，无硬编码色导致的「亮底亮字」。

最终（全部 Phase 完成后）额外满足：

- [ ] `style.css` 中 `:is(html[data-theme="modern"], html[data-theme="kimi"])` 覆盖层基本清空（仅保留必要的结构性规则），文件行数显著下降。
- [ ] 不存在「同名组件类在多个文件各写一遍」（如 `.act-btn`、`.qbtn`、`.kbtn` 已替换为 `Button`）。
- [ ] 全站只有一种 `Dialog`、一种 `Button`、一种 `Input`、一种 `Badge`。

---

## 1.5 并行实施顺序（科学调度，给编排者）

实施 agent 可以用 subagent 并行加速，但**只能「阶段内并行、阶段间串行」**——因为有依赖关系与共享文件冲突点。下面的顺序是强制的。

### 依赖图

```
Phase 0 设计令牌  ──►  Stage A 基元(并行)  ──►  验收A  ──►  Stage B 迁移(并行按区域)
   ✅已完成                                                        │
                                                                 ▼
                                          Stage C 删去终端化覆盖层(串行·单agent)
                                                                 │
                                                                 ▼
                                          Stage D 防劣化+清理(并行) ──► 终验
```

### 阶段内可并行 / 阶段间必须串行

| 阶段 | 内容 | 并行度 | 共享文件冲突 |
|---|---|---|---|
| **Stage A** | 8 个基元 + MoonSpinner | **可并行 ×9** | 无（每个基元独立 SFC + `<style scoped>`，不写共享 `ui.css`） |
| **验收 A** | build / typecheck / 基元渲染自查 | 串行 | — |
| **Stage B** | 按区域迁移现有组件 | **可并行 ×N 组** | 无（每组只动自己负责的组件 `.vue`，**不许碰 `style.css`**） |
| **验收 B** | build / typecheck / 分区视觉自查 | 串行 | — |
| **Stage C** | 删 `style.css` 去终端化覆盖层 + 死样式 | **串行·单 agent** | 瓶颈：`style.css` 只能一个 agent 改 |
| **Stage D** | 反模式检测脚本 + AGENTS.md + 清理 | **可并行 ×3** | 无（脚本 / 文档 / 单个组件修复互不冲突） |
| **终验** | build / typecheck / 检测脚本 / 全量视觉 | 串行 | — |

### 共享文件 / 冲突点（必须串行）

- **`src/style.css`**：只有 Phase 0（已完成）与 Stage C 能改，且**同时只能一个 agent 改**。Stage B 的迁移 subagent **严禁**碰它。
- **`src/components/ui/*.vue`**：每个基元只由一个 subagent 创建，不并发写同一文件。
- **`apps/kimi-web/AGENTS.md`**：仅 Stage D2 改，单 agent。

### Stage A：基元并行（×9 subagent）

每个 subagent 领**一个**基元，严格按 §3 的 API 表 + 下方的「基元公共约定」实现：

- 一个 `.vue` 文件，`<script setup lang="ts">` + `<style scoped>`。
- 样式只许 `var(--*)`，不得出现 `#[0-9a-fA-F]` / `font-family:` / 游离圆角。
- 导出 props/emits 类型与 §3 一致（命名必须完全相同，否则 Stage B 迁移会断）。

**基元公共约定（所有 subagent 必须遵守，避免命名漂移）**

- props 命名：`variant` / `size` / `disabled` / `loading` / `modelValue` / `open` / `title`。
- 事件命名：`update:modelValue` / `update:open` / `click` / `close`。
- 尺寸枚举：`sm | md | lg`（`Badge` 多一个 `xs` 可选）。
- 变体枚举按 §3 表格逐字一致（如 `danger-soft` 不是 `dangerSoft`）。
- 组件根元素加 `class="ui-<name>"`（如 `ui-button`），便于 Stage C 清理旧 CSS 时识别。

### Stage B：迁移并行（按区域分组，每组一个 subagent）

每组只动自己负责的 `.vue` 文件的 `<template>` + `<style scoped>`，**不许碰 `style.css`**（旧类留给 Stage C 统一删）：

- **B1 聊天卡片**：`ToolCall / AgentCard / AgentGroup / QuestionCard / ApprovalCard / SwarmCard / TodoCard / GoalStrip` → `Card`
- **B2 输入条与菜单**：`Composer / SlashMenu / MentionMenu / ModelPicker` → `Pill / Badge / IconButton`
- **B3 弹窗**：`LoginDialog / AddWorkspaceDialog / StatusPanel / SettingsDialog / Onboarding` → `Dialog`（保留 `BottomSheet`）
- **B4 ServerAuthDialog 重写**（独立·高风险·单 agent）：去全部硬编码，接 `Dialog + Input + Button`
- **B5 设置**：`ProviderManager / ModelPicker / LanguageSwitcher` → `Input / Button / Badge`
- **B6 顶层/侧栏**：`Sidebar / SessionRow / WorkspaceGroup / Mobile*` → `Button / IconButton / Badge`
- **B7 Spinner 分流**：`MoonSpinner / ActivityNotice / ChatPane(sending) / SideChatPanel` → 月相合并去重（仅聊天等待态）+ 其余 loading 换普通 `Spinner`

### 冲突规避铁律（编排者必须向每个 subagent 强调）

1. subagent **只写被明确分配的文件**，其他文件只读。
2. `src/style.css` 在 Stage B 全程**只读**。
3. 基元在 Stage A 完成后即冻结；Stage B 只能 `import` 使用，不得改基元。
4. 任何 subagent 不得新增共享 helper / 共享 CSS 文件（需要就内联，或上报编排者）。

### 整体回合建议

- **回合 1**：Stage A（×8 并行）→ 验收 A。
- **回合 2**：Stage B（×7 组并行）→ 验收 B。
- **回合 3**：Stage C（串行）+ Stage D（×3 并行）→ 终验。

理想情况下 3 个回合即可完成，每个回合内高度并行。

---

## 2. Phase 0 · 设计令牌收口（约 0.5–1 天，低风险）

**目标**：在 `src/style.css` 补齐缺失刻度，并完成主题合并。此阶段只动 token，不动组件。

### 任务

- [ ] **新增刻度**（`:root` 中定义，亮/暗两套值）：
  - 间距：`--space-1:4px` `--space-2:8px` `--space-3:12px` `--space-4:16px` `--space-5:20px` `--space-6:24px` `--space-8:32px`
  - 圆角：`--radius-xs:4px` `--radius-sm:6px` `--radius-md:8px` `--radius-lg:12px` `--radius-xl:16px` `--radius-2xl:20px` `--radius-full:999px`
  - 层级：`--z-base:0` `--z-sticky:100` `--z-dropdown:200` `--z-overlay:300` `--z-modal:400` `--z-toast:600` `--z-max:9999`
  - 阴影：`--shadow-xs/sm/md/lg/xl`（亮/暗成对，参考 design-system.html §03）
  - 动效：`--ease-out:cubic-bezier(0.16,1,0.3,1)` `--ease-in-out:cubic-bezier(0.4,0,0.2,1)` `--duration-fast:120ms` `--duration-base:160ms` `--duration-slow:260ms`
- [ ] **字体 token**：把 `--font-sans` 语义化为 `--font-ui`；统一 CJK 回退链为 `Inter, -apple-system, …, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif`；决定 Geist Mono 去留（**默认从 kimi 的 `--mono` 链中移除**，让 JetBrains Mono 成为唯一 mono；除非产品确认要补 `@fontsource/geist-mono`）。
- [ ] **主题合并（核心）**：把 terminal / modern / kimi 并为一套，暴露 4 个颜色种子：
  - `--accent-primary`（默认 `#1783ff`）
  - `--accent-secondary`（默认 `#6b7280`）
  - `--surface-light`（默认 `#ffffff`）
  - `--surface-dark`（默认 `#0d1117`）
  - 其余语义 token（`--color-text` / `--color-line` / `--color-success` 等）由这 4 个种子派生，亮/暗由当前 surface 驱动。删除 `--blue` 在 kimi 下的语义分裂与 `data-accent="mono"` 分支（如确认不再需要）。详见 design-system.html §06。
- [ ] 补齐 `--canvas` / `--sh` / `--shc` 在合并后主题下的缺省值；删除未使用的死 token。
- [ ] 保留 `--bg` / `--ink` / `--blue` 等短名作为兼容别名**一个版本**（避免一次性大改），但新代码一律用语义名。

### 验收

- [ ] `grep` 确认新增刻度变量均存在，且亮/暗都有定义。
- [ ] `data-color-scheme` 切到 dark / light / system 下，整页无破版、无未定义变量导致的透明/黑块。
- [ ] 改 `--accent-primary` 一个值，主按钮、链接、焦点环、徽标状态色同步变化（验证「只调 4 色」生效）。
- [ ] 不再存在「某 token 只在某主题定义」的情况。

---

## 3. Phase 1 · 组件基元落地（约 2–3 天，中风险）

**目标**：新建 `src/components/ui/`，实现 8 个基元。此阶段**只新增组件，不替换旧用法**，便于单独 review。

### 目录约定

```
src/components/ui/
  Button.vue      IconButton.vue
  Badge.vue       Pill.vue
  Card.vue        Input.vue        (含 Select / Textarea 变体)
  Dialog.vue      Spinner.vue      (普通 SVG 环形)
  MoonSpinner.vue                  (月相，仅聊天等待态)
  ui.css                          (基元样式，全部 var(--*) 驱动，在 style.css 之后引入)
```

- SFC 用 `<script setup lang="ts">`，props 用 `defineProps<{ }>()`，emits 用 `defineEmits<{ }>()`（遵守 `apps/kimi-web/AGENTS.md`）。
- 样式全部 `var(--*)`，**不得**写死十六进制色、字号、圆角、字体。
- 无 path alias、无 auto-import，写相对路径。

### 8 个基元 API 速查（props/变体以 design-system.html §04 为准）

| 基元 | 核心 props | 变体 | 备注 |
|---|---|---|---|
| `Button` | `variant` `size` `loading` `disabled` `type` | `primary/secondary/ghost/danger/danger-soft` × `sm/md/lg` | `loading` 时内嵌普通 `Spinner` |
| `IconButton` | `size` `aria-label` | `sm/md` | 默认 slot 放内联 SVG |
| `Badge` | `variant` `size` `dot` | `neutral/info/success/warning/danger/solid` | 状态徽标 |
| `Pill` | `active` | — | composer 工具条药丸 |
| `Card` | `interactive` `flat` | slot: `header` / default / `footer` | 三段式骨架 |
| `Input` | `modelValue` `as` `type` `size` `placeholder` `rows` `disabled` | `as: input/select/textarea` | `type` = HTML input 类型；`as` = 元素形态（select 用默认 slot 放 `<option>`） |
| `Dialog` | `open` `title` `description` `size` | slot: default / `footer` | 替代 6 套手写遮罩 |
| `Spinner` | `size` | `sm/md` | **普通**加载器，SVG 环形 |
| `MoonSpinner` | `size` | — | **仅**「等待 Agent 响应」用，月相 8 帧 |

### 验收

- [ ] `src/components/ui/` 下组件齐全，每个都有 `defineProps` 类型与 `emits` 类型。
- [ ] 基元样式 0 处硬编码十六进制色 / 字体（grep `#[0-9a-fA-F]{3,6}` 与 `font-family:` 应为 0，允许 SVG `fill="currentColor"`）。
- [ ] 在任意现有页面临时挂一个 `<Button variant="primary">` 验证渲染、暗色、焦点环正常后移除。
- [ ] `MoonSpinner` 与 `Spinner` 是两个独立组件，职责不混。

---

## 4. Phase 2 · 逐文件迁移（约 3–5 天，中风险）

**目标**：把现有组件切换到基元，删除重复样式与「去终端化」覆盖层。按文件小步提交，每改一个跑一次 typecheck。

### 迁移顺序（先易后难）

1. **按钮**：`ApprovalCard / QuestionCard / SettingsDialog / ProviderManager / LoginDialog / Onboarding / AddWorkspaceDialog / StatusPanel` 的 `.kbtn/.qbtn/.act/.act-btn/.nb-primary/.ob-start` → `<Button>`。
2. **徽标 / 药丸**：`Composer / DiffView / SwarmCard / AgentCard` 等 11 种 chip/badge → `<Badge>` / `<Pill>`。
3. **输入**：`ProviderManager / SettingsDialog / LoginDialog / AddWorkspaceDialog / ServerAuthDialog` → `<Input>`。
4. **弹窗**：6 套（`LoginDialog / AddWorkspaceDialog / StatusPanel / SettingsDialog / Onboarding / ServerAuthDialog`）→ `<Dialog>` + `<BottomSheet>`（保留）。
5. **重写 `ServerAuthDialog.vue`**：去除全部硬编码 `#ffffff/#1565c0/'Inter'/z-index:9999`，接入 `<Dialog>` + `<Input>` + `<Button>`，使其可换肤。
6. **聊天卡片统一为 `Card` 骨架**：`ToolCall / AgentCard / AgentGroup / QuestionCard / ApprovalCard / SwarmCard / TodoCard / GoalStrip`。
7. **Spinner 分流**：`MoonSpinner` / `ActivityNotice` 两份月相合并为单个 `MoonSpinner`（仅聊天等待态）；其余 loading（按钮、启动、内联）用普通 `<Spinner>`。
8. **删除 `style.css` 去终端化覆盖层**（约第 313–754 行），仅保留仍有必要的结构性规则。

### 验收

- [ ] 每个迁移文件：`grep` 不再出现被替换的旧类（如 `.act-btn` 在迁移后应为 0 处定义）。
- [ ] 视觉对比迁移前后截图无错位；暗色正常。
- [ ] `ServerAuthDialog.vue` 中 `#[0-9a-fA-F]` 与 `font-family:` 为 0 处。
- [ ] 全部完成后：`style.css` 行数较基线显著下降；`:is(html[data-theme="modern"], html[data-theme="kimi"])` 块基本清空。

---

## 5. Phase 3 · 防劣化收口（约 1 天，低风险）

**目标**：把反模式清单变成可执行检查，避免新代码再次引入不一致。

### 任务

- [ ] 新增轻量检测脚本（如 `scripts/check-style.mjs` 或 oxlint/stylelint 自定义规则），规则见 §6。
- [ ] 移除 `Onboarding.vue:125` 的 `backdrop-filter: blur(3px)`。
- [ ] 把 `#8250df`（已合并 PR，GitHub 域色）登记为具名 token。
- [ ] 在 `apps/kimi-web/AGENTS.md` 增补「组件与样式约定」一节：新组件必须用 `components/ui/` 基元，样式必须 `var(--*)`，禁止新增 emoji 图标（月相除外）。

### 验收

- [ ] 检测脚本对当前代码 0 告警（或对既有遗留有明确豁免清单）。
- [ ] 故意写一行 `background: #fff` 能被脚本拦下。

---

## 6. 反模式 / 禁区清单（检测脚本规则）

| 规则 | 检测 | 处置 |
|---|---|---|
| `no-gradient` | `gradient(` | 禁止 |
| `no-glassmorphism` | `backdrop-filter` | 禁止 |
| `no-hardcoded-hex` | 组件 `<style>` 内未登记 `#[0-9a-fA-F]{3,8}` | 警告（基元内允许） |
| `no-hardcoded-font` | 组件内硬编码 `font-family`（非 `var(--font-ui/--font-mono)`） | 警告 |
| `no-emoji-icon` | 用 emoji 当功能性图标 | 禁止，**唯一豁免：月相 🌑…🌘，且仅限「等待 Agent 响应」聊天态** |
| `radius-from-scale` | 圆角不在 `{4,6,8,12,16,20,999}` 内 | 警告 |
| `z-from-scale` | `z-index` 用未登记大数字 | 警告 |
| `weight-from-scale` | `font-weight` 不在 `{400,500,600,700}` 内 | 警告 |

> 月相 🌑…🌘 是 Kimi Web 的品牌特色，**仅**用于「发出消息后、等待 Agent 首条响应」这一聊天态。其余所有 loading（按钮、启动、内联）一律用普通 `<Spinner>`。

---

## 7. 交付与验收协议

**实施 agent 每完成一个 Phase，回复一次**：

```
Phase N 完成
- 改动文件：<列表>
- typecheck / build：通过
- 反模式检测：<通过 / 告警列表>
- 视觉自查：<聊天/设置/登录/侧栏 已对比，无回归 / 问题列表>
- 未决问题：<如有>
```

**验收 agent（我）将**：

1. 拉取改动，跑 typecheck + build + 反模式检测。
2. 读关键 diff，核对是否遵守 §0 禁区与 §3 API。
3. 启 dev server，对聊天页 / 设置弹窗 / 登录弹窗 / 侧栏截图，确认无视觉回归、暗色正常。
4. 按各 Phase「验收」清单逐项打勾，不通过则退回并指出具体文件/行。

**不要在 Phase 之间跳过验收**：建议 Phase 0 → 验收 → Phase 1 → 验收 → Phase 2（可分批）→ 验收 → Phase 3 → 终验。

---

## 8. 一句话总结

颜色 token 已相对完整，真正缺的是「组件基元」与「间距/层级/动效」刻度。把 14 种按钮、11 种徽标、6 套弹窗收敛为 8 个基元，三套主题并为一套（只调 4 个颜色），再删掉约 440 行全局覆盖层——视觉一致性即建立，未来换肤只需改 4 个颜色种子，不动组件。
