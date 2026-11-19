const HEADER_LINE = /^(task_id|agent_id): \S/;
const SUMMARY_MARKER = '[summary]';
const ERROR_PREFIX = 'subagent error: ';
const TRAILER_LINE = /^(resume_hint|next_step): /;

function splitLines(output: readonly string[] | undefined): string[] {
  return (output ?? []).flatMap((chunk) => chunk.split('\n'));
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start++;
  while (end > start && lines[end - 1]!.trim() === '') end--;
  return lines.slice(start, end);
}

function dropTrailer(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && (TRAILER_LINE.test(lines[end - 1]!) || lines[end - 1]!.trim() === '')) end--;
  return lines.slice(0, end);
}

export function agentResultBody(output: readonly string[] | undefined): string[] {
  const lines = splitLines(output);
  if (lines.length === 0 || !HEADER_LINE.test(lines[0]!)) return [...(output ?? [])];

  const summaryAt = lines.indexOf(SUMMARY_MARKER);
  if (summaryAt >= 0) return trimBlankEdges(dropTrailer(lines.slice(summaryAt + 1)));

  const errorAt = lines.findIndex((line) => line.startsWith(ERROR_PREFIX));
  if (errorAt >= 0) {
    const body = dropTrailer(lines.slice(errorAt));
    body[0] = body[0]!.slice(ERROR_PREFIX.length);
    return trimBlankEdges(body);
  }

  return [];
}
