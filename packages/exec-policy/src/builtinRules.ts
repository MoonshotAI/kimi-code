/**
 * Built-in rule layer — the always-on floor every evaluation starts from.
 * Forbidden entries are terminal (nothing can soften them by design);
 * prompts cover egress and privilege tools; allows stay minimal and
 * read-only so they never pre-empt sensitive-file or sandbox checks.
 */

import type { ExecRule, NetworkRule, PrefixRule } from './types';

type UnsourcedRule = Omit<PrefixRule, 'source'> | Omit<NetworkRule, 'source'>;

const rule = (partial: UnsourcedRule): ExecRule =>
  ({ ...partial, source: 'builtin' }) as ExecRule;

export const BUILTIN_RULES: readonly ExecRule[] = [
  rule({
    kind: 'prefix_rule',
    pattern: ['rm', '-rf', '/'],
    decision: 'forbidden',
    justification: 'recursive delete of the filesystem root',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['rm', '-fr', '/'],
    decision: 'forbidden',
    justification: 'recursive delete of the filesystem root',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['rm', '-rf', '~'],
    decision: 'forbidden',
    justification: 'recursive delete of the home directory',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['mkfs'],
    decision: 'forbidden',
    justification: 'formats a filesystem',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['dd', 'if=/dev/zero'],
    decision: 'forbidden',
    justification: 'destructive raw disk write',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['shutdown'],
    decision: 'forbidden',
    justification: 'system power control',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['reboot'],
    decision: 'forbidden',
    justification: 'system power control',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['halt'],
    decision: 'forbidden',
    justification: 'system power control',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['poweroff'],
    decision: 'forbidden',
    justification: 'system power control',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['sudo'],
    decision: 'prompt',
    justification: 'privilege escalation wrapper',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['doas'],
    decision: 'prompt',
    justification: 'privilege escalation wrapper',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['curl'],
    decision: 'prompt',
    justification: 'network egress — pipe-to-shell or exfiltration risk',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['wget'],
    decision: 'prompt',
    justification: 'network egress — fetch risk',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['nc'],
    decision: 'prompt',
    justification: 'raw network socket',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['ncat'],
    decision: 'prompt',
    justification: 'raw network socket',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['ssh'],
    decision: 'prompt',
    justification: 'remote shell access',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['scp'],
    decision: 'prompt',
    justification: 'remote file copy',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['git', 'status'],
    decision: 'allow',
    justification: 'read-only repository inspection',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['git', 'diff'],
    decision: 'allow',
    justification: 'read-only repository inspection',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['git', 'log'],
    decision: 'allow',
    justification: 'read-only repository inspection',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['git', 'show'],
    decision: 'allow',
    justification: 'read-only repository inspection',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['git', 'branch'],
    decision: 'allow',
    justification: 'read-only repository inspection',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['ls'],
    decision: 'allow',
    justification: 'directory listing',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['pwd'],
    decision: 'allow',
    justification: 'working directory query',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['echo'],
    decision: 'allow',
    justification: 'no side effects',
  }),
  rule({
    kind: 'prefix_rule',
    pattern: ['true'],
    decision: 'allow',
    justification: 'no side effects',
  }),
];
