# Custom Themes

Kimi Code CLI ships with three built-in color schemes: `dark`, `light`, and `auto` (picks light/dark by detecting the terminal background). Beyond those, you can define your own colors in a JSON file — drop it into the themes directory and it shows up in `/theme` alongside the built-in ones.

## Create a theme

Add a `.json` file to the themes directory:

- `~/.kimi-code/themes/`
- or `$KIMI_CODE_HOME/themes/` when the `KIMI_CODE_HOME` environment variable is set

Create the directory if it does not exist. **The filename is the theme name**: `ember.json` appears in `/theme` as `Custom: ember`.

A minimal theme only sets the colors you want to change; the rest fall back to `dark`:

```json
{
  "name": "ember",
  "colors": {
    "primary": "#83A598",
    "accent": "#FE8019"
  }
}
```

Fields:

- `name` (required): the theme identifier.
- `displayName` (optional): a human-readable name.
- `colors` (optional): the color tokens to override, each a 6-digit hex value (e.g. `#FE8019`).

> Tip: copying a full example like the one below and tweaking it is the fastest way to start.

## Color tokens

These are the tokens you can set under `colors`. Each note says where the token is actually used in the UI, so you can predict what a change affects:

| Token | What it controls |
| --- | --- |
| `primary` | The most-used color. Links, inline code, the selected item in nearly every dialog, the focused editor border, plan/"running" badges, spinners |
| `accent` | Secondary highlight. Approval `▶` prefix, device-code box, image placeholder, BTW / queue panes, registry import |
| `text` | Body text. Dialog bodies, todo titles, footer model label, Markdown headings, assistant/tool message bullets, list bullets |
| `textStrong` | Emphasized / bold text. Input dialogs, status messages |
| `textDim` | Secondary, dimmed text (the most widely used dim shade). Thinking, hints, descriptions, completed todos, Markdown quotes, footer status bar (cwd, git badge) |
| `textMuted` | Faintest text. Counters, scroll info, descriptions, Markdown link URLs, code-block borders |
| `border` | Borders. Pane and editor borders, Markdown horizontal rule |
| `borderFocus` | Focus / attention border (currently only the approval panel) |
| `success` | Success state. `✓`, "enabled", completed |
| `warning` | Warning state. auto/yolo badges, stale markers, plan-mode hint |
| `error` | Error state. Error messages, failed tool output |
| `diffAdded` | Diff added lines |
| `diffRemoved` | Diff removed lines |
| `diffAddedStrong` | Diff intra-line changed words, added (bold) |
| `diffRemovedStrong` | Diff intra-line changed words, removed (bold) |
| `diffGutter` | Diff line-number gutter |
| `diffMeta` | Diff meta / hunk headers |
| `roleUser` | User message bullet and text, skill-activation name |

Any token you omit falls back to its `dark` value, so partial themes are fine:

```json
{
  "name": "just-blue",
  "colors": {
    "primary": "#3B82F6",
    "roleUser": "#3B82F6"
  }
}
```

## Select a theme

Two ways:

1. **The `/theme` command** (recommended): opens the theme picker, where custom themes appear as `Custom: <filename>`. The picker **re-scans the themes directory every time it opens**, so a theme file you just added shows up **without a restart**.
2. **`tui.toml`**: set `theme` to your theme name:

   ```toml
   # ~/.kimi-code/tui.toml
   theme = "ember"
   ```

## What happens on errors

Custom themes are designed to never get in your way:

- **An invalid color value** (not `#` followed by 6 hex digits): that one entry is skipped with a warning; the rest of the colors still apply.
- **An unrecognized token**: ignored, with no effect on other colors.
- **A missing file or malformed JSON**: silently falls back to `dark`.

## Editing the active theme

If you edit the theme file that is **currently active**, the change is not reloaded automatically. To apply the new colors:

- run `/reload-tui` — it reloads `tui.toml` and re-applies the current theme (including re-reading the theme file); or
- switch to another theme in `/theme` and back.

::: warning Note
Re-selecting the **same** theme in `/theme` does not reload it (you get a "Theme unchanged" message). To reload changes to the active theme, use one of the two methods above.
:::
