import { createHash } from 'node:crypto';

import { expect } from 'vitest';

export type DecodedProgramResume =
  | {
      readonly kind: 'resume';
      readonly pid: number;
      readonly time: number;
      readonly argv: readonly string[];
      readonly cwd?: string;
    }
  | {
      readonly kind: 'clear';
      readonly pid: number;
      readonly time: number;
    };

const OSC_PREFIX = '\u001B]7577;';
const OSC_SUFFIX = '\u001B\\';

export function decodeOsc7577(sequence: string, expectedToken: string): DecodedProgramResume {
  expect(sequence.startsWith(OSC_PREFIX)).toBe(true);
  expect(sequence.endsWith(OSC_SUFFIX)).toBe(true);

  const payload = sequence.slice(OSC_PREFIX.length, -OSC_SUFFIX.length);
  const macSeparator = payload.lastIndexOf(':mac=');
  expect(macSeparator).toBeGreaterThan(0);

  const body = payload.slice(0, macSeparator);
  const mac = payload.slice(macSeparator + ':mac='.length);
  expect(mac).toMatch(/^[0-9a-f]{64}$/);

  const expectedMac = createHash('sha256')
    .update(`${body}:${expectedToken}`, 'utf8')
    .digest('hex');
  expect(mac).toBe(expectedMac);

  const fields = body.split(':');
  let pid: number | undefined;
  let time: number | undefined;
  let argv: string[] | undefined;
  let cwd: string | undefined;
  let clear = false;

  for (const field of fields) {
    const eqIndex = field.indexOf('=');
    expect(eqIndex).toBeGreaterThan(0);
    const key = field.slice(0, eqIndex);
    const rawValue = field.slice(eqIndex + 1);
    switch (key) {
      case 'pid':
        pid = Number(rawValue);
        break;
      case 'time':
        time = Number(rawValue);
        break;
      case 'argv':
        argv = rawValue
          .split(',')
          .map((part) => Buffer.from(part, 'base64').toString('utf8'));
        break;
      case 'cwd':
        cwd = Buffer.from(rawValue, 'base64').toString('utf8');
        break;
      case 'clear':
        expect(rawValue).toBe('1');
        clear = true;
        break;
      default:
        throw new Error(`Unexpected OSC 7577 field: ${key}`);
    }
  }

  expect(pid).toBeDefined();
  expect(time).toBeDefined();
  if (clear) {
    expect(argv).toBeUndefined();
    expect(cwd).toBeUndefined();
    return { kind: 'clear', pid: pid!, time: time! };
  }
  expect(argv).toBeDefined();
  return {
    kind: 'resume',
    pid: pid!,
    time: time!,
    argv: argv!,
    ...(cwd === undefined ? {} : { cwd }),
  };
}

export function decodeOsc7577Writes(
  writes: readonly string[],
  expectedToken: string,
): DecodedProgramResume[] {
  return writes
    .filter((chunk) => chunk.startsWith(OSC_PREFIX) && chunk.endsWith(OSC_SUFFIX))
    .map((chunk) => decodeOsc7577(chunk, expectedToken));
}
