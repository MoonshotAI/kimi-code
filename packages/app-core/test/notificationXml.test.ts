import { describe, expect, it } from 'vitest';
import {
  notificationStatus,
  notificationVariant,
  parseTaskNotifications,
} from '../src/client';

const COMPLETED = `<notification id="task:bash-lo9yv9ch:completed" category="task" type="task.completed" source_kind="background_task" source_id="bash-lo9yv9ch">
Title: desktop dev (renderer HMR + embedded server)
Severity: info
Background process completed.
<output-file path="/Users/x/.kimi-code/sessions/s1/agents/main/tasks/bash-lo9yv9ch/output.log" bytes="2157599">
Read the output file to retrieve the result: /Users/x/.kimi-code/sessions/s1/agents/main/tasks/bash-lo9yv9ch/output.log
</output-file>
</notification>`;

const FAILED = `<notification id="task:bash-m4:failed" category="task" type="task.failed" source_kind="background_task" source_id="bash-m4">
Title: pnpm build
Severity: error
Background process failed with exit code 1.
</notification>`;

// The `<output-preview>` shape renderOutputPreviewBlock emits when no
// persisted full output file exists (agent-core taskService).
const PREVIEW = `<notification id="task:bash-x9:failed" category="task" type="task.failed" source_kind="background_task" source_id="bash-x9">
Title: Background process failed
Severity: warning
pnpm build failed. Reason: exit code 1
<output-preview bytes="46" total_bytes="4096" truncated="true">
Showing the last 46 bytes. No persisted full output is available.
src/index.ts(1,7): error TS2304: Cannot find name 'foo'.
</output-preview>
</notification>`;

describe('parseTaskNotifications', () => {
  it('parses a full block with output file', () => {
    const [n] = parseTaskNotifications(COMPLETED);
    expect(n).toMatchObject({
      id: 'task:bash-lo9yv9ch:completed',
      category: 'task',
      type: 'task.completed',
      sourceKind: 'background_task',
      sourceId: 'bash-lo9yv9ch',
      title: 'desktop dev (renderer HMR + embedded server)',
      severity: 'info',
      body: 'Background process completed.',
      outputFile: {
        path: '/Users/x/.kimi-code/sessions/s1/agents/main/tasks/bash-lo9yv9ch/output.log',
        bytes: 2157599,
      },
      raw: COMPLETED,
    });
  });

  it('parses a block without output file', () => {
    const [n] = parseTaskNotifications(FAILED);
    expect(n?.outputFile).toBeUndefined();
    expect(n?.body).toBe('Background process failed with exit code 1.');
  });

  it('parses merged blocks from one message', () => {
    const list = parseTaskNotifications(`${COMPLETED}\n\n${FAILED}`);
    expect(list.map((n) => n.type)).toEqual(['task.completed', 'task.failed']);
  });

  it('parses an output-preview block, dropping its explanation line', () => {
    const [n] = parseTaskNotifications(PREVIEW);
    expect(n?.outputFile).toBeUndefined();
    expect(n?.outputPreview).toEqual({
      text: "src/index.ts(1,7): error TS2304: Cannot find name 'foo'.",
      bytes: 46,
      totalBytes: 4096,
      truncated: true,
    });
    // The preview markup stays out of the prose body.
    expect(n?.body).toBe('pnpm build failed. Reason: exit code 1');
  });

  it('unescapes XML entities in the output-preview text', () => {
    const text = PREVIEW.replace(
      "src/index.ts(1,7): error TS2304: Cannot find name 'foo'.",
      'pnpm lint &amp;&amp; pnpm build &gt; out.log',
    );
    const [n] = parseTaskNotifications(text);
    expect(n?.outputPreview?.text).toBe('pnpm lint && pnpm build > out.log');
  });

  it('reads truncated="false" as false and tolerates a missing total_bytes', () => {
    const text = PREVIEW.replace('total_bytes="4096" truncated="true"', 'truncated="false"');
    const [n] = parseTaskNotifications(text);
    expect(n?.outputPreview?.truncated).toBe(false);
    expect(n?.outputPreview?.totalBytes).toBeUndefined();
    expect(n?.outputPreview?.bytes).toBe(46);
  });

  it('keeps the agent_id attr for subagent sources', () => {
    const text = COMPLETED.replace('source_kind="background_task"', 'source_kind="subagent" agent_id="agent-42"');
    const [n] = parseTaskNotifications(text);
    expect(n?.sourceKind).toBe('subagent');
    expect(n?.agentId).toBe('agent-42');
  });

  it('unescapes XML attr entities', () => {
    const text = FAILED.replace('bash-m4:failed', 'a&amp;b&quot;c');
    const [n] = parseTaskNotifications(text);
    expect(n?.id).toBe('task:a&b"c');
  });

  it('unescapes XML entities in title and body text nodes', () => {
    const text = FAILED.replace('pnpm build', 'pnpm lint &amp;&amp; pnpm build').replace(
      'Background process failed with exit code 1.',
      'exit code 1 &gt; see &lt;build.log&gt;',
    );
    const [n] = parseTaskNotifications(text);
    expect(n?.title).toBe('pnpm lint && pnpm build');
    expect(n?.body).toBe('exit code 1 > see <build.log>');
  });

  it('returns [] for text without a well-formed block', () => {
    expect(parseTaskNotifications('plain user text')).toEqual([]);
    expect(parseTaskNotifications('<notification id="x">unclosed')).toEqual([]);
  });

  it('drops the child markup from the body but keeps surrounding prose', () => {
    const text = FAILED.replace(
      'Background process failed with exit code 1.',
      'line one\nline two',
    );
    const withFile = text.replace('</notification>', `<output-file path="/tmp/o.log" bytes="3">\nread it\n</output-file>\n</notification>`);
    const [n] = parseTaskNotifications(withFile);
    expect(n?.body).toBe('line one\nline two');
  });
});

describe('notificationStatus / notificationVariant', () => {
  const base = parseTaskNotifications(COMPLETED)[0]!;
  const withType = (type: string, severity = 'info') => ({ ...base, type, severity });

  it('derives status from the type suffix', () => {
    expect(notificationStatus(withType('task.completed'))).toBe('completed');
    expect(notificationStatus(withType('task.failed'))).toBe('failed');
    expect(notificationStatus(withType('task.timed_out'))).toBe('timed_out');
    expect(notificationStatus(withType('task.killed'))).toBe('killed');
    expect(notificationStatus(withType('task.lost'))).toBe('lost');
    expect(notificationStatus(withType('task.whatever'))).toBe('info');
  });

  it('maps status to variant, with severity as the fallback for unknown types', () => {
    expect(notificationVariant(withType('task.completed'))).toBe('ok');
    expect(notificationVariant(withType('task.failed'))).toBe('err');
    expect(notificationVariant(withType('task.timed_out'))).toBe('err');
    expect(notificationVariant(withType('task.lost'))).toBe('err');
    expect(notificationVariant(withType('task.killed'))).toBe('warn');
    expect(notificationVariant(withType('task.whatever', 'error'))).toBe('err');
    expect(notificationVariant(withType('task.whatever', 'warning'))).toBe('warn');
    expect(notificationVariant(withType('task.whatever', 'info'))).toBe('info');
  });
});
