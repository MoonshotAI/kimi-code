import { describe, expect, it } from 'vitest';
import type { SessionContextItemDetail } from '@moonshot-ai/app-core/api';
import { contextItemText, contextPartText } from '../../src/renderer/inspector/contextCopy';

function detail(parts: SessionContextItemDetail['parts']): SessionContextItemDetail {
  return {
    id: 'message-0',
    role: 'assistant',
    chars: 0,
    has_media: false,
    parts,
    raw: null,
  };
}

describe('context copy text', () => {
  it('joins readable parts and formats structured tool calls', () => {
    const text = contextItemText(detail([
      { kind: 'think', text: 'Check the tests' },
      { kind: 'text', text: 'I will run them.' },
      { kind: 'function', name: 'Bash', data: { command: 'pnpm test' } },
    ]));
    expect(text).toBe([
      'Check the tests',
      'I will run them.',
      'Bash\n{\n  "command": "pnpm test"\n}',
    ].join('\n\n'));
  });

  it('uses nested result text once and preserves the tool name', () => {
    const part = {
      kind: 'result',
      name: 'Read',
      data: { content: 'file contents' },
      children: [{ kind: 'text', text: 'file contents' }],
    };
    expect(contextPartText(part)).toBe('Read\nfile contents');
  });

  it('falls back to structured data and skips empty parts', () => {
    expect(contextItemText(detail([
      { kind: 'data' },
      { kind: 'data', data: { ok: true } },
    ]))).toBe('{\n  "ok": true\n}');
    expect(contextItemText(detail([]))).toBe('');
  });

  it('preserves raw system prompt text and formats named text sections', () => {
    expect(contextPartText({ kind: 'text', name: 'Skills', text: 'Available skills' })).toBe(
      '# Skills\n\nAvailable skills',
    );
    expect(contextItemText({
      id: 'system',
      role: 'system',
      chars: 25,
      has_media: false,
      parts: [
        { kind: 'text', text: 'Intro' },
        { kind: 'text', name: 'Skills', text: 'List' },
      ],
      raw: 'Intro\n\n# Skills\n\nList',
    })).toBe('Intro\n\n# Skills\n\nList');
  });
});
