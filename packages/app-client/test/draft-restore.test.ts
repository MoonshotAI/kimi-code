import { describe, expect, it, vi } from 'vitest';
import { restoreSendDraftAtOrigin, type RecoveredSendDraft } from '../src/lib/draftRestore';

function draft(text: string): RecoveredSendDraft {
  return { text };
}

function setup(opts: { activeSid?: string; composerEmpty?: boolean; loadOk?: boolean; noComposer?: boolean }) {
  const persistDraft = vi.fn();
  const loadRecoveredDraft = vi.fn(() => opts.loadOk ?? true);
  const composer =
    opts.noComposer === true
      ? null
      : {
          isComposerEmpty: () => opts.composerEmpty ?? true,
          loadRecoveredDraft,
        };
  const outcome = (sid: string | undefined, value: RecoveredSendDraft) =>
    restoreSendDraftAtOrigin(sid, value, {
      activeSessionId: () => opts.activeSid,
      composer: () => composer,
      persistDraft,
    });
  return { outcome, persistDraft, loadRecoveredDraft };
}

describe('restoreSendDraftAtOrigin', () => {
  it('restores in place when the origin session is active and the composer is empty', () => {
    const { outcome, persistDraft, loadRecoveredDraft } = setup({ activeSid: 's1' });
    expect(outcome('s1', draft('hello'))).toBe('in-place');
    expect(loadRecoveredDraft).toHaveBeenCalledOnce();
    expect(persistDraft).not.toHaveBeenCalled();
  });

  it('persists when the composer load reports failure', () => {
    const { outcome, persistDraft } = setup({ activeSid: 's1', loadOk: false });
    expect(outcome('s1', draft('hello'))).toBe('persisted');
    expect(persistDraft).toHaveBeenCalledWith('s1', 'hello', [], undefined);
  });

  it('persists when no composer is mounted for the active session', () => {
    const { outcome, persistDraft } = setup({ activeSid: 's1', noComposer: true });
    expect(outcome('s1', draft('hello'))).toBe('persisted');
    expect(persistDraft).toHaveBeenCalledWith('s1', 'hello', [], undefined);
  });

  it('keeps the live draft untouched when the composer already has content', () => {
    const { outcome, persistDraft, loadRecoveredDraft } = setup({ activeSid: 's1', composerEmpty: false });
    expect(outcome('s1', draft('recovered'))).toBe('kept-in-history');
    expect(loadRecoveredDraft).not.toHaveBeenCalled();
    expect(persistDraft).not.toHaveBeenCalled();
  });

  it('persists to the origin session when another session is active', () => {
    const { outcome, persistDraft, loadRecoveredDraft } = setup({ activeSid: 's2' });
    expect(outcome('s1', draft('hello'))).toBe('persisted');
    expect(loadRecoveredDraft).not.toHaveBeenCalled();
    expect(persistDraft).toHaveBeenCalledWith('s1', 'hello', [], undefined);
  });

  it('restores in place for a workspace draft (no session on either side)', () => {
    const { outcome, loadRecoveredDraft } = setup({ activeSid: undefined });
    expect(outcome(undefined, draft('hello'))).toBe('in-place');
    expect(loadRecoveredDraft).toHaveBeenCalledOnce();
  });

  it('does not clobber a newer persisted draft at the origin session', () => {
    const persistDraft = vi.fn();
    const outcome = restoreSendDraftAtOrigin('s1', draft('old recovered'), {
      activeSessionId: () => 's2',
      composer: () => null,
      persistDraft,
      hasPersistedDraft: () => true,
    });
    expect(outcome).toBe('kept-in-history');
    expect(persistDraft).not.toHaveBeenCalled();
  });

  it('persists only when the origin draft box is empty', () => {
    const persistDraft = vi.fn();
    const run = (hasDraft: boolean) =>
      restoreSendDraftAtOrigin('s1', draft('recovered'), {
        activeSessionId: () => 's2',
        composer: () => null,
        persistDraft,
        hasPersistedDraft: () => hasDraft,
      });
    expect(run(false)).toBe('persisted');
    expect(run(true)).toBe('kept-in-history');
    expect(persistDraft).toHaveBeenCalledTimes(1);
  });
});
