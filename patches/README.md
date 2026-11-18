# Dependency patches

## markstream-vue 2.0.19

The shared tooltip moves only between anchors within 120px. Distant anchor changes fade out the previous tooltip before showing the next one at its destination, and anchor changes arriving during an in-flight fade-out wait for the remaining fade before showing. Initial display animates opacity only, and hiding preserves visibility until the leave transition completes.

The patch covers both the singleton handoff in `dist/exports.js` and positioning transitions in `dist/Tooltip.js`. It is applied through `pnpm-workspace.yaml` and locked by `pnpm-lock.yaml`. The 2.0.19 upstream code is identical to 1.1.5 in these two areas (only minified identifier renames), so the patch is a direct port of the 1.1.5 one.

When upgrading the dependency, verify initial display, nearby and distant anchor changes, pointer leave during a handoff, and rapid pointer movement before removing or adapting the patch.
