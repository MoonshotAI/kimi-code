/**
 * Dynamic Workflow contract schema validation.
 *
 * Exercises the Zod schemas from `contract/session/workflow.ts` with both
 * valid and invalid inputs.
 */

import { describe, expect, it } from 'vitest';

import {
  workflowDefinitionSchema,
  workflowRunRecordSchema,
  saveWorkflowInputSchema,
  startWorkflowRunInputSchema,
  skippedWorkflowSchema,
} from '../../../src/contract/session/workflow.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validWorkflowDefinition = {
  meta: {
    name: 'my-workflow',
    description: 'A test workflow',
    whenToUse: 'When testing',
    argumentHint: '<prompt>',
    phases: [{ title: 'phase-1', detail: 'First phase' }],
  },
  script: '---\nname: my-workflow\n---\nconsole.log("hello")',
  path: '/workflows/my-workflow.md',
  source: 'user' as const,
};

const validWorkflowRunRecord = {
  runId: 'wfrun-abc123',
  workflowName: 'my-workflow',
  description: 'A test workflow run',
  phases: [{ title: 'phase-1' }],
  status: 'running' as const,
  phase: 'phase-1',
  phaseIndex: 0,
  agentCalls: 3,
  logs: ['Starting phase-1', 'Agent call #1 completed'],
  error: undefined,
  resultJson: undefined,
  startedAt: Date.now(),
  endedAt: undefined,
  taskId: 'task-xyz',
  scriptPath: '/workflows/my-workflow.md',
  source: 'user' as const,
  script: '---\nname: my-workflow\n---\nconsole.log("hello")',
  args: 'some arg',
  callerAgentId: 'main',
};

const validSaveWorkflowInput = {
  script: '---\nname: my-workflow\n---\nconsole.log("hello")',
  scope: 'user' as const,
  overwrite: true,
};

const validStartWorkflowRunInput = {
  name: 'my-workflow',
  args: 'some-arg',
  callerAgentId: 'main',
};

const validSkippedWorkflow = {
  path: '/workflows/bad-workflow.md',
  reason: 'Invalid frontmatter: missing name field',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workflowDefinitionSchema', () => {
  it('accepts a minimal valid definition', () => {
    const result = workflowDefinitionSchema.safeParse(validWorkflowDefinition);
    expect(result.success).toBe(true);
  });

  it('accepts a definition without optional fields', () => {
    const minimal = {
      meta: { name: 'minimal', description: 'Minimal', phases: [{ title: 'only' }] },
      script: 'console.log("minimal")',
      path: '',
      source: 'builtin',
    };
    const result = workflowDefinitionSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('rejects a definition without name', () => {
    const noName = {
      meta: { description: 'no name', phases: [] },
      script: '',
      path: '',
      source: 'project',
    };
    const result = workflowDefinitionSchema.safeParse(noName);
    expect(result.success).toBe(false);
  });
});

describe('workflowRunRecordSchema', () => {
  it('accepts a valid running record', () => {
    const result = workflowRunRecordSchema.safeParse(validWorkflowRunRecord);
    expect(result.success).toBe(true);
  });

  it('accepts a completed record with optional fields', () => {
    const completed = {
      ...validWorkflowRunRecord,
      status: 'completed' as const,
      endedAt: Date.now(),
      resultJson: '{"result":"ok"}',
    };
    const result = workflowRunRecordSchema.safeParse(completed);
    expect(result.success).toBe(true);
  });

  it('accepts a failed record with error', () => {
    const failed = {
      ...validWorkflowRunRecord,
      status: 'failed' as const,
      endedAt: Date.now(),
      error: 'Something went wrong',
    };
    const result = workflowRunRecordSchema.safeParse(failed);
    expect(result.success).toBe(true);
  });

  it('rejects an invalid status', () => {
    const bad = { ...validWorkflowRunRecord, status: 'unknown' };
    const result = workflowRunRecordSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe('saveWorkflowInputSchema', () => {
  it('accepts valid save input', () => {
    const result = saveWorkflowInputSchema.safeParse(validSaveWorkflowInput);
    expect(result.success).toBe(true);
  });

  it('accepts save input without overwrite', () => {
    const withoutOverwrite = { script: validSaveWorkflowInput.script, scope: 'user' as const };
    const result = saveWorkflowInputSchema.safeParse(withoutOverwrite);
    expect(result.success).toBe(true);
  });

  it('rejects save input with invalid scope', () => {
    const bad = { script: 'test', scope: 'invalid' };
    const result = saveWorkflowInputSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe('startWorkflowRunInputSchema', () => {
  it('accepts valid start input', () => {
    const result = startWorkflowRunInputSchema.safeParse(validStartWorkflowRunInput);
    expect(result.success).toBe(true);
  });

  it('accepts inline script without name', () => {
    const inline = { script: 'console.log("inline")', args: '', callerAgentId: 'main' };
    const result = startWorkflowRunInputSchema.safeParse(inline);
    expect(result.success).toBe(true);
  });
});

describe('skippedWorkflowSchema', () => {
  it('accepts a valid skipped workflow entry', () => {
    const result = skippedWorkflowSchema.safeParse(validSkippedWorkflow);
    expect(result.success).toBe(true);
  });

  it('rejects entry without reason', () => {
    const noReason = { path: '/workflows/bad.md' };
    const result = skippedWorkflowSchema.safeParse(noReason);
    expect(result.success).toBe(false);
  });
});
