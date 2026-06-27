// apps/kimi-web/src/lib/branchColor.ts
// Map a git branch name to a stable accent color used to mark its worktree
// group in the sidebar.
//
// The palette is generated in OKLCH with a FIXED lightness and chroma, and only
// the hue varies. That keeps every swatch the same perceived brightness/weight
// (so no color feels louder than another) while the hue gives clear
// distinguishability between worktrees. The pure-red hue range (0–40°) is
// skipped so a worktree never reads as "error red".

const LIGHTNESS = 0.6;
const CHROMA = 0.17;
// Hue is in [40, 360): the 0–40° range (pure red) is excluded.
const HUE_MIN = 40;
const HUE_SPAN = 320;

export function branchColor(branch: string): string {
  let h = 0;
  for (let i = 0; i < branch.length; i++) h = (h * 31 + (branch.codePointAt(i) ?? 0)) % 2147483647;
  const hue = HUE_MIN + (h % HUE_SPAN);
  return `oklch(${LIGHTNESS} ${CHROMA} ${hue})`;
}
