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
    const fullOutput = `HEAD_MARKER${'x'.repeat(50_000)}MIDDLE_MARKER${'y'.repeat(2_000)}TAIL_MARKER`;

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
    expect(rendered).toContain(`output_size_chars: ${String(fullOutput.length)}`);
    expect(rendered).toContain('HEAD_MARKER');
    expect(rendered).toContain('TAIL_MARKER');
    expect(rendered).not.toContain('MIDDLE_MARKER');
    expect(rendered).toMatch(/\[elided: chars \[4096, \d+\)\]/);

    const outputPath = renderedOutputPath(rendered);
    expect(outputPath).toContain(
      join(
        homeDir,
        'sessions/workspace/session/agents/main/tool-results/Lookup_Tool-call_lookup-',
      ),
    );
    await expect(readFile(outputPath, 'utf8')).resolves.toBe(fullOutput);
  });

  it('spills retained full output carried by a pre-truncated tool result', async () => {
    const full = `HEAD${'x'.repeat(60_000)}TAIL`;

    const result = await truncation.truncateForModel<ExecutableToolResult>({
      toolName: 'Bash',
      toolCallId: 'call_bash',
      result: {
        output: `${'x'.repeat(50_000)}[...truncated]`,
        truncated: true,
        untruncatedOutput: full,
        untruncatedOutputTotalChars: full.length,
        untruncatedOutputSuffix:
          'Command failed with exit code: 1. Output is truncated to fit in the message.',
      },
    });

    expect(result.truncated).toBe(true);
    expect('untruncatedOutput' in result).toBe(false);
    expect('untruncatedOutputTotalChars' in result).toBe(false);
    const rendered = result.output;
    expect(typeof rendered).toBe('string');
    if (typeof rendered !== 'string') throw new Error('expected string output');
    expect(rendered).toContain(`output_size_chars: ${String(full.length)}`);
    expect(rendered).toContain(
      'Command failed with exit code: 1. Output is truncated to fit in the message.',
    );
    expect(rendered).not.toContain('[...truncated]');
    await expect(readFile(renderedOutputPath(rendered), 'utf8')).resolves.toBe(full);
  });

  it('reports when retention preserved only a prefix of the full output', async () => {
    const preserved = 'x'.repeat(60_000);

    const result = await truncation.truncateForModel<ExecutableToolResult>({
      toolName: 'Bash',
      toolCallId: 'call_partial',
      result: {
        output: 'truncated view',
        truncated: true,
        untruncatedOutput: preserved,
        untruncatedOutputTotalChars: 25_000_000,
      },
    });

    const rendered = result.output;
    expect(typeof rendered).toBe('string');
    if (typeof rendered !== 'string') throw new Error('expected string output');
    expect(rendered).toContain(
      'output_size_chars: 25000000 (only the first 60000 characters were preserved)',
    );
    await expect(readFile(renderedOutputPath(rendered), 'utf8')).resolves.toBe(preserved);
  });

  it('passes spill-exempt results through untouched', async () => {
    const exempt = { output: 'z'.repeat(60_000), spillExempt: true as const };

    await expect(
      truncation.truncateForModel({
        toolName: 'Read',
        toolCallId: 'call_read',
        result: exempt,
      }),
    ).resolves.toBe(exempt);
  });

  it('identifies paths inside the agent spill directory', () => {
    const dir = join(homeDir, 'sessions/workspace/session/agents/main/tool-results');
    expect(truncation.isSpillFilePath(join(dir, 'Bash-call-1.txt'))).toBe(true);
    expect(truncation.isSpillFilePath(dir)).toBe(true);
    expect(
      truncation.isSpillFilePath(
        join(homeDir, 'sessions/workspace/session/agents/main/other/file.txt'),
      ),
    ).toBe(false);
    expect(truncation.isSpillFilePath(join(homeDir, 'tool-results-evil/file.txt'))).toBe(false);
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
