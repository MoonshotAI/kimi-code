# Composer Workspace Picker — Design

Date: 2026-07-20
Status: Implemented (2026-07-20, revised 2026-07-21)

## Problem

On a new (empty) session, the workspace picker was a standalone pill inside
the centered hint stack **above** the composer (`ConversationPane.vue`). It
read as part of the placeholder text rather than as a property of the
message you are about to send. The picker is now paired with the composer as
a **companion strip**: a full-width sunken bar directly below the composer
card — the same pattern as the kimi.com composer's project strip (chosen
after dev-reviewing the earlier in-card footer variant).

## Goal

- Move the empty-state workspace picker from above the composer to a strip
  directly below the composer card.
- Picker panel: a "Recent folders" section (max 5 rows: icon + name + path,
  check on active), a divider, and a "Choose folder…" action.
- Implemented desktop-first and synced to `apps/web` (shared copies).

Non-goals: the docked composer in `ChatDock` is unchanged; sidebar workspace
management is unchanged; no new server APIs.

## Design

### Layout (empty state only)

```
            ┌─ KimiDoodle / title / hint text ─┐
            │                                  │
            │   ┌──────── Composer ────────┐   │
            │   │ textarea                 │   │
            │   │ toolbar                  │   │
            │   └───────────────┬──────────┘   │  ← complete card: own
            │   ┊ 📁 数据建设  ⌄              ┊   │     border/radius/shadow
            │   └──────────────────────────┘   │  ← separate attachment
            └──────────────────────────────────┘     card, top tucked behind
```

- The picker renders through `Composer.vue`'s `footer` slot, placed as a
  sibling **right after** `.composer-card` inside `.composer`'s padding
  box — outside the card, so the card's `container-type` stacking /
  fixed-containing-block effects never apply to the trigger, and the card
  keeps its own border/radius/shadow untouched.
- Hidden while `starting` (a workspace is already committed).

### Attachment card anatomy (measured from kimi.com)

kimi.com's structure: the composer is a **complete** card (own border,
radius, shadow), and `.home-input-options` is a **separate** strip of the
same width (`background: rgba(0,0,0,0.03)`, `border-radius: 0 0 24px 24px`)
whose `padding-top: 44px` hides its top ~35px behind the card; the trigger
inside is a compact capsule (122×36, transparent, radius 20px, 14px/400 at
60% black). Our translation, all tokens:

- **Structure**: the attachment renders through `Composer.vue`'s `footer`
  slot, placed as a sibling **right after** `.composer-card` inside
  `.composer`'s padding box — so its width always matches the card's with
  no alignment hacks, and the card itself is never touched. The card is
  raised (`.empty-composer :deep(.composer-card) { z-index: --z-sticky }`)
  so the attachment always paints behind it.
- **Attachment** (`.ws-bar`): `margin-top: -(--space-4)` with
  `padding-top: --space-4 + --space-2`, so its top 16px slides behind the
  card and the trigger sits 8px below the card's bottom edge (the
  reference's exact gap). Background `--color-hover` at 60% via
  `color-mix` (≈0.03 black in light, self-adapting in dark), no border,
  no shadow; only the rounded bottom (`0 0 --radius-2xl --radius-2xl`)
  shows.
- **Trigger** (`.ws-chip`): quiet capsule — transparent background,
  `--radius-full`, `--space-2 --space-3` padding, 16px leading icon and
  `--ui-font-size-sm` label in `--color-text-muted` at
  `--weight-option-label`; muted chevron rotates while open. Hover:
  `--color-selected` background (one step deeper than the zone), label
  turns `--color-text`. `--p-focus-ring` on focus-visible; tooltip
  `conversation.switchWorkspace`. Name truncated with end-ellipsis.
- No environment pill (decision 1) and no `✕` affordance (decision 2) —
  removal stays in the sidebar.

### Picker panel

```
 ┌────────────────────────────────────────────┐
 │ 最近的文件夹                                │  ← workspace.recentLabel
 │  📁 prototypes                              │
 │     /Users/moonshot/Desktop/web rc/protot…  │
 │  📁 数据建设                             ✓  │  ← active: --color-selected + ✓
 │     /Users/moonshot/Desktop/数据建设        │
 │ ────────────────────────────────────────── │
 │  ⤴ 选择文件夹…                              │  ← conversation.pickFolder
 └────────────────────────────────────────────┘
```

- Rows come from `workspacesView` (already ordered; `name` + `shortPath`),
  capped at 5 via `getVisibleWorkspaces(workspaces, activeId, false)` —
  no "More workspaces" expander, no scroll (decision 5).
- Active row click → existing `selectWorkspace` emit → `openWorkspaceDraft(id)`;
  panel closes. Backdrop click closes, as before.
- Action row (`folder-plus` icon) → existing `addWorkspace` emit →
  `requestAddWorkspace()`: native folder picker on desktop, in-app
  `AddWorkspaceDialog` fallback on web — no new divergence.
- `client.recentRoots` is not used: it carries raw paths without display
  names, and `workspacesView` already provides the ordered, named list.

### Viewport-aware placement

The panel is `position: absolute`, anchored to the strip (`.ws-anchor`), so
its box counts toward the chat scroller's (`.panes`) scrollable overflow
area. Uncapped, opening it can add scrollable overflow below the centred
empty-session layout — a new/changed scrollbar and scroll-anchor adjustments
visibly shift (or resize) the composer. Placement is therefore measured once
per open (`toggleWsPick`):

- Available space above/below the strip is computed against the `.panes`
  scrollport rect. When the space above is larger, the panel flips upward
  (`.ws-panel.up`, `bottom: calc(100% + var(--space-1))`).
- `max-height` is clamped to `min(calc(var(--space-8) * 10), available px)`
  (inline style) and the panel is `box-sizing: border-box`, so the clamp
  covers the whole border box; internal scroll is the fallback for very
  short viewports (both directions cramped → the larger side wins).
- Horizontally the panel is content-sized between
  `min(calc(var(--space-8) * 8), 100%)` and `100%` of the strip, so it never
  exceeds the strip or creates horizontal overflow.
- The click-outside backdrop is a fixed full-pane sibling
  (`z-index: --z-sticky`); the panel (`--z-dropdown`) outranks it in the
  same stacking context, so rows stay clickable without lifting the card.

Because the panel never adds new scrollable overflow, the scroller's scroll
metrics are identical before and after opening, and the centred composer
cannot move.

### States

- **No workspaces**: the strip shows `📁+ 选择文件夹…` (same sunken style,
  dim content), click → `addWorkspace`.
- **Starting**: strip hidden entirely.
- **Docked composer** (`ChatDock`): unchanged — the strip only exists in the
  empty state.

### Styling

All values from `style.css` tokens — `--color-surface-sunken` strip /
raised `--color-surface-raised` panel + border, `--radius-lg`,
`--space-*` gaps, `--text-*` with `--weight-option-label`, 16px icons,
`--shadow-sm`, `--z-*`, `--duration-*`/`--ease-*` transitions,
`--p-focus-ring` on focus-visible. `check:style` reports no new findings.

## Implementation

- `apps/desktop/src/renderer/components/chat/ConversationPane.vue`: old
  above-composer picker removed; `.ws-bar`/`.ws-chip`/`.ws-ghost`/
  `.ws-panel` attachment card + panel passed through the `footer` slot;
  script simplified (`wsPickExpanded`/`hiddenWorkspaceCount` gone;
  `toggleWsPick` measures the anchor once per open).
- `apps/desktop/src/renderer/components/chat/Composer.vue`: new optional
  `footer` slot rendered as a sibling right after `.composer-card` (so the
  attachment tucks under the complete card shell); the docked instance
  simply doesn't pass it and is unaffected.
- `packages/web-i18n/src/locales/{en,zh}/conversation.ts`: `pickFolder`
  ("Choose folder…" / "选择文件夹…").
- Synced to `apps/web/src/components/chat/{Composer,ConversationPane}.vue`
  (whole-file copies; only the header comment differs).
- Emits/props contract of `ConversationPane` unchanged
  (`selectWorkspace` / `addWorkspace`); `App.vue` untouched; no new entry
  in `apps/desktop/docs/native-todos.md`.
- Changeset: `.changeset/composer-workspace-footer-chip.md` (patch,
  `kimi-code-app`).

## Decisions (from user, 2026-07-20/21)

1. **Environment pill** (`本地`): not in v1.
2. **Chip ✕**: not in v1 — removal stays in the sidebar.
3. **Action row wording**: new key `conversation.pickFolder`.
4. ~~In-card footer (v4-soft-footer)~~ → superseded by 6 after dev review.
5. **Recent list**: capped at 5 workspaces, no "More workspaces"
   expansion.
6. **Attachment card** tucked under a COMPLETE composer card, measured
   from kimi.com's `.home-input-options` / `.project-selector-trigger`
   (via WebBridge DOM probe): the composer keeps its own
   border/radius/shadow; a separate `--color-hover` card of the same width
   hides its top behind it. Replaces the in-card soft chip, a detached
   full-width tray, and an in-card footer zone (which erased the card's
   own bottom border — rejected by the user).

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm test`,
  `pnpm --filter kimi-code-web run check:style` — all green, no new
  findings.
- desktop/web copies diff clean (header comment only).
- Light/dark hover/focus visual pass: done by user in dev (UI automation
  against the desktop app is restricted by repo policy).
