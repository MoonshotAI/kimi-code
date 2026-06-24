import { describe, expect, it } from 'vitest';

import { SRC_ROOT, checkSource } from '../../scripts/check-domain-layers.mjs';

const at = (domain: string, file: string): string => `${SRC_ROOT}/${domain}/${file}`;

// Build the v1 specifier dynamically so the static import-boundary scanner
// does not flag this test file itself.
const V1 = ['@moonshot-ai', 'agent-core'].join('/');

describe('check-domain-layers', () => {
  it('flags a direct import of v1 (@moonshot-ai/agent-core)', () => {
    const violations = checkSource(
      `import { KimiCore } from '${V1}';`,
      at('turn', 'turn.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/v2 must not import v1/);
  });

  it('flags a v1 subpath import', () => {
    const violations = checkSource(
      `import { Session } from '${V1}/session';`,
      at('turn', 'turn.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/v2 must not import v1/);
  });

  it('allows a domain to import a lower layer', () => {
    // turn (L4) importing _base (L0) — legal.
    const violations = checkSource(
      `import { createDecorator } from '#/_base/di/instantiation';`,
      at('turn', 'turn.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('flags a lower layer importing a higher layer', () => {
    // log (L1) importing turn (L4) — illegal.
    const violations = checkSource(
      `import { ITurnService } from '#/turn/turn';`,
      at('log', 'log.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/layer violation/);
    expect(violations[0]?.message).toMatch(/log.*L1.*turn.*L4/s);
  });

  it('allows same-domain relative imports', () => {
    const violations = checkSource(
      `import { helper } from './helper';`,
      at('turn', 'turn.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows sibling-package imports (out of scope for layering)', () => {
    const violations = checkSource(
      `import { something } from '@moonshot-ai/kaos';`,
      at('log', 'log.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('exempts the top-level package barrel from layering', () => {
    const violations = checkSource(
      `export * from './_base/di/index';`,
      `${SRC_ROOT}/index.ts`,
    );
    expect(violations).toHaveLength(0);
  });
});
