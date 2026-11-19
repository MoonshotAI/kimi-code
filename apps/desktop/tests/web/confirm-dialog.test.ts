import { beforeEach, describe, expect, it } from 'vitest';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (err?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (err?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useConfirmDialog', () => {
  const { current, busy, isConfirmOpen, confirm, settle, runAction } = useConfirmDialog();

  beforeEach(() => {
    settle(false);
  });

  it('resolves true on confirm without an action', async () => {
    const p = confirm({ title: 'Archive?' });
    expect(current.value?.title).toBe('Archive?');
    await runAction();
    expect(current.value).toBeNull();
    await expect(p).resolves.toBe(true);
  });

  it('resolves false on cancel', async () => {
    const p = confirm({ title: 'Archive?' });
    settle(false);
    expect(current.value).toBeNull();
    await expect(p).resolves.toBe(false);
  });

  it('exposes isConfirmOpen while a request is pending', async () => {
    expect(isConfirmOpen.value).toBe(false);
    const p = confirm({ title: 'Archive?' });
    expect(isConfirmOpen.value).toBe(true);
    settle(false);
    expect(isConfirmOpen.value).toBe(false);
    await expect(p).resolves.toBe(false);
  });

  it('cancels a pending request when a new confirm supersedes it', async () => {
    const first = confirm({ title: 'First' });
    const second = confirm({ title: 'Second' });
    await expect(first).resolves.toBe(false);
    expect(current.value?.title).toBe('Second');
    settle(true);
    await expect(second).resolves.toBe(true);
  });

  it('keeps the dialog open (busy) while the action runs, then closes', async () => {
    const action = deferred();
    let ran = false;
    const p = confirm({
      title: 'Archive?',
      action: async () => {
        ran = true;
        await action.promise;
      },
    });

    void runAction();
    expect(ran).toBe(true);
    expect(busy.value).toBe(true);
    expect(current.value).not.toBeNull();
    settle(false);
    expect(current.value).not.toBeNull();

    action.resolve();
    await p;
    expect(busy.value).toBe(false);
    expect(current.value).toBeNull();
    await expect(p).resolves.toBe(true);
  });

  it('closes and rejects the confirm() promise when the action fails', async () => {
    const failure = new Error('boom');
    const p = confirm({
      title: 'Archive?',
      action: () => Promise.reject(failure),
    });
    const assertion = expect(p).rejects.toBe(failure);
    await runAction();
    expect(busy.value).toBe(false);
    expect(current.value).toBeNull();
    await assertion;
  });

  it('ignores a duplicate confirm while an action is running', async () => {
    const action = deferred();
    let runs = 0;
    const p = confirm({
      title: 'Archive?',
      action: async () => {
        runs += 1;
        await action.promise;
      },
    });
    void runAction();
    await runAction();
    expect(runs).toBe(1);
    action.resolve();
    await p;
  });

  it('runAction without a pending request is a no-op', async () => {
    expect(current.value).toBeNull();
    await runAction();
    expect(busy.value).toBe(false);
  });

  it('resolves a new confirm false instead of superseding while an action runs', async () => {
    const action = deferred();
    const first = confirm({
      title: 'First',
      action: () => action.promise,
    });
    void runAction();
    expect(busy.value).toBe(true);

    const second = confirm({ title: 'Second' });
    await expect(second).resolves.toBe(false);
    expect(current.value?.title).toBe('First');
    expect(busy.value).toBe(true);

    action.resolve();
    await expect(first).resolves.toBe(true);
    expect(busy.value).toBe(false);
    expect(current.value).toBeNull();
  });
});
