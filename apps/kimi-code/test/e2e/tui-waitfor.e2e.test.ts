/**
 * WaitFor from the user's seat: the real TUI in tmux against a scripted mock
 * LLM (see `tui-sandbox.ts`). Opt-in like the other e2e suites — runs only
 * with `KIMI_E2E=1` and a `tmux` binary on PATH. Set `KIMI_E2E_FRAMES_DIR` to
 * keep a text capture of the screen at each step.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { hasTmux, MockLlm, type MockStep, TuiSandbox } from './tui-sandbox';

const ENABLED = process.env['KIMI_E2E'] === '1' && (await hasTmux());
const TEST_TIMEOUT_MS = 120_000;

const START_BACKGROUND_BUILD: MockStep = {
  toolCalls: [
    {
      name: 'Bash',
      args: { command: 'sleep 60; echo build ok', run_in_background: true, description: 'slow build' },
    },
  ],
};

let mock: MockLlm | undefined;
let tui: TuiSandbox | undefined;

afterEach(async () => {
  await tui?.dispose();
  await mock?.close();
  tui = undefined;
  mock = undefined;
});

describe.skipIf(!ENABLED)('TUI e2e — WaitFor', () => {
  it(
    'ends a running wait when the user sends a message with Enter',
    async () => {
      mock = await MockLlm.start([
        START_BACKGROUND_BUILD,
        { toolCalls: [{ name: 'WaitFor', args: { timeout: 60 } }] },
        { text: 'Stopped waiting. You said: ', echoUser: true },
      ]);
      tui = await TuiSandbox.launch({ name: 'enter-ends-wait', mock });
      await tui.frame('ready');

      await tui.submit('Run the build and wait for it');
      await tui.waitForScreen((screen) => /Waiting \d+s \/ 1m/.test(screen));
      await tui.frame('waiting');

      await tui.submit('Skip the build, check the README first');
      await tui.waitForScreen((screen) =>
        screen.includes('You said: Skip the build, check the README first'),
      );
      const screen = await tui.frame('wait-interrupted');

      expect(screen).toContain('Wait interrupted by new input');
      expect(screen).toContain('1 background task still running');
      expect(mock.requests[2]?.lastUser).toBe('Skip the build, check the README first');
      expect(mock.requests[2]?.toolResults.join('\n')).toContain('wait_status: interrupted');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'steers messages queued before the wait into the turn once it starts waiting',
    async () => {
      mock = await MockLlm.start([
        START_BACKGROUND_BUILD,
        { toolCalls: [{ name: 'WaitFor', args: { timeout: 60 } }], delayMs: 4_000 },
        { text: 'Read your queued note: ', echoUser: true },
      ]);
      tui = await TuiSandbox.launch({ name: 'queued-before-wait', mock });

      await tui.submit('Run the build and wait for it');
      await tui.waitForScreen((screen) => screen.includes('bash task started in background'));
      await tui.submit('Also bump the version');
      await tui.waitForScreen((screen) => screen.includes('ctrl-s to steer immediately'));
      await tui.frame('queued-while-model-thinks');

      await tui.waitForScreen((screen) => screen.includes('Read your queued note: Also bump the version'));
      const screen = await tui.frame('queued-note-steered-into-wait');

      expect(screen).toContain('Wait interrupted by new input');
      expect(mock.requests[2]?.lastUser).toBe('Also bump the version');
      expect(mock.requests[2]?.toolResults.join('\n')).toContain('wait_status: interrupted');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps queued input queued when a WaitFor call is rejected instead of waiting',
    async () => {
      mock = await MockLlm.start([
        START_BACKGROUND_BUILD,
        { toolCalls: [{ name: 'WaitFor', args: { timeout: 600 } }], delayMs: 2_000 },
        { text: 'Continuing without waiting.', delayMs: 3_000 },
        { text: 'Next turn got: ', echoUser: true },
      ]);
      tui = await TuiSandbox.launch({ name: 'rejected-wait-keeps-queue', mock });

      await tui.submit('Run the build and wait for it');
      await tui.waitForScreen((screen) => screen.includes('bash task started in background'));
      await tui.submit('Queued follow-up');
      await tui.waitForScreen((screen) => screen.includes('Could not wait for background task'));
      await tui.frame('rejected-wait-queue-intact');

      await tui.waitForScreen((screen) => screen.includes('Next turn got: Queued follow-up'));
      await tui.frame('queued-follow-up-ran-as-next-turn');

      expect(mock.requests[2]?.lastUser).not.toBe('Queued follow-up');
      expect(mock.requests[2]?.toolResults.join('\n')).not.toContain('wait_status: interrupted');
      expect(mock.requests[3]?.lastUser).toBe('Queued follow-up');
    },
    TEST_TIMEOUT_MS,
  );
});

const WAIT_WARNING = '[wait_warning]';

function waitOnce(timeout: number): MockStep {
  return { toolCalls: [{ name: 'WaitFor', args: { timeout } }] };
}

const COMPLETE_GOAL: MockStep = { toolCalls: [{ name: 'UpdateGoal', args: { status: 'complete' } }] };

describe.skipIf(!ENABLED)('TUI e2e — WaitFor in goal mode', () => {
  it(
    'finishes a goal in one turn by waiting for its background build',
    async () => {
      mock = await MockLlm.start([
        {
          toolCalls: [
            {
              name: 'Bash',
              args: { command: 'sleep 5; echo build ok', run_in_background: true, description: 'slow build' },
            },
          ],
        },
        waitOnce(30),
        COMPLETE_GOAL,
        { text: 'Goal done.' },
      ]);
      tui = await TuiSandbox.launch({ name: 'goal-waits-in-one-turn', mock });

      await tui.startGoal('Ship the build');
      await tui.waitForScreen((screen) => /Waiting \d+s \/ 30s/.test(screen));
      await tui.frame('goal-waiting-for-build');

      await tui.waitForScreen((screen) => screen.includes('Goal complete'));
      const screen = await tui.frame('goal-complete');

      expect(screen).toContain('Worked 1 turn');
      expect(mock.requests).toHaveLength(4);
      expect(mock.requests[2]?.toolResults.join('\n')).toContain('wait_status: completed');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'lets a message end a goal wait, then continues the goal',
    async () => {
      mock = await MockLlm.start([
        START_BACKGROUND_BUILD,
        waitOnce(60),
        { text: 'Noted: ', echoUser: true },
        COMPLETE_GOAL,
        { text: 'Goal done.' },
      ]);
      tui = await TuiSandbox.launch({ name: 'goal-wait-interrupted', mock });

      await tui.startGoal('Ship the build');
      await tui.waitForScreen((screen) => /Waiting \d+s \/ 1m/.test(screen));
      await tui.submit('Use the release profile');
      await tui.waitForScreen((screen) => screen.includes('Noted: Use the release profile'));
      await tui.frame('goal-wait-interrupted');

      await tui.waitForScreen((screen) => screen.includes('Goal complete'));
      await tui.frame('goal-continued-and-completed');

      expect(mock.requests[2]?.lastUser).toBe('Use the release profile');
      expect(mock.requests[2]?.toolResults.join('\n')).toContain('wait_status: interrupted');
      expect(mock.requests).toHaveLength(5);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'warns the model on a repeated wait within a goal turn',
    async () => {
      mock = await MockLlm.start([START_BACKGROUND_BUILD, waitOnce(2), waitOnce(2), COMPLETE_GOAL, { text: 'Goal done.' }]);
      tui = await TuiSandbox.launch({ name: 'goal-repeated-wait', mock });

      await tui.startGoal('Ship the build');
      await tui.waitForScreen((screen) => screen.includes('Goal complete'));
      await tui.frame('goal-two-waits');

      const first = mock.requests[2]?.toolResults.join('\n') ?? '';
      const second = mock.requests[3]?.toolResults.join('\n') ?? '';
      tui.note('model-sees-first-wait', first);
      tui.note('model-sees-second-wait', second);
      expect(first).not.toContain(WAIT_WARNING);
      expect(second).toContain(WAIT_WARNING);
    },
    TEST_TIMEOUT_MS,
  );
});

describe.skipIf(!ENABLED)('TUI e2e — repeated WaitFor calls', () => {
  it(
    'warns the model on the second wait in a turn and starts over in the next turn',
    async () => {
      mock = await MockLlm.start([
        START_BACKGROUND_BUILD,
        waitOnce(2),
        waitOnce(2),
        { text: 'Still building; I will check later.' },
        waitOnce(2),
        { text: 'Still building.' },
      ]);
      tui = await TuiSandbox.launch({ name: 'repeated-wait', mock });

      await tui.submit('Run the build and wait for it');
      await tui.waitForScreen((screen) => screen.includes('Still building; I will check later.'));
      await tui.frame('two-waits-in-one-turn');

      await tui.submit('Check the build again');
      await tui.waitForScreen((screen) => /Still building\.\s*$/m.test(screen));
      await tui.frame('one-wait-in-the-next-turn');

      const turnOneFirst = mock.requests[2]?.toolResults.join('\n') ?? '';
      const turnOneSecond = mock.requests[3]?.toolResults.join('\n') ?? '';
      const turnTwoFirst = mock.requests[5]?.toolResults.join('\n') ?? '';
      tui.note('model-sees-turn-1-first-wait', turnOneFirst);
      tui.note('model-sees-turn-1-second-wait', turnOneSecond);
      tui.note('model-sees-turn-2-first-wait', turnTwoFirst);
      expect(turnOneFirst).not.toContain(WAIT_WARNING);
      expect(turnOneSecond).toContain(WAIT_WARNING);
      expect(turnTwoFirst).not.toContain(WAIT_WARNING);
    },
    TEST_TIMEOUT_MS,
  );
});
