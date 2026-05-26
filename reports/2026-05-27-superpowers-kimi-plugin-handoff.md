# Superpowers / Kimi Code 插件接手文档

## 当前结论

Kimi Code 插件路线收束为：

```text
Kimi Code plugin =
  plugin.json 或 .kimi-plugin/plugin.json
  + skills
  + sessionStart.skill 声明式注入
  + skillInstructions
  + 可选 mcpServers
  + 展示元数据
```

插件 loader 不执行第三方 Python、Node.js、Shell、hook 脚本，也不兼容旧
Kimi CLI 的 `tools[].command` runtime。

`.codex-plugin/plugin.json` 不再作为 fallback。后续 Superpowers 测试都应该使用
带 `.kimi-plugin/plugin.json` 的本地包或 CDN zip。

## Manifest 查找顺序

当前目标查找顺序：

```text
<plugin_root>/plugin.json
<plugin_root>/.kimi-plugin/plugin.json
```

根目录 `plugin.json` 优先。如果两者同时存在，根目录 `plugin.json` 胜出，
`.kimi-plugin/plugin.json` 只作为 shadowed manifest 在 `/plugins info` 中展示。

Zip 安装也必须按同样规则检测插件根目录。也就是说，CDN beta zip 只要包含
`.kimi-plugin/plugin.json`，就应该能被识别为 Kimi 插件包。

## Superpowers 本地适配形状

在 `~/code/superpowers` 中先加 Kimi 专属薄适配，不提交：

```text
~/code/superpowers/
  .kimi-plugin/
    plugin.json
  skills/
    using-superpowers/
      SKILL.md
    brainstorming/
      SKILL.md
    ...
```

建议 `.kimi-plugin/plugin.json`：

```json
{
  "name": "superpowers",
  "version": "5.1.0",
  "description": "An agentic skills framework & software development methodology.",
  "skills": "./skills/",
  "sessionStart": {
    "skill": "using-superpowers"
  },
  "skillInstructions": "Kimi Code tool mapping: TodoWrite -> TodoList; Task -> Agent; Skill -> Skill. Use AskUserQuestion when asking the user to choose between concrete options.",
  "interface": {
    "displayName": "Superpowers",
    "shortDescription": "Planning, TDD, debugging, and delivery workflows for coding agents"
  }
}
```

这份适配不 fork、复制或改写 Superpowers skills，只告诉 Kimi：

- 从 `./skills/` 扫描 Skills。
- 新 session 开始时声明式注入 `using-superpowers`。
- 给每个 Superpowers skill 前面附加 Kimi 工具映射说明。

## Kimi 侧核心代码路径

入口和状态：

- `apps/kimi-code/src/tui/kimi-tui.ts`
  - `/plugins` 子命令分发。
  - `install` 后提示用户 `/new`，因为当前 session 不热更新 Skills/MCP。
- `packages/node-sdk/src/session.ts`
  - 暴露 TUI 调用的 plugin SDK 方法。
- `packages/agent-core/src/rpc/core-impl.ts`
  - RPC 实现，持有 `PluginManager`。

插件管理：

- `packages/agent-core/src/plugin/manifest.ts`
  - 解析 `plugin.json` / `.kimi-plugin/plugin.json`。
  - 校验 `skills`、`sessionStart`、`mcpServers`、`skillInstructions`。
- `packages/agent-core/src/plugin/manager.ts`
  - 安装、启用、禁用、删除、重载。
  - `pluginSkillRoots()` 把 enabled plugin 的 skill roots 接到 session。
  - `enabledSessionStarts()` 输出需要注入的 session-start skill。
- `packages/agent-core/src/plugin/archive.ts`
  - zip 下载和解压。
  - 解压后检测 plugin root。
- `packages/agent-core/src/plugin/store.ts`
  - 读写 `$KIMI_CODE_HOME/plugins/installed.json`。

Skill 注入：

- `packages/agent-core/src/skill/scanner.ts`
  - 扫描插件贡献的 skill roots。
- `packages/agent-core/src/skill/registry.ts`
  - `renderSkillPrompt()` 把 `skillInstructions` 加到插件 skill 正文前。
- `packages/agent-core/src/agent/injection/plugin-session-start.ts`
  - 把 `sessionStart.skill` 渲染成一次性 session-start 注入。
  - 不执行插件 hook 代码。
  - resume/replay 时避免重复注入。

## Superpowers 验收方式

本地安装：

```sh
/plugins install /Users/moonshot/code/superpowers
/new
```

检查：

```sh
/plugins
/plugins info superpowers
```

必须看到：

- `skills` 数量大于 0。
- `Session start: using-superpowers`。
- `Skill instructions: present`。

行为验收：

```text
Let's make a react todo list
```

期望：

- 首轮先注入 `using-superpowers`。
- 模型随后触发 `brainstorming`，而不是直接写代码。
- 如果需要用户在具体选项中选择，应调用 Kimi 的 `AskUserQuestion`，让 TUI 出现结构化选择 UI。

如果没有出现结构化 UI，优先排查：

1. `.kimi-plugin/plugin.json` 是否真的被读取，而不是只装到了旧 `.codex-plugin` 包。
2. `/plugins info superpowers` 是否显示 `Session start` 和 `Skill instructions`。
3. `skillInstructions` 是否明确写了 `AskUserQuestion` 映射。
4. 当前模型是否实际遵守了工具映射；`skillInstructions` 是 prompt guidance，不是代码层硬替换。

## CDN beta 策略

Superpowers upstream 合入前，可以把本地适配包打成 zip 发到 CDN：

```text
superpowers-kimi-5.1.0-kimi.1.zip
```

包内容应该来自官方 `obra/superpowers` 对应 tag 或 commit，再加：

```text
.kimi-plugin/plugin.json
```

不要改：

```text
skills/**/*.md
```

除非是在准备给 upstream 提交且有行为评估证据。不要把 plugin id 改成
`superpowers-kimi`，保持：

```json
{ "name": "superpowers" }
```

这样 upstream 合入后可以把安装源从 CDN 切到官方包，用户侧仍是同一个 plugin id。

## Upstream PR 策略

Superpowers 接受的模式是“新增宿主薄适配”，不是 fork skills。

建议 PR 只包含：

```text
.kimi-plugin/plugin.json
docs/README.kimi.md
README.md 中 Kimi Code 安装入口
```

PR 前需要准备真实 transcript。Superpowers 贡献指南要求新 harness 支持必须证明
clean session 中发送：

```text
Let's make a react todo list
```

会自动触发 `brainstorming`。如果 transcript 里没有自动触发，先修 Kimi 侧或
manifest，不要提 PR。

PR 文案要明确：

- 这是 Kimi Code harness adapter。
- 不复制、不改写 Superpowers skills。
- Kimi 的 session start 是声明式 skill 注入，不执行第三方脚本。
- 需要 Kimi Code 版本包含 `.kimi-plugin/plugin.json` 和 `/plugins` 支持。

## 不做的事

- 不提交或自动打开 upstream PR。
- 不长期维护 Superpowers fork。
- 不通过 `.codex-plugin/plugin.json` 安装 Superpowers。
- 不在 Kimi core 里硬编码 `superpowers`。
- 不执行 Superpowers 的 hook 脚本。
