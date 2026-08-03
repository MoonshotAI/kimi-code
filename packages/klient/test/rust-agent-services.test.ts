/**
 * A1+A2 agent service integration over the rust transport: plan round-trip
 * (enter → status → cancel), profile get/set model, shell run, and the task
 * roster. The channel is assembled directly (`RustChannel` +
 * `createKlientFromChannel`) and only the A1+A2 service module is imported —
 * the registry's sibling group modules land in parallel and may not exist
 * yet. Run with `KIMI_AGENT_FORCE_STDIO=1` (the vitest config sets it,
 * mirroring the node-sdk suite).
 */
import { describe, expect, it } from 'vitest';

import * as rustLoop from '@moonshot-ai/kimi-agent/rust-loop';
import { createKlientFromChannel, type Klient } from '#/core/klient';
import { RustChannel } from '#/transports/rust/channel';
// Side-effect import: self-registers agentPlanService + agentProfileService +
// agentShellCommandService + agentTaskService.
import '#/transports/rust/services/agentServices';

function createTestKlient(): Klient {
  const channel = new RustChannel({
    rust: rustLoop as unknown as typeof rustLoop,
    host: { homeDir: process.cwd(), configPath: 'config.toml' },
  });
  return createKlientFromChannel(channel);
}

describe('rust agentPlanService', () => {
  it('plan enter → status → cancel round-trips through the engine', async () => {
    const klient = createTestKlient();
    try {
      const created = await rustLoop.sessionCreate({ homedir: process.cwd() });
      expect(created?.session_id).toBeTypeOf('string');
      const agent = klient.session(created!.session_id).agent('main');

      // Not in plan mode yet.
      expect(await agent.getPlan()).toBeNull();

      // Enter plan mode: the engine activates plan mode and creates the plan
      // file, so `status` resolves to a full plan snapshot.
      await agent.enterPlan();
      const plan = await agent.getPlan();
      expect(plan).not.toBeNull();
      expect(typeof plan!.id).toBe('string');
      expect(plan!.id.length).toBeGreaterThan(0);
      expect(typeof plan!.content).toBe('string');
      expect(typeof plan!.path).toBe('string');
      expect(plan!.path.length).toBeGreaterThan(0);

      // Exiting plan mode clears the state machine; the plan snapshot is gone.
      await agent.cancelPlan();
      expect(await agent.getPlan()).toBeNull();
    } finally {
      await klient.close();
    }
  });
});

describe('rust agentProfileService', () => {
  it('getModel defaults to empty and setModel round-trips', async () => {
    const klient = createTestKlient();
    try {
      const created = await rustLoop.sessionCreate({ homedir: process.cwd() });
      expect(created?.session_id).toBeTypeOf('string');
      const agent = klient.session(created!.session_id).agent('main');

      expect(await agent.getModel()).toBe('');

      const result = await agent.setModel('kimi-k2');
      expect(result.model).toBe('kimi-k2');
      expect(await agent.getModel()).toBe('kimi-k2');
    } finally {
      await klient.close();
    }
  });
});

describe('rust agentShellCommandService', () => {
  it('run returns the contract stdout/stderr/isError shape', async () => {
    const klient = createTestKlient();
    try {
      const created = await rustLoop.sessionCreate({ homedir: process.cwd() });
      expect(created?.session_id).toBeTypeOf('string');
      const agent = klient.session(created!.session_id).agent('main');

      const result = await agent.runShellCommand({ command: 'echo SHELL_OK' });
      expect(typeof result.stdout).toBe('string');
      expect(typeof result.stderr).toBe('string');
      if (result.isError !== true) {
        expect(result.stdout).toContain('SHELL_OK');
      }
    } finally {
      await klient.close();
    }
  });
});

describe('rust agentTaskService', () => {
  it('list returns a contract-shaped roster (empty on a fresh engine)', async () => {
    const klient = createTestKlient();
    try {
      const created = await rustLoop.sessionCreate({ homedir: process.cwd() });
      expect(created?.session_id).toBeTypeOf('string');
      const agent = klient.session(created!.session_id).agent('main');

      const tasks = await agent.getTasks({});
      expect(Array.isArray(tasks)).toBe(true);
      for (const task of tasks) {
        expect(['process', 'agent', 'question']).toContain(task.kind);
        expect(typeof task.taskId).toBe('string');
        expect(typeof task.status).toBe('string');
      }
    } finally {
      await klient.close();
    }
  });

  it('readOutput and stopTask tolerate unknown task ids', async () => {
    const klient = createTestKlient();
    try {
      const created = await rustLoop.sessionCreate({ homedir: process.cwd() });
      expect(created?.session_id).toBeTypeOf('string');
      const agent = klient.session(created!.session_id).agent('main');

      expect(await agent.getTaskOutput({ taskId: 'task_does_not_exist' })).toBe('');
      await expect(
        agent.stopTask({ taskId: 'task_does_not_exist' }),
      ).resolves.toBeUndefined();
    } finally {
      await klient.close();
    }
  });
});
