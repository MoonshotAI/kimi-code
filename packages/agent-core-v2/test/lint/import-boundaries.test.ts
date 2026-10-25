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
      `import { createMessageAccumulator } from '#/message';`,
      atHuman('llm-requester', 'machine.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows human to import external SDK packages', () => {
    const violations = checkSource(
      `import OpenAI from 'openai';`,
      atHuman('llm/builtin/protocol/openai', 'index.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('flags a non-adapter v2 file importing a human implementation module', () => {
    const violations = checkSource(
      `import { createOpenAIRequester } from '#human/llm-requester/factories';`,
      at('agent', 'loop.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/only llm-adapter, agent\/loop\/machine and session\/agentLifecycle may import the human implementation/);
  });

  it('allows a non-adapter v2 file importing human vocabulary', () => {
    const violations = checkSource(
      `import type { Message } from '#human/llm/message';\nimport { emptyUsage } from '#human/llm-requester/usage';\nimport type { LlmError } from '#human/llm-requester/errors';`,
      at('agent', 'loop.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows llm-adapter to import the human implementation', () => {
    const violations = checkSource(
      `import { createOpenAIRequester } from '#human/llm-requester/factories';\nimport { kimiRequesters } from '#human/llm/builtin/provider/kimi/index';`,
      atAdapter('protocol', 'protocolAdapterRegistry.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('flags a package-self human implementation import outside llm-adapter', () => {
    const violations = checkSource(
      `import { createOpenAIRequester } from '@moonshot-ai/agent-core-v2/human/llm-requester/factories';`,
      at('agent', 'loop.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/only llm-adapter, agent\/loop\/machine and session\/agentLifecycle may import the human implementation/);
  });

  it('allows a built-in provider importing a protocol lower module', () => {
    const violations = checkSource(
      `import { lowerMessage } from '#/llm/builtin/protocol/anthropic/lower';`,
      atHuman('llm/builtin/provider/kimi', 'protocol.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows a built-in provider importing a protocol lower module via a relative path', () => {
    const violations = checkSource(
      `import { lowerMessage } from '../../protocol/openai/lower';`,
      atHuman('llm/builtin/provider/kimi', 'protocol.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('flags the A requester importing a protocol lower module', () => {
    const violations = checkSource(
      `import { lowerMessage } from '#/llm/builtin/protocol/openai/lower';`,
      atHuman('llm-requester', 'run.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/internal to the requester pipeline/);
  });

  it('allows a built-in provider importing the protocol contract', () => {
    const violations = checkSource(
      `import type { OpenAIWireToolCall } from '#/llm/builtin/protocol/openai/contract';`,
      atHuman('llm/builtin/provider/kimi', 'protocol.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('flags llm-adapter importing a protocol lower module', () => {
    const violations = checkSource(
      `import { convertOpenAIError } from '#/llm/builtin/protocol/openai/lower';`,
      atAdapter('protocol', 'protocolAdapterRegistry.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/internal to the requester pipeline/);
  });

  it('flags other human code importing a protocol lower module', () => {
    const violations = checkSource(
      `import { lowerMessage } from '#/llm/builtin/protocol/openai/lower';`,
      atHuman('agent', 'turn.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/internal to the requester pipeline/);
  });

  it('allows a sibling protocol importing another protocol lower module', () => {
    const violations = checkSource(
      `import { convertOpenAIError } from '../openai/lower';`,
      atHuman('llm/builtin/protocol/openai-responses', 'index.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows a test importing a protocol lower module', () => {
    const violations = checkSource(
      `import { lowerMessage } from '#/llm/builtin/protocol/openai/lower';`,
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
      `import { something } from '@moonshot-ai/minidb';`,
      at('log', 'log.ts'),
    );
    expect(violations).toHaveLength(0);
  });
});
