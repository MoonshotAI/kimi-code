import { describe, expect, it } from 'vitest';

import { SRC_ROOT, checkSource } from '../../scripts/check-import-boundaries.mjs';

const at = (domain: string, file: string): string => `${SRC_ROOT}/${domain}/${file}`;
const atHuman = (sub: string, file: string): string => `${SRC_ROOT}/human/${sub}/${file}`;
const atAdapter = (sub: string, file: string): string => `${SRC_ROOT}/llm-adapter/${sub}/${file}`;

const KOSONG_IMPORT = ['#', 'kosong', 'contract', 'message'].join('/');
const KOSONG_SELF_IMPORT = ['@moonshot-ai/agent-core-v2', 'kosong', 'contract', 'message'].join('/');

describe('check-import-boundaries', () => {
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

  it('flags a trait importing a protocol format module', () => {
    const violations = checkSource(
      `import { CONTEXT_MANAGEMENT_BETA } from '#/llm/requester/bases/anthropic/format';`,
      atHuman('llm-kimi', 'trait.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/format and trait never import each other/);
  });

  it('flags a trait importing a protocol lower module via a relative path', () => {
    const violations = checkSource(
      `import type { OpenAIWireToolCall } from '../openai/lower';`,
      atHuman('llm/requester/bases/anthropic', 'trait.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/format and trait never import each other/);
  });

  it('flags a format module importing a trait', () => {
    const violations = checkSource(
      `import type { OpenAITrait } from './trait';`,
      atHuman('llm/requester/bases/openai', 'format.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/format and trait never import each other/);
  });

  it('allows a trait importing the protocol contract', () => {
    const violations = checkSource(
      `import type { OpenAIWireToolCall } from '#/llm/requester/bases/openai/contract';`,
      atHuman('llm-kimi', 'trait.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('flags llm-adapter importing a protocol format module', () => {
    const violations = checkSource(
      `import { convertOpenAIError } from '#human/llm/requester/bases/openai/format';`,
      atAdapter('protocol', 'protocolAdapterRegistry.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/internal to the requester pipeline/);
  });

  it('flags human code outside bases importing a protocol lower module', () => {
    const violations = checkSource(
      `import { lowerMessage } from '#/llm/requester/bases/openai/lower';`,
      atHuman('llm-kimi', 'provider.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/internal to the requester pipeline/);
  });

  it('allows a sibling base importing another base format module', () => {
    const violations = checkSource(
      `import { convertOpenAIError } from '../openai/format';`,
      atHuman('llm/requester/bases/openai-responses', 'format.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows a test importing a protocol format module', () => {
    const violations = checkSource(
      `import { createOpenAIFormat } from '#/llm/requester/bases/openai/format';`,
      atHuman('test/llm', 'usage.test.ts'),
    );
    expect(violations).toHaveLength(0);
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
