# Agent Skills

Agent Skills are a lightweight mechanism for extending model capabilities in Kimi Code CLI. A Skill is a Markdown document with YAML frontmatter that describes a specialized area of knowledge or a workflow — for example, a project's code style guidelines, a PR review process, or a commit message format.

Compared to pasting the same instructions into a prompt every time, Skills offer the advantage of keeping content in a file, enabling reuse across projects and teams, allowing instant loading via a slash command, and letting the model invoke them automatically when needed.

## Creating a Skill

Skill files must be placed in a [known scan directory](#skill-locations). Two file structures are supported:

- **Directory form (recommended)**: Create a subdirectory under the Skills directory, name the main file `SKILL.md`, and place scripts, reference materials, and other supporting files in the same directory. When both `<name>/SKILL.md` and a same-named `<name>.md` exist in the same directory, the subdirectory takes precedence.
- **Flat form**: Use a single `.md` file directly; the Skill name is taken from the filename (minus `.md`).

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
| `name` | Skill name. Required in a directory-form `SKILL.md`; when omitted in a flat `.md` file, the filename is used. Names are case-insensitive |
| `description` | A one-line summary; the model uses this to decide when to use the Skill. Required in a directory-form `SKILL.md`; when omitted in a flat `.md` file, falls back to the first non-empty line of the body (up to 240 characters) |
| `type` | Skill type: `prompt` (default), `inline` (same semantics as `prompt`), `flow` (manual invocation only; not available for automatic model invocation). Other values are skipped |
| `whenToUse` | Description of when the Skill should be triggered. Also accepts `when-to-use` and `when_to_use` |
| `disableModelInvocation` | When set to `true`, prevents the model from invoking this Skill automatically. Also accepts `disable-model-invocation` and `disable_model_invocation` |
| `arguments` | List of named parameters; can be written as a string array or a whitespace-separated string (e.g., `arguments: target mode`). Once declared, parameters can be read in the body with `$<name>` |

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
- `~/.kimi-code/skills/`
- `~/.agents/skills/`

**Project level** (project root = the nearest directory containing `.git`, searching upward from the working directory):
- `.kimi-code/skills/`
- `.agents/skills/`

**Extra directories**: Declared via `extra_skill_dirs` at the top level of `config.toml`:

```toml
extra_skill_dirs = ["~/team-skills", ".agents/team-skills"]
```

**Built-in Skills** are distributed with the CLI and have the lowest priority.

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

Save this as `~/.kimi-code/skills/review-pr/SKILL.md`, place the checklist at `references/checklist.md` in the same directory, and after starting a new session you can invoke it with `/skill:review-pr #1234`, where `#1234` is expanded into `$pr_ref`.

## Next steps

- [Plugins](./plugins.md) — Package Skills into installable units to share with your team
- [Agents and sub-agents](./agents.md) — How Skills influence sub-agent behavior
