/**
 * Notification XML rendering — produces the chat-history injection text
 * shared between the live ContextMemory and the projector.
 *
 * Output shape:
 *   <notification id="..." category="..." type="..." source_kind="..." source_id="..." [agent_id="..."]>
 *   Title: ...
 *   Severity: ...
 *   <body>
 *   <task-notification>   (only when source_kind === 'background_task' and tail_output is non-empty)
 *   <truncated tail>
 *   </task-notification>
 *   </notification>
 *
 * The opening-tag names (`<notification ` / `<task-notification>`) are
 * load-bearing for the projector's `mergeAdjacentUserMessages` detector
 * — rename requires updating the detector too.
 *
 * `agent_id` is emitted only for background_task notifications whose
 * source task is an agent subagent — surfacing it structurally lets the
 * LLM identify the correct id to pass to `Agent(resume=...)` without
 * having to grep the body or the original spawn-success ToolResult.
 * It is intentionally a separate attribute from `source_id`: the two
 * look alike (`agent-...`) but live in different namespaces.
 */

export function renderNotificationXml(data: Record<string, unknown>): string {
  const id = stringAttr(data['id'], 'unknown');
  const category = stringAttr(data['category'], 'unknown');
  const type = stringAttr(data['type'], 'unknown');
  const sourceKind = stringAttr(data['source_kind'], 'unknown');
  const sourceId = stringAttr(data['source_id'], 'unknown');
  const agentId = optionalStringAttr(data['agent_id']);
  const title = typeof data['title'] === 'string' ? data['title'] : '';
  const severity = typeof data['severity'] === 'string' ? data['severity'] : '';
  const body = typeof data['body'] === 'string' ? data['body'] : '';

  const agentIdAttr = agentId === undefined ? '' : ` agent_id="${agentId}"`;
  const lines: string[] = [
    `<notification id="${id}" category="${category}" type="${type}" source_kind="${sourceKind}" source_id="${sourceId}"${agentIdAttr}>`,
  ];
  if (title.length > 0) lines.push(`Title: ${title}`);
  if (severity.length > 0) lines.push(`Severity: ${severity}`);
  if (body.length > 0) lines.push(body);

  if (data['source_kind'] === 'background_task') {
    const tailRaw = typeof data['tail_output'] === 'string' ? data['tail_output'] : '';
    if (tailRaw.length > 0) {
      const truncated = truncateTailOutput(tailRaw, 20, 3000);
      lines.push('<task-notification>');
      lines.push(truncated);
      lines.push('</task-notification>');
    }
  }

  lines.push('</notification>');
  return lines.join('\n');
}

/**
 * Truncate tail output to at most `maxLines` lines and `maxChars`
 * characters. Takes the *last* N lines, then trims from the front if
 * the character budget is exceeded.
 */
function truncateTailOutput(raw: string, maxLines: number, maxChars: number): string {
  const allLines = raw.split('\n');
  const tailLines = allLines.length > maxLines ? allLines.slice(-maxLines) : allLines;
  let result = tailLines.join('\n');
  if (result.length > maxChars) {
    result = result.slice(-maxChars);
  }
  return result;
}

function stringAttr(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  // Attribute boundary safety: escape `&` and `"`. Body-text `<` / `>`
  // stay untouched — the injection target is an LLM-visible transcript
  // where double-escaping would be noisier than literal punctuation.
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

/** Like `stringAttr` but returns `undefined` instead of a fallback so the
 *  caller can omit the attribute entirely when the source value is absent. */
function optionalStringAttr(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}
