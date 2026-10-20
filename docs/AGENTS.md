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

Additional sourcing rules:

- **Document only what the current released version does.** Released opt-in experiments are in scope when the docs state their default and how to enable them; code that is unreleased or internal-only must not appear in user docs. When release status is unclear, document the current released version.
- **One fact, one authoritative home.** When a mechanism is fully defined on one page, other pages state only what it is and how it relates to the current task, then link to the exact section. Never expand the same fact in two places.
- **Confirm the source of truth before editing.** Know which locale owns the page (see above), edit the source, and sync the mirror in the same change. If the two locales fall out of sync, say so in the PR description — never silently drop or rewrite one side.

## Authoring workflow

- Each page should keep the section ordering established by surrounding pages. Changelog is the exception because it is generated from release history.
- For other pages: edit either locale, then update its mirror in the same change.

Before rewriting a page, always: (1) understand why the original is structured the way it is — what question each block answers and whether facts, dependencies, or ordering are tangled together, (2) review necessity — what the reader genuinely needs to know, meaning what they could not act, decide, or troubleshoot without, (3) sketch the section structure, then (4) fill in the content. Skip steps 1–3 and you will lose content while rearranging format.

## Page responsibilities

Decide the page's job before writing or restructuring it; the job decides what the page keeps and which format it uses.

| Page type | Primary job | Out of scope |
| --- | --- | --- |
| Overview | Capability summary and entry points | Full parameter and operation details |
| Guide | Complete one task on the shortest path | The complete command contract |
| Reference | The single complete definition of commands, parameters, return values, and limits | Tutorials and marketing copy |
| Configuration | Fields, precedence, overrides, and when they take effect | Use cases already covered on other pages |
| FAQ / error reference | Problem, cause, and fix | Re-explaining the whole mechanism |

## Readers

Kimi Code documentation serves two overlapping audiences. Write for both simultaneously.

**Technical users** — familiar with the terminal, config files, API keys, and environment variables. Give them commands and paths directly; do not explain basics.

**Non-technical AI users** — product managers, designers, operators — who use AI tools but are unfamiliar with terms like "stdin", "exit code", or "regex". They primarily interact through VS Code or config files rather than writing scripts.

Both groups share the same behavior: they arrive with a specific goal, scan headings and first sentences before reading further, execute steps in order, and copy-paste code blocks directly. They abandon pages when they hit unexplained jargon.

**Writing targets:**
- Technical users: complete a task in under 5 minutes, no filler.
- Non-technical users: copy-paste their way to a working setup and roughly understand what it does, without needing to understand the underlying mechanics.

**Jargon rule:** On first use, add a plain-English gloss in parentheses. Use the term normally afterwards.

> Example: `stdin` (the channel a program reads input from), `exit code` (the status number a program returns when it finishes; 0 means success).

## Naming conventions

- Filenames are kebab-case and mirror across locales (same slug in `docs/en/` and `docs/zh/`).
- Use consistent section labels that match the sidebar titles.
- Use backticks for flags, commands, subcommands, command arguments, file paths, code identifiers, type names, field names, field values, and keyboard shortcuts.

## Wording conventions

- Do not change H1 titles or nav/sidebar labels.
- English H2+ headings use sentence case (only the first word capitalized unless it is a proper noun). Treat "Wire", "Plan mode", "Thinking mode", and the permission mode names "Always Ask", "Ask When Needed", and "Never Ask" as proper nouns; do not treat "agent" as a proper noun.
- Chinese H2+ headings keep English words in sentence case; preserve proper nouns listed in the term table below.
- Use `API key` in English and `API 密钥` in Chinese; keep `JSON`, `JSONL`, `OAuth`, `macOS`, `Node.js`, `npm`, `pnpm`, and `TypeScript` as-is.
- Use curly double quotes `“”` for quoted content in Chinese body text (not straight quotes). Reserve corner brackets `「」` for genuinely special terms and use them sparingly — if they appear more than a few times on one page, reconsider.
- Use “终端” for the runtime environment or interface (“终端界面”, “终端操作”); use “命令行” for the CLI product form and for command-line options.
- Use "工具调用" / "tool call", not "工具使用" / "tool use".
- Use inline code for tool names (e.g., `Read`, `Grep`, `Bash`).

Term mapping (Chinese <-> English, and proper noun handling):

| Chinese | English | Proper noun (zh) | Proper noun (en) |
| --- | --- | --- | --- |
| Agent | agent | yes | no |
| main agent | main agent | no | no |
| subagent | subagent | no | no |
| Shell | shell | yes | no |
| Plan 模式 | Plan mode | yes | yes (Plan mode) |
| 始终询问 | Always Ask | yes | yes |
| 必要时询问 | Ask When Needed | yes | yes |
| 完全自动 | Never Ask | yes | yes |
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

Chinese UI wording — prefer natural Chinese over transliterated UI nouns:

| Use (zh) | Avoid | Note |
| --- | --- | --- |
| 桌面端 | Desktop | The Kimi Code desktop app form |
| 命令行 | CLI | The CLI product form; the full product name stays Kimi Code CLI |
| 输入框 | composer | The command input area |

### Kimi platform rules

Two distinct platforms exist and must never be mixed:

| | Kimi Code platform | Kimi Open Platform |
|---|---|---|
| Audience | Individual developers, subscription-based | Enterprise / product integration, pay-per-token |
| OpenAI-compatible base URL | `https://api.kimi.com/coding/v1` (mainland China), `https://api.kimi.ai/coding/v1` (global) | `https://api.moonshot.cn/v1` (mainland China), `https://api.moonshot.ai/v1` (global) |
| Anthropic-compatible base URL | `https://api.kimi.com/coding/` (mainland China), `https://api.kimi.ai/coding/` (global) | Not supported |
| API key entry | [Kimi Code console](https://www.kimi.com/code/console) (mainland China), [Kimi Code console](https://www.kimi.ai/code/console) (global) | [platform.kimi.com](https://platform.kimi.com) (mainland China), [platform.kimi.ai](https://platform.kimi.ai) (global) |

Rules:
- For Kimi Code managed/OAuth examples in CLI or VS Code docs, use `api.kimi.com/coding/…` (mainland China) or `api.kimi.ai/coding/…` (global). Never use Open Platform hosts for those managed accounts.
- When documenting Open Platform providers or third-party integrations, including direct API-key providers used from CLI or VS Code, use `api.moonshot.cn/v1` (mainland China) or `api.moonshot.ai/v1` (global). The Open Platform has no Anthropic-compatible endpoint.
- Base URL tables always list both the mainland China and global addresses in both locales. Config examples give one concrete value matching the page's language: Chinese pages use the mainland China address, English pages use the global address.
- Distinguish context explicitly: "in Kimi Code CLI / VS Code" vs "in third-party tools / your own product".
- Product full names: **Kimi Code CLI** and **Kimi Code for VS Code**. Do not abbreviate to "Kimi CLI".

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
  - ✓ `::: warning 注意` + content `部分 \`.agents\` 资源不受 \`KIMI_CODE_HOME\` 影响。...`
  - ✗ `::: warning 不影响 .agents` (title too long, should be in content)
  - ✗ `::: tip .agents 路径独立于 KIMI_CODE_HOME` (title too long)
- **Version info blocks**: For version change callouts, use `::: info` with a category title (Added/Changed/Removed in English; 新增/变更/移除 in Chinese). The content should be a complete sentence.
  - ✓ `::: info 新增` + content `新增于 0.2.0。`
  - ✗ `::: info 新增于 0.2.0` (title too long)
  - ✓ `::: info Changed` + content `Renamed in 0.2.0. ...`
  - ✗ `::: info Renamed in 0.2.0` (title too long)
- **Callout syntax**: Use `:::` for standalone callouts. `::::` is valid only as the outer fence of a nested container and must be correctly closed; an unclosed or mismatched `::::` breaks page rendering. When nesting is not needed, use a `>` blockquote inside a callout for secondary notes instead.

## Writing style

- **Natural narrative**: Organize content like writing an article, guiding readers smoothly through the material.
- **Avoid fragmentation**: Don't turn every point into a subheading; use paragraph transitions instead. This applies to narrative content — explanations, motivations, and sequential reasoning that flow as connected prose.
- **Global perspective**: "Getting Started" introduces core concepts only; detailed usage belongs in later pages.
- **Progressive depth**: Guides → Customization → Configuration → Reference, information deepens gradually.
- **No nav tip blocks**: VitePress provides automatic prev/next navigation; don't add `::: tip 接下来` blocks at page end. A `## Next steps` section is appropriate when there are closely related follow-on pages — see [Page structure](#page-structure).
- **One idea per paragraph**: Each paragraph makes one point. 3–4 sentences is the target; split when a paragraph exceeds 5 sentences.
- **Map before detail**: Every page and every major section should open with one "map" sentence — what this section covers and how it relates to what came before — before expanding into details. Readers should know where they are before they dive in.

  > ❌ Jump straight to detail: "Credential resolution has three steps: first read `api_key`…"
  >
  > ✓ Map then detail: "Provider credentials follow a separate resolution path from ordinary runtime parameters — the CLI reads only from `config.toml` and never falls back to shell environment variables. The priority order is:…"

- **Parallel content needs formatting**: This is the counterpart to "avoid fragmentation" — the distinction is what kind of content you have. Multiple items of the same kind (file descriptions, config field explanations, caveats) written as separate paragraphs with no visual distinction force readers to parse shape instead of meaning. Fix:
  - Each item is "name + one sentence": use an unordered list: `- **Name**: description`
  - Multiple dimensions (name + type + description): use a table
  - Each item is longer than two sentences: use a `###` subheading
- **Sections follow a discernible sequence**: order sections by the reader's task flow or by a classification of one concept. The next section should answer the question the previous one naturally raises; do not park loosely related features in the same section.

### Chinese prose rules

- **Write Chinese body text in Chinese.** Do not mix English words into sentences; keep product full names (Kimi Code CLI) and term-table entries as-is, and render UI nouns as natural Chinese rather than transliterating them (see the wording table in [Wording conventions](#wording-conventions)).
- **Drop filler that adds no fact.** Banned patterns: 值得注意的是 / 首先、其次、最后 / 总而言之、综上所述 / 你会发现 / 进行安装、轻松搞定 / 强大、灵活、高效、无缝. State the fact directly; use an ordered list for a real sequence; replace praise with verifiable behavior, numbers, or limits.
- **Delete colloquial 了 in rules and statements of fact.** Write 取消、新增、修改, not 取消了、新增了、改了.
- **Avoid explanatory em-dashes (——).** Rewrite as a period, colon, or list instead.
- **Parentheses carry facts, not filler.** Drop circular glosses (`glob（glob 过滤）`) and enumerative examples in parentheses; keep defaults, permission numbers, path rules, and version ranges. Not every detail needs to be shown to the reader: omit details that do not help them act, decide, or troubleshoot instead of tucking them into parentheses.

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

## Format decisions

Choose the format that matches the content's structure, not the one that looks most thorough.

**Most suitable format** — use formatting deliberately, not sparingly by default. Choose the format that best matches the content and the reader's task: sentence, list, table, subheading, or `<details>`. Use formatting when it improves scanning, lookup, or comparison; do not upgrade just because a richer format looks more thorough.

**Ordered list** — steps that must happen in sequence (installation, configuration, migration). Do not nest sub-lists inside steps.

**Unordered list** — parallel items with no ordering dependency. Format: `- **Name**: one-sentence description`.

**Table** — reference content with multiple dimensions to compare or look up (config fields with name + type + required + description; keyboard shortcuts; platform comparison). Avoid tables when cell content would need to wrap to be readable.

**Prose** — explanations, motivations, caveats, anything that flows naturally as connected sentences. Do not convert prose into bullets just to add visual structure.

**Cards** — at least three entries of the same shape where the reader is choosing a direction. Not for steps, full explanations, or parameter reference. Follow existing page implementations for cards, icons, and other components; do not invent one-off styles.

**`<details>` boundaries** — fold only low-frequency material that must be kept: edge behavior, full default sets, implementation background, supplementary examples. Never fold commands the user must run, prerequisites, permission or security boundaries, failure consequences, or what to run after a change.

**Reference pages need a navigation layer** — a page covering many commands, tools, or APIs opens with a quick-reference table covering every entry, each row linking to a detail section with a stable anchor below. The table provides navigation and minimal usage; the detail sections own the facts. When adding a detail section, add its row to the table.

## Cross-references

Readers never read just one page. A complete understanding is usually spread across several pages. Add links wherever they help.

**Always link when:**
1. A concept mentioned on this page has a full explanation on another page — link to it on first mention, not the second or third. Prefer anchors (`#section`) over page-top links when the relevant content is in a specific section.
2. This page gives a brief summary while another page has the full field reference or example — link the summary to the detail.
3. A later section on this page depends on a concept defined earlier on this page — back-link with `[term](#anchor)` so readers don't have to scroll.

**Do not write:**
- "See related documentation" — which one? Readers skip this.
- Link only in a "Next steps" list at the bottom — readers who hit a blocker mid-page won't scroll to the end to find the link.
- First mention without a link, linked on second or third mention — the first mention is when the reader most wants to click.

**Inline links vs "Next steps":** Inline links serve readers who need supplemental information mid-page. A closing "Next steps" section serves readers who finished the page and want natural follow-on reading. Both have a place; neither replaces the other.

## Page structure

```
# Title (noun phrase, no period)

Opening sentence or two + plain-English summary (only when the concept has a learning curve)

> blockquote (optional: Beta notice, prerequisites)

Supplementary context / use-case list (optional)

Diagram (optional)

::: warning Banner (deprecation, breaking change, security notice — after opening content, before first ##)

## First section

Body…

## Next steps (optional, only when related pages exist)
- [Page name](/path) — one sentence describing what the reader can do there
```

**Banner placement rule:** Banners must appear after all opening content (opening sentences, blockquote, diagram) and before the first `##`. A banner must never be the first thing on the page.

## Content completeness

**Default position: keep everything.** When editing a page, every block of original content needs an explicit destination — either retained or consciously removed with a stated reason. Reference pages default to keeping everything: parameters, defaults, limits, error behavior, and complete examples are all lookup facts. Guide pages may drop or move content, with a stated reason.

**Valid reasons to omit content:**
- Pure implementation detail that users cannot change (keep failure facts and workarounds)
- Field listings already shown in full by another page or a product-generated schema — supplement with defaults, constraints, and quotas instead of repeating them
- Content already fully expressed by a table on the same page
- Already covered more completely on another page that is linked from here
- Content is ambiguous or suspected outdated — flag it rather than silently dropping it

**Not valid reasons:**
- "Seems unimportant" — that is a guess, not a reason
- "I'm not sure about this" — research it rather than omitting it
- "The page is getting long" — restructure, do not cut

If content is omitted, note it explicitly in the PR description or commit message. Do not write omission notices inside the document itself.

## Checklist

Run through this before marking any doc change ready for review.

### Format

| Problem | Fix |
|---|---|
| `::::` unclosed or mismatched | Close the fence or replace with `:::` if nesting is not needed |
| Nested callout containers | Change inner one to `>` blockquote |
| Banner before first `##` but also before opening content | Move to after opening sentences / blockquote / diagram |
| Steps written as unordered list | Change to ordered list |
| Multi-dimension comparison written as prose | Convert to table |
| Table cells that take more than a glance to read | Restructure as a list or subheadings — tables are for lookup, and cells should stay short enough to scan at a glance |
| Technical term used without explanation on first occurrence | Add plain-English gloss in parentheses |
| Cross-reference written as "see …" with no link | Add inline link; prefer anchor to section, not just page top |
| Concept depends on earlier definition but no back-link | Add `[term](#anchor)` |
| Anchor link checked only against the Markdown source | Verify the fragment in the built page (`docs/.vitepress/dist`), not just that the page returns 200 |
| Template literal (`${...}`, `{{...}}`, `<item>`) missing or empty in the rendered page | Inspect the built HTML — Vue/VitePress may treat `<...>` as HTML or a template; an empty `<code>` in the output is a failure |
| Layout checked only at desktop width | Check the changed page at ~1440px and ~390px: tables, inline code, long headings, callouts, and `<details>` blocks |
| Changed zh without changing en (or vice versa) | Update both locales |
| Code block has no language tag | Add language (e.g., `sh`, `toml`, `json`); exception: natural-language prompt examples may omit the tag |

### Kimi-specific consistency

Before shipping, verify these values match the rest of the docs:

- **Base URL**: matches the [Kimi platform rules](#kimi-platform-rules) table above
- **Upgrade command**: matches `guides/getting-started.md`
- **Model ID**: use `kimi-for-coding`, not a versioned model name
- **Login command**: `/login`, not `/setup`
- **Product full name**: **Kimi Code CLI** or **Kimi Code for VS Code** — never "Kimi CLI"
- **Platform URLs**: Kimi Code platform `api.kimi.com/coding/…` (mainland China) / `api.kimi.ai/coding/…` (global); Open Platform `api.moonshot.cn/v1` (mainland China) / `api.moonshot.ai/v1` (global) — never mix the two

### Acceptance order

Run these in order after any doc change; report done only after every step passes.

1. `git diff --check`.
2. `npm run build` (see [Build and preview](#build-and-preview)).
3. On the built output, verify internal links, anchors, and template literals on every changed page — target page, heading, and generated fragment must all match. Do not trust the Markdown source alone.
4. View each changed page at ~1440px and ~390px: tables, inline code, long headings, callouts, and `<details>` blocks.
5. Compare zh and en side by side: headings, code blocks, images, links, and key facts.

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
