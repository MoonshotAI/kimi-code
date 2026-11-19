
interface DangerPattern {
  pattern: RegExp;
  detail: string;
}

const DANGER_PATTERNS: DangerPattern[] = [
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*|--recursive|--force)\b/, detail: 'rm -rf' },
  { pattern: /\bsudo\b/, detail: 'sudo' },
  { pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/, detail: 'mkfs' },
  { pattern: /\bdd\b[^|;&]*\bof=/, detail: 'dd of=…' },
  { pattern: />\s*\/dev\/(?:sd|nvme|disk|hd)/, detail: '> /dev/…' },
  { pattern: /:\(\)\s*\{/, detail: 'fork bomb' },
  { pattern: /\bgit\s+push\b[^|;&]*(?:--force(?:-with-lease)?\b|\s-f\b)/, detail: 'git push --force' },
  { pattern: /\bchmod\s+(?:-[a-zA-Z]+\s+)*777\b/, detail: 'chmod 777' },
  { pattern: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, detail: 'curl | sh' },
  { pattern: /\b(?:shutdown|reboot|poweroff|halt)\b/, detail: 'shutdown / reboot' },
];

export function detectShellDanger(command: string): string | undefined {
  const bare = command.replace(/"[^"]*"|'[^']*'/g, ' ');
  for (const { pattern, detail } of DANGER_PATTERNS) {
    if (pattern.test(bare)) return detail;
  }
  return undefined;
}
