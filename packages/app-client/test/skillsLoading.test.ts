import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSkill, KimiWebApi } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { modelsStore } from '../src/stores/models';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe.each(['session', 'workspace'] as const)('models store — %s skills cancellation', (scope) => {
  function setupScope() {
    const { store, listSkills, listSkillsForWorkspace } = setup();
    store.skillsBySession = {};
    store.skillsByWorkspace = {};
    store.skillsFetchedBySession = {};
    store.skillsFetchedByWorkspace = {};
    return {
      list: scope === 'session' ? listSkills : listSkillsForWorkspace,
      load: scope === 'session' ? store.loadSkillsForSession : store.loadSkillsForWorkspace,
      skills: () => scope === 'session' ? store.skillsBySession : store.skillsByWorkspace,
      fetched: () => scope === 'session' ? store.skillsFetchedBySession : store.skillsFetchedByWorkspace,
    };
  }

  it('skips an already cancelled request', async () => {
    const { list, load, fetched } = setupScope();
    await load('a', { signal: AbortSignal.abort() });
    expect(list).not.toHaveBeenCalled();
    expect(fetched().a).toBeUndefined();
  });

  it.each(['resolve', 'reject'] as const)('does not mark a cancelled %s as fetched', async (outcome) => {
    const { list, load, skills, fetched } = setupScope();
    const request = deferred<AppSkill[]>();
    const controller = new AbortController();
    const options = { signal: controller.signal, background: true };
    list.mockReturnValueOnce(request.promise);
    const pending = load('a', options);
    expect(list).toHaveBeenCalledWith('a', options);
    controller.abort();
    if (outcome === 'resolve') request.resolve([{ name: 'stale' } as AppSkill]);
    else request.reject(new Error('cancelled'));
    await pending;
    expect(skills().a).toBeUndefined();
    expect(fetched().a).toBeUndefined();
  });

  it('replaces aborted A-B-A requests without the old finally clearing the new inflight entry', async () => {
    const { list, load, skills, fetched } = setupScope();
    const old = deferred<AppSkill[]>();
    const current = deferred<AppSkill[]>();
    const firstOwner = new AbortController();
    const currentOwner = new AbortController();
    list.mockReturnValueOnce(old.promise).mockResolvedValueOnce([]).mockReturnValueOnce(current.promise);

    const first = load('a', { signal: firstOwner.signal });
    firstOwner.abort();
    await load('b');
    const second = load('a', { signal: currentOwner.signal });
    old.resolve([{ name: 'old' } as AppSkill]);
    await first;
    expect(skills().a).toBeUndefined();
    expect(fetched().a).toBeUndefined();
    const duplicate = load('a', { signal: currentOwner.signal });
    expect(list).toHaveBeenCalledTimes(3);
    current.resolve([{ name: 'new' } as AppSkill]);
    await Promise.all([second, duplicate]);
    expect(skills().a?.map((skill) => skill.name)).toEqual(['new']);
    expect(fetched().a).toBe(true);
  });

  it('does not overwrite a replacement result when the aborted request settles last', async () => {
    const { list, load, skills, fetched } = setupScope();
    const old = deferred<AppSkill[]>();
    const controller = new AbortController();
    list.mockReturnValueOnce(old.promise).mockResolvedValueOnce([{ name: 'new' } as AppSkill]);
    const first = load('a', { signal: controller.signal });
    controller.abort();
    await load('a', { signal: new AbortController().signal });
    old.resolve([{ name: 'old' } as AppSkill]);
    await first;
    expect(skills().a?.map((skill) => skill.name)).toEqual(['new']);
    expect(fetched().a).toBe(true);
  });

  it('isolates different cancellation owners and guards stale live completions', async () => {
    const { list, load, skills, fetched } = setupScope();
    const old = deferred<AppSkill[]>();
    const current = deferred<AppSkill[]>();
    const firstOwner = new AbortController();
    const currentOwner = new AbortController();
    list.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = load('a', { signal: firstOwner.signal });
    const second = load('a', { signal: currentOwner.signal });
    expect(list).toHaveBeenCalledTimes(2);
    old.resolve([{ name: 'old' } as AppSkill]);
    await first;
    expect(skills().a).toBeUndefined();
    expect(fetched().a).toBeUndefined();
    const duplicate = load('a', { signal: currentOwner.signal });
    expect(list).toHaveBeenCalledTimes(2);
    firstOwner.abort();
    expect(currentOwner.signal.aborted).toBe(false);
    current.resolve([{ name: 'new' } as AppSkill]);
    await Promise.all([second, duplicate]);
    expect(skills().a?.map((skill) => skill.name)).toEqual(['new']);
    expect(fetched().a).toBe(true);
  });

  it('shares an uncancellable explicit read without inheriting the observer cancellation', async () => {
    const { list, load, skills, fetched } = setupScope();
    const request = deferred<AppSkill[]>();
    const observer = new AbortController();
    list.mockReturnValueOnce(request.promise);
    const explicit = load('a');
    const observed = load('a', { signal: observer.signal });
    expect(list).toHaveBeenCalledExactlyOnceWith('a');
    observer.abort();
    request.resolve([{ name: 'explicit' } as AppSkill]);
    await Promise.all([explicit, observed]);
    expect(skills().a?.map((skill) => skill.name)).toEqual(['explicit']);
    expect(fetched().a).toBe(true);
  });

  it('does not attach an explicit read to an in-flight observer-owned request', async () => {
    const { list, load, skills, fetched } = setupScope();
    const observedRequest = deferred<AppSkill[]>();
    const observer = new AbortController();
    list.mockReturnValueOnce(observedRequest.promise).mockResolvedValueOnce([{ name: 'explicit' } as AppSkill]);
    const observed = load('a', { signal: observer.signal });
    await load('a');
    expect(list).toHaveBeenCalledTimes(2);
    observer.abort();
    observedRequest.resolve([{ name: 'old' } as AppSkill]);
    await observed;
    expect(skills().a?.map((skill) => skill.name)).toEqual(['explicit']);
    expect(fetched().a).toBe(true);
  });
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
    const duplicate = store.loadSkillsForSession('sess-1');
    expect(listSkills).toHaveBeenCalledTimes(1);
    expect(store.skillsFetchedBySession['sess-1']).toBeUndefined();

    resolveFirst([{ name: 's0', description: '', source: 'project' } as AppSkill]);
    await Promise.all([first, duplicate]);
    expect(store.skillsBySession['sess-1']?.map((s) => s.name)).toEqual(['s0']);
    expect(store.skillsFetchedBySession['sess-1']).toBe(true);

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

  it('keeps the cached list when a refresh fails', async () => {
    const { listSkills, store } = setup();
    store.setSkillsForSession('sess-1', [
      { name: 'old', description: '', source: 'user' } as AppSkill,
    ]);
    listSkills.mockRejectedValueOnce(new Error('daemon unreachable'));

    await store.loadSkillsForSession('sess-1');
    expect(listSkills).toHaveBeenCalledWith('sess-1');
    expect(store.skillsBySession['sess-1']?.map((s) => s.name)).toEqual(['old']);
    expect(store.skillsFetchedBySession['sess-1']).toBe(true);
  });
});
