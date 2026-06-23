---
"@moonshot-ai/kimi-code": minor
---

Redesign `/plugins` as a single tabbed panel: **Installed** (manage installed
plugins — toggle, remove, MCP, details, reload), **Official** (Kimi-maintained
marketplace plugins), **Third-party** (marketplace plugins from other
publishers), and **Custom** (install straight from a GitHub URL, zip URL, or
local path). `Tab` / `Shift+Tab` switch tabs. The Official and Third-party
catalogs load lazily, so `/plugins` opens instantly and keeps working offline —
a marketplace fetch failure is shown inline instead of closing the panel.
Marketplace rows can also open setup URLs instead of installing a plugin. The
tab strip is shared with the `/model` provider tabs via the new `renderTabStrip`
helper.
