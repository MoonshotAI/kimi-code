import { RequestError, type ContentBlock, type McpServer } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import { acpPromptToKimiInput } from '#/acp/content-adapter';
import { acpMcpServersToKimiConfig } from '#/acp/mcp-adapter';
import { createAcpModelState } from '#/acp/model-adapter';
import {
  approvalRequestToToolCallUpdate,
  approvalResponseFromOutcome,
} from '#/acp/tool-adapter';

describe('ACP adapter helpers', () => {
  it('converts text, image, resource link, and embedded text prompt blocks', () => {
    const prompt: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      {
        type: 'resource_link',
        name: 'README.md',
        title: 'README',
        uri: 'file:///repo/README.md',
      },
      {
        type: 'resource',
        resource: {
          uri: 'file:///repo/context.txt',
          text: 'embedded context',
          mimeType: 'text/plain',
        },
      },
    ];

    expect(acpPromptToKimiInput(prompt)).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: 'README\nfile:///repo/README.md' },
      { type: 'text', text: 'embedded context' },
    ]);
  });

  it('rejects unsupported audio prompt blocks with invalid params', () => {
    expect(() =>
      acpPromptToKimiInput([{ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }]),
    ).toThrow(RequestError);
  });

  it('converts stdio and http MCP servers to Kimi session MCP config', () => {
    const servers: McpServer[] = [
      {
        name: 'filesystem',
        command: 'node',
        args: ['server.mjs'],
        env: [{ name: 'ROOT', value: '/tmp/project' }],
      },
      {
        type: 'http',
        name: 'docs',
        url: 'https://mcp.example.test',
        headers: [{ name: 'X-Test', value: '1' }],
      },
    ];

    expect(acpMcpServersToKimiConfig(servers)).toEqual({
      filesystem: {
        transport: 'stdio',
        command: 'node',
        args: ['server.mjs'],
        env: { ROOT: '/tmp/project' },
      },
      docs: {
        transport: 'http',
        url: 'https://mcp.example.test',
        headers: { 'X-Test': '1' },
      },
    });
  });

  it('rejects unsupported ACP MCP transports', () => {
    expect(() =>
      acpMcpServersToKimiConfig([{ type: 'acp', name: 'client-tools', id: 'mcp-1' }]),
    ).toThrow(RequestError);
  });

  it('maps ACP permission outcomes to SDK approval decisions', () => {
    expect(
      approvalResponseFromOutcome({ outcome: 'selected', optionId: 'allow_always' }),
    ).toEqual({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Allow for session',
    });
    expect(approvalResponseFromOutcome({ outcome: 'cancelled' })).toEqual({
      decision: 'cancelled',
    });
  });

  it('builds ACP model state from configured Kimi model aliases', async () => {
    await expect(
      createAcpModelState(
        {
          providers: {},
          defaultModel: 'deepseek/flash',
          models: {
            'deepseek/flash': {
              provider: 'deepseek',
              model: 'deepseek-v4-flash',
              maxContextSize: 128000,
              displayName: 'DeepSeek Flash',
            },
          },
        },
        {
          getStatus: async () => ({
            model: 'deepseek/flash',
            thinkingLevel: 'auto',
            permission: 'manual',
            planMode: false,
            contextTokens: 0,
            maxContextTokens: 128000,
            contextUsage: 0,
          }),
        } as never,
      ),
    ).resolves.toEqual({
      availableModels: [
        {
          modelId: 'deepseek/flash',
          name: 'DeepSeek Flash',
          description: 'deepseek/deepseek-v4-flash (128000 context)',
        },
      ],
      currentModelId: 'deepseek/flash',
    });
  });

  it('builds permission tool-call updates from display metadata', () => {
    expect(
      approvalRequestToToolCallUpdate({
        turnId: 9,
        toolCallId: 'tc_1',
        toolName: 'apply_patch',
        action: 'Edit src/app.ts',
        display: {
          kind: 'diff',
          path: '/repo/src/app.ts',
          before: 'old',
          after: 'new',
        },
      }),
    ).toEqual({
      toolCallId: '9:tc_1',
      title: 'Edit src/app.ts',
      kind: 'edit',
      locations: [{ path: '/repo/src/app.ts' }],
      content: [{ type: 'diff', path: '/repo/src/app.ts', oldText: 'old', newText: 'new' }],
    });
  });
});
