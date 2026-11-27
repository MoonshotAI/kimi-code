import { describe, it, expect } from 'vitest';

import {
  errorSignature,
  fnv1a,
  normalizeErrorMessage,
  signatureOf,
  topStackFrame,
} from '../../../src/shared/error-signature';

describe('normalizeErrorMessage', () => {
  it('replaces paths, URLs, ids and numbers so the same bug groups together', () => {
    expect(
      normalizeErrorMessage(
        "ENOENT: no such file '/Users/someone/project/a.ts' at https://example.com/api?token=1 session 9b2f0c1e-1d2a-4c3b-8e4f-123456789abc retry 3",
      ),
    ).toBe("ENOENT: no such file '<path>' at <url> session <id> retry <n>");
    expect(normalizeErrorMessage('C:\\Users\\someone\\app\\file.js failed')).toBe('<path> failed');
    expect(normalizeErrorMessage("Cannot read properties of undefined (reading 'items')")).toBe(
      "Cannot read properties of undefined (reading 'items')",
    );
  });
});

describe('topStackFrame', () => {
  it('returns the first application frame as file:line:col', () => {
    const stack = [
      'TypeError: boom',
      '    at node:internal/process/task_queues:95:5',
      '    at Object.load (/Applications/Kimi Code.app/Contents/Resources/app.asar/out/app-cf5d5_J1.cjs:1:23456)',
      '    at async Promise.all (index 0)',
    ].join('\n');
    expect(topStackFrame(stack)).toBe('app-cf5d5_J1.cjs:1:23456');
  });

  it('handles renderer URLs with queries and anonymous frames', () => {
    expect(topStackFrame('Error: x\n    at app://renderer/assets/index-abc.js?v=2:1:987')).toBe('index-abc.js:1:987');
    expect(topStackFrame('Error: x\n    at async Promise.all (index 0)')).toBeNull();
    expect(topStackFrame(undefined)).toBeNull();
  });
});

describe('errorSignature', () => {
  it('is stable for the same class, message shape and site and differs otherwise', () => {
    const stack = 'Error\n    at f (/x/out/main.cjs:1:10)';
    const first = errorSignature('TypeError', 'item 12 missing', stack);
    const second = errorSignature('TypeError', 'item 99 missing', stack);
    const elsewhere = errorSignature('TypeError', 'item 12 missing', 'Error\n    at f (/x/out/main.cjs:1:99)');
    expect(first).toEqual({ fingerprint: second.fingerprint, topFrame: 'main.cjs:1:10' });
    expect(first.fingerprint).not.toBe(elsewhere.fingerprint);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it('describes non-Error rejection reasons by their type', () => {
    expect(signatureOf('quota exceeded')).toEqual({
      name: 'string',
      fingerprint: fnv1a('string|quota exceeded|'),
      topFrame: null,
    });
    expect(signatureOf(new RangeError('Invalid array length')).name).toBe('RangeError');
  });
});
