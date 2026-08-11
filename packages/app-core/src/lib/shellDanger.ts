// packages/app-core/src/lib/shellDanger.ts
// Display-layer heuristic for the approval card: flag obviously destructive
// shell commands so the card can show a danger hint. The daemon's approval
// payload has a `danger` slot but never fills it, so the client does a
// high-precision pattern pass instead. This is presentation only — it never
// blocks, alters, or re-orders the command; false positives just show a hint.

interface DangerPattern {
  pattern: RegExp;
  /** Short, locale-neutral detail shown after the "Danger:" label. */
  detail: string;
}

const DANGER_PATTERNS: DangerPattern[] = [
  // Recursive/forced delete, short or long flags (aligned with the TUI's set).
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*|--recursive|--force)\b/, detail: 'rm -rf' },
  // Privilege escalation.
  { pattern: /\bsudo\b/, detail: 'sudo' },
  // Disk / filesystem destruction.
  { pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/, detail: 'mkfs' },
  { pattern: /\bdd\b[^|;&]*\bof=/, detail: 'dd of=…' },
  { pattern: />\s*\/dev\/(?:sd|nvme|disk|hd)/, detail: '> /dev/…' },
  // Fork bomb.
  { pattern: /:\(\)\s*\{/, detail: 'fork bomb' },
  // Force-push shared history.
  { pattern: /\bgit\s+push\b[^|;&]*(?:--force(?:-with-lease)?\b|\s-f\b)/, detail: 'git push --force' },
  // World-writable recursive permission change.
  { pattern: /\bchmod\s+(?:-[a-zA-Z]+\s+)*777\b/, detail: 'chmod 777' },
  // Piping a remote script straight into a shell.
  { pattern: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, detail: 'curl | sh' },
  // Power state.
  { pattern: /\b(?:shutdown|reboot|poweroff|halt)\b/, detail: 'shutdown / reboot' },
];

/**
 * Return a short detail string when the command looks destructive, else
 * undefined. Only the first (highest-priority) match is reported. Quoted
 * spans are blanked out first so `echo "rm -rf"` doesn't false-positive.
 */
export function detectShellDanger(command: string): string | undefined {
  const bare = command.replace(/"[^"]*"|'[^']*'/g, ' ');
  for (const { pattern, detail } of DANGER_PATTERNS) {
    if (pattern.test(bare)) return detail;
  }
  return undefined;
}
