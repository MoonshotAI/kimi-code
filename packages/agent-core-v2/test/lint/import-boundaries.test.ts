import { describe, expect, it } from 'vitest';

import { SRC_ROOT, checkSource } from '../../scripts/check-import-boundaries.mjs';

const at = (domain: string, file: string): string => `${SRC_ROOT}/${domain}/${file}`;
const atHuman = (sub: string, file: string): string => `${SRC_ROOT}/human/${sub}/${file}`;
const atAdapter = (sub: string, file: string): string => `${SRC_ROOT}/llm-adapter/${sub}/${file}`;

const V1 = ['@moonshot-ai', 'agent-core'].join('/');
const KOSONG_IMPORT = ['#', 'kosong', 'contract', 'message'].join('/');
const KOSONG_SELF_IMPORT = ['@moonshot-ai/agent-core-v2', 'kosong', 'contract', 'message'].join('/');

describe('check-import-boundaries', () => {
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

  it('flags a v1 import in test code', () => {
    const violations = checkSource(
      `import { Session } from '${V1}/session';`,
      `${SRC_ROOT}/../test/agent/loop/loop.test.ts`,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/v2 must not import v1/);
  });

  it('flags a literal #/kosong/ import (the deleted kernel)', () => {
    const violations = checkSource(
      `import { Foo } from '${KOSONG_IMPORT}';`,
      at('agent', 'loop.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/kosong kernel is deleted/);
  });

  it('flags a package-self kosong subpath import', () => {
    const violations = checkSource(
      `import { Foo } from '${KOSONG_SELF_IMPORT}';`,
      at('agent', 'loop.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/kosong kernel is deleted/);
  });

  it('flags human importing llm-adapter', () => {
    const violations = checkSource(
      `import { Foo } from '#/llm-adapter/contract/message';`,
      atHuman('llm', 'message.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/human must not import outside its kernel/);
  });

  it('flags human importing a v2 domain', () => {
    const violations = checkSource(
      `import { IConfigService } from '#/app/config/config';`,
      atHuman('llm', 'message.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/human must not import outside its kernel/);
  });

  it('flags human escaping into v2 via a relative path', () => {
    const violations = checkSource(
      `import { Foo } from '../../llm-adapter/contract/message';`,
      atHuman('llm', 'message.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/human must not import outside its kernel/);
  });

  it('allows intra-human imports through its own alias', () => {
    const violations = checkSource(
      `import { createMessageAccumulator } from '#/llm/message';`,
      atHuman('llm/requester', 'machine.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows human to import external SDK packages', () => {
    const violations = checkSource(
      `import OpenAI from 'openai';`,
      atHuman('llm/requester/bases/openai', 'requester.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('flags a non-adapter v2 file importing a human implementation module', () => {
    const violations = checkSource(
      `import { createOpenAIRequester } from '#human/llm/requester/bases/openai/requester';`,
      at('agent', 'loop.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/only llm-adapter and agent\/loop\/machine may import the human implementation/);
  });

  it('allows a non-adapter v2 file importing human vocabulary', () => {
    const violations = checkSource(
      `import type { Message } from '#human/llm/message';\nimport { emptyUsage } from '#human/llm/usage';`,
      at('agent', 'loop.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows llm-adapter to import the human implementation', () => {
    const violations = checkSource(
      `import { createOpenAIRequester } from '#human/llm/requester/bases/openai/requester';\nimport { kimiProvider } from '#human/llm-kimi/provider';`,
      atAdapter('protocol', 'protocolAdapterRegistry.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('flags a package-self human implementation import outside llm-adapter', () => {
    const violations = checkSource(
      `import { createOpenAIRequester } from '@moonshot-ai/agent-core-v2/human/llm/requester/bases/openai/requester';`,
      at('agent', 'loop.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/only llm-adapter and agent\/loop\/machine may import the human implementation/);
  });

  it('allows arbitrary cross-domain imports outside kosong', () => {
    const violations = checkSource(
      `import { IAgentLoopService } from '#/agent/loop/loop';`,
      at('log', 'log.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows sibling-package imports outside kosong', () => {
    const violations = checkSource(
      `import { something } from '@moonshot-ai/kaos';`,
      at('log', 'log.ts'),
    );
    expect(violations).toHaveLength(0);
  });
});
