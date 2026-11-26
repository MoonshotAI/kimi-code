import { Readable, type Writable } from 'node:stream';

import { bash, say } from '@moonshot-ai/testkit/model';
import { describe, expect, test as base } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

import { makeHookRunner } from '../features/externalHooks/runner-stub';
import {
  execEnvServices,
  externalHookServices,
  testkitAgentFixtures,
  type TestkitAgentFixtures,
} from '../harness';
import { createFakeProcessRunner } from '../tools/fixtures/fake-exec';

function hookJsonCommand(payload: unknown): string {
  const script = `process.stdout.write(JSON.stringify(${JSON.stringify(payload)}));`;
  return `node -e ${JSON.stringify(script)}`;
}

function recordingCommandRunner(stdout: string, spawned: string[]): IHostProcessService {
  function createProcess(): IHostProcess {
    return {
      _serviceBrand: undefined,
      stdin: { write: () => {}, end: () => {} } as unknown as Writable,
      stdout: Readable.from([stdout]),
      stderr: Readable.from(['']),
      pid: 42,
      exitCode: 0,
      wait: () => Promise.resolve(0),
      kill: () => Promise.resolve(undefined),
      dispose: () => Promise.resolve(undefined),
    } as unknown as IHostProcess;
  }
  return createFakeProcessRunner({
    spawn: (async (command: string, args?: readonly string[]) => {
      spawned.push([command, ...(args ?? [])].join(' '));
      return createProcess();
    }) as unknown as IHostProcessService['spawn'],
  });
}

describe('external hook tool I/O rewriting', () => {
  describe('PreToolUse updatedInput', () => {
    const spawned: string[] = [];
    const hookEngine = makeHookRunner([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: hookJsonCommand({
          hookSpecificOutput: { updatedInput: { command: 'printf rewritten-args', timeout: 60 } },
        }),
      },
    ]);
    const test = base.extend<TestkitAgentFixtures>(
      testkitAgentFixtures(
        execEnvServices({ processRunner: recordingCommandRunner('rewritten-args', spawned) }),
        externalHookServices(hookEngine),
      ),
    );

    test('executes the rewritten command instead of the original one', async ({ agent, model }) => {
      spawned.length = 0;
      agent.get(IAgentLoopService).update({ activeToolNames: ['Bash'] });
      await agent.rpc.setPermission({ mode: 'auto' });
      model.script(bash('printf original-args'), say('done'));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'run the command' }] });
      await agent.untilTurnEnd();

      expect(spawned.some((command) => command.includes('printf rewritten-args'))).toBe(true);
      expect(spawned.some((command) => command.includes('printf original-args'))).toBe(false);
    });
  });

  describe('PreToolUse malformed updatedInput', () => {
    const spawned: string[] = [];
    const hookEngine = makeHookRunner([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: hookJsonCommand({ hookSpecificOutput: { updatedInput: 'not-an-object' } }),
      },
    ]);
    const test = base.extend<TestkitAgentFixtures>(
      testkitAgentFixtures(
        execEnvServices({ processRunner: recordingCommandRunner('unreachable', spawned) }),
        externalHookServices(hookEngine),
      ),
    );

    test('rejects the call visibly without executing the original input', async ({ agent, model }) => {
      spawned.length = 0;
      agent.get(IAgentLoopService).update({ activeToolNames: ['Bash'] });
      await agent.rpc.setPermission({ mode: 'auto' });
      model.script(bash('printf original-args'), say('done'));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'run the command' }] });
      await agent.untilTurnEnd();

      expect(spawned).toHaveLength(0);
      const history = JSON.stringify(agent.get(IAgentLoopService).history());
      expect(history).toContain('malformed updatedInput');
    });
  });

  describe('PostToolUse malformed content parts', () => {
    const spawned: string[] = [];
    const hookEngine = makeHookRunner([
      {
        event: 'PostToolUse',
        matcher: 'Bash',
        command: hookJsonCommand({
          hookSpecificOutput: { updatedToolOutput: [{ type: 'text' }] },
        }),
      },
    ]);
    const test = base.extend<TestkitAgentFixtures>(
      testkitAgentFixtures(
        execEnvServices({ processRunner: recordingCommandRunner('original-kept-output', spawned) }),
        externalHookServices(hookEngine),
      ),
    );

    test('keeps the original result when a content part is malformed', async ({ agent, model }) => {
      agent.get(IAgentLoopService).update({ activeToolNames: ['Bash'] });
      await agent.rpc.setPermission({ mode: 'auto' });
      model.script(bash('printf original-kept-output'), say('done'));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'run the command' }] });
      await agent.untilTurnEnd();

      const requests = model.requests('main');
      expect(requests.length).toBeGreaterThanOrEqual(2);
      const toolTexts = requests[1]!.view.messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.text);
      expect(toolTexts.some((text) => text.includes('original-kept-output'))).toBe(true);
    });
  });

  describe('PostToolUse updatedToolOutput', () => {
    const spawned: string[] = [];
    const hookEngine = makeHookRunner([
      {
        event: 'PostToolUse',
        matcher: 'Bash',
        command: hookJsonCommand({
          hookSpecificOutput: { updatedToolOutput: 'replaced-output-text' },
        }),
      },
    ]);
    const test = base.extend<TestkitAgentFixtures>(
      testkitAgentFixtures(
        execEnvServices({ processRunner: recordingCommandRunner('original-output-text', spawned) }),
        externalHookServices(hookEngine),
      ),
    );

    test('replaces the model-facing tool result', async ({ agent, model }) => {
      agent.get(IAgentLoopService).update({ activeToolNames: ['Bash'] });
      await agent.rpc.setPermission({ mode: 'auto' });
      model.script(bash('printf original-output-text'), say('done'));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'run the command' }] });
      await agent.untilTurnEnd();

      const requests = model.requests('main');
      expect(requests.length).toBeGreaterThanOrEqual(2);
      const toolTexts = requests[1]!.view.messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.text);
      expect(toolTexts.some((text) => text.includes('replaced-output-text'))).toBe(true);
      expect(toolTexts.every((text) => !text.includes('original-output-text'))).toBe(true);
    });
  });
});
