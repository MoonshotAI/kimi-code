/**
 * Monitor from the user's seat: the real TUI in tmux against a scripted mock
 * LLM (see `tui-sandbox.ts`). Opt-in like the other e2e suites — runs only
 * with `KIMI_E2E=1` and `tmux` on PATH.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  foreground,
  hasTmux,
  monitor,
  say,
  scenario,
  startFakeService,
  stopMonitor,
  waitFor,
} from './tui-sandbox';

const ENABLED = process.env['KIMI_E2E'] === '1' && (await hasTmux());
const MONITOR_ON = { env: { KIMI_CODE_EXPERIMENTAL_MONITOR: '1' } };
vi.setConfig({ testTimeout: 120_000 });

// A service on a "remote" host. A single background command cannot follow it:
// it reports once and exits, while the monitor reports every status change.
const service = ENABLED ? await startFakeService('deploying') : undefined;
afterAll(() => service?.close());
const pollStatus = (url: string): string =>
  `sleep 3; prev=""; while true; do s=$(curl -sf --max-time 2 ${url} || echo unreachable); ` +
  'if [ "$s" != "$prev" ]; then echo "status: $s"; prev=$s; fi; sleep 1; done';
const watchStaging = monitor(pollStatus(service?.url ?? ''), 'staging service');

describe.skipIf(!ENABLED)('TUI e2e — Monitor', () => {
  it('An event wakes an idle agent with the new line', scenario(
    [monitor('sleep 2; echo "tick one"; sleep 60'), say('Watching the ticker.'), say('Saw the tick.')],
    async ({ tui, model }) => {
      await tui.submit('Watch the ticker');
      await tui.see('Started a monitor · $ sleep 2', 'monitor-started');
      await tui.see('Watching the ticker.');
      await tui.see('monitor event (ticker)', 'event-row');
      await tui.see('tick one');
      await tui.see('Saw the tick.', 'woke-on-event');

      expect(model.userText(2)).toContain('type="task.event"');
      expect(model.userText(2)).toContain('tick one');
    },
    MONITOR_ON,
  ));

  it('An event that arrives mid-turn reaches the next step', scenario(
    [monitor('sleep 1; echo "server ready"; sleep 60'), foreground('sleep 4'), say('Server is up.')],
    async ({ tui, model }) => {
      await tui.submit('Start watching, then wait a bit');
      await tui.see('Server is up.', 'mid-turn-delivery');

      expect(model.userTexts(2).join('\n')).toContain('server ready');
    },
    MONITOR_ON,
  ));

  it('WaitFor returns as soon as a monitor prints', scenario(
    [monitor('sleep 2; echo "tests passed"; sleep 60'), waitFor(60), say('Tests passed, moving on.')],
    async ({ tui, model }) => {
      await tui.submit('Watch the tests and wait for the result');
      await tui.see('Wait ended by monitor output', 'wait-ended-by-event');
      await tui.see('Tests passed, moving on.');

      expect(model.toolResult(2)).toContain('wait_status: event');
      expect(model.userTexts(2).join('\n')).toContain('tests passed');
    },
    MONITOR_ON,
  ));

  it('A monitor that floods output is stopped', scenario(
    [monitor('yes flood', 'flood'), say('Started.'), say('It was stopped.'), say('Noted.')],
    async ({ tui, model }) => {
      await tui.submit('Watch the flood');
      await tui.see('monitor stopped', 'flood-stopped');
      await tui.see('Event limit exceeded');

      expect(model.sent.flatMap((request) => request.userTexts).join('\n')).toContain('Event limit exceeded');
    },
    MONITOR_ON,
  ));

  describe('remote service status', () => {
    it('Each status change of a remote service reaches the agent', scenario(
      [watchStaging, say('Watching staging.'), say('Still deploying.'), say('Staging is healthy.')],
      async ({ tui, model }) => {
        service!.set('deploying');
        await tui.submit('Deploy staging and tell me when it is healthy');
        await tui.see('Watching staging.');
        await tui.see('status: deploying', 'first-status');
        await tui.see('Still deploying.');
        service!.set('healthy');
        await tui.see('status: healthy', 'second-status');
        await tui.see('Staging is healthy.');

        expect(model.userText(2)).toContain('status: deploying');
        expect(model.userText(3)).toContain('status: healthy');
        expect(model.userText(3)).not.toContain('status: deploying');
      },
      MONITOR_ON,
    ));

    it('An unreachable service wakes the agent', scenario(
      [watchStaging, say('Watching staging.'), say('Staging looks healthy.'), say('Staging is unreachable, looking into it.')],
      async ({ tui, model }) => {
        service!.set('healthy');
        await tui.submit('Keep an eye on staging');
        await tui.see('Staging looks healthy.');
        service!.down();
        await tui.see('status: unreachable', 'unreachable');
        await tui.see('Staging is unreachable, looking into it.');

        expect(model.userText(3)).toContain('status: unreachable');
      },
      MONITOR_ON,
    ));

    it('The agent stops the monitor once the service is healthy', scenario(
      [
        watchStaging,
        say('Watching staging.'),
        say('Still deploying.'),
        stopMonitor(),
        say('Staging is healthy; I stopped watching it.'),
      ],
      async ({ tui, model }) => {
        service!.set('deploying');
        await tui.submit('Tell me when staging is healthy, then stop watching');
        await tui.see('Still deploying.');
        service!.set('healthy');
        await tui.see('Staging is healthy; I stopped watching it.', 'stopped-watching');
        await tui.see('monitor stopped');

        const requests = model.sent.length;
        service!.set('deploying');
        await new Promise((done) => setTimeout(done, 5_000));
        expect(model.sent.length).toBe(requests);
        expect(model.toolResult(4)).toMatch(/monitor-[0-9a-z]+/);
      },
      MONITOR_ON,
    ));
  });
});
