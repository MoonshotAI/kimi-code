---
name: custom-theme
description: Create or edit a kimi-code custom color theme — a JSON file under ~/.kimi-code/themes/ that recolors the TUI. Use when the user wants their own theme, asks for a specific palette or mood, or wants to tweak an existing custom theme's colors.
---

# Create a kimi-code custom theme (custom-theme)

Help the user design, write, and apply a custom color theme for the kimi-code TUI. A theme is a single JSON file; the TUI ships with `dark`, `light`, and `auto`, and any file the user adds becomes selectable alongside them.

## What a theme is

- A theme lives at `~/.kimi-code/themes/<name>.json` (or `$KIMI_CODE_HOME/themes/<name>.json` when that variable is set). Create the `themes/` directory if it doesn't exist.
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

   Use **AskUserQuestion** for the discrete choices (light vs dark, a few style options); use a plain question for free-form input like specific hex values. Don't start picking colors until you at least know light-vs-dark and the rough style.
2. **Pick a starting point.**
   - Tweaking an existing custom theme: **Read** `~/.kimi-code/themes/<name>.json` first — never overwrite a theme you haven't read.
   - Starting fresh: build a `colors` object from the token table. You can `ls ~/.kimi-code/themes/` and Read one of the user's existing themes as a reference for the format.
3. **Choose colors deliberately.**
   - Every value is a 6-digit hex `#RRGGBB` (not 3-digit, not a named color).
   - Keep contrast usable against the user's terminal background: don't let `text` / `textDim` sit too close to the background, and keep `success` / `warning` / `error` clearly distinguishable from each other.
   - `primary` is the most-seen color (links, selection, focus) — make it readable and distinct from `text`.
   - `roleUser` is the one role color meant to stand on its own — give it a distinct hue.
4. **Write the file** to `~/.kimi-code/themes/<name>.json` with **Write** for a new theme (pick a short kebab-case filename). When editing an existing theme, prefer **Edit** on just the color(s) that change so the rest stays intact — and back it up first (see Don'ts).
5. **Validate.** Confirm the file is valid JSON and every `colors` value matches `^#[0-9a-fA-F]{6}$`. A quick check with **Bash**:

   ```bash
   node -e 'const p=require("os").homedir()+"/.kimi-code/themes/<name>.json";const c=(require(p).colors)||{};const bad=Object.entries(c).filter(([,v])=>!/^#[0-9a-fA-F]{6}$/.test(v));console.log(bad.length?["invalid:",...bad]:"all hex valid")'
   ```

   Invalid values are silently skipped at load (they fall back to the base palette; not fatal), but fix them so the theme renders as intended.
6. **Tell the user how to apply it** (next section).

## Applying the theme

- The `/theme` picker re-scans the themes directory every time it opens, so a newly added file shows up **without restarting** — tell the user to run `/theme` and choose `Custom: <name>`.
- Or set it in `tui.toml`: `theme = "<name>"`.
- **Editing the active theme**: changes to the theme that's *currently in use* are not auto-reloaded. Tell the user to run **`/reload-tui`** (or switch to another theme and back). Re-selecting the **same** theme in `/theme` is a no-op ("Theme unchanged").

## Don'ts

- Don't invent token names — only use the documented set; unknown keys are silently ignored.
- Don't write 3-digit hex or named colors — use full `#RRGGBB`.
- Before overwriting an existing theme file, **read it and back it up** (e.g. `cp <name>.json "<name>.json.$(date +%Y%m%d-%H%M%S).bak"`) so the user can recover.
- Don't tell the user to restart the app to apply a theme — `/theme` or `/reload-tui` is enough.
