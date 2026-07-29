/**
 * Scenario: session plugin-contribution convergence.
 *
 * Exercises the real coordinator against a stubbed App plugin boundary:
 * catalog-kind changes fan out to Agent participants and the change waits
 * for the whole fan-out, MCP-only changes skip convergence, and a failing
 * or hung participant cannot block the change for everyone else.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/session/sessionPluginContribution/sessionPluginContribution.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createScopedTestHost, stubPair } from '#/_base/di/test';
import {
  _clearScopedRegistryForTests,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import { AsyncEmitter, Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IPluginService, type PluginChangedEvent } from '#/app/plugin/plugin';

import {
  ISessionPluginContributionService,
  PLUGIN_CONVERGENCE_TIMEOUT_MS,
} from '#/session/sessionPluginContribution/sessionPluginContribution';
import { SessionPluginContributionService } from '#/session/sessionPluginContribution/sessionPluginContributionService';

const noopLog = {
  _serviceBrand: undefined,
  level: 'off',
  setLevel: () => {},
  flush: async () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => noopLog,
} as unknown as ILogService;

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface PluginBoundary {
  readonly change: AsyncEmitter<PluginChangedEvent>;
}

function pluginStub(boundary: PluginBoundary): IPluginService {
  return {
    _serviceBrand: undefined,
    onDidChange: boundary.change.event,
    onDidReload: Event.None as IPluginService['onDidReload'],
  } as unknown as IPluginService;
}

function makeHost(boundary: PluginBoundary) {
  const host = createScopedTestHost([
    stubPair(ILogService, noopLog),
    stubPair(IPluginService, pluginStub(boundary)),
  ]);
  const session = host.child(LifecycleScope.Session, 's1');
  return { host, session };
}

describe('SessionPluginContributionService', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Session,
      ISessionPluginContributionService,
      SessionPluginContributionService,
    );
  });

  it('notifies participants and waits for the whole fan-out', async () => {
    const change = new AsyncEmitter<PluginChangedEvent>();
    const boundary: PluginBoundary = { change };
    const { host, session } = makeHost(boundary);
    try {
      const coordinator = session.accessor.get(ISessionPluginContributionService);

      const participantCalled = deferred();
      const release = deferred();
      const subscription = coordinator.onDidChange((event) => {
        participantCalled.resolve();
        event.waitUntil(release.promise);
      });
      let settled = false;
      const fired = change
        .fireAsync({ kind: 'catalog' }, new AbortController().signal)
        .then(() => {
          settled = true;
        });

      await participantCalled.promise;
      expect(settled).toBe(false);

      release.resolve();
      await fired;
      expect(settled).toBe(true);
      subscription.dispose();
    } finally {
      host.dispose();
      change.dispose();
    }
  });

  it('skips convergence entirely for MCP-only changes', async () => {
    const change = new AsyncEmitter<PluginChangedEvent>();
    const { host, session } = makeHost({ change });
    try {
      const coordinator = session.accessor.get(ISessionPluginContributionService);

      let participants = 0;
      const subscription = coordinator.onDidChange(() => {
        participants += 1;
      });

      await change.fireAsync({ kind: 'mcp' }, new AbortController().signal);

      expect(participants).toBe(0);
      subscription.dispose();
    } finally {
      host.dispose();
      change.dispose();
    }
  });

  it('lets a rejected participant fail without blocking the change or other participants', async () => {
    const change = new AsyncEmitter<PluginChangedEvent>();
    const { host, session } = makeHost({ change });
    try {
      const coordinator = session.accessor.get(ISessionPluginContributionService);

      let healthy = 0;
      coordinator.onDidChange((event) => {
        event.waitUntil(Promise.reject(new Error('boom')));
      });
      coordinator.onDidChange((event) => {
        healthy += 1;
        event.waitUntil(Promise.resolve());
      });

      await change.fireAsync({ kind: 'catalog' }, new AbortController().signal);

      expect(healthy).toBe(1);
    } finally {
      host.dispose();
      change.dispose();
    }
  });

  it('cuts off a hung participant after the convergence timeout', async () => {
    vi.useFakeTimers();
    try {
      const change = new AsyncEmitter<PluginChangedEvent>();
      const { host, session } = makeHost({ change });
      try {
        const coordinator = session.accessor.get(ISessionPluginContributionService);

        coordinator.onDidChange((event) => {
          event.waitUntil(new Promise(() => {}));
        });
        let settled = false;
        const fired = change
          .fireAsync({ kind: 'catalog' }, new AbortController().signal)
          .then(() => {
            settled = true;
          });

        await vi.advanceTimersByTimeAsync(PLUGIN_CONVERGENCE_TIMEOUT_MS);
        await fired;

        expect(settled).toBe(true);
      } finally {
        host.dispose();
        change.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains blocked participants on later changes without stopping the pipeline', async () => {
    vi.useFakeTimers();
    try {
      const change = new AsyncEmitter<PluginChangedEvent>();
      const { host, session } = makeHost({ change });
      try {
        const coordinator = session.accessor.get(ISessionPluginContributionService);

        coordinator.onDidChange((event) => {
          event.waitUntil(new Promise(() => {}));
        });
        const firstFire = change.fireAsync({ kind: 'catalog' }, new AbortController().signal);
        await vi.advanceTimersByTimeAsync(PLUGIN_CONVERGENCE_TIMEOUT_MS);
        await firstFire;
        await vi.advanceTimersByTimeAsync(1);

        let second = 0;
        coordinator.onDidChange((event) => {
          second += 1;
          event.waitUntil(Promise.resolve());
        });
        const secondFire = change.fireAsync({ kind: 'catalog' }, new AbortController().signal);
        await vi.advanceTimersByTimeAsync(PLUGIN_CONVERGENCE_TIMEOUT_MS);
        await secondFire;
        await vi.advanceTimersByTimeAsync(1);
        expect(second).toBe(0);

        const thirdFire = change.fireAsync({ kind: 'catalog' }, new AbortController().signal);
        await vi.advanceTimersByTimeAsync(PLUGIN_CONVERGENCE_TIMEOUT_MS);
        await thirdFire;
        await vi.advanceTimersByTimeAsync(1);

        expect(second).toBe(1);
      } finally {
        host.dispose();
        change.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues a later change behind an in-flight convergence and retries it after the hang clears', async () => {
    vi.useFakeTimers();
    try {
      const change = new AsyncEmitter<PluginChangedEvent>();
      const { host, session } = makeHost({ change });
      try {
        const coordinator = session.accessor.get(ISessionPluginContributionService);

        const hang = deferred();
        const firstCalled = deferred();
        coordinator.onDidChange((event) => {
          firstCalled.resolve();
          event.waitUntil(hang.promise);
        });
        const firstFire = change.fireAsync({ kind: 'catalog' }, new AbortController().signal);

        await firstCalled.promise;
        await vi.advanceTimersByTimeAsync(PLUGIN_CONVERGENCE_TIMEOUT_MS);
        await firstFire;

        let second = 0;
        coordinator.onDidChange((event) => {
          second += 1;
          event.waitUntil(Promise.resolve());
        });
        let secondSettled = false;
        const secondFire = change
          .fireAsync({ kind: 'catalog' }, new AbortController().signal)
          .then(() => {
            secondSettled = true;
          });

        await vi.advanceTimersByTimeAsync(0);
        expect(second).toBe(0);

        await vi.advanceTimersByTimeAsync(PLUGIN_CONVERGENCE_TIMEOUT_MS);
        await secondFire;
        expect(secondSettled).toBe(true);
        expect(second).toBe(0);

        hang.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(second).toBe(1);
      } finally {
        host.dispose();
        change.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
