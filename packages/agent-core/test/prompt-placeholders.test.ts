import { globSync, readFileSync } from 'node:fs';
import { join } from 'pathe';

import { describe, expect, it } from 'vitest';

/**
 * Guard against unrendered template placeholders reaching the model.
 *
 * Prompt `.md` files fall into two groups:
 *   - **Templated** — rendered at runtime through `renderPrompt` (nunjucks).
 *     They are expected to contain `{{ }}` / `{% %}`.
 *   - **Static** — imported as raw strings and used verbatim. They must NOT
 *     contain template syntax: a stray `{{ var }}` in a static file would be
 *     sent to the model literally, since nothing renders it.
 *
 * This test pins that split. Adding a `{{ }}` to a static file (or forgetting
 * to route it through `renderPrompt`) fails here instead of leaking silently.
 */

const SRC = join(import.meta.dirname, '..', 'src');

// `.md` files rendered through `renderPrompt`. Keep in sync when a new
// templated prompt file is introduced.
const TEMPLATED = new Set([
  'agent/compaction/compaction-instruction.md',
  'profile/default/system.md',
  'tools/builtin/file/read.md',
  'tools/builtin/file/read-media.md',
  'tools/builtin/shell/bash.md',
]);

const STATIC_PLACEHOLDER_PROTOCOL_FILES = new Set([
  'agent/swarm/enter-reminder.md',
  'tools/builtin/collaboration/agent-swarm.md',
]);

const mdFiles = globSync('**/*.md', { cwd: SRC })
  .map((file) => file.split('\\').join('/'))
  .filter((file) => !file.endsWith('README.md'));

describe('prompt placeholders', () => {
  it('discovers prompt .md files', () => {
    expect(mdFiles.length).toBeGreaterThan(0);
  });

  it('static .md files contain no unrendered template syntax', () => {
    for (const file of mdFiles) {
      if (TEMPLATED.has(file)) continue;
      if (STATIC_PLACEHOLDER_PROTOCOL_FILES.has(file)) continue;
      const content = readFileSync(join(SRC, file), 'utf-8');
      expect(
        /\{\{|\{%|\$\{/.test(content),
        `${file} is imported as raw text; it must not contain {{ }} / {% %} / \${ } ` +
          'or it would reach the model unrendered (route it through renderPrompt instead).',
      ).toBe(false);
    }
  });

  it('templated .md files use {{ }} syntax, not legacy ${ }', () => {
    for (const file of mdFiles) {
      if (!TEMPLATED.has(file)) continue;
      const content = readFileSync(join(SRC, file), 'utf-8');
      expect(content.includes('${'), `${file} must use {{ }} placeholders, not legacy \${ }`).toBe(
        false,
      );
    }
  });

  // Closes the whitelist loop: a file wrongly added to TEMPLATED would have its
  // own `{{ }}` skipped by the static-file check above and leak unrendered.
  it('every TEMPLATED entry exists and actually uses template syntax', () => {
    for (const file of TEMPLATED) {
      // readFileSync throws on a wrong path — pins the whitelist to real files.
      const content = readFileSync(join(SRC, file), 'utf-8');
      expect(
        /\{\{|\{%/.test(content),
        `${file} is whitelisted as templated but has no {{ }} / {% %} — it must not be in TEMPLATED.`,
      ).toBe(true);
    }
  });
});
