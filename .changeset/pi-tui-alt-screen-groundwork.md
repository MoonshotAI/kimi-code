---
"@moonshot-ai/pi-tui": patch
---

Add fullscreen groundwork to the alternate-screen renderer: `ScrollView.canScroll`, `TuiAltScreen.getLayoutRoot()`, and viewport navigation keys (PageUp/PageDown/Home/End and friends) now fall through to the focused component when the primary scroll view has nothing to scroll. Terminal focus in/out reports are no longer consumed by the viewport input handler, so app-level listeners (focus-aware notifications, clipboard-image hints) keep working in fullscreen.
