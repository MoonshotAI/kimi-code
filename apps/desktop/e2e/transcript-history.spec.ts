import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type DesktopApp } from './fixtures/app';
import { captureClipboardWrites } from './fixtures/clipboard';
import { messageProblems, say, type StubModel } from './fixtures/model';
import { answerNativeDialog } from './fixtures/native-dialog';
import { chooseHeaderMenuItem, closeOverlayMenu, readZip, relaunchAndSettle, waitForSettledReply } from './fixtures/transcript';
import { sidebarOf } from './fixtures/sessions';

const TURNS = 12;
const PAGE = 10;
const question = (n: number): string => `History question ${n}`;
const answer = (n: number): string => `History answer ${n} is settled.`;
const reply = (n: number): string[] => [`${answer(n)}\n\n`, ...Array.from({ length: 6 }, (_, index) => `Detail ${index + 1} for question ${n}.\n\n`)];
const OTHER = 'A separate quick question';
const OTHER_REPLY = 'A separate quick answer.';
const ZIP_NAME = 'history-export.zip';

function expectedMarkdown(last = TURNS, first = 1): string {
  return Array.from({ length: last - first + 1 }, (_, index) => [
    `**User**\n\n${question(first + index)}`,
    `**Assistant**\n\n${reply(first + index).join('')}`,
  ]).flat().join('\n\n---\n\n');
}

async function buildHistory(app: DesktopApp, model: StubModel, turns: number): Promise<string> {
  for (let n = 1; n <= turns; n += 1) {
    model.script(say(reply(n), { intervalMs: 5 }));
    await app.startTurn(question(n));
    await waitForSettledReply(app.window, answer(n));
  }
  return app.sessionId();
}

const REPLAY_TURNS = 450;
const REPLAY_TOOLS_PER_TURN = 10;
const replayQuestion = (n: number): string => `Replay question ${n}`;
const replayAnswer = (n: number): string => `Replay answer ${n} is settled.`;

interface SyntheticWireRecord {
  readonly type: string;
  readonly time: number;
  readonly [key: string]: unknown;
}

async function writeReplayHistory(home: string, sessionId: string): Promise<number> {
  const wireFiles = (await readdir(home, { recursive: true })).filter(path =>
    path.includes(sessionId) && path.endsWith(join('agents', 'main', 'wire.jsonl')));
  expect(wireFiles).toHaveLength(1);
  const wirePath = join(home, wireFiles[0]!);
  const seed = (await readFile(wirePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as SyntheticWireRecord);
  const firstPrompt = seed.findIndex(record => record.type === 'turn.prompt');
  expect(firstPrompt).toBeGreaterThan(0);
  const records = seed.slice(0, firstPrompt);
  let time = Date.now();
  const append = (type: string, fields: Record<string, unknown>): void => {
    records.push({ type, time: time++, ...fields });
  };

  for (let n = 1; n <= REPLAY_TURNS; n += 1) {
    const turnId = n - 1;
    const promptId = `replay-prompt-${n}`;
    append('turn.prompt', {
      agentId: 'main',
      input: [{ type: 'text', text: replayQuestion(n) }],
      origin: { kind: 'user' },
      promptId,
      turnId,
    });
    append('context.append_message', {
      agentId: 'main',
      message: {
        id: promptId,
        role: 'user',
        content: [{ type: 'text', text: replayQuestion(n) }],
        origin: { kind: 'user' },
        toolCalls: [],
      },
    });
    for (let tool = 0; tool < REPLAY_TOOLS_PER_TURN; tool += 1) {
      const stepUuid = `replay-step-${n}-${tool}`;
      const toolCallId = `replay-call-${n}-${tool}`;
      append('context.append_loop_event', {
        agentId: 'main',
        event: { type: 'step.begin', uuid: stepUuid, turnId: String(turnId), step: tool },
      });
      append('context.append_loop_event', {
        agentId: 'main',
        event: {
          type: 'tool.call',
          uuid: `replay-tool-event-${n}-${tool}`,
          stepUuid,
          turnId: String(turnId),
          step: tool,
          toolCallId,
          name: 'Bash',
          args: { command: `printf 'Replay tool ${n}-${tool}\\n'`, description: `Replay tool ${n}-${tool}` },
        },
      });
      append('context.append_loop_event', {
        agentId: 'main',
        event: { type: 'step.end', uuid: stepUuid, turnId: String(turnId), step: tool, finishReason: 'tool_calls' },
      });
      append('context.append_loop_event', {
        agentId: 'main',
        event: { type: 'tool.result', toolCallId, result: { output: `Replay tool ${n}-${tool}\n`, durationMs: 1 } },
      });
    }
    const finalStep = `replay-step-${n}-final`;
    append('context.append_loop_event', {
      agentId: 'main',
      event: { type: 'step.begin', uuid: finalStep, turnId: String(turnId), step: REPLAY_TOOLS_PER_TURN },
    });
    append('context.append_loop_event', {
      agentId: 'main',
      event: {
        type: 'content.part',
        uuid: `replay-content-${n}`,
        stepUuid: finalStep,
        turnId: String(turnId),
        step: REPLAY_TOOLS_PER_TURN,
        part: { type: 'text', text: replayAnswer(n) },
      },
    });
    append('context.append_loop_event', {
      agentId: 'main',
      event: { type: 'step.end', uuid: finalStep, turnId: String(turnId), step: REPLAY_TOOLS_PER_TURN, finishReason: 'end_turn' },
    });
    append('turn.ended', { agentId: 'main', turnId, reason: 'completed', durationMs: 1 });
  }

  await writeFile(wirePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  return records.length;
}

test('a long transcript pages in earlier turns, copies as markdown, survives a session switch and exports', async ({ app, model }) => {
  let sessionId = '';
  const transcript = () => app.window.getByRole('list').first();
  const sidebar = () => sidebarOf(app);

  await test.step('twelve turns build a long session', async () => {
    sessionId = await buildHistory(app, model, TURNS);
    expect(model.requests()).toHaveLength(TURNS);
  });

  await test.step('after a relaunch only the latest page is loaded and the earliest turns wait behind "Load earlier messages"', async () => {
    await relaunchAndSettle(app, question(1));
    expect(await app.sessionId()).toBe(sessionId);
    await expect(transcript().getByText(answer(TURNS), { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(transcript().getByText(question(1), { exact: true })).toHaveCount(0);
    await expect(transcript().getByText(question(2), { exact: true })).toHaveCount(0);
    await expect(app.window.getByRole('button', { name: 'Load earlier messages' })).toBeAttached();
    await expect(app.window.getByRole('button', { name: 'Load earlier messages' })).not.toBeInViewport();
    await app.snapshot('latest-page');
  });

  await test.step('scrolling to the top loads the earlier messages above the current ones', async () => {
    await transcript().hover();
    await app.window.mouse.wheel(0, -100_000);
    await expect(transcript().getByText(question(1), { exact: true })).toBeAttached();
    await transcript().hover();
    await app.window.mouse.wheel(0, -100_000);
    await expect(transcript().getByText(question(1), { exact: true })).toBeInViewport();
    await expect(transcript().getByText(answer(2), { exact: true })).toBeAttached();
    await expect(app.window.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
    const mountedQuestions = await transcript().getByText(/^History question \d+$/).allTextContents();
    expect(mountedQuestions).toContain(question(1));
    expect(mountedQuestions.length).toBeLessThan(TURNS);
    await app.snapshot('earlier-loaded');
  });

  await test.step('Copy all as Markdown from the header menu copies the whole conversation in order', async () => {
    const clipboard = await captureClipboardWrites(app);
    await chooseHeaderMenuItem(app, 'Copy all as Markdown');
    await expect.poll(clipboard).toEqual([expectedMarkdown()]);
    await expect((await app.overlay()).getByRole('menuitem', { name: 'Copied' })).toBeVisible();
    await closeOverlayMenu(app);
  });

  await test.step('switching to another session and back returns to the same transcript', async () => {
    await transcript().hover();
    await app.window.mouse.wheel(0, -100_000);
    await expect(transcript().getByText(question(1), { exact: true })).toBeInViewport();

    await sidebar().getByRole('button', { name: /^New Session/ }).click();
    await expect(transcript().getByText(question(1), { exact: true })).toHaveCount(0);
    model.script(say(OTHER_REPLY));
    await app.startTurn(OTHER);
    await waitForSettledReply(app.window, OTHER_REPLY);
    await expect.poll(() => app.sessionId()).not.toBe(sessionId);

    await sidebar().getByText(question(1), { exact: true }).click();
    await expect.poll(() => app.sessionId()).toBe(sessionId);
    await expect(transcript().getByText(answer(TURNS), { exact: true })).toBeAttached();
    await expect(transcript().getByText(question(3), { exact: true })).toBeAttached();
    await expect(transcript().getByText(OTHER, { exact: true })).toHaveCount(0);
    await app.snapshot('switched-back');
  });

  await test.step('Export session saves a ZIP whose wire log holds the whole transcript', async () => {
    const target = join(app.downloads, ZIP_NAME);
    await answerNativeDialog(app, 'showSaveDialogSync', target);
    await chooseHeaderMenuItem(app, 'Export session');
    await expect.poll(async () => (await readdir(app.downloads)).filter(name => !name.endsWith('.crdownload'))).toEqual([ZIP_NAME]);
    let files = new Map<string, string>();
    await expect.poll(async () => {
      try {
        files = readZip(await readFile(target));
        return files.has('agents/main/wire.jsonl');
      } catch {
        return false;
      }
    }).toBe(true);
    const manifest = JSON.parse(files.get('manifest.json') ?? '{}') as { sessionId?: string; title?: string };
    expect(manifest.sessionId).toBe(sessionId);
    expect(manifest.title).toBe(question(1));
    const wire = files.get('agents/main/wire.jsonl')!;
    for (let n = 1; n <= TURNS; n += 1) {
      expect(wire).toContain(question(n));
      expect(wire).toContain(answer(n));
    }
    expect(wire).not.toContain(OTHER);
    await app.snapshot('exported');
  });
});

test('Copy all as Markdown after a relaunch copies the loaded turns', async ({ app, model }) => {
  await buildHistory(app, model, PAGE + 1);
  await relaunchAndSettle(app, question(1));
  const transcript = app.window.getByRole('list').first();
  await expect(transcript.getByText(answer(PAGE + 1), { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(transcript.getByText(question(1), { exact: true })).toHaveCount(0);
  const clipboard = await captureClipboardWrites(app);
  await chooseHeaderMenuItem(app, 'Copy all as Markdown');
  await expect.poll(clipboard).toHaveLength(1);
  expect((await clipboard())[0]).toContain(expectedMarkdown(PAGE + 1, 2));
});

test('switching sessions and back keeps the earlier-loaded turns', async ({ app, model }) => {
  const sessionId = await buildHistory(app, model, PAGE + 1);
  await relaunchAndSettle(app, question(1));
  const transcript = app.window.getByRole('list').first();
  const sidebar = sidebarOf(app);
  await expect(transcript.getByText(answer(PAGE + 1), { exact: true })).toBeVisible({ timeout: 30_000 });
  await transcript.hover();
  await app.window.mouse.wheel(0, -100_000);
  await expect(transcript.getByText(question(1), { exact: true })).toBeAttached();
  const anchor = transcript.getByText(question(6), { exact: true });
  await anchor.evaluate(element => element.scrollIntoView({ block: 'start' }));
  await expect(anchor).toBeInViewport();
  const anchorTop = (await anchor.boundingBox())!.y;
  const loadedTurns = await transcript.getByRole('listitem').first().getAttribute('aria-setsize');
  expect(Number(loadedTurns)).toBeGreaterThan(PAGE * 2);

  await sidebar.getByRole('button', { name: /^New Session/ }).click();
  await expect(transcript.getByText(question(1), { exact: true })).toHaveCount(0);
  model.script(say(OTHER_REPLY));
  await app.startTurn(OTHER);
  await waitForSettledReply(app.window, OTHER_REPLY);

  await sidebar.getByText(question(1), { exact: true }).click();
  await expect.poll(() => app.sessionId()).toBe(sessionId);
  await expect(transcript.getByText(answer(PAGE + 1), { exact: true })).toBeAttached();
  await expect(transcript.getByRole('listitem').first()).toHaveAttribute('aria-setsize', loadedTurns!);
  await expect(anchor).toBeInViewport();
  await expect.poll(async () => Math.abs(((await anchor.boundingBox())?.y ?? Number.POSITIVE_INFINITY) - anchorTop)).toBeLessThanOrEqual(24);
});

test('a session with 450 turns and 4500 tool calls restores promptly and accepts a follow-up', async ({ app, model, scratch }, testInfo) => {
  let sessionId = '';
  const transcript = () => app.window.getByRole('list').first();
  const sidebar = () => sidebarOf(app);

  await test.step('persist a real session shape with 450 turns and 4500 completed tool calls', async () => {
    model.script(say(replayAnswer(1)));
    await app.startTurn(replayQuestion(1));
    await waitForSettledReply(app.window, replayAnswer(1));
    sessionId = await app.sessionId();
    const records = await writeReplayHistory(join(scratch, 'home'), sessionId);
    expect(records).toBeGreaterThan(REPLAY_TURNS * (REPLAY_TOOLS_PER_TURN * 4 + 6));
  });

  await test.step('relaunch from another session so the long session is restored only when selected', async () => {
    await sidebar().getByRole('button', { name: /^New Session/ }).click();
    model.script(say(OTHER_REPLY));
    await app.startTurn(OTHER);
    await waitForSettledReply(app.window, OTHER_REPLY);
    await relaunchAndSettle(app, OTHER);
    await expect.poll(() => app.sessionId()).not.toBe(sessionId);
  });

  await test.step('selecting the long session restores the latest page and its tools without a multi-second stall', async () => {
    const startedAt = Date.now();
    await sidebar().getByText(replayQuestion(1), { exact: true }).click();
    await expect(transcript().getByText(replayAnswer(REPLAY_TURNS), { exact: true })).toBeVisible();
    const openMs = Date.now() - startedAt;
    await testInfo.attach('long-session-open', {
      body: JSON.stringify({ openMs, turns: REPLAY_TURNS, toolCalls: REPLAY_TURNS * REPLAY_TOOLS_PER_TURN }),
      contentType: 'application/json',
    });
    expect(openMs).toBeLessThan(5_000);
    await expect.poll(() => app.sessionId()).toBe(sessionId);
    await expect(transcript().getByText(replayQuestion(REPLAY_TURNS - PAGE + 1), { exact: true })).toBeAttached();
    await expect(transcript().getByText(replayQuestion(1), { exact: true })).toHaveCount(0);
    const latestTools = transcript().getByRole('button', { name: `Ran ${REPLAY_TOOLS_PER_TURN} commands`, exact: true }).last();
    await expect(latestTools).toBeAttached();
    await latestTools.click();
    await expect(transcript().getByText(`Replay tool ${REPLAY_TURNS}-${REPLAY_TOOLS_PER_TURN - 1}`, { exact: false }).first()).toBeAttached();
    await app.snapshot('450-turns-restored');
  });

  await test.step('the restored loop journal sends valid paired history on a follow-up turn', async () => {
    const followUpReply = 'The restored session accepted a follow-up.';
    model.script(say('Replay history compacted.'), say(followUpReply));
    const request = await app.startTurn('Continue after restoring the long session');
    expect(messageProblems(request.messages)).toEqual([]);
    await waitForSettledReply(app.window, followUpReply);
    await app.snapshot('450-turns-follow-up');
  });
});
