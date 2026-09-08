import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPrompt } from '#/cli/run-prompt';

const mocks = vi.hoisted(() => ({
  runV2Print: vi.fn(
    async (
      opts: { readonly outputFormat?: string },
      version: string,
      io?: {
        readonly stdout?: { write(chunk: string): boolean };
        readonly stderr?: { write(chunk: string): boolean };
      },
    ) => {
      const stdout = io?.stdout ?? process.stdout;
      const stderr = io?.stderr ?? process.stderr;
      const outputFormat = opts?.outputFormat ?? 'text';
      if (outputFormat === 'stream-json') {
        stdout.write(
          `${JSON.stringify({ role: 'meta', type: 'system.version', version })}\n`,
        );
        stdout.write(`${JSON.stringify({ role: 'assistant', content: 'hello world' })}\n`);
        stdout.write(
          `${JSON.stringify({
            role: 'meta',
            type: 'session.resume_hint',
            session_id: 'ses_prompt',
            command: 'kimi -r ses_prompt',
            content: 'To resume this session: kimi -r ses_prompt',
          })}\n`,
        );
        return;
      }
      stderr.write(`kimi version ${version}\n`);
      stdout.write('• hello world\n\n');
      stderr.write('To resume this session: kimi -r ses_prompt\n');
    },
  ),
}));

vi.mock('../../src/cli/v2/run-v2-print', () => ({
  runV2Print: mocks.runV2Print,
}));

function opts(overrides: Partial<Parameters<typeof runPrompt>[0]> = {}) {
  return {
    session: undefined,
    continue: false,
    yolo: false,
    auto: false,
    plan: false,
    model: undefined,
    outputFormat: undefined,
    prompt: 'say hello',
    skillsDirs: [],
    agent: undefined,
    agentFiles: [],
    addDirs: [],
    ...overrides,
  };
}

function writer(columns?: number) {
  let text = '';
  return {
    columns,
    write: vi.fn((chunk: string) => {
      text += chunk;
      return true;
    }),
    text: () => text,
  };
}

describe('runPrompt', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits the version first in text mode', async () => {
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr });

    expect(mocks.runV2Print).toHaveBeenCalled();
    expect(stderr.write).toHaveBeenNthCalledWith(1, 'kimi version 1.2.3-test\n');
    expect(stderr.text().startsWith('kimi version 1.2.3-test\n')).toBe(true);
    expect(stdout.text()).toBe('• hello world\n\n');
  });

  it('emits the version first in stream-json mode', async () => {
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', {
      stdout,
      stderr,
    });

    expect(mocks.runV2Print).toHaveBeenCalled();
    const lines = stdout.text().split('\n');
    expect(lines[0]).toBe(
      '{"role":"meta","type":"system.version","version":"1.2.3-test"}',
    );
    expect(stderr.text()).toBe('');
  });
});
