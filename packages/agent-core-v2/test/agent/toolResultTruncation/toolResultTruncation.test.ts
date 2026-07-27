import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ExecutableToolResult } from '#/tool/toolContract';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { ToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncationService';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { ContentPart } from '#/kosong/contract/message';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stubBootstrap } from '../../app/bootstrap/stubs';

describe('ToolResultTruncationService', () => {
  let disposables: DisposableStore;
  let homeDir: string;
  let truncation: IAgentToolResultTruncationService;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'tool-result-truncation-'));
    disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(IBootstrapService, stubBootstrap(homeDir));
    ix.stub(
      IAgentScopeContext,
      makeAgentScopeContext({
        agentId: 'main',
        agentScope: 'sessions/workspace/session/agents/main',
      }),
    );
    ix.stub(IFileSystemStorageService, new FileStorageService(homeDir));
    truncation = ix.createInstance(ToolResultTruncationService);
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('persists oversized string output and renders a bounded model preview', async () => {
    const fullOutput = `${'x'.repeat(50_001)}tail survives on disk`;

    const result = await truncation.truncateForModel<ExecutableToolResult>({
      toolName: 'Lookup Tool',
      toolCallId: 'call:lookup',
      result: { output: fullOutput, isError: true },
    });

    expect(result.truncated).toBe(true);
    expect(result.isError).toBe(true);
    const rendered = result.output;
    expect(typeof rendered).toBe('string');
    if (typeof rendered !== 'string') throw new Error('expected string output');
    expect(rendered).toContain('Tool output exceeded 50000 characters');
    expect(rendered).toContain('tool_name: Lookup Tool');
    expect(rendered).toContain('tool_call_id: call:lookup');
    expect(rendered).not.toContain('tail survives on disk');

    const outputPath = renderedOutputPath(rendered);
    expect(outputPath).toContain(
      join(
        homeDir,
        'sessions/workspace/session/agents/main/tool-results/Lookup_Tool-call_lookup-',
      ),
    );
    await expect(readFile(outputPath, 'utf8')).resolves.toBe(fullOutput);
  });

  it('persists oversized text content parts as one complete text file', async () => {
    const output: ContentPart[] = [
      { type: 'text', text: 'first\n' },
      { type: 'text', text: 'y'.repeat(50_001) },
    ];

    const result = await truncation.truncateForModel<ExecutableToolResult>({
      toolName: 'Lookup',
      toolCallId: 'call_text_parts',
      result: { output },
    });

    expect(result.truncated).toBe(true);
    const rendered = result.output;
    expect(typeof rendered).toBe('string');
    if (typeof rendered !== 'string') throw new Error('expected string output');
    await expect(readFile(renderedOutputPath(rendered), 'utf8')).resolves.toBe(
      `first\n${'y'.repeat(50_001)}`,
    );
  });

  it('keeps already-truncated and mixed-media results unchanged', async () => {
    const alreadyTruncated = {
      output: 'z'.repeat(50_001),
      truncated: true,
    } as const;
    const mixedMedia = {
      output: [
        { type: 'text', text: 'z'.repeat(50_001) },
        { type: 'image_url', imageUrl: { url: 'file:///tmp/image.png' } },
      ] satisfies ContentPart[],
    };

    await expect(
      truncation.truncateForModel({
        toolName: 'Lookup',
        toolCallId: 'call_truncated',
        result: alreadyTruncated,
      }),
    ).resolves.toBe(alreadyTruncated);
    await expect(
      truncation.truncateForModel({
        toolName: 'Lookup',
        toolCallId: 'call_media',
        result: mixedMedia,
      }),
    ).resolves.toBe(mixedMedia);
  });

  it('uses unique output files for repeated call ids', async () => {
    const first = await truncation.truncateForModel({
      toolName: 'Lookup',
      toolCallId: 'call_repeat',
      result: { output: `${'a'.repeat(50_001)}first` },
    });
    const second = await truncation.truncateForModel({
      toolName: 'Lookup',
      toolCallId: 'call_repeat',
      result: { output: `${'b'.repeat(50_001)}second` },
    });

    const firstPath = renderedOutputPath(first.output);
    const secondPath = renderedOutputPath(second.output);
    expect(firstPath).not.toBe(secondPath);
    await expect(readFile(firstPath, 'utf8')).resolves.toContain('first');
    await expect(readFile(secondPath, 'utf8')).resolves.toContain('second');
  });
});

function renderedOutputPath(output: unknown): string {
  if (typeof output !== 'string') throw new Error('expected rendered output to be a string');
  const match = /^output_path: (.+)$/m.exec(output);
  if (match === null) throw new Error('expected rendered output to include output_path');
  return match[1]!;
}
