---
name: custom-theme
description: Create or edit a kimi-code custom color theme — a JSON file under the resolved KIMI_CODE_HOME data directory that recolors the TUI. Use when the user wants their own theme, asks for a specific palette or mood, or wants to tweak an existing custom theme's colors.
---

# Create a kimi-code custom theme (custom-theme)

Help the user design, write, and apply a custom color theme for the kimi-code TUI. A theme is a single JSON file; the TUI ships with `dark`, `light`, and `auto`, and any file the user adds becomes selectable alongside them.

## Rules of engagement

- **Never write a theme until the user has explicitly clarified what they want.** This skill may only run after the user has confirmed light vs dark, the style or mood, any specific colors they care about, and the intended filename. If any of these are missing, ask before creating files.
- **Never assume the data directory is `~/.kimi-code`.** Always resolve `$KIMI_CODE_HOME` first with the Bash command below.
- **Never edit a live theme file in place.** Always create a `.json.new` candidate, validate it, back up the old file, and then `mv` it into place.
- **Never overwrite an existing theme without reading it first.** Read, back up, then overwrite only after the user confirms.

## Where a theme lives

The kimi-code runtime resolves the data directory as `KIMI_CODE_HOME` first, falling back to `~/.kimi-code`. Theme files live inside the `themes/` subdirectory of that data directory.

Before doing anything, resolve the actual data root with Bash so you don't write to the wrong place. Check whether `KIMI_CODE_HOME` is set and fall back to `~/.kimi-code` when it is empty:

```bash
echo "$KIMI_CODE_HOME"
echo "$HOME/.kimi-code"
```

Use the first line when it is non-empty; otherwise use the second line. In the rest of this skill, `<KIMI_CODE_HOME>` means that resolved data root — **never assume `~/.kimi-code`**. Theme files live at `<KIMI_CODE_HOME>/themes/<name>.json`. Create the `themes/` directory if it doesn't exist.

## What a theme is

- A theme lives at `<KIMI_CODE_HOME>/themes/<name>.json`.
- **The filename is the theme name**: `ember.json` shows up in the `/theme` picker as `Custom: ember`.
- Shape:

  ```json
  {
    "name": "ember",
    "displayName": "Ember",
    "colors": {
      "primary": "#83A598",
      "accent": "#FE8019"
    }
  }
  ```

  - `name` (required), `displayName` (optional), `base` (optional: `"dark"` default, or `"light"`), `colors` (each value a 6-digit hex `#RRGGBB`).
- **Partial themes are fine**: any token you leave out falls back to the **base** palette (`dark` by default; set `"base": "light"` for a light theme), so you can recolor just a few tokens or all of them.

## Source of truth: the docs token reference

Before choosing colors, use **FetchURL** to fetch the official custom-theme docs as the authoritative list of tokens and what each controls:

```
https://moonshotai.github.io/kimi-code/en/customization/themes.html
```

Only set tokens from this set — unknown keys are silently ignored at load. If FetchURL is unavailable or the fetch fails, fall back to the embedded reference below (it mirrors the same tokens) and tell the user you're working from the built-in list rather than the live docs.

## Color tokens (what each controls)

| Token | Controls |
| --- | --- |
| `primary` | The most-used color: links, inline code, the selected item in nearly every dialog, the focused editor border, plan/"running" badges, spinners |
| `accent` | Secondary highlight: approval `▶` prefix, device-code box, image placeholder, BTW / queue panes, registry import |
| `text` | Body text: dialog bodies, todo titles, footer model label, Markdown headings, assistant/tool message bullets, list bullets |
| `textStrong` | Emphasized / bold text: input dialogs, status messages |
| `textDim` | Secondary, dimmed text (the most widely used dim shade): thinking, hints, descriptions, completed todos, Markdown quotes, footer status bar |
| `textMuted` | Faintest text: counters, scroll info, descriptions, Markdown link URLs, code-block borders |
| `border` | Pane and editor borders, Markdown horizontal rule |
| `borderFocus` | Focus / attention border (currently only the approval panel) |
| `success` | Success state: `✓`, "enabled", completed |
| `warning` | Warning state: auto/yolo badges, stale markers, plan-mode hint |
| `error` | Error state: error messages, failed tool output |
| `diffAdded` | Diff added lines |
| `diffRemoved` | Diff removed lines |
| `diffAddedStrong` | Diff intra-line changed words, added (bold) |
| `diffRemovedStrong` | Diff intra-line changed words, removed (bold) |
| `diffGutter` | Diff line-number gutter |
| `diffMeta` | Diff meta / hunk headers |
| `roleUser` | User message bullet and text, skill-activation name (the one role color with its own hue) |

## Workflow

1. **Ask the user what they want first — before choosing any colors.** Clarify, in one short exchange:
   - **Light or dark?** A light theme (dark text on a light background) or a dark theme (light text on a dark background). This sets the whole direction, so settle it first. For a light theme, set `"base": "light"` so the tokens you leave out inherit the light palette instead of dark.
   - **What style / mood?** e.g. warm vs cool, vivid vs muted, high vs low contrast, a named vibe ("nord", "solarized", "sunset"), or a base to start from (an existing theme, or `dark` / `light`).
   - **Any specific colors?** Whether they have exact hex values to anchor on (a brand color, a preferred `primary`, etc.).

   For the discrete choices (light vs dark, a few style options), prefer **AskUserQuestion** if it is available. If you are running in **auto mode** and `AskUserQuestion` is unavailable, ask the same question as a plain-text message with clear numbered or bulleted options, and wait for the user's reply. Don't start picking colors until you at least know light-vs-dark and the rough style.

2. **Resolve the actual theme directory and current theme(s).**
   - Resolve the data root by checking `echo "$KIMI_CODE_HOME"`; if empty, use `echo "$HOME/.kimi-code"`. Use `<root>/themes` for every subsequent step.
   - If tweaking an existing custom theme, **Read** `<KIMI_CODE_HOME>/themes/<name>.json` first — never overwrite a theme you haven't read.
   - Starting fresh: build a `colors` object from the token table. You can `ls <KIMI_CODE_HOME>/themes/` and Read one of the user's existing themes as a reference for the format.

3. **Pick a starting point and choose colors deliberately.**
   - Every value is a 6-digit hex `#RRGGBB` (not 3-digit, not a named color).
   - Keep contrast usable against the user's terminal background: don't let `text` / `textDim` sit too close to the background, and keep `success` / `warning` / `error` clearly distinguishable from each other.
   - `primary` is the most-seen color (links, selection, focus) — make it readable and distinct from `text`.
   - `roleUser` is the one role color meant to stand on its own — give it a distinct hue.

4. **Create a candidate file; never edit the live theme in place.**
   - Use Bash to create a candidate. If the target theme already exists, copy it verbatim: `cp <name>.json <name>.json.new` (inside `<KIMI_CODE_HOME>/themes/`). If it doesn't exist, use **Write** to create a minimal skeleton named `<name>.json.new`.
   - Use **Edit** on the candidate to change only the intended keys. Keep every existing entry, comment, and formatting intact.

5. **Validate the candidate before overwriting.**
   - Read the candidate with **Read** to visually confirm it is well-formed JSON and that every `colors` value is a full 6-digit hex `#RRGGBB` (not 3-digit, not a named color).
   - Invalid hex values are silently skipped at load (they fall back to the base palette), but fix them so the theme renders as intended.

6. **Back up and overwrite.**
   - Back up the old file first — **always** create a new timestamped backup and never overwrite an existing backup: `cp <name>.json "<name>.json.$(date +%Y%m%d-%H%M%S).bak"`.
   - If the target didn't exist, skip the backup.
   - Overwrite with the candidate: `mv <name>.json.new <name>.json`.

7. **Tell the user how to apply it** (next section).

## Applying the theme

- The `/theme` picker re-scans the themes directory every time it opens, so a newly added file shows up **without restarting** — tell the user to run `/theme` and choose `Custom: <name>`.
- Or set it in `tui.toml`: `theme = "<name>"`.
- **Editing the active theme**: changes to the theme that's *currently in use* are not auto-reloaded. Tell the user to run **`/reload-tui`** (or switch to another theme and back). Re-selecting the **same** theme in `/theme` is a no-op ("Theme unchanged").

## Don'ts

- **Don't start creating or editing a theme until the user has clarified light/dark, style/mood, any specific colors, and the filename.** If anything is unclear, ask — don't guess.
- Don't invent token names — only use the documented set; unknown keys are silently ignored.
- Don't write 3-digit hex or named colors — use full `#RRGGBB`.
- Never edit the live theme file in place; work through a candidate and validate before `mv`.
- Before overwriting an existing theme file, **read it and back it up** so the user can recover.
- Don't tell the user to restart the app to apply a theme — `/theme` or `/reload-tui` is enough.
