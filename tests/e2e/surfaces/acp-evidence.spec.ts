import { expect, test } from '@playwright/test';

import { editorServedFile, type WireEvent } from './acp-evidence';

const A_TXT = '/home/workspace/a.txt';
const B_TXT = '/home/workspace/b.txt';
const READ = 'read-a';
const EARLIER_READ = 'read-a-earlier';
const EDIT = 'edit-b';

function served(timeline: readonly WireEvent[], turnStart: number, tool: string, access: 'read' | 'write', path: string, answered: readonly number[]): boolean {
  return editorServedFile({ timeline, served: new Set(answered), turnStart, tool, access, path });
}

test('counts a read the editor answered before the tool card of this turn arrived', () => {
  const timeline: WireEvent[] = [{ read: A_TXT, request: 3 }, { tool: READ, settled: false }, { tool: READ, settled: true }];
  expect(served(timeline, 0, READ, 'read', A_TXT, [3])).toBe(true);
});

test('counts a write the editor answered before the tool card of this turn arrived', () => {
  const timeline: WireEvent[] = [{ read: B_TXT, request: 5 }, { write: B_TXT, request: 6 }, { tool: EDIT, settled: false }, { tool: EDIT, settled: true }];
  expect(served(timeline, 0, EDIT, 'write', B_TXT, [5, 6])).toBe(true);
});

test('also counts a read of the file that an earlier tool of this turn made', () => {
  const timeline: WireEvent[] = [
    { tool: EARLIER_READ, settled: false },
    { read: A_TXT, request: 3 },
    { tool: EARLIER_READ, settled: true },
    { tool: READ, settled: false },
    { tool: READ, settled: true },
  ];
  expect(served(timeline, 0, READ, 'read', A_TXT, [3])).toBe(true);
});

test('fails a read when no read reached the editor in this turn', () => {
  const timeline: WireEvent[] = [{ tool: READ, settled: false }, { tool: READ, settled: true }];
  expect(served(timeline, 0, READ, 'read', A_TXT, [])).toBe(false);
});

test('fails a read when the only read of the file happened in an earlier turn', () => {
  const timeline: WireEvent[] = [{ tool: EARLIER_READ, settled: false }, { tool: EARLIER_READ, settled: true }, { read: A_TXT, request: 1 }, { tool: READ, settled: false }, { tool: READ, settled: true }];
  expect(served(timeline, 3, READ, 'read', A_TXT, [1])).toBe(false);
});

test('fails a read when the read of the file arrived after the tool finished', () => {
  const timeline: WireEvent[] = [{ tool: READ, settled: false }, { tool: READ, settled: true }, { read: A_TXT, request: 4 }];
  expect(served(timeline, 0, READ, 'read', A_TXT, [4])).toBe(false);
});

test('fails a read when the editor did not answer the read of the file', () => {
  const timeline: WireEvent[] = [{ read: A_TXT, request: 3 }, { tool: READ, settled: false }, { tool: READ, settled: true }];
  expect(served(timeline, 0, READ, 'read', A_TXT, [])).toBe(false);
});

test('fails a read when the editor answered a read of another file', () => {
  const timeline: WireEvent[] = [{ read: B_TXT, request: 3 }, { tool: READ, settled: false }, { tool: READ, settled: true }];
  expect(served(timeline, 0, READ, 'read', A_TXT, [3])).toBe(false);
});

test('fails a write when the editor only read the file', () => {
  const timeline: WireEvent[] = [{ read: B_TXT, request: 5 }, { tool: EDIT, settled: false }, { tool: EDIT, settled: true }];
  expect(served(timeline, 0, EDIT, 'write', B_TXT, [5])).toBe(false);
});
