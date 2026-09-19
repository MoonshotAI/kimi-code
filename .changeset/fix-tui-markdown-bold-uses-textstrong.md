---
"@moonshot-ai/kimi-code": patch
---

Fix TUI markdown bold rendering as dark-on-dark. The pi-tui `MarkdownTheme` adapter emitted `chalk.bold(text)` — only the SGR bold code, no foreground colour — so bold spans in assistant messages inherited whatever fg the surrounding style left set and most terminals rendered them as a dim gray on dark backgrounds, nearly unreadable and unresponsive to theme changes. Route bold through `chalk.bold.hex(currentTheme.color('textStrong'))`, matching the token's documented role ("emphasised / bold text"). No behaviour change for callers that already override foreground colour before applying bold (e.g. diff-preview intra-line highlights).
