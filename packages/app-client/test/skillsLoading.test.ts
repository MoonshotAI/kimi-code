// packages/app-client/test/skillsLoading.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSkill, KimiWebApi } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { modelsStore } from '../src/stores/models';

// Skill-list loading: a finished fetch (success OR failure) flips the
// skillsLoaded marker so a stale skill pill can degrade — but only the single
// in-flight request per scope may write it (two overlapping loads must not
// race their finally blocks).

function setup() {
  const listSkills = vi.fn<(sessionId: string) => Promise<AppSkill[]>>();
  const listSkillsForWorkspace = vi.fn<(workspaceId: string) => Promise<AppSkill[]>>();
  const api = { listSkills, listSkillsForWorkspace } as unknown as KimiWebApi;
  setKimiClientDeps({ api: () => api, t: (key) => key });
  return { listSkills, listSkillsForWorkspace, store: modelsStore() };
}

afterEach(() => {
  resetKimiClientDeps();
});

describe('models store — skills loading', () => {
  it('dedupes overlapping fetches for the same session scope', async () => {
    const { listSkills, store } = setup();
    let resolveFirst!: (list: AppSkill[]) => void;
    listSkills.mockImplementationOnce(
      () => new Promise<AppSkill[]>((resolve) => { resolveFirst = resolve; }),
    );
    listSkills.mockResolvedValue([{ name: 's1', description: '', source: 'project' } as AppSkill]);

    const first = store.loadSkillsForSession('sess-1');
    // A second load for the SAME scope while the first is still in flight
    // must return early instead of racing its finally with the first's.
    await store.loadSkillsForSession('sess-1');
    expect(listSkills).toHaveBeenCalledTimes(1);
    expect(store.skillsFetchedBySession['sess-1']).toBeUndefined();

    resolveFirst([{ name: 's0', description: '', source: 'project' } as AppSkill]);
    await first;
    expect(store.skillsBySession['sess-1']?.map((s) => s.name)).toEqual(['s0']);
    expect(store.skillsFetchedBySession['sess-1']).toBe(true);

    // After the flight completes, a fresh load is allowed again.
    await store.loadSkillsForSession('sess-1');
    expect(listSkills).toHaveBeenCalledTimes(2);
    expect(store.skillsBySession['sess-1']?.map((s) => s.name)).toEqual(['s1']);
  });

  it('marks a failed fetch finished but keeps the data key absent (retry on next switch)', async () => {
    const { listSkills, store } = setup();
    listSkills.mockRejectedValueOnce(new Error('daemon without /skills'));
    await store.loadSkillsForSession('sess-x');
    expect(store.skillsFetchedBySession['sess-x']).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(store.skillsBySession, 'sess-x')).toBe(false);
  });

  it('dedupes overlapping fetches for the same workspace scope', async () => {
    const { listSkillsForWorkspace, store } = setup();
    listSkillsForWorkspace.mockResolvedValue([]);
    await Promise.all([
      store.loadSkillsForWorkspace('ws-1'),
      store.loadSkillsForWorkspace('ws-1'),
    ]);
    expect(listSkillsForWorkspace).toHaveBeenCalledTimes(1);
    expect(store.skillsFetchedByWorkspace['ws-1']).toBe(true);
  });
});
