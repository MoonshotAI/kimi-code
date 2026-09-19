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
    expect(violations[0]?.message).toMatch(/only llm-adapter, agent\/loop\/machine and session\/agentLifecycle may import the human implementation/);
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
    expect(violations[0]?.message).toMatch(/only llm-adapter, agent\/loop\/machine and session\/agentLifecycle may import the human implementation/);
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

  it('enforces resolved kernel and Store boundaries without restricting unrelated domains', () => {
    expect(checkSource(`import { IAgentLoopService } from '#/agent/loop/loop';`, at('log', 'log.ts'))).toHaveLength(0);
    for (const specifier of ['../store/index', '#/store/log', '#human/xstate2', '@moonshot-ai/agent-core-v2/human/feature/runtime', 'xstate']) {
      expect(checkSource(`import { value } from '${specifier}';`, atHuman('kernel', 'runtime.ts')).some((item) => item.message.includes('kernel primitives'))).toBe(true);
    }
    for (const specifier of ['../session/events', '#/agent/events', '#human/feature/runtime', '@moonshot-ai/agent-core-v2/human/todo/slice', './node', './node.js', './internal/storage/backend/node.ts', './internal/storage/backend/node.js', './actor', './importers/v2']) {
      expect(checkSource(`export * from '${specifier}';`, atHuman('store', 'index.ts')).some((item) => item.message.includes('Store core'))).toBe(true);
    }
    for (const specifier of ['../store/internal/storage/branch', '#/store/internal/events/events', '#human/store/internal/storage/types', '@moonshot-ai/agent-core-v2/human/store/internal/events/slice']) {
      expect(checkSource(`import { value } from '${specifier}';`, atHuman('agent', 'machine.ts')).some((item) => item.message.includes('Store internals'))).toBe(true);
    }
    expect(checkSource(`import { createStore } from '#/store/index'; import { createEventStore } from '#/store/log';`, atHuman('feature', 'host.ts'))).toEqual([]);
    for (const specifier of ['fs/promises', 'node:fs/promises', 'xstate/actions']) {
      expect(checkSource(`import { value } from '${specifier}';`, atHuman('store', 'durable.ts')).some((item) => item.message.includes('Store core'))).toBe(true);
    }
    for (const specifier of ['#/session/stores', '#human/feature/host', '../../../agent/machine', '#/store/actor', 'xstate/actions']) {
      expect(checkSource(`import { value } from '${specifier}';`, atHuman('store/importers/v2', 'migrate.ts')).some((item) => item.message.includes('Store importer'))).toBe(true);
    }
    expect(checkSource(`import { createTurnMachine } from '#/agent/turn';`, atHuman('store/importers/v2', 'migrate.ts')).some((item) => item.message.includes('Store importer'))).toBe(true);
    expect(checkSource(`import type { HistoryMessage } from '#/agent/turn'; import { messageAppended } from '#/agent/events';`, atHuman('store/importers/v2', 'migrate.ts'))).toEqual([]);
    expect(checkSource(`import { parseLine } from '#/store/internal/storage/codec';`, atHuman('test/store', 'codec.test.ts'))).toEqual([]);
  });

  it('allows sibling-package imports outside kosong', () => {
    const violations = checkSource(
      `import { something } from '@moonshot-ai/klient';`,
      at('log', 'log.ts'),
    );
    expect(violations).toHaveLength(0);
  });
});
