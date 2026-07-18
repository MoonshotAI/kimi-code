/**
 * 5-field cron expression parsing and "next fire time" computation, in
 * local time. Self-contained — no external cron library is used because
 * upstream `claude-code` mirrors the same semantics and we need exact
 * lock-step behaviour with their implementation.
 *
 * Two flavours of correctness we care about:
 *
 *   1. **Semantics.** Standard 5 fields (minute hour day-of-month month
 *      day-of-week). Day-of-month and day-of-week combine with cron's
 *      OR rule when both are restricted (POSIX/Vixie tradition). dow
 *      accepts 0..7 with 7 folded to 0 (Sunday).
 *
 *   2. **Termination.** Computing `next` for a legal-but-never-fires
 *      expression like `0 0 31 2 *` must not spin. We bound the search
 *      at a fixed window (5 years by default) and return `null` past
 *      that — the validator at `CronCreate` reuses this signal.
 */

/** A parsed cron expression. Opaque to callers — pass it back into {@link computeNextCronRun}. */
export interface ParsedCronExpression {
  readonly raw: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly daysOfMonthWildcard: boolean;
  readonly daysOfWeekWildcard: boolean;
}

const MINUTE_RANGE = { min: 0, max: 59 } as const;
const HOUR_RANGE = { min: 0, max: 23 } as const;
const DOM_RANGE = { min: 1, max: 31 } as const;
const MONTH_RANGE = { min: 1, max: 12 } as const;
const DOW_RANGE = { min: 0, max: 7 } as const;

const MS_PER_MINUTE = 60_000;

export function parseCronExpression(expr: string): ParsedCronExpression {
  if (typeof expr !== 'string') {
    throw new TypeError('cron expression must be a string');
  }
  const trimmed = expr.trim();
  if (trimmed === '') {
    throw new Error('cron expression is empty');
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week); got ${fields.length}`,
    );
  }
  const [minField, hourField, domField, monthField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const minutes = parseField(minField, MINUTE_RANGE.min, MINUTE_RANGE.max, 'minute');
  const hours = parseField(hourField, HOUR_RANGE.min, HOUR_RANGE.max, 'hour');
  const daysOfMonth = parseField(domField, DOM_RANGE.min, DOM_RANGE.max, 'day-of-month');
  const months = parseField(monthField, MONTH_RANGE.min, MONTH_RANGE.max, 'month');
  const dowRaw = parseField(dowField, DOW_RANGE.min, DOW_RANGE.max, 'day-of-week');
  const daysOfWeek = new Set<number>();
  for (const v of dowRaw) daysOfWeek.add(v === 7 ? 0 : v);

  return {
    raw: trimmed,
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    daysOfMonthWildcard: isWildcard(domField),
    daysOfWeekWildcard: isWildcard(dowField),
  };
}

function isWildcard(field: string): boolean {
  return field === '*';
}

function parseField(field: string, min: number, max: number, name: string): Set<number> {
  if (field === '') {
    throw new Error(`cron ${name} field is empty`);
  }
  const out = new Set<number>();
  const terms = field.split(',');
  for (const term of terms) {
    if (term === '') {
      throw new Error(`cron ${name} field has empty term in list`);
    }
    addTerm(out, term, min, max, name);
  }
  if (out.size === 0) {
    throw new Error(`cron ${name} field matches no values`);
  }
  return out;
}

const DIGIT_ONLY = /^\d+$/;

function parseCronInt(raw: string, name: string, role: string): number {
  if (!DIGIT_ONLY.test(raw)) {
    throw new Error(
      `cron ${name} ${role} must be a non-negative integer with digits only (got ${JSON.stringify(raw)})`,
    );
  }
  return Number.parseInt(raw, 10);
}

function addTerm(out: Set<number>, term: string, min: number, max: number, name: string): void {
  let rangePart = term;
  let step = 1;
  const slash = term.indexOf('/');
  if (slash !== -1) {
    rangePart = term.slice(0, slash);
    const stepStr = term.slice(slash + 1);
    if (stepStr === '') {
      throw new Error(`cron ${name} step is empty in "${term}"`);
    }
    const parsedStep = parseCronInt(stepStr, name, 'step');
    if (parsedStep <= 0) {
      throw new Error(`cron ${name} step must be a positive integer (got "${stepStr}")`);
    }
    step = parsedStep;
    if (rangePart === '') {
      throw new Error(`cron ${name} step needs a range or "*" before "/" in "${term}"`);
    }
  }

  let lo: number;
  let hi: number;
  if (rangePart === '*') {
    lo = min;
    hi = max;
  } else {
    const dash = rangePart.indexOf('-');
    if (dash === -1) {
      const single = parseCronInt(rangePart, name, 'value');
      if (single < min || single > max) {
        throw new Error(`cron ${name} value ${single} out of range ${min}..${max}`);
      }
      if (slash !== -1) {
        lo = single;
        hi = max;
      } else {
        out.add(single);
        return;
      }
    } else {
      const loStr = rangePart.slice(0, dash);
      const hiStr = rangePart.slice(dash + 1);
      lo = parseCronInt(loStr, name, 'range lower bound');
      hi = parseCronInt(hiStr, name, 'range upper bound');
      if (lo < min || hi > max || lo > hi) {
        throw new Error(
          `cron ${name} range ${lo}-${hi} out of bounds (must be ${min}..${max}, ascending)`,
        );
      }
    }
  }

  for (let v = lo; v <= hi; v += step) {
    out.add(v);
  }
}

export function computeNextCronRun(expr: ParsedCronExpression, fromMs: number): number | null {
  return nextRunWithinMinutes(expr, fromMs, 5 * 366 * 24 * 60);
}

export function hasFireWithinYears(
  expr: ParsedCronExpression,
  years: number,
  fromMs: number,
): boolean {
  const cap = Math.max(1, Math.floor(years * 366 * 24 * 60));
  return nextRunWithinMinutes(expr, fromMs, cap) !== null;
}

function nextRunWithinMinutes(
  expr: ParsedCronExpression,
  fromMs: number,
  capMinutes: number,
): number | null {
  const start = new Date(fromMs);
  start.setSeconds(0, 0);
  const date = new Date(start.getTime() + MS_PER_MINUTE);

  const deadlineMs = fromMs + capMinutes * MS_PER_MINUTE;

  let iterations = 0;
  const HARD_ITERATION_CAP = 10_000_000;

  while (date.getTime() <= deadlineMs && iterations++ < HARD_ITERATION_CAP) {
    if (!expr.months.has(date.getMonth() + 1)) {
      advanceMonth(date);
      continue;
    }

    if (!dayMatches(expr, date)) {
      advanceDay(date);
      continue;
    }

    if (!expr.hours.has(date.getHours())) {
      advanceHour(date);
      continue;
    }

    if (!expr.minutes.has(date.getMinutes())) {
      advanceMinute(date);
      continue;
    }

    return date.getTime();
  }

  return null;
}

function dayMatches(expr: ParsedCronExpression, date: Date): boolean {
  const dom = date.getDate();
  const dow = date.getDay();
  const domOk = expr.daysOfMonth.has(dom);
  const dowOk = expr.daysOfWeek.has(dow);

  if (expr.daysOfMonthWildcard && expr.daysOfWeekWildcard) return true;
  if (expr.daysOfMonthWildcard) return dowOk;
  if (expr.daysOfWeekWildcard) return domOk;
  return domOk || dowOk;
}

function advanceMonth(date: Date): void {
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  date.setMonth(date.getMonth() + 1);
}

function advanceDay(date: Date): void {
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 1);
}

function advanceHour(date: Date): void {
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
}

function advanceMinute(date: Date): void {
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export function cronToHuman(expr: ParsedCronExpression): string {
  const allMin = isFullRange(expr.minutes, 0, 59);
  const allHour = isFullRange(expr.hours, 0, 23);
  const allDom = expr.daysOfMonthWildcard;
  const allMonth = isFullRange(expr.months, 1, 12);
  const allDow = expr.daysOfWeekWildcard;

  if (allHour && allDom && allMonth && allDow) {
    const step = detectStep(expr.minutes, 0, 59);
    if (step !== null && step > 1) return `every ${step} minutes`;
    if (allMin) return 'every minute';
    if (expr.minutes.size === 1) {
      const m = [...expr.minutes][0]!;
      return `at minute ${m} of every hour`;
    }
  }

  if (expr.minutes.size === 1 && allDom && allMonth && allDow) {
    const m = [...expr.minutes][0]!;
    const step = detectStep(expr.hours, 0, 23);
    if (step !== null && step > 1) {
      return `every ${step} hours at minute ${pad(m)}`;
    }
  }

  if (
    expr.minutes.size === 1 &&
    expr.hours.size === 1 &&
    allDom &&
    allMonth
  ) {
    const h = [...expr.hours][0]!;
    const m = [...expr.minutes][0]!;
    if (allDow) return `at ${pad(h)}:${pad(m)} every day`;
    const dowStr = formatDows(expr.daysOfWeek);
    if (dowStr !== null) return `at ${pad(h)}:${pad(m)} on ${dowStr}`;
  }

  if (
    expr.minutes.size === 1 &&
    expr.hours.size === 1 &&
    expr.daysOfMonth.size === 1 &&
    !expr.daysOfMonthWildcard &&
    expr.months.size === 1 &&
    allDow
  ) {
    const h = [...expr.hours][0]!;
    const m = [...expr.minutes][0]!;
    const d = [...expr.daysOfMonth][0]!;
    const mo = [...expr.months][0]!;
    return `at ${pad(h)}:${pad(m)} on day ${d} of ${MONTH_NAMES[mo - 1]}`;
  }

  return expr.raw;
}

function isFullRange(set: ReadonlySet<number>, min: number, max: number): boolean {
  if (set.size !== max - min + 1) return false;
  for (let v = min; v <= max; v++) if (!set.has(v)) return false;
  return true;
}

function detectStep(set: ReadonlySet<number>, min: number, max: number): number | null {
  const values = [...set].toSorted((a, b) => a - b);
  if (values.length < 2) return null;
  if (values[0] !== min) return null;
  const step = values[1]! - values[0]!;
  if (step <= 0) return null;
  let expected = min;
  for (const v of values) {
    if (v !== expected) return null;
    expected += step;
  }
  if (expected - step > max) return null;
  return step;
}

function formatDows(set: ReadonlySet<number>): string | null {
  const values = [...set].toSorted((a, b) => a - b);
  if (values.length === 0) return null;
  if (values.length === 5 && values.every((v, i) => v === i + 1)) {
    return 'weekdays';
  }
  if (values.length === 2 && values[0] === 0 && values[1] === 6) {
    return 'weekends';
  }
  return values.map((v) => DAY_NAMES[v]!).join(', ');
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
