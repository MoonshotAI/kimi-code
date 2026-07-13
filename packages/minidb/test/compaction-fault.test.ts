// test/compaction-fault.test.ts
//
// Fault-injection tests for the compaction helpers using `vi.doMock` to replace
// node:fs/promises. These exercise branches that real filesystems essentially
// never produce (a write that returns 0 bytes, a close/sync that throws).
//
// NOTE: each test resets the module registry and re-mocks node:fs/promises so a
// fresh import of compaction.ts picks up that test's mocked fs.

import assert from 'node:assert/strict';
import { afterEach, expect, test, vi } from 'vitest';

interface MockHandle {
  read?: (...args: unknown[]) => Promise<{ bytesRead: number }>;
  write?: (...args: unknown[]) => Promise<{ bytesWritten: number }>;
  sync?: () => Promise<void>;
  close?: () => Promise<void>;
}

// Replace node:fs/promises with a module whose only export is `open`. compaction.ts
// consumes it via a default import (`import fs from 'node:fs/promises'`), so the
// mock also exposes the same handle set as its `default` export.
function mockFsPromises(open: (path: string, flags?: string) => Promise<MockHandle>): void {
  const exports = { open };
  vi.doMock('node:fs/promises', () => ({ ...exports, default: exports }));
}

afterEach(() => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
});

test('copyFileRange throws when the destination short-writes (bytesWritten === 0)', async () => {
  mockFsPromises(async (_p, flags) => {
    if (flags === 'r') {
      // Source claims to have produced bytes so the loop reaches write().
      return { read: async () => ({ bytesRead: 16 }), close: async () => {} };
    }
    // Destination makes no progress → the short-write guard fires.
    return { write: async () => ({ bytesWritten: 0 }), sync: async () => {}, close: async () => {} };
  });
  const { copyFileRange } = await import('../src/compaction.js');
  await assert.rejects(() => copyFileRange('/tmp/src', '/tmp/dst', 0, 16), /short write/);
});

test('copyFileRange tolerates a source close() failure (best-effort close)', async () => {
  mockFsPromises(async (_p, flags) => {
    if (flags === 'r') {
      return {
        read: async (buf: unknown) => {
          (buf as Buffer)[0] = 0xab;
          return { bytesRead: 1 };
        },
        close: async () => {
          throw new Error('source close failed');
        },
      };
    }
    return {
      write: async (_b: unknown, _o: unknown, len: number) => ({ bytesWritten: len }),
      sync: async () => {},
      close: async () => {},
    };
  });
  const { copyFileRange } = await import('../src/compaction.js');
  // The source close failure is swallowed; the copy itself succeeds.
  await expect(copyFileRange('/tmp/src', '/tmp/dst', 0, 1)).resolves.toBeUndefined();
});

test('copyFileRange tolerates a destination close() failure (best-effort close)', async () => {
  mockFsPromises(async (_p, flags) => {
    if (flags === 'r') {
      return { read: async () => ({ bytesRead: 0 }), close: async () => {} };
    }
    return {
      write: async (_b: unknown, _o: unknown, len: number) => ({ bytesWritten: len }),
      sync: async () => {},
      close: async () => {
        throw new Error('dest close failed');
      },
    };
  });
  const { copyFileRange } = await import('../src/compaction.js');
  // Empty range (start===end) → no writes, only a dst.sync() then a failing
  // dst.close() that must be swallowed.
  await expect(copyFileRange('/tmp/src', '/tmp/dst', 0, 0)).resolves.toBeUndefined();
});

test('fsyncDir swallows a sync() failure and still closes the handle', async () => {
  let closed = false;
  mockFsPromises(async () => ({
    sync: async () => {
      throw new Error('sync failed');
    },
    close: async () => {
      closed = true;
    },
  }));
  const { fsyncDir } = await import('../src/compaction.js');
  await fsyncDir('/tmp/whatever');
  assert.equal(closed, true, 'close() is called even after sync() throws');
});
