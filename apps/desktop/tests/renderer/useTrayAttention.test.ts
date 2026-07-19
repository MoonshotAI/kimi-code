import { describe, expect, it, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';

import {
  buildTrayAttention,
  createTrayAttentionReporter,
  createTrayLocaleSync,
  createTraySessionSelector,
  runWhenInitialized,
  type TrayAttentionCounts,
} from '../../src/renderer/composables/useTrayAttention';

const ALL_VISIBLE = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe('buildTrayAttention', () => {
  it('returns zeros and no items for empty inputs', () => {
    expect(buildTrayAttention([], ALL_VISIBLE(), {}, {})).toEqual({
      unread: 0,
      approvals: 0,
      questions: 0,
      items: [],
    });
  });

  it('lists every visible session that is unread OR has pending items, in session order', () => {
    const result = buildTrayAttention(
      [
        { id: 's1', title: '正常运行中' },
        { id: 's2', title: '跑完了没看' },
        { id: 's3', title: '等着审批' },
        { id: 's4', title: '又未读又待回答' },
      ],
      ALL_VISIBLE('s1', 's2', 's3', 's4'),
      { s2: true, s4: true },
      { s3: { approvals: 2, questions: 0 }, s4: { approvals: 0, questions: 1 } },
    );
    expect(result.items).toEqual([
      { sessionId: 's2', title: '跑完了没看', unread: true, approvals: 0, questions: 0 },
      { sessionId: 's3', title: '等着审批', unread: false, approvals: 2, questions: 0 },
      { sessionId: 's4', title: '又未读又待回答', unread: true, approvals: 0, questions: 1 },
    ]);
    expect(result.unread).toBe(2);
    expect(result.approvals).toBe(2);
    expect(result.questions).toBe(1);
  });

  it('excludes sessions outside the visible set (removed workspace, side-chat children)', () => {
    const result = buildTrayAttention(
      [
        { id: 's1', title: '可见未读' },
        { id: 's2', title: '已移除工作区的未读会话' },
        { id: 's3', title: '已移除工作区的待审批会话' },
      ],
      ALL_VISIBLE('s1'),
      { s1: true, s2: true },
      { s3: { approvals: 3, questions: 0 } },
    );
    expect(result.items.map((item) => item.sessionId)).toEqual(['s1']);
    expect(result.unread).toBe(1);
    expect(result.approvals).toBe(0);
  });

  it('ignores unread/pending flags for sessions that no longer exist (stale leftovers)', () => {
    // forgetSession does not clean the unread map — an archived session's flag
    // must not inflate the totals when no visible session backs it.
    const result = buildTrayAttention(
      [{ id: 's1', title: '还在' }],
      ALL_VISIBLE('s1'),
      { ghost: true, s1: false },
      { ghost: { approvals: 2, questions: 1 } },
    );
    expect(result).toEqual({ unread: 0, approvals: 0, questions: 0, items: [] });
  });

  it('falls back to the list-level pendingInteraction when details are not loaded', () => {
    const result = buildTrayAttention(
      [
        { id: 's1', title: '待审批(未加载详情)', pendingInteraction: 'approval' },
        { id: 's2', title: '待回答(未加载详情)', pendingInteraction: 'question' },
        { id: 's3', title: '无待办', pendingInteraction: 'none' },
        { id: 's4', title: '详情已加载', pendingInteraction: 'approval' },
      ],
      ALL_VISIBLE('s1', 's2', 's3', 's4'),
      {},
      { s4: { approvals: 3, questions: 0 } },
    );
    expect(result.items).toEqual([
      { sessionId: 's1', title: '待审批(未加载详情)', unread: false, approvals: 1, questions: 0 },
      { sessionId: 's2', title: '待回答(未加载详情)', unread: false, approvals: 0, questions: 1 },
      // s3: pendingInteraction 'none' — no item. s4: details win over the list-level fact.
      { sessionId: 's4', title: '详情已加载', unread: false, approvals: 3, questions: 0 },
    ]);
    expect(result.approvals).toBe(4);
    expect(result.questions).toBe(1);
  });
});

describe('createTrayAttentionReporter', () => {
  it('is a no-op without the bridge (web fallback)', async () => {
    const unread = ref<Record<string, boolean>>({ s1: true });
    const stop = createTrayAttentionReporter(
      undefined,
      computed(() => buildTrayAttention([], ALL_VISIBLE(), unread.value, {})),
    );
    unread.value = { s1: true, s2: true };
    await nextTick();
    // Nothing to assert on a missing bridge — the reporter must simply not
    // throw and return a callable stop handle.
    expect(() => stop()).not.toThrow();
  });

  it('pushes the current totals immediately, then on every change', async () => {
    const sessions = ref([{ id: 's1', title: '会话一' }]);
    const unread = ref<Record<string, boolean>>({ s1: true });
    const pending = ref<Record<string, { approvals: number; questions: number }>>({});
    const bridge = { setTrayAttention: vi.fn() };
    createTrayAttentionReporter(
      bridge,
      computed(() => buildTrayAttention(sessions.value, ALL_VISIBLE('s1'), unread.value, pending.value)),
    );

    // immediate: the reload/reopen recovery push happens synchronously.
    expect(bridge.setTrayAttention).toHaveBeenCalledTimes(1);
    expect(bridge.setTrayAttention).toHaveBeenLastCalledWith({
      unread: 1,
      approvals: 0,
      questions: 0,
      items: [{ sessionId: 's1', title: '会话一', unread: true, approvals: 0, questions: 0 }],
    });

    unread.value = { s1: true, s2: true };
    pending.value = { s3: { approvals: 2, questions: 1 } };
    await nextTick();
    // s2/s3 are not in the session list (not visible): totals stay item-derived.
    expect(bridge.setTrayAttention).toHaveBeenLastCalledWith({
      unread: 1,
      approvals: 0,
      questions: 0,
      items: [{ sessionId: 's1', title: '会话一', unread: true, approvals: 0, questions: 0 }],
    });

    unread.value = {};
    await nextTick();
    expect(bridge.setTrayAttention).toHaveBeenLastCalledWith({
      unread: 0,
      approvals: 0,
      questions: 0,
      items: [],
    });
  });

  it('stops pushing after the stop handle runs', async () => {
    const unread = ref<Record<string, boolean>>({});
    const bridge = { setTrayAttention: vi.fn() };
    const stop = createTrayAttentionReporter(
      bridge,
      computed(() => buildTrayAttention([], ALL_VISIBLE(), unread.value, {})),
    );
    expect(bridge.setTrayAttention).toHaveBeenCalledTimes(1);

    stop();
    unread.value = { s1: true };
    await nextTick();
    expect(bridge.setTrayAttention).toHaveBeenCalledTimes(1);
  });

  it('does not re-push when a tick produces an identical payload (clock re-sort)', async () => {
    // The sessions computed re-evaluates on every sessionTimeClock tick,
    // yielding fresh-but-identical inputs; only real changes may reach IPC.
    const tick = ref(0);
    const unread = ref<Record<string, boolean>>({ s1: true });
    const bridge = { setTrayAttention: vi.fn() };
    createTrayAttentionReporter(
      bridge,
      computed(() => {
        void tick.value;
        return buildTrayAttention([{ id: 's1', title: '会话一' }], ALL_VISIBLE('s1'), unread.value, {});
      }),
    );
    expect(bridge.setTrayAttention).toHaveBeenCalledTimes(1);

    tick.value += 1;
    await nextTick();
    expect(bridge.setTrayAttention).toHaveBeenCalledTimes(1);

    unread.value = { s1: true, s2: true };
    await nextTick();
    // s2 is not in the session list, so the payload is unchanged (totals are
    // item-derived) — the dedupe must swallow this tick as well.
    expect(bridge.setTrayAttention).toHaveBeenCalledTimes(1);
  });

  it('never pushes null (client state not loaded): last-known tray state survives boot', async () => {
    // At App.vue setup client.load() has not run yet — pushing the empty
    // projection would wipe the main process's last-known menu for the whole
    // load window. Null values must be skipped until real state exists.
    const ready = ref(false);
    const bridge = { setTrayAttention: vi.fn() };
    createTrayAttentionReporter(
      bridge,
      computed<TrayAttentionCounts | null>(() =>
        ready.value
          ? buildTrayAttention([{ id: 's1', title: '会话一' }], ALL_VISIBLE('s1'), { s1: true }, {})
          : null,
      ),
    );
    // immediate fired with null → no push.
    expect(bridge.setTrayAttention).not.toHaveBeenCalled();

    ready.value = true;
    await nextTick();
    expect(bridge.setTrayAttention).toHaveBeenCalledTimes(1);
    expect(bridge.setTrayAttention).toHaveBeenLastCalledWith(
      expect.objectContaining({ unread: 1 }),
    );
  });
});

describe('runWhenInitialized', () => {
  it('runs immediately when the client is already initialized', () => {
    const fn = vi.fn();
    runWhenInitialized(ref(true), fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('defers until the first load settles, then runs exactly once', async () => {
    const initialized = ref(false);
    const first = vi.fn();
    const second = vi.fn();
    runWhenInitialized(initialized, first);

    await nextTick();
    expect(first).not.toHaveBeenCalled();

    initialized.value = true;
    await nextTick();
    expect(first).toHaveBeenCalledTimes(1);

    // A second queued call before readiness also fires, and the first one's
    // watch is already stopped (no double-fire on later flips).
    initialized.value = false;
    runWhenInitialized(initialized, second);
    initialized.value = true;
    await nextTick();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });
});

describe('createTrayLocaleSync', () => {
  it('is a no-op without the bridge (web fallback)', () => {
    const stop = createTrayLocaleSync(undefined, ref('zh'));
    expect(() => stop()).not.toThrow();
  });

  it('pushes the mapped locale immediately and on change', async () => {
    const locale = ref('zh');
    const bridge = { setLocale: vi.fn() };
    const stop = createTrayLocaleSync(bridge, locale);
    expect(bridge.setLocale).toHaveBeenCalledTimes(1);
    expect(bridge.setLocale).toHaveBeenLastCalledWith('zh');

    locale.value = 'en';
    await nextTick();
    expect(bridge.setLocale).toHaveBeenLastCalledWith('en');

    // Anything non-zh maps to en (the main-process string table is en/zh).
    locale.value = 'fr';
    await nextTick();
    expect(bridge.setLocale).toHaveBeenLastCalledWith('en');

    stop();
    locale.value = 'zh';
    await nextTick();
    expect(bridge.setLocale).toHaveBeenCalledTimes(3);
  });
});

describe('createTraySessionSelector', () => {
  it('is a no-op without the bridge (web fallback)', () => {
    const open = vi.fn();
    const stop = createTraySessionSelector(undefined, open);
    expect(() => stop()).not.toThrow();
    expect(open).not.toHaveBeenCalled();
  });

  it('routes tray clicks to the session opener until unsubscribed', () => {
    const listeners = new Set<(sessionId: string) => void>();
    const bridge = {
      onTraySelectSession: vi.fn((cb: (sessionId: string) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      }),
    };
    const open = vi.fn();
    const stop = createTraySessionSelector(bridge, open);
    expect(bridge.onTraySelectSession).toHaveBeenCalledOnce();

    listeners.forEach((cb) => cb('s1'));
    expect(open).toHaveBeenCalledWith('s1');

    stop();
    listeners.forEach((cb) => cb('s2'));
    expect(open).toHaveBeenCalledTimes(1);
  });
});
