# 给第二轮实施 agent 的提示词

> 用法：把下面 `---` 之间的内容整段复制给实施 agent。本次是「视觉优先 + 自验证 + 一次性跑完」，不需要人类在回路里。

---

你是 Kimi Code Web UI（`apps/kimi-web`）UI 改造的第二轮实施 agent。
第一轮失败了——视觉回归、不像设计稿、被回退。这一次你要用「视觉优先 + 自验证」的方式一次性做完，不需要人类在回路里。

## 关键背景（第一轮为什么失败，你必须避开）

1. 第一轮全程没有用浏览器看过一次渲染效果，只靠 build/typecheck/grep 验收，结果把视觉回归放出去了。
2. 它走了「先建抽象基元 → 迁移 27 个组件 → 删全局覆盖层」的路线，每一步视觉都在漂，却从未收敛到设计稿。
3. 最后一步「把全局覆盖规则搬进组件 scoped」改了 CSS 优先级，引入新 bug（侧栏 hover 高度变化、卡片 hover 半截、标题底色过短、字号变小、composer 底色没变）。
4. 结论：设计稿（`design-system.html`）才是目标，不是「代码层面安全」。

## 你的目标

让 `apps/kimi-web` 的 UI 在视觉上**精确匹配 `apps/kimi-web/design/design-system.html`**（高保真设计稿），且不引入回归。设计稿是最高权威——你的实现要长得像它，不是像你自己的理解。

## 必读

- `apps/kimi-web/design/design-system.html` —— **目标视觉稿**。§03 token、§04 组件基元、§05 聊天界面、§06 主题。每一节都是你要匹配的对象。
- `apps/kimi-web/design/implementation.md` —— token 体系、反模式规则（§6）、基元 API（§3，供参考，但视觉以 `design-system.html` 为准）。
- 当前 `main` 代码（你要改造的基线）。

## 基线

- 仓库：`/Users/moonshot/code/kimi-code-web3`，分支 `main`，工作区干净（仅 `design/` 未跟踪）。
- 命令：`pnpm --filter @moonshot-ai/kimi-web {typecheck,build,dev}`。
- 浏览器自验证：用 webbridge（`http://127.0.0.1:10086`）对 `http://localhost:5173` 截图；或本机 headless Chrome。
  注意：应用需要后端 server 才能渲染真实会话/弹窗。若 `localhost:5173` 只显示「连接中」，先确认后端是否在跑；没有后端时，能渲染的状态（空会话/splash）用截图验证，其余状态严格按 `design-system.html` 实现 + 代码审查保证。

## 工作流（编排 + 自验证，不要让人类介入）

你是编排者，可以用 subagent。流程：

### 1. 建 token 地基（单 agent，先做）
按 `design-system.html` §03 在 `src/style.css` 补齐 token（间距/圆角/层级/阴影/动效/字体 + 4 颜色种子 + 语义色层），保留旧短名作兼容别名。完成跑 build。截图确认无回归。

### 2. 按区域并行实施 + 逐区域自验证（并行 subagent，每个区域一个）
把改造拆成独立区域，每个 subagent 负责一个区域，**每个区域都要做完「截图→对比设计稿→改→再截图」的闭环**：

- 区域 A：Composer（聊天输入框）→ 匹配 `design-system.html` §05 的 Composer 稿（圆润卡片、工具条药丸、圆形发送钮）。
- 区域 B：聊天卡片流（ToolCall / AgentCard / QuestionCard / ApprovalCard / SwarmCard / TodoCard）→ 匹配 §05 统一卡片流。
- 区域 C：侧栏 + 会话列表（Sidebar / SessionRow / WorkspaceGroup）→ 匹配 §04/§05 侧栏稿。
- 区域 D：弹窗（LoginDialog / SettingsDialog / AddWorkspaceDialog / StatusPanel / Onboarding / ServerAuthDialog）→ 匹配 §04 Dialog 稿。
- 区域 E：设置页（ProviderManager / ModelPicker / LanguageSwitcher）→ 匹配 §04 表单/卡片稿。
- 区域 F：顶层/移动（Sidebar 顶栏 / MobileTopBar 等）→ 匹配 §04 IconButton/Badge 稿。

每个 subagent 的硬性工作步骤：
1. 先截图当前状态（light + dark + 必要的 hover）。
2. 对比 `design-system.html` 对应区域，列出差异。
3. 改代码（模板 + scoped 样式 + 必要 token），用 `var(--*)`，不写死色/字体。
4. 再截图、再对比，迭代直到肉眼匹配设计稿。
5. 检查 hover/focus/active 态、暗色、以及相邻区域没被影响。
6. 跑 typecheck + build。
7. 报告：改动文件、before/after 截图路径、与设计稿的差异确认、回归检查。

### 3. 整合 + 全量自验证（编排者）
所有区域返回后，你（编排者）：
1. 跑 typecheck + build + check-style（如有）。
2. 全量截图复核：聊天页（空 + 有消息）、设置弹窗、登录弹窗、侧栏、composer，light + dark。
3. 对照 `design-system.html` 整体验收，列出任何不一致并修正。
4. 对照「第一轮 bug 清单」确认全部未复现（见下）。

## 第一轮 bug 清单（必须全部不复现）

- 侧栏 hover 后高度变化。
- 卡片 hover 样式只有一半跟随文字。
- 卡片展开后标题背景色过短。
- 整体字号变小。
- composer 底色没变成设计稿的圆润卡片。

## 硬约束

- 视觉以 `design-system.html` 为准；不匹配就继续改，不要「差不多就行」。
- 样式一律 `var(--*)`，组件 `<style>` 内不写死 `#[0-9a-fA-F]` / `font-family:` / 游离圆角。
- 不新增依赖（无 UI 框架 / 图标库 / CSS-in-JS）；图标内联 SVG。
- 月相 🌑…🌘 仅用于「等待 Agent 响应」聊天态，其余 loading 用普通 Spinner。
- 不改业务逻辑 / API / 路由 / i18n 文案；不碰 `apps/kimi-web` 之外的包。
- 不 commit、不 push。

## 完成判定（全部满足才停）

- 每个区域 light + dark 截图与设计稿匹配。
- 第一轮 bug 清单全部不复现。
- typecheck + build 通过。
- 没有新增硬编码色/字体（grep 自查）。
- 输出最终报告：改动文件列表、各区域 before/after 截图路径、与设计稿的差异确认、回归检查结果、未决问题。

## 重要：不要让人类介入

- 全流程自己跑完，不要中途停下来问。
- 遇到设计稿没说清的细节，按 `design-system.html` 的整体风格（克制、临床、token 驱动）自行决定，不要问。
- 完成后一次性输出最终报告。

开始：先建 token 地基，再按区域并行实施 + 自验证，最后全量复核并出报告。
