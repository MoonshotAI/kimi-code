/**
 * WaitFor from the user's seat: the real TUI in tmux against a scripted mock
 * LLM (see `tui-sandbox.ts`). Opt-in like the other e2e suites — runs only
 * with `KIMI_E2E=1` and `tmux` on PATH.
 */

import { describe, expect, it, vi } from 'vitest';

import { after, bash, completeGoal, echo, hasTmux, say, scenario, waitFor } from './tui-sandbox';

const ENABLED = process.env['KIMI_E2E'] === '1' && (await hasTmux());
const WARNING = '[wait_warning]';
vi.setConfig({ testTimeout: 120_000 });
const build = bash('sleep 60; echo build ok');

describe.skipIf(!ENABLED)('TUI e2e — WaitFor', () => {
  describe('normal mode', () => {
    it('Enter ends a running wait', scenario(
      [build, waitFor(60), echo('Stopped waiting. You said: ')],
      async ({ tui, model }) => {
        await tui.submit('Run the build and wait for it');
        await tui.see(/Waiting \d+s \/ 1m/, 'waiting');
        await tui.submit('Skip the build, check the README first');
        await tui.see('You said: Skip the build, check the README first', 'wait-interrupted');

        expect(model.userText(2)).toBe('Skip the build, check the README first');
        expect(model.toolResult(2)).toContain('wait_status: interrupted');
      },
    ));

    it('A message queued before the wait is steered in once it waits', scenario(
      [build, after(4_000, waitFor(60)), echo('Read your queued note: ')],
      async ({ tui, model }) => {
        await tui.submit('Run the build and wait for it');
        await tui.see('bash task started in background');
        await tui.submit('Also bump the version');
        await tui.see('ctrl-s to steer immediately', 'queued-while-model-thinks');
        await tui.see('Read your queued note: Also bump the version', 'steered-into-wait');

        expect(model.toolResult(2)).toContain('wait_status: interrupted');
      },
    ));

    it('A rejected WaitFor leaves the queue alone', scenario(
      [build, after(2_000, waitFor(600)), after(3_000, say('Continuing without waiting.')), echo('Next turn got: ')],
      async ({ tui, model }) => {
        await tui.submit('Run the build and wait for it');
        await tui.see('bash task started in background');
        await tui.submit('Queued follow-up');
        await tui.see('Could not wait for background task', 'rejected-wait-queue-intact');
        await tui.see('Next turn got: Queued follow-up', 'follow-up-ran-as-next-turn');

        expect(model.userText(2)).not.toBe('Queued follow-up');
        expect(model.userText(3)).toBe('Queued follow-up');
      },
    ));
  });

  describe('goal mode', () => {
    it('A goal waits for its build within one turn', scenario(
      [bash('sleep 5; echo build ok'), waitFor(30), completeGoal(), say('Goal done.')],
      async ({ tui, model }) => {
        await tui.startGoal('Ship the build');
        await tui.see(/Waiting \d+s \/ 30s/, 'goal-waiting');
        await tui.see('Worked 1 turn', 'goal-complete');

        expect(model.sent).toHaveLength(4);
        expect(model.toolResult(2)).toContain('wait_status: completed');
      },
    ));

    it('A message ends a goal wait and the goal continues', scenario(
      [build, waitFor(60), echo('Noted: '), completeGoal(), say('Goal done.')],
      async ({ tui, model }) => {
        await tui.startGoal('Ship the build');
        await tui.see(/Waiting \d+s \/ 1m/);
        await tui.submit('Use the release profile');
        await tui.see('Goal complete', 'goal-wait-interrupted-then-completed');

        expect(model.userText(2)).toBe('Use the release profile');
        expect(model.toolResult(2)).toContain('wait_status: interrupted');
      },
    ));

    it('Repeated waits in a goal turn warn the model', scenario(
      [build, waitFor(2), waitFor(2), completeGoal(), say('Goal done.')],
      async ({ tui, model }) => {
        await tui.startGoal('Ship the build');
        await tui.see('Goal complete', 'goal-two-waits');
        tui.save('model-sees-second-wait', model.toolResult(3));

        expect(model.toolResult(2)).not.toContain(WARNING);
        expect(model.toolResult(3)).toContain(WARNING);
      },
    ));
  });

  describe('repeated calls', () => {
    it('The second wait in a turn warns and the next turn starts over', scenario(
      [build, waitFor(2), waitFor(2), say('Still building; will check later.'), waitFor(2), say('Still building.')],
      async ({ tui, model }) => {
        await tui.submit('Run the build and wait for it');
        await tui.see('will check later.', 'two-waits-in-one-turn');
        await tui.submit('Check the build again');
        await tui.see(/Still building\.\s*$/m, 'one-wait-next-turn');
        tui.save('model-sees-turn-1-second-wait', model.toolResult(3));

        expect(model.toolResult(2)).not.toContain(WARNING);
        expect(model.toolResult(3)).toContain(WARNING);
        expect(model.toolResult(5)).not.toContain(WARNING);
      },
    ));
  });
});
