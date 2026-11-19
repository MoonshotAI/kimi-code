export type TaskFields = Record<string, string>;

export interface TaskListResult {
  activeOnly: boolean;
  count: number;
  tasks: TaskFields[];
}

export interface TaskOutputResult {
  fields: TaskFields;
  truncated: boolean;
  output: string[];
}

const FIELD_LINE = /^([a-z][a-z0-9_]*): (.*)$/;
const LIST_HEADER = /^(active_background_tasks|background_tasks): (\d+)$/;
const OUTPUT_MARKER = '[output]';
const NO_OUTPUT = '[no output available]';

export function parseTaskFields(lines: readonly string[]): TaskFields {
  const fields: TaskFields = {};
  let last: string | undefined;
  for (const line of lines) {
    const match = FIELD_LINE.exec(line);
    if (match) {
      last = match[1]!;
      fields[last] = match[2]!;
    } else if (last !== undefined) {
      fields[last] += `\n${line}`;
    }
  }
  return fields;
}

function splitLines(output: readonly string[] | undefined): string[] {
  return (output ?? []).flatMap((chunk) => chunk.split('\n'));
}

export function parseTaskListResult(output: readonly string[] | undefined): TaskListResult | null {
  const lines = splitLines(output);
  const header = LIST_HEADER.exec(lines[0] ?? '');
  if (!header) return null;
  const count = Number(header[2]);
  const tasks: TaskFields[] = [];
  let block: string[] = [];
  const flush = () => {
    const fields = parseTaskFields(block);
    if (fields.task_id) tasks.push(fields);
    block = [];
  };
  for (const line of lines.slice(1)) {
    if (line === '---') flush();
    else block.push(line);
  }
  flush();
  return { activeOnly: header[1] === 'active_background_tasks', count, tasks };
}

export function parseTaskOutputResult(output: readonly string[] | undefined): TaskOutputResult | null {
  const lines = splitLines(output);
  const marker = lines.indexOf(OUTPUT_MARKER);
  if (marker < 0) return null;
  const blank = lines.indexOf('');
  const fields = parseTaskFields(lines.slice(0, blank >= 0 && blank < marker ? blank : marker));
  if (!fields.task_id || !fields.status) return null;
  const truncated = lines.slice(0, marker).some((line) => line.startsWith('[Truncated.'));
  const body = lines.slice(marker + 1);
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const preview = body.length === 1 && body[0] === NO_OUTPUT ? [] : body;
  return { fields, truncated, output: preview };
}

export function parseTaskStopResult(output: readonly string[] | undefined): TaskFields | null {
  const fields = parseTaskFields(splitLines(output));
  return fields.task_id && fields.status ? fields : null;
}
