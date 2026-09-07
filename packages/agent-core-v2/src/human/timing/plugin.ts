import type { Plugin } from '#/plugin';

export interface LlmRequestTiming {
  readonly requestBuildMs?: number;
  readonly ttftMs: number;
  readonly serverFirstTokenMs: number;
  readonly streamDurationMs: number;
  readonly serverDecodeMs: number;
  readonly clientConsumeMs: number;
}

export interface TimingPlugin extends Plugin {
  readonly name: 'timing';
  timing(): LlmRequestTiming | undefined;
}

export function createTimingPlugin(input?: { now?: () => number }): TimingPlugin {
  const now = input?.now ?? Date.now;
  let current: LlmRequestTiming | undefined;
  let lastEventAt: number | undefined;
  let retryAnchor: { at: number; delayMs: number } | undefined;
  let sentAt: number | undefined;
  let attemptStartedAt: number | undefined;
  let firstDeltaAt: number | undefined;
  let lastHandledAt = 0;
  let serverDecodeMs = 0;
  let clientConsumeMs = 0;

  const resetWindow = (): void => {
    sentAt = undefined;
    attemptStartedAt = undefined;
    firstDeltaAt = undefined;
    serverDecodeMs = 0;
    clientConsumeMs = 0;
  };

  return {
    name: 'timing',
    timing: () => current,
    connect(target) {
      if (target.kind !== 'agent') return;
      const mark = (): void => {
        lastEventAt = now();
      };
      target.on('turn.start', () => {
        retryAnchor = undefined;
        lastEventAt = now();
      });
      target.on('tool.async', mark);
      target.on('tool.done', mark);
      target.on('tool.failed', mark);
      target.on('tool.aborted', mark);
      target.on('llm.sent', () => {
        const t = now();
        attemptStartedAt =
          retryAnchor === undefined ? lastEventAt : retryAnchor.at + retryAnchor.delayMs;
        retryAnchor = undefined;
        sentAt = t;
        firstDeltaAt = undefined;
        serverDecodeMs = 0;
        clientConsumeMs = 0;
        lastEventAt = t;
      });
      target.on('llm.delta', () => {
        const arrivedAt = now();
        if (sentAt === undefined) return;
        if (firstDeltaAt === undefined) {
          firstDeltaAt = arrivedAt;
        } else {
          serverDecodeMs += arrivedAt - lastHandledAt;
        }
        const handledAt = now();
        clientConsumeMs += handledAt - arrivedAt;
        lastHandledAt = handledAt;
        lastEventAt = handledAt;
      });
      target.on('llm.done', () => {
        const t = now();
        if (sentAt !== undefined && firstDeltaAt !== undefined) {
          serverDecodeMs += t - lastHandledAt;
          current = {
            requestBuildMs:
              attemptStartedAt === undefined
                ? undefined
                : Math.max(0, sentAt - attemptStartedAt),
            ttftMs: Math.max(0, firstDeltaAt - (attemptStartedAt ?? sentAt)),
            serverFirstTokenMs: Math.max(0, firstDeltaAt - sentAt),
            streamDurationMs: Math.max(0, t - firstDeltaAt),
            serverDecodeMs: Math.max(0, serverDecodeMs),
            clientConsumeMs: Math.max(0, clientConsumeMs),
          };
        }
        resetWindow();
        lastEventAt = t;
      });
      target.on('llm.retrying', (event) => {
        const t = now();
        if (event.type === 'llm.retrying') {
          retryAnchor = { at: t, delayMs: event.delayMs };
        }
        resetWindow();
        lastEventAt = t;
      });
      target.on('llm.recovering', () => {
        const t = now();
        retryAnchor = undefined;
        resetWindow();
        lastEventAt = t;
      });
      target.on('llm.failed.syntax', () => {
        const t = now();
        retryAnchor = undefined;
        resetWindow();
        lastEventAt = t;
      });
      target.on('llm.failed.remote', () => {
        const t = now();
        retryAnchor = undefined;
        resetWindow();
        lastEventAt = t;
      });
    },
  };
}
