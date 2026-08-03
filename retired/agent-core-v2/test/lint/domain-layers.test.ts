import { describe, expect, it } from 'vitest';

import { SRC_ROOT, checkSource } from '../../scripts/check-domain-layers.mjs';

const at = (domain: string, file: string): string => `${SRC_ROOT}/${domain}/${file}`;

const V1 = ['@moonshot-ai', 'agent-core'].join('/');

describe('check-domain-layers', () => {
  it('flags a direct import of v1 (@moonshot-ai/agent-core)', () => {
    const violations = checkSource(
      `import { KimiCore } from '${V1}';`,
      at('loop', 'loop.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/v2 must not import v1/);
  });

  it('flags a v1 subpath import', () => {
    const violations = checkSource(
      `import { Session } from '${V1}/session';`,
      at('loop', 'loop.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/v2 must not import v1/);
  });

  it('allows a domain to import a lower layer', () => {
    const violations = checkSource(
      `import { createDecorator } from '#/_base/di/instantiation';`,
      at('loop', 'loop.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('flags a lower layer importing a higher layer', () => {
    const violations = checkSource(
      `import { IAgentLoopService } from '#/agent/loop/loop';`,
      at('log', 'log.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/layer violation/);
    expect(violations[0]?.message).toMatch(/log.*L1.*loop.*L4/s);
  });

  it('allows same-domain relative imports', () => {
    const violations = checkSource(
      `import { helper } from './helper';`,
      at('loop', 'loop.ts'),
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

  it('flags a require() call with v1', () => {
    const violations = checkSource(
      `const kc = require('${V1}');`,
      at('loop', 'loop.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/v2 must not import v1/);
  });

  it('flags a dynamic import() with v1', () => {
    const violations = checkSource(
      `const kc = await import('${V1}');`,
      at('loop', 'loop.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/v2 must not import v1/);
  });

  it('flags a type-only import of v1', () => {
    const violations = checkSource(
      `import type { KimiCore } from '${V1}';`,
      at('loop', 'loop.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/v2 must not import v1/);
  });

  it('flags a type-only import of v1 subpath', () => {
    const violations = checkSource(
      `import type { Session } from '${V1}/session';`,
      at('loop', 'loop.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/v2 must not import v1/);
  });

  it('allows a lower layer to import from _base (L0)', () => {
    const violations = checkSource(
      `import { createDecorator } from '#/_base/di/instantiation';`,
      at('loop', 'loop.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows a higher layer to import from _base (L0)', () => {
    const violations = checkSource(
      `import { createDecorator } from '#/_base/di/instantiation';`,
      at('session', 'session.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows same-layer cross-domain imports', () => {
    // Both `loop` and `goal` are L4.
    const violations = checkSource(
      `import { IGoalService } from '#/agent/goal/goal';`,
      at('loop', 'loop.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('flags a lower layer (L2) importing a higher layer (L4)', () => {
    const violations = checkSource(
      `import { IGoalService } from '#/agent/goal/goal';`,
      at('auth', 'auth.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/layer violation/);
  });

  it('reports an unregistered source domain', () => {
    const violations = checkSource(
      `import { something } from '#/_base/foo';`,
      `${SRC_ROOT}/unknownDomain/bar.ts`,
    );
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations[0]?.message).toMatch(/not registered in DOMAIN_LAYER/);
  });

  it('reports an unregistered target domain', () => {
    const violations = checkSource(
      `import { something } from '#/unknownDomain/foo';`,
      at('loop', 'loop.ts'),
    );
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations[0]?.message).toMatch(/not registered in DOMAIN_LAYER/);
  });

  it('allows a v2 import of a sibling package', () => {
    const violations = checkSource(
      `import { createDecorator } from '@moonshot-ai/kaos';`,
      at('loop', 'loop.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows a third-party npm import', () => {
    const violations = checkSource(
      `import { z } from 'zod';`,
      at('loop', 'loop.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows a node built-in import', () => {
    const violations = checkSource(
      `import { readFileSync } from 'node:fs';`,
      at('loop', 'loop.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('handles a multi-line import statement', () => {
    const violations = checkSource(
      `import {\n  type IAgentLoopService\n} from '#/agent/loop/loop';`,
      at('log', 'log.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/layer violation/);
  });
});
