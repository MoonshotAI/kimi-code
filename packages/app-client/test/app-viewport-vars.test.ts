import { describe, expect, it } from 'vitest';
import { createAppViewportVarsWriter } from '../src/lib/appViewportVars';

function harness() {
  const writes: string[] = [];
  const write = createAppViewportVarsWriter({
    setProperty: (name, value) => {
      writes.push(`${name}=${value}`);
    },
  });
  return { writes, write };
}

describe('createAppViewportVarsWriter', () => {
  it('writes both variables on the first call', () => {
    const { writes, write } = harness();
    expect(write({ height: 900, top: 0 })).toBe(true);
    expect(writes).toEqual(['--app-height=900px', '--app-top=0px']);
  });

  it('skips the write entirely when nothing changed', () => {
    const { writes, write } = harness();
    write({ height: 900, top: 0 });
    expect(write({ height: 900, top: 0 })).toBe(false);
    expect(writes).toHaveLength(2);
  });

  it('writes only the variable whose value changed', () => {
    const { writes, write } = harness();
    write({ height: 900, top: 0 });
    expect(write({ height: 640, top: 0 })).toBe(true);
    expect(writes.slice(2)).toEqual(['--app-height=640px']);
    expect(write({ height: 640, top: 12 })).toBe(true);
    expect(writes.slice(3)).toEqual(['--app-top=12px']);
  });
});
