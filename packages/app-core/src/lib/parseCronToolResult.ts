export interface CronJobFields {
  id?: string;
  cron?: string;
  recurring?: string;
  nextFireAt?: string;
  prompt?: string;
  stale?: string;
}

export interface CronListResult {
  count: number;
  jobs: CronJobFields[];
}

const LIST_REQUIRED = ['id', 'cron', 'prompt', 'recurring'] as const satisfies readonly (keyof CronJobFields)[];

const FIELD_LINE = /^([A-Za-z][A-Za-z0-9_]*): (.*)$/;
const LIST_HEADER = /^cron_jobs: (\d+)$/;
const DELETE_LINE = /^Deleted cron job (\S+)\.$/;

function splitLines(output: readonly string[] | undefined): string[] {
  return (output ?? []).flatMap((chunk) => chunk.split('\n'));
}

function parseCronFields(lines: readonly string[]): CronJobFields {
  const fields: Record<string, string> = {};
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

export function parseCronCreateResult(output: readonly string[] | undefined): CronJobFields | null {
  const fields = parseCronFields(splitLines(output));
  return fields.id && fields.cron ? fields : null;
}

export function parseCronDeleteResult(output: readonly string[] | undefined): CronJobFields | null {
  const match = DELETE_LINE.exec(splitLines(output).join('\n').trim());
  return match ? { id: match[1] } : null;
}

export function parseCronListResult(output: readonly string[] | undefined): CronListResult | null {
  const lines = splitLines(output);
  const header = LIST_HEADER.exec(lines[0] ?? '');
  if (!header) return null;
  const count = Number(header[1]);
  const jobs: CronJobFields[] = [];
  let block: string[] = [];
  const flush = () => {
    const fields = parseCronFields(block);
    block = [];
    if (LIST_REQUIRED.every((key) => fields[key] !== undefined)) jobs.push(fields);
  };
  for (const line of lines.slice(1)) {
    if (line === '---') flush();
    else block.push(line);
  }
  flush();
  return jobs.length === count ? { count, jobs } : null;
}
