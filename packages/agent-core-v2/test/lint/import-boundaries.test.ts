import { describe, expect, it } from 'vitest';

import { SRC_ROOT, checkSource } from '../../scripts/check-import-boundaries.mjs';

const at = (domain: string, file: string): string => `${SRC_ROOT}/${domain}/${file}`;
const atKosong = (sub: string, file: string): string => `${SRC_ROOT}/kosong/${sub}/${file}`;

const V1 = ['@moonshot-ai', 'agent-core'].join('/');

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

  it('allows arbitrary cross-domain imports outside kosong', () => {
    const violations = checkSource(
      `import { IAgentLoopService } from '#/agent/loop/loop';`,
      at('log', 'log.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows workspace-tier imports from session/agent code', () => {
    const violations = checkSource(
      `import { IWorkspaceFsService } from '#/workspace/workspaceFs/fs';`,
      `${SRC_ROOT}/session/sessionMetadata/sessionMetadata.ts`,
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

  it('flags any external package import from kosong/contract', () => {
    const violations = checkSource(
      `import { z } from 'zod';`,
      atKosong('contract', 'message.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/kosong\/contract must not import external package/);
  });

  it('flags a wire SDK import from kosong/protocol', () => {
    const violations = checkSource(
      `import OpenAI from 'openai';`,
      atKosong('protocol', 'protocol.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/kosong\/protocol must not import wire SDK/);
  });

  it('flags a lower kosong layer importing a higher one', () => {
    const violations = checkSource(
      `import { Foo } from '#/kosong/provider/provider';`,
      atKosong('protocol', 'protocol.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/kosong layer violation/);
  });

  it('flags the provider → model peer edge', () => {
    const violations = checkSource(
      `import { Foo } from '#/kosong/model/model';`,
      atKosong('provider', 'provider.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/kosong peer violation/);
  });

  it('allows the model → provider peer edge', () => {
    const violations = checkSource(
      `import { Foo } from '#/kosong/provider/provider';`,
      atKosong('model', 'model.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('flags a kosong subdomain importing a non-kosong, non-_base domain', () => {
    const violations = checkSource(
      `import { IConfigService } from '#/app/config/config';`,
      atKosong('provider', 'provider.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/pure abstraction layer/);
  });

  it('allows kosong to import _base utilities', () => {
    const violations = checkSource(
      `import { helper } from '#/_base/utils/helper';`,
      atKosong('provider', 'provider.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows kosong to import the app/scopes DI vocabulary', () => {
    const violations = checkSource(
      `import { LifecycleScope } from '#/app/scopes';`,
      atKosong('provider', 'provider.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('flags a bases implementation importing a registry module', () => {
    const violations = checkSource(
      `import { registry } from '#/kosong/provider/protocolAdapterRegistry';`,
      atKosong('provider', 'bases/anthropic/anthropic.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/kosong bases boundary/);
  });

  it('allows a contrib module to import the registry (registration side)', () => {
    const violations = checkSource(
      `import { registry } from '#/kosong/provider/protocolAdapterRegistry';`,
      atKosong('provider', 'bases/anthropic/anthropic.contrib.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('resolves the package self-reference as an intra-v2 import', () => {
    const violations = checkSource(
      `import { Foo } from '@moonshot-ai/agent-core-v2/kosong/provider/provider';`,
      atKosong('protocol', 'protocol.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/kosong layer violation/);
  });
});
