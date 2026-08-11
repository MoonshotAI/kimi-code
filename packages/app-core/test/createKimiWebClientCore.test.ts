import { describe, expect, it } from 'vitest';
import type { DaemonKimiWebApi } from '../src/api';
import { createKimiWebClientCore } from '../src/client/createKimiWebClientCore';

describe('createKimiWebClientCore', () => {
  it('creates two isolated clients (no shared singleton state)', () => {
    const api = {} as unknown as DaemonKimiWebApi;
    const a = createKimiWebClientCore({ api });
    const b = createKimiWebClientCore({ api });
    a.state.activeSessionId = 'x';
    expect(b.state.activeSessionId).not.toBe('x');
    expect(a.state).not.toBe(b.state);
  });
});
