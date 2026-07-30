/**
 * Scenario: an idle engine launches work independently of any ACP prompt request.
 * Responsibilities: project the safe trigger, tool lifecycle, and final reply over ACP NDJSON.
 * Wiring: real v1/v2 harnesses, engines, node SDK, ACP connections, filesystem, and shell task;
 * only the remote Chat Completions endpoint is stubbed on loopback.
 * Run: pnpm --filter @moonshot-ai/acp-adapter exec vitest run test/agent-initiated-engine.e2e.test.ts
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRealEngineRig,
  type Engine,
  type RealEngineRig,
  waitForSessionEvent,
} from './_helpers/real-engine-rig';

const LONG_RUNNING_COMMAND = "node -e 'setInterval(()=>{},1e3)'";
const SAFE_TERMINATION_TEXT = 'Test background task was stopped.';

const rigs: RealEngineRig[] = [];

afterEach(async () => {
  for (const rig of rigs.splice(0).toReversed()) {
    await rig.close();
  }
});

describe('ACP idle engine turn projection', () => {
  it.each(['v1', 'v2'] as const)(
    'projects a complete idle task-notification turn through the %s engine',
    async (engine) => {
      const rig = await createAutonomousRig(engine);
      await expect(
        rig.client.prompt({
          sessionId: rig.session.id,
          prompt: [{ type: 'text', text: 'Start the test background task.' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
      const activeTasks = await rig.session.listBackgroundTasks({ activeOnly: true });
      expect(activeTasks).toEqual([
        expect.objectContaining({
          kind: 'process',
          command: LONG_RUNNING_COMMAND,
          detached: true,
          status: 'running',
        }),
      ]);
      const task = activeTasks[0];
      if (task === undefined) {
        throw new Error(`${engine} did not retain the background task`);
      }
      rig.collecting.updates.length = 0;

      const terminated = waitForSessionEvent(
        rig.session,
        (event) =>
          event.type === 'background.task.terminated' &&
          event.info.taskId === task.taskId,
        `${engine} background.task.terminated`,
      );
      const autonomousTurn = waitForSessionEvent(
        rig.session,
        (event) =>
          event.type === 'turn.started' &&
          event.origin.kind === (engine === 'v1' ? 'background_task' : 'task') &&
          event.origin.taskId === task.taskId,
        `${engine} background turn.started`,
      );
      const turnEnded = waitForSessionEvent(
        rig.session,
        (event) => event.type === 'turn.ended',
        `${engine} turn.ended`,
      );
      const safeTrigger = rig.collecting.waitForUpdate(
        (notification) =>
          notification.update.sessionUpdate === 'user_message_chunk' &&
          notification.update.content.type === 'text' &&
          notification.update.content.text === SAFE_TERMINATION_TEXT,
        `${engine} safe autonomous trigger`,
      );
      const toolStarted = rig.collecting.waitForUpdate(
        (notification) => notification.update.sessionUpdate === 'tool_call',
        `${engine} tool_call`,
      );
      const assistantReply = rig.collecting.waitForUpdate(
        (notification) =>
          notification.update.sessionUpdate === 'agent_message_chunk' &&
          notification.update.content.type === 'text' &&
          notification.update.content.text === 'Autonomous review finished.',
        `${engine} assistant reply`,
      );

      await rig.session.stopBackgroundTask(task.taskId);
      const [
        terminatedEvent,
        autonomousEvent,
        endedEvent,
        triggerUpdate,
        toolUpdate,
        replyUpdate,
      ] = await Promise.all([
        terminated,
        autonomousTurn,
        turnEnded,
        safeTrigger,
        toolStarted,
        assistantReply,
      ]);
      const toolCallId = toolUpdate.update.sessionUpdate === 'tool_call'
        ? toolUpdate.update.toolCallId
        : undefined;
      if (toolCallId === undefined) {
        throw new Error('tool_call waiter returned a different ACP update');
      }
      const toolCompleted = await rig.collecting.waitForUpdate(
        (notification) =>
          notification.update.sessionUpdate === 'tool_call_update' &&
          notification.update.toolCallId === toolCallId &&
          notification.update.status === 'completed',
        `${engine} completed tool_call_update for ${toolCallId}`,
      );
      expect(terminatedEvent.type).toBe('background.task.terminated');
      expect(autonomousEvent.type).toBe('turn.started');
      expect(endedEvent).toMatchObject({ type: 'turn.ended', reason: 'completed' });
      expect(rig.modelRequests).toHaveLength(4);
      expect(rig.modelRequests.map((request) => request.authorization)).toEqual([
        'Bearer YOUR_API_KEY',
        'Bearer YOUR_API_KEY',
        'Bearer YOUR_API_KEY',
        'Bearer YOUR_API_KEY',
      ]);
      expect(rig.modelRequests[2]?.body).toMatchObject({
        model: 'stub-model',
        stream: true,
        tools: expect.arrayContaining([
          expect.objectContaining({
            function: expect.objectContaining({ name: 'Read' }),
          }),
        ]),
      });
      expect(rig.modelRequests[3]?.body).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'tool', content: expect.stringContaining('fixture contents') }),
        ]),
      });

      const orderedUpdates = [
        triggerUpdate,
        toolUpdate,
        toolCompleted,
        replyUpdate,
      ].map((update) => rig.collecting.updates.indexOf(update));
      expect(orderedUpdates).toEqual(orderedUpdates.toSorted((left, right) => left - right));
      expect(new Set(orderedUpdates).size).toBe(orderedUpdates.length);

      const wire = JSON.stringify(rig.collecting.updates);
      expect(wire).not.toContain('<notification');
      expect(wire).not.toContain('task_id:');
      expect(wire).not.toContain(task.taskId);
    },
    30_000,
  );
});

async function createAutonomousRig(engine: Engine): Promise<RealEngineRig> {
  const homeDir = await mkdtemp(join(tmpdir(), `kimi-acp-${engine}-home-`));
  const workDir = await mkdtemp(join(tmpdir(), `kimi-acp-${engine}-work-`));
  const readPath = join(workDir, 'fixture.txt');
  await writeFile(readPath, 'fixture contents', 'utf-8');
  const rig = await createRealEngineRig({
    engine,
    homeDir,
    workDir,
    replies: [
      {
        kind: 'tool',
        id: 'call_start_background',
        name: 'Bash',
        arguments: {
          command: LONG_RUNNING_COMMAND,
          description: 'Test background task',
          run_in_background: true,
        },
      },
      { kind: 'text', text: 'Background task started.' },
      {
        kind: 'tool',
        id: 'call_read_fixture',
        name: 'Read',
        arguments: { path: readPath },
      },
      { kind: 'text', text: 'Autonomous review finished.' },
    ],
  });
  rigs.push(rig);
  return rig;
}
