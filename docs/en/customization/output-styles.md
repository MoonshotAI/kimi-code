# Custom Output Styles

An output style is a set of instructions injected into Kimi Code's system prompt to shape **how** the assistant responds — its tone, format, and verbosity. Styles are **additive**: they layer on top of Kimi Code's default behavior and never override correctness, safety, or what a task actually requires. Two styles are built in (`concise` and `explanatory`), and you can add your own as Markdown files.

## Built-in styles

| Name | What it does |
| --- | --- |
| `concise` | Terse, minimal-prose responses focused on the result — skips preamble, restating the question, and summaries unless asked. |
| `explanatory` | Explains the reasoning behind notable decisions and trade-offs, teaching as it works. |

Built-in styles always exist. A style file you create with the same name overrides the built-in one.

## Create a style

Add a `.md` file to an output-styles directory:

- **Project scope** — `<git-root>/.kimi-code/output-styles/`, where `<git-root>` is the nearest ancestor of the working directory that contains a `.git` directory (or the working directory itself when there is no git repository). Style files in other subdirectories are not scanned.
- **User scope** — `~/.kimi-code/output-styles/`, or `$KIMI_CODE_HOME/output-styles/` when the `KIMI_CODE_HOME` environment variable is set

Style files are read from the local filesystem, so when you run Kimi Code against a remote host (for example over SSH), keep your style files on the local machine.

Create the directory if it does not exist. The **filename is the style name** when no `name` is set in the frontmatter: `socratic.md` becomes the style `socratic`.

A style file is optional YAML frontmatter followed by the instruction body:

```md
---
name: socratic
description: Answers with guiding questions instead of handing over solutions.
---
Guide the user toward the answer with focused questions rather than handing over
the full solution immediately. Once they are close, confirm and fill in the
remaining details. Keep each reply short.
```

Fields:

- `name` (optional): the style identifier. Falls back to the filename without `.md`.
- `description` (optional): a human-readable summary. Falls back to the first non-empty line of the body.
- **body** (required): the instructions injected into the system prompt. A file with an empty body is skipped.

## Precedence

When more than one scope defines a style with the same name, the more specific scope wins: **project overrides user overrides built-in**.

## Select a style

Set `output_style` to the style name in `config.toml`:

```toml
# ~/.kimi-code/config.toml
output_style = "concise"
```

`output_style` is applied when an agent's system prompt is built. A **new session's** main agent uses the current value, and subagents pick it up on every spawn. An already-running session keeps its main agent's system prompt, so `/reload` and resume do **not** change the main agent's style — start a new session to apply a change. Leave `output_style` unset for the default behavior.

## What happens on errors

Output styles are designed never to block startup:

- **An invalid or empty style file** (malformed YAML frontmatter, empty body): that file is skipped; the other styles still load.
- **`output_style` names a style that does not exist**: no style is injected, and Kimi Code runs with its default behavior.
