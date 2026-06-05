# Documentation Agent Guide

This repository uses VitePress for the documentation site. Most user-facing pages under `docs/en/` and `docs/zh/` are fully written; New or updated content should keep both locales in sync.

## Structure

- Locales live under `docs/en/` and `docs/zh/` with mirrored paths and filenames.
- Main sections (nav + sidebar) are:
  - Guides: getting-started, migration, use-cases, interaction, sessions
  - Customization: mcp, skills, plugins, datasource, agents, hooks
  - Configuration: config-files, providers, overrides, env-vars, data-locations
  - Reference: kimi-command, tools, slash-commands, keyboard
  - Release notes: changelog
- Navigation and sidebar are defined in `docs/.vitepress/config.ts`. Any new or renamed page must be wired there for both locales.

## Source of truth

- **Changelog page**: The English version (`docs/en/release-notes/changelog.md`) is the source of truth; the Chinese changelog should be translated from it. The changelog is currently generated manually by a skill that syncs from the CLI package's `CHANGELOG.md` after each release.
- **All other pages**: `docs/en/` and `docs/zh/` are mirrored pairs with the same paths, headings, and section structure. Edit whichever locale you are working in, and update the other locale in the same change.

Keep both locales in sync before release. Machine-assisted translation is fine; review the locale you changed and its mirror for accuracy, terminology, and broken links.

## Authoring workflow

- Each page should keep the section ordering established by surrounding pages. Changelog is the exception because it is generated from release history.
- For other pages: edit either locale, then update its mirror in the same change.

## Naming conventions

- Filenames are kebab-case and mirror across locales (same slug in `docs/en/` and `docs/zh/`).
- Use consistent section labels that match the sidebar titles.
- Use backticks for flags, commands, subcommands, command arguments, file paths, code identifiers, type names, field names, field values, and keyboard shortcuts.

## Wording conventions

- Do not change H1 titles or nav/sidebar labels.
- English H2+ headings use sentence case (only the first word capitalized unless it is a proper noun). Treat "Wire", "Plan mode", "YOLO mode", and "Thinking mode" as proper nouns; do not treat "agent" as a proper noun.
- Chinese H2+ headings keep English words in sentence case; preserve proper nouns listed in the term table below.
- Use `API key` in English and `API 密钥` in Chinese; keep `JSON`, `JSONL`, `OAuth`, `macOS`, `Node.js`, `npm`, `pnpm`, and `TypeScript` as-is.
- Use straight double quotes with spaces for quoted content: `"被引内容"` (not curly quotes). Add a space before and after the quoted text when adjacent to CJK characters. Use corner brackets `「」` for special terms (e.g., `「工具」`, `「会话」`).
- Prefer "终端" over "命令行" in Chinese when both are applicable (e.g., "运行在终端中", "终端界面", "终端操作").
- Use "工具调用" / "tool call", not "工具使用" / "tool use".
- Use inline code for tool names (e.g., `Read`, `Grep`, `Bash`).

Term mapping (Chinese <-> English, and proper noun handling):

| Chinese | English | Proper noun (zh) | Proper noun (en) |
| --- | --- | --- | --- |
| Agent | agent | yes | no |
| 主 Agent | main agent | yes (Agent) | no |
| 子 Agent | subagent | yes (Agent) | no |
| Shell | shell | yes | no |
| Plan 模式 | Plan mode | yes | yes (Plan mode) |
| YOLO 模式 | YOLO mode | yes | yes (YOLO mode) |
| Thinking 模式 | Thinking mode | yes | yes (Thinking mode) |
| MCP | MCP | yes | yes |
| Kimi Code CLI | Kimi Code CLI | yes | yes |
| Agent Skills | Agent Skills | yes | yes |
| Skill | skill | yes | no |
| 系统提示词 | system prompt | no | no |
| 提示词 | prompt | no | no |
| 会话 | session | no | no |
| 上下文 | context | no | no |
| API 密钥 | API key | yes | no |
| JSON | JSON | yes | yes |
| JSONL | JSONL | yes | yes |
| OAuth | OAuth | yes | yes |
| macOS | macOS | yes | yes |
| TypeScript | TypeScript | yes | yes |
| Node.js | Node.js | yes | yes |
| npm | npm | yes | yes |
| pnpm | pnpm | yes | yes |
| kimi | kimi | yes | yes |
| 审批请求 | approval request | no | no |
| 斜杠命令 | slash command | no | no |
| 工具调用 | tool call | no | no |
| Frontmatter | frontmatter | yes | no |
| User 消息 | user message | yes (User) | no |
| Assistant 消息 | assistant message | yes (Assistant) | no |
| Tool 消息 | tool message | yes (Tool) | no |
| 轮次 | turn | no | no |
| 供应商 | provider | no | no |
| Prompt Flow | Prompt Flow | yes | yes |
| Diff | diff | yes | no |

## Typography

- **Spacing around mixed content**: Add a space between Chinese characters and English words, numbers, inline code, or links. Exception: no space before full-width punctuation.
  - ✓ 在 TypeScript 中使用 `class` 关键字
  - ✗ 在TypeScript中使用`class`关键字
  - ✓ 详见 [配置文件](./config.md)。
  - ✗ 详见[配置文件](./config.md)。
- **Full-width punctuation**: Use full-width punctuation in Chinese text: `，。；：？！（）` not `, . ; : ? ! ( )`.
- **Keyboard shortcuts**: Use hyphen between modifier and key (`Ctrl-C`, `Ctrl-D`, `Shift-Tab`, `Alt-V`), not plus sign. Exception: literal application output (e.g., the `Press Ctrl+C again to exit` hint produced by the product itself) keeps its exact rendering.
- **Code block language**: Always specify language for fenced code blocks (e.g., ` ```sh `, ` ```toml `, ` ```json `, ` ```ts `). Exception: natural language examples (user prompts) may omit the language.
- **Callout titles**: Use short category titles for callout blocks (`::: tip`, `::: warning`, `::: info`, `::: danger`). Put the detailed description in the block content, not the title.
  - Chinese: use `提示` for tip, `注意` for warning, `说明` for info, `警告` for danger.
  - English: use no title or short words like `Note` for warning.
  - ✓ `::: tip 提示` + content starting with the key point
  - ✓ `::: warning 注意` + content `\`KIMI_CODE_HOME\` 不影响 Skills 的搜索路径。...`
  - ✗ `::: warning 不影响 Skills` (title too long, should be in content)
  - ✗ `::: tip Skills 路径独立于 KIMI_CODE_HOME` (title too long)
- **Version info blocks**: For version change callouts, use `::: info` with a category title (Added/Changed/Removed in English; 新增/变更/移除 in Chinese). The content should be a complete sentence.
  - ✓ `::: info 新增` + content `新增于 0.2.0。`
  - ✗ `::: info 新增于 0.2.0` (title too long)
  - ✓ `::: info Changed` + content `Renamed in 0.2.0. ...`
  - ✗ `::: info Renamed in 0.2.0` (title too long)

## Writing style

- **Natural narrative**: Organize content like writing an article, guiding readers smoothly through the material.
- **Avoid fragmentation**: Don't turn every point into a subheading; use paragraph transitions instead.
- **Global perspective**: "Getting Started" introduces core concepts only; detailed usage belongs in later pages.
- **Progressive depth**: Guides → Customization → Configuration → Reference, information deepens gradually.
- **No "next steps"**: VitePress already provides prev/next navigation; don't add manual `::: tip 接下来` blocks at page end.

### Example: good vs bad

Outline prompt:

```
* Install and upgrade
  * System requirements: Node.js 24.15.0+, recommend pnpm
  * Install, upgrade, uninstall steps
```

**Bad** (mechanical conversion to headings):

```markdown
## Install and upgrade

### System requirements

- Node.js 24.15.0+
- Recommend pnpm

### Install

...

### Upgrade

...
```

**Good** (natural narrative):

```markdown
## Install and upgrade

Kimi Code CLI requires Node.js 24.15.0 or later. We recommend using pnpm for installation and management.

If you haven't installed pnpm yet, please refer to the pnpm installation docs first. Install Kimi Code CLI:

(code block)

Verify the installation:

(code block)

Upgrade to the latest version:

(code block)
```

## Build and preview

- Docs are built with VitePress from `docs/`.
- Common commands (run inside `docs/`):
  - `npm install`
  - `npm run dev`
  - `npm run build`
  - `npm run preview`
- The build output is `docs/.vitepress/dist`.

## Changelog syncing

See `sync-changelog` skill for the changelog generation workflow.
