---
"@moonshot-ai/pi-tui": patch
---

Re-baseline the fork on upstream pi-tui v0.85.1 plus upstream main up to `53816d7` (2026-09-14), which adds component mouse input (`handleMouse`, `MouseRegion`), a bordered fullscreen search panel with clickable navigation and a jump-to-end indicator, native clipboard helpers for darwin/win32/linux-X11 (the platform modules are renamed to `darwin-platform`, `win32-platform`, and `linux-platform-x11`), main-screen render chunking for large outputs, terminal capability overrides, and Alt-modified wheel scroll acceleration. Upstream also removed the library's own `PI_*` environment/config reads; logging destinations are now constructor-provided only. All local patches are retained: narrow-terminal hardening, overwide-line truncation, processed-line render caching, editor history hooks, the paste-burst fallback, inline slash autocomplete, host-marked completions, CJK-aware autolinks, fullscreen nav fall-through, and multi-root `@` completion.
