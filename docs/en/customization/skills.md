# Agent Skills

Agent Skills are a lightweight mechanism for extending model capabilities in Kimi Code CLI. A Skill is a Markdown document with YAML frontmatter that describes a specialized area of knowledge or a workflow: a project's code style guidelines, a PR review process, or a commit message format.

Compared to pasting the same instructions into a prompt every time, Skills offer the advantage of keeping content in a file, enabling reuse across projects and teams, allowing instant loading via a slash command, and letting the model invoke them automatically when needed.

## Creating a Skill

Skill files must be placed in a [known scan directory](#skill-locations). Two file structures are supported:

- **Directory form (recommended)**: Create a subdirectory under the skills directory with the main file named `SKILL.md`, and place scripts, reference material, and other supporting files alongside it.
- **Flat form**: Skip the subdirectory and drop a single `.md` file directly into the skills directory — handy for simple Skills that need no supporting files.

Both structures register a Skill; they differ only in how the files are organized:

```text
skills/
├── review-pr/              # Directory form → Skill name review-pr
│   ├── SKILL.md            # Main file
│   └── checklist.md        # Supporting file, referenced via ${KIMI_SKILL_DIR}
└── commit.md               # Flat form → Skill name commit
```

How the Skill name is derived:

- Directory form: from the required frontmatter `name` field (see the table below); by convention the subdirectory carries the same name — `review-pr/SKILL.md` with `name: review-pr` registers as `review-pr`.
- Flat form: `name` may be omitted, falling back to the filename without the `.md` extension — `commit.md` registers as `commit`. The extension is stripped only from the registered Skill name; the file on disk must keep its `.md` extension to be picked up by the scanner, so don't actually create an extensionless `commit` file.
- When both `<name>/SKILL.md` and `<name>.md` exist in the same directory, the directory form wins and the flat file is ignored.

Two limitations of the flat form:

- Only `.md` files placed directly at the top level of a skills directory are recognized; loose `.md` files inside subdirectories (other than `SKILL.md`) are not treated as Skills.
- A flat Skill has no directory of its own, so `${KIMI_SKILL_DIR}` points at the skills directory itself — switch to the directory form whenever the Skill needs supporting files.

### File Format

`SKILL.md` consists of two parts: YAML frontmatter and a Markdown body:

```markdown
---
name: code-style
description: Project code style guidelines defining naming, indentation, comments, and file organization
type: prompt
whenToUse: When the user asks me to write, modify, or review project source code
disableModelInvocation: false
arguments:
  - target
  - mode
---

Please handle code according to the following guidelines:

- Use 2-space indentation
- Variable names use `camelCase`, type names use `PascalCase`
- Public functions must have TSDoc comments
- Lines must not exceed 100 characters
```

### Frontmatter Fields

| Field | Description |
| --- | --- |
| `name` | Skill name (case-insensitive). Required in directory-form `SKILL.md`; flat `.md` falls back to the filename without the `.md` extension |
| `description` | One-line summary the model uses to decide when to invoke. Required in directory-form `SKILL.md`; flat `.md` falls back to the first non-empty body line (up to 240 characters) |
| `type` | Skill type: `prompt` (default), `inline` (same as `prompt`), `flow` (manual invocation only). Other values are skipped |
| `whenToUse` | Description of when the Skill should be triggered. Also accepts `when-to-use` and `when_to_use` |
| `disableModelInvocation` | If `true`, blocks automatic model invocation. Also accepts `disable-model-invocation`, `disable_model_invocation` |
| `arguments` | Named parameters; a string array or whitespace-separated string (e.g., `arguments: target mode`). Once declared, readable in the body as `$<name>` |

::: warning Note
In a directory-form `SKILL.md`, both `name` and `description` **must** be explicitly provided. Omitting either one will cause parsing to fail.
:::

### Body Placeholders

Before the body is sent to the model, a small set of placeholders are expanded:

- `$ARGUMENTS`: The full raw argument string passed at invocation
- `$ARGUMENTS[0]`, `$ARGUMENTS[1]` and shorthand `$0`, `$1`: Positional arguments after whitespace tokenization (zero-indexed)
- `$<name>`: Named parameters declared in `arguments`
- `${KIMI_SKILL_DIR}`: The directory containing the current Skill file

Positional arguments support single and double quoting, so in `/skill:commit "fix login" patch`, `$0` expands to `fix login`. If the body contains no argument placeholders, text passed at invocation is appended to the end of the body as `\n\nARGUMENTS: <text>`.

## Skill Locations

Kimi Code CLI scans four tiers by scope; more specific scopes take higher priority: **Project > User > Extra > Built-in**

**User level** (applies to all projects):
- `$KIMI_CODE_HOME/skills/` (default: `~/.kimi-code/skills/`)
- `~/.agents/skills/`

The Kimi-specific user Skill directory moves with `KIMI_CODE_HOME`, so isolated data roots also get isolated Kimi-specific Skills. The generic `~/.agents/skills/` directory stays under the real OS home so it can be shared across tools.

**Project level** (project root = the nearest directory containing `.git`, searching upward from the working directory):
- `.kimi-code/skills/`
- `.agents/skills/`

**Extra directories**: Declared via `extra_skill_dirs` at the top level of `config.toml`:

```toml
extra_skill_dirs = ["~/team-skills", ".agents/team-skills"]
```

**Built-in Skills** are distributed with the CLI and have the lowest priority. They provide out-of-the-box workflows for common tasks: configuring MCP servers, customizing the TUI theme, and editing config files. See [Built-in skill commands](../reference/slash-commands.md#built-in-skill-commands) for the full list. Those describing Kimi Code itself can be turned off with the top-level [`builtin_product_skills`](../configuration/config-files.md#top-level-fields) field.

## Invoking a Skill

Users can invoke a Skill manually with a slash command:

```
/skill:code-style
/skill:git-commits fix concurrency issue in login endpoint
```

The model can also invoke a Skill automatically based on `description` and `whenToUse` (unless `disableModelInvocation` is `true` or `type` is `flow`). Skill invocations allow up to 3 levels of nesting; beyond that they are terminated.

## Complete Example

```markdown
---
name: review-pr
description: Review a Pull Request according to team standards and produce a structured review report
type: prompt
whenToUse: When the user asks me to review a PR, inspect code changes, or evaluate commit quality
arguments:
  - pr_ref
---

Please review the PR the user specified: $pr_ref

1. Fetch and read the full diff for `$pr_ref`.
2. Check each of the following items:
   - Whether corresponding test cases are included
   - Whether public API documentation has been updated
   - Whether new dependencies have been introduced; if so, state the reason
   - Whether error handling covers edge cases
3. Refer to the checklist in the same directory: `references/checklist.md`
4. Produce a review report containing:
   - Overall conclusion (approve / request changes / comment)
   - Required changes (blocking)
   - Suggested improvements (non-blocking)
   - Noteworthy positives
```

Save this as `$KIMI_CODE_HOME/skills/review-pr/SKILL.md` (or `~/.kimi-code/skills/review-pr/SKILL.md` when `KIMI_CODE_HOME` is unset), place the checklist at `references/checklist.md` in the same directory, and after starting a new session you can invoke it with `/skill:review-pr #1234`, where `#1234` is expanded into `$pr_ref`.

## Next steps

- [Plugins](./plugins.md) — Package Skills into installable units to share with your team
- [Agents and sub-agents](./agents.md) — How Skills influence sub-agent behavior
