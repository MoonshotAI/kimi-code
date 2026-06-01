/**
 * Task id format: `{bash|agent}-{8 base36 chars}`.
 *
 * Legacy `bg_<hex>` format is NOT accepted.
 */

import { describe, expect, it } from 'vitest';

import { generateTaskId, VALID_TASK_ID } from '../../../src/agent/background';

describe('background task id format', () => {
  it('generated ids pass VALID_TASK_ID for every kind', () => {
    for (const kind of ['bash', 'agent'] as const) {
      for (let i = 0; i < 32; i++) {
        const id = generateTaskId(kind);
        expect(id).toMatch(VALID_TASK_ID);
        expect(id.startsWith(`${kind}-`)).toBe(true);
      }
    }
  });

  it('rejects malformed ids', () => {
    const rejected = [
      '', // empty
      'x', // too short
      '-bash', // wrong prefix
      'BASH-12345678', // uppercase
      'bash_12345678', // underscore separator
      '../escape', // path traversal
      'bash-1234567', // 7-char suffix
      'bash-123456789', // 9-char suffix
      'agent-ABCDEFGH', // uppercase suffix
      'bg_12345678', // legacy format is no longer accepted
      'a'.repeat(26), // long junk
    ];
    for (const bad of rejected) {
      expect(VALID_TASK_ID.test(bad)).toBe(false);
    }
    // Spot-check one *valid* id so the negative assertions aren't
    // drifting (a regex that rejects everything would pass the block
    // above on its own).
    expect(VALID_TASK_ID.test('bash-00000000')).toBe(true);
    expect(VALID_TASK_ID.test('agent-zzzzzzzz')).toBe(true);
  });

  // Cross-module invariant: every id produced by the generator must
  // satisfy the validation regex used by the persistence store. Run
  // multiple iterations because the suffix is random.
  it('every generated id passes VALID_TASK_ID for every kind', () => {
    for (const kind of ['bash', 'agent'] as const) {
      for (let i = 0; i < 128; i++) {
        const id = generateTaskId(kind);
        expect(VALID_TASK_ID.test(id)).toBe(true);
        expect(id.startsWith(`${kind}-`)).toBe(true);
      }
    }
  });

  // Negative invariant: empty / too-short / wrong-prefix / uppercase /
  // underscore / path-traversal must all be rejected.
  it('explicit rejection set', () => {
    const cases = [
      '',
      'x',
      '-bash',
      'BASH-12345678',
      'bash_12345678',
      '../escape',
      'a'.repeat(26),
    ];
    for (const bad of cases) {
      expect(VALID_TASK_ID.test(bad)).toBe(false);
    }
  });
});
