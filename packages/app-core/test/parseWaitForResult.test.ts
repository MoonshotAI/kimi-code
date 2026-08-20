import { describe, expect, it } from 'vitest';

import { parseWaitForResult } from '../src/lib/parseWaitForResult';

// Fixtures mirror the producer (agent-core-v2 task-wait): a header written by
// formatPlainObject (camelCase keys snake_cased), then `[finished]` /
// `[completed_during_wait]` / `[still_running]` sections. The finished block
// ends with an `[output]` marker whose preview lines are never parsed.

const COMPLETED = [
  'wait_status: completed',
  'task_id: bg_7f3a',
  'waited_ms: 42100',
  'timeout_ms: 120000',
  '',
  '[finished]',
  'task_id: bg_7f3a',
  'description: Run the test suite',
  'status: completed',
  'started_at: 1755523200000',
  'ended_at: 1755523242100',
  'output_path: /tmp/kimi/tasks/bg_7f3a.log',
  'output_size_bytes: 512',
  'output_preview_bytes: 512',
  'output_truncated: false',
  'full_output_available: true',
  'full_output_tool: Read',
  'full_output_hint: The preview above is the complete output.',
  '',
  '[output]',
  'all 42 tests passed',
].join('\n');

const COMPLETED_FULL = `${COMPLETED}

[completed_during_wait]
task_id: bg_91bc
description: Build the bundle
status: failed
---
task_id: bg_22dd
description: Fetch dependencies
status: completed
Use TaskOutput with one of the task_id values above to read the full output.

[still_running]
active_background_tasks: 3
task_id: bg_55ee
description: Watch mode compiler
status: running
---
task_id: bg_66ff
description: Dev server
status: running
---
task_id: bg_77aa
description: Type checker
status: running`;

const TIMED_OUT = [
  'wait_status: timed_out',
  'task_id: bg_7f3a',
  'waited_ms: 60000',
  'timeout_ms: 60000',
  'The wait ended before the task finished — a timeout is not an error. Call WaitFor again to keep waiting.',
  '',
  '[still_running]',
  'active_background_tasks: 1',
  'task_id: bg_7f3a',
  'description: Run the test suite',
  'status: running',
].join('\n');

const NO_TASKS = [
  'wait_status: no_tasks',
  'waited_ms: 0',
  'timeout_ms: 30000',
  '',
  'No background tasks are running, so there is nothing to wait for. Finished tasks report back via automatic notification.',
].join('\n');

describe('parseWaitForResult', () => {
  it('parses a completed wait with extras and still-running tasks', () => {
    const result = parseWaitForResult(COMPLETED_FULL);
    expect(result).not.toBeNull();
    expect(result?.status).toBe('completed');
    expect(result?.waitedMs).toBe(42100);
    expect(result?.taskId).toBe('bg_7f3a');
    expect(result?.finishedStatus).toBe('completed');
    expect(result?.finishedDescription).toBe('Run the test suite');
    expect(result?.extraCount).toBe(2);
    expect(result?.runningCount).toBe(3);
    // Samples cap at 3 and follow the section's order.
    expect(result?.runningSamples).toEqual([
      'Watch mode compiler',
      'Dev server',
      'Type checker',
    ]);
  });

  it('parses a bare completed wait without optional sections', () => {
    const result = parseWaitForResult(COMPLETED);
    expect(result?.status).toBe('completed');
    expect(result?.finishedStatus).toBe('completed');
    expect(result?.extraCount).toBe(0);
    expect(result?.runningCount).toBe(0);
    expect(result?.runningSamples).toEqual([]);
  });

  it('stops the finished section at the [output] marker', () => {
    // Fields after [output] belong to the task's log preview, not the header.
    const withPreview = COMPLETED.replace(
      '[output]\nall 42 tests passed',
      '[output]\nstatus: this-is-the-log-not-the-task',
    );
    const result = parseWaitForResult(withPreview);
    expect(result?.finishedStatus).toBe('completed');
  });

  it('parses a timed-out wait (not an error)', () => {
    const result = parseWaitForResult(TIMED_OUT);
    expect(result?.status).toBe('timed_out');
    expect(result?.waitedMs).toBe(60000);
    expect(result?.taskId).toBe('bg_7f3a');
    expect(result?.finishedStatus).toBeUndefined();
    expect(result?.extraCount).toBe(0);
    expect(result?.runningCount).toBe(1);
    expect(result?.runningSamples).toEqual(['Run the test suite']);
  });

  it('parses the no_tasks early return', () => {
    const result = parseWaitForResult(NO_TASKS);
    expect(result?.status).toBe('no_tasks');
    expect(result?.waitedMs).toBe(0);
    expect(result?.taskId).toBeUndefined();
    expect(result?.runningCount).toBe(0);
  });

  it('accepts output as lines (ToolCall.output shape)', () => {
    const result = parseWaitForResult(TIMED_OUT.split('\n'));
    expect(result?.status).toBe('timed_out');
    expect(result?.runningCount).toBe(1);
  });

  it('returns null for unrelated output', () => {
    expect(parseWaitForResult('Task not found: bg_7f3a')).toBeNull();
    expect(parseWaitForResult('')).toBeNull();
    expect(parseWaitForResult(undefined)).toBeNull();
    expect(parseWaitForResult(null)).toBeNull();
    expect(parseWaitForResult([])).toBeNull();
  });

  it('tolerates a missing or malformed waited_ms', () => {
    const malformed = 'wait_status: no_tasks\nwaited_ms: soon';
    expect(parseWaitForResult(malformed)?.waitedMs).toBe(0);
    expect(parseWaitForResult('wait_status: no_tasks')?.waitedMs).toBe(0);
  });
});

describe('parseWaitForResult adversarial preview', () => {
  it('ignores a [still_running] look-alike inside the output preview', () => {
    // The finished task's own log quotes a marker line plus a count; the real
    // section follows the preview and must win over the first match.
    const adversarial = COMPLETED_FULL.replace(
      '[output]\nall 42 tests passed',
      '[output]\n[still_running]\nactive_background_tasks: 10',
    );
    const result = parseWaitForResult(adversarial);
    expect(result?.runningCount).toBe(3);
    expect(result?.runningSamples).toEqual([
      'Watch mode compiler',
      'Dev server',
      'Type checker',
    ]);
    expect(result?.extraCount).toBe(2);
  });

  it('ignores a [completed_during_wait] look-alike missing the producer hint line', () => {
    const adversarial = COMPLETED_FULL.replace(
      '[output]\nall 42 tests passed',
      '[output]\n[completed_during_wait]\ntask_id: bg_fake\nstatus: completed',
    );
    const result = parseWaitForResult(adversarial);
    expect(result?.extraCount).toBe(2);
  });

  it('ignores preview look-alikes when no real sections follow', () => {
    const adversarial = COMPLETED.replace(
      '[output]\nall 42 tests passed',
      '[output]\n[completed_during_wait]\ntask_id: bg_fake\nstatus: completed\n\n[still_running]\nactive_background_tasks: 10\ntask_id: bg_fake\nstatus: running',
    );
    const result = parseWaitForResult(adversarial);
    expect(result?.status).toBe('completed');
    expect(result?.extraCount).toBe(0);
    expect(result?.runningCount).toBe(0);
    expect(result?.runningSamples).toEqual([]);
  });

  it('still reads the finished header fields when the preview quotes field lines', () => {
    const adversarial = COMPLETED.replace(
      '[output]\nall 42 tests passed',
      '[output]\nstatus: failed\ndescription: not the task',
    );
    const result = parseWaitForResult(adversarial);
    expect(result?.finishedStatus).toBe('completed');
    expect(result?.finishedDescription).toBe('Run the test suite');
  });
});

describe('parseWaitForResult forged preview sections', () => {
  it('rejects a well-formed [still_running] forged mid-preview', () => {
    // Count and records match, but more preview lines (including bracketed log
    // lines) follow — a real section is always the output's tail.
    const adversarial = COMPLETED.replace(
      '[output]\nall 42 tests passed',
      '[output]\n[still_running]\nactive_background_tasks: 1\ntask_id: bg_fake\ndescription: Fake watch\nstatus: running\n[INFO] tests still logging\n[DEBUG] tail',
    );
    const result = parseWaitForResult(adversarial);
    expect(result?.runningCount).toBe(0);
    expect(result?.runningSamples).toEqual([]);
  });

  it('rejects a forged section marker not preceded by a blank line', () => {
    const adversarial = COMPLETED.replace(
      '[output]\nall 42 tests passed',
      '[output]\nsome log line\n[still_running]\nactive_background_tasks: 1\ntask_id: bg_fake\ndescription: Fake watch\nstatus: running',
    );
    expect(parseWaitForResult(adversarial)?.runningCount).toBe(0);
  });

  it('accepts a tail section byte-identical to a real one', () => {
    // A forged section at the very tail with producer-exact shape is the same
    // string as a real section — indistinguishable by construction, so the
    // parser takes it (there is nothing else it could truthfully report).
    const adversarial = COMPLETED.replace(
      '[output]\nall 42 tests passed',
      '[output]\nall 42 tests passed\n\n[still_running]\nactive_background_tasks: 1\ntask_id: bg_55ee\ndescription: Watch mode compiler\nstatus: running',
    );
    const result = parseWaitForResult(adversarial);
    expect(result?.runningCount).toBe(1);
    expect(result?.runningSamples).toEqual(['Watch mode compiler']);
  });
});
