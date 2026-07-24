/**
 * `kimi import` — tests for Claude Code session parser.
 *
 * Verifies: session file parsing, JSONL extraction, handoff context generation.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import type {
  HandoffContext,
  SourceSessionSummary,
} from '#/cli/import/sources/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestCCSession(): { dir: string; sessionPath: string; sessionId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-import-test-'));
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  // CLAUDE_CONFIG_DIR → projects/ subdirectory, matching real CC layout
  const projectsDir = join(dir, 'projects', '-Users-testuser-testproject');
  mkdirSync(projectsDir, { recursive: true });
  const sessionPath = join(projectsDir, `${sessionId}.jsonl`);

  const lines = [
    JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-07-24T10:00:00.000Z',
      sessionId,
    }),
    JSON.stringify({
      type: 'user',
      parentUuid: null,
      uuid: 'msg-1',
      timestamp: '2026-07-24T10:00:01.000Z',
      sessionId,
      cwd: '/Users/testuser/testproject',
      gitBranch: 'main',
      version: '2.1.0',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Help me fix a pagination bug' }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      parentUuid: 'msg-1',
      uuid: 'msg-2',
      timestamp: '2026-07-24T10:00:05.000Z',
      sessionId,
      cwd: '/Users/testuser/testproject',
      message: {
        role: 'assistant',
        model: 'deepseek-v4-pro',
        content: [
          { type: 'thinking', thinking: 'I need to read the file first.' },
          { type: 'text', text: 'Let me check the UserTable component.' },
          {
            type: 'tool_use',
            id: 'call_01',
            name: 'Read',
            input: { file_path: 'src/components/UserTable.tsx' },
          },
        ],
        usage: { input_tokens: 1000, output_tokens: 200 },
      },
    }),
    JSON.stringify({
      type: 'user',
      parentUuid: 'msg-2',
      uuid: 'msg-3',
      timestamp: '2026-07-24T10:00:10.000Z',
      sessionId,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_01',
            content: 'export function UserTable() { ... }',
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      parentUuid: 'msg-3',
      uuid: 'msg-4',
      timestamp: '2026-07-24T10:00:15.000Z',
      sessionId,
      message: {
        role: 'assistant',
        model: 'deepseek-v4-pro',
        content: [
          {
            type: 'thinking',
            thinking: 'I can see the issue. The pageSize is hardcoded. We need to use the prop instead.',
          },
          { type: 'text', text: 'Found the bug. The pagination is using a hardcoded pageSize of 10 instead of the prop.' },
        ],
        usage: { input_tokens: 500, output_tokens: 150 },
      },
    }),
    JSON.stringify({
      type: 'ai-title',
      title: 'Fix pagination bug in UserTable',
      sessionId,
    }),
  ];

  writeFileSync(sessionPath, lines.join('\n') + '\n', 'utf-8');
  return { dir, sessionPath, sessionId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Claude Code session parser', () => {
  it('should parse a valid CC session JSONL file', async () => {
    const test = createTestCCSession();
    try {
      // Import dynamically to avoid module caching issues
      const { claudeCodeParser } = await import('#/cli/import/sources/claude-code');

      // Override the projects directory for testing
      const origEnv = process.env['CLAUDE_CONFIG_DIR'];
      process.env['CLAUDE_CONFIG_DIR'] = test.dir;
      try {
        const sessions = await claudeCodeParser.listSessions();
        expect(sessions.length).toBe(1);
        expect(sessions[0]!.sessionId).toBe(test.sessionId);
        expect(sessions[0]!.title).toBe('Help me fix a pagination bug');

        const ctx = await claudeCodeParser.parseSession(test.sessionId);
        expect(ctx.source).toBe('claude-code');
        expect(ctx.sourceSessionId).toBe(test.sessionId);
        expect(ctx.model).toBe('deepseek-v4-pro');
        expect(ctx.summary).toBe('Help me fix a pagination bug');

        // Token usage
        expect(ctx.tokenUsage).toBeDefined();
        expect(ctx.tokenUsage!.input).toBe(1500);
        expect(ctx.tokenUsage!.output).toBe(350);

        // Conversation turns
        expect(ctx.recentConversation.length).toBeGreaterThan(0);

        // File changes — we read src/components/UserTable.tsx
        expect(ctx.filesModified.length).toBeGreaterThan(0);
        expect(ctx.filesModified.some((f) => f.path.includes('UserTable'))).toBe(true);

        // Markdown
        expect(ctx.markdown).toContain('claude-code');
        expect(ctx.markdown).toContain('pagination bug');
        expect(ctx.markdown).toContain('UserTable');

        // Key decisions (from thinking blocks)
        // Should detect "need to" patterns in thinking
        expect(ctx.filesModified.length).toBeGreaterThan(0);
      } finally {
        if (origEnv !== undefined) {
          process.env['CLAUDE_CONFIG_DIR'] = origEnv;
        } else {
          delete process.env['CLAUDE_CONFIG_DIR'];
        }
      }
    } finally {
      rmSync(test.dir, { recursive: true, force: true });
    }
  });

  it('should return empty list when no sessions exist', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'kimi-import-empty-'));
    try {
      const { claudeCodeParser } = await import('#/cli/import/sources/claude-code');

      const origEnv = process.env['CLAUDE_CONFIG_DIR'];
      process.env['CLAUDE_CONFIG_DIR'] = emptyDir;
      try {
        const sessions = await claudeCodeParser.listSessions();
        expect(sessions).toEqual([]);
      } finally {
        if (origEnv !== undefined) {
          process.env['CLAUDE_CONFIG_DIR'] = origEnv;
        } else {
          delete process.env['CLAUDE_CONFIG_DIR'];
        }
      }
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('should extract pending work from thinking blocks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-import-pending-'));
    const sessionId = 'pending-session-1111-2222-3333-444444444444';
    const projectsDir = join(dir, 'projects', '-Users-testuser-testproject');
    mkdirSync(projectsDir, { recursive: true });
    const sessionPath = join(projectsDir, `${sessionId}.jsonl`);

    const lines = [
      JSON.stringify({
        type: 'user',
        parentUuid: null,
        uuid: 'm1',
        timestamp: '2026-07-24T10:00:00.000Z',
        sessionId,
        cwd: '/Users/testuser/testproject',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Build a todo app' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        parentUuid: 'm1',
        uuid: 'm2',
        timestamp: '2026-07-24T10:00:05.000Z',
        sessionId,
        message: {
          role: 'assistant',
          model: 'test-model',
          content: [
            {
              type: 'thinking',
              thinking:
                'Done with the basic CRUD. Next step: add authentication. ' +
                'I also need to implement error handling and proper loading states. ' +
                'TODO: write unit tests for all components.',
            },
            { type: 'text', text: 'Basic CRUD is working.' },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    ];

    writeFileSync(sessionPath, lines.join('\n') + '\n', 'utf-8');

    try {
      const { claudeCodeParser } = await import('#/cli/import/sources/claude-code');

      const origEnv = process.env['CLAUDE_CONFIG_DIR'];
      process.env['CLAUDE_CONFIG_DIR'] = dir;
      try {
        const ctx = await claudeCodeParser.parseSession(sessionId);
        // Should catch "next step", "need to", "TODO"
        expect(ctx.pendingWork.length).toBeGreaterThan(0);
      } finally {
        if (origEnv !== undefined) {
          process.env['CLAUDE_CONFIG_DIR'] = origEnv;
        } else {
          delete process.env['CLAUDE_CONFIG_DIR'];
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should throw for non-existent session', async () => {
    const { claudeCodeParser } = await import('#/cli/import/sources/claude-code');
    await expect(
      claudeCodeParser.parseSession('nonexistent-session-id'),
    ).rejects.toThrow('not found');
  });
});

describe('Handoff Markdown format', () => {
  it('should produce valid Markdown with YAML frontmatter', async () => {
    const test = createTestCCSession();
    try {
      const { claudeCodeParser } = await import('#/cli/import/sources/claude-code');

      const origEnv = process.env['CLAUDE_CONFIG_DIR'];
      process.env['CLAUDE_CONFIG_DIR'] = test.dir;
      try {
        const ctx = await claudeCodeParser.parseSession(test.sessionId);

        // YAML frontmatter
        expect(ctx.markdown.startsWith('---')).toBe(true);
        const secondDelim = ctx.markdown.indexOf('---', 4);
        expect(secondDelim).toBeGreaterThan(0);

        const yamlPart = ctx.markdown.slice(3, secondDelim).trim();
        expect(yamlPart).toContain('source: claude-code');
        expect(yamlPart).toContain(`sourceSessionId: "${test.sessionId}"`);
        expect(yamlPart).toContain('model: "deepseek-v4-pro"');

        // Content sections
        expect(ctx.markdown).toContain('## Summary');
        expect(ctx.markdown).toContain('## Recent Conversation');
        expect(ctx.markdown).toContain('## Files Modified');
      } finally {
        if (origEnv !== undefined) {
          process.env['CLAUDE_CONFIG_DIR'] = origEnv;
        } else {
          delete process.env['CLAUDE_CONFIG_DIR'];
        }
      }
    } finally {
      rmSync(test.dir, { recursive: true, force: true });
    }
  });
});
