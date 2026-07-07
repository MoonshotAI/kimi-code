/**
 * Benchmark for the message-component render cache (Phase 1 + 1.5).
 *
 * Measures the cost of re-rendering a long transcript when *nothing* has
 * changed — the common steady-state frame. With the render cache enabled
 * ("cached (warm)") every message returns its previously computed lines, and
 * the GutterContainer returns its cached concatenation, so the cost is roughly
 * O(number of messages). With it disabled ("uncached") every message rebuilds
 * its output (Markdown, Text, truncation) and the container rebuilds the full
 * line array, which is O(total rendered lines) and dominates CPU as the
 * transcript grows.
 *
 * Run:
 *   pnpm --filter @moonshot-ai/kimi-code exec vitest bench test/tui/render-memo.bench.ts
 */

import { bench, describe } from 'vitest';

import type { Component } from '@moonshot-ai/pi-tui';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { setRenderCacheEnabled } from '#/tui/utils/render-cache';

const WIDTH = 100;
const TRANSCRIPT_TURNS = 200;
const GUTTER = 2;

const USER_TEXT =
  'Can you refactor the streaming renderer so that finalized assistant messages stop being re-rendered on every frame? Please keep the diff minimal and avoid touching the engine.';

const ASSISTANT_TEXT = [
  'Here is a summary of the change:',
  '',
  '- cache the rendered lines per message component',
  '- invalidate the cache when content, theme, or width changes',
  '- keep the diff renderer untouched',
  '',
  '```ts',
  'render(width: number): string[] {',
  '  if (this.cache && this.cache.width === width) return this.cache.lines;',
  '  const lines = this.compute(width);',
  '  this.cache = { width, lines };',
  '  return lines;',
  '}',
  '```',
  '',
  'This keeps the steady-state frame cheap while preserving correctness.',
].join('\n');

const THINKING_TEXT = [
  'Let me reason through the invalidation paths carefully.',
  'The cache must be cleared on content changes, theme switches, and width changes.',
  'Width changes already trigger a full repaint, so they fall out naturally.',
  'Theme switches flow through invalidate(), so that is the hook to clear the cache.',
  'Streaming updates go through updateContent/setText, which already short-circuit when unchanged.',
].join('\n');

function buildMessages(turns: number): Component[] {
  const components: Component[] = [];
  for (let i = 0; i < turns; i++) {
    components.push(new UserMessageComponent(`[${i}] ${USER_TEXT}`));

    const assistant = new AssistantMessageComponent();
    assistant.updateContent(`[${i}] ${ASSISTANT_TEXT}`);
    components.push(assistant);

    components.push(new ThinkingComponent(`[${i}] ${THINKING_TEXT}`, true, 'finalized'));
  }
  return components;
}

function buildGutter(turns: number): GutterContainer {
  const gutter = new GutterContainer(GUTTER, GUTTER);
  for (const message of buildMessages(turns)) gutter.addChild(message);
  return gutter;
}

describe('render memo — flat child render', () => {
  const messages = buildMessages(TRANSCRIPT_TURNS);

  // Warm up: populate every component's cache so the "cached" case measures
  // steady-state cache hits rather than first-render cost.
  setRenderCacheEnabled(true);
  for (const message of messages) message.render(WIDTH);

  bench('cached (warm)', () => {
    setRenderCacheEnabled(true);
    for (const message of messages) message.render(WIDTH);
  });

  bench('uncached', () => {
    setRenderCacheEnabled(false);
    for (const message of messages) message.render(WIDTH);
  });
});

describe('render memo — via GutterContainer', () => {
  const gutter = buildGutter(TRANSCRIPT_TURNS);

  setRenderCacheEnabled(true);
  gutter.render(WIDTH);

  bench('cached (warm)', () => {
    setRenderCacheEnabled(true);
    gutter.render(WIDTH);
  });

  bench('uncached', () => {
    setRenderCacheEnabled(false);
    gutter.render(WIDTH);
  });
});
