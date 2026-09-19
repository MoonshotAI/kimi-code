import { describe, expect, it, vi } from 'vitest';

import type { Session, SuggestFilesResult } from '@moonshot-ai/kimi-code-sdk';

import { remoteMentionSuggester } from '#/tui/utils/remote-mention-suggest';
import type { EnvironmentSlotState } from '#/tui/types';

const REMOTE: EnvironmentSlotState = { environmentId: 'dev-box', type: 'ssh', status: 'ready' };
const LOCAL: EnvironmentSlotState = { environmentId: 'local', type: 'local', status: 'ready' };

function makeSession(result: SuggestFilesResult | undefined, options: { fail?: boolean } = {}) {
  const suggestFiles = vi.fn(async () => {
    if (options.fail === true) throw new Error('engine down');
    return result;
  });
  const session = { suggestFiles } as unknown as Session;
  return { session, suggestFiles };
}

describe('remoteMentionSuggester', () => {
  it('returns undefined for local or unsynced sessions (local path stays in charge)', () => {
    const { session } = makeSession(undefined);
    expect(remoteMentionSuggester(session, LOCAL)).toBeUndefined();
    expect(remoteMentionSuggester(session, undefined)).toBeUndefined();
    expect(remoteMentionSuggester(undefined, REMOTE)).toBeUndefined();
  });

  it('maps engine suggestions to mention items (dirs get trailing slash, spaces get quoted)', async () => {
    const { session, suggestFiles } = makeSession({
      items: [
        { path: 'src/app.ts', name: 'app.ts', kind: 'file', matchPositions: [0] },
        { path: 'src/my docs', name: 'my docs', kind: 'directory', matchPositions: [0] },
      ],
      truncated: false,
    });
    const suggester = remoteMentionSuggester(session, REMOTE);
    expect(suggester).toBeDefined();

    const items = await suggester!('app', new AbortController().signal);

    expect(suggestFiles).toHaveBeenCalledWith({ query: 'app', limit: 50 });
    expect(items).toEqual([
      { value: '@src/app.ts', label: 'app.ts', description: 'src/app.ts' },
      { value: '@"src/my docs/"', label: 'my docs/', description: 'src/my docs' },
    ]);
  });

  it('degrades to null when the endpoint reports undefined or the call fails', async () => {
    const unavailable = remoteMentionSuggester(makeSession(undefined).session, REMOTE);
    expect(await unavailable!('app', new AbortController().signal)).toBeNull();

    const failing = remoteMentionSuggester(makeSession(undefined, { fail: true }).session, REMOTE);
    expect(await failing!('app', new AbortController().signal)).toBeNull();
  });
});
