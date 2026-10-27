import { createSystemEntry, type HistoryMessage } from '@moonshot-ai/agent-core/history/index';
import { extractText, type ToolDescription } from '@moonshot-ai/agent-core/llm/message';
import type { Loop } from '@moonshot-ai/agent-core/loop/index';

export const SYSTEM_PROMPT_NOTICE_KEY = 'system-prompt-change';
export const TOOLS_NOTICE_KEY = 'tools-change';

export interface ProfileSync {
  refresh(): void;
  reload(): void;
  dispose(): void;
}

export interface PromptSection {
  readonly id: string;
  readonly text: string;
}

interface Diff<T> {
  readonly put: readonly T[];
  readonly removed: readonly T[];
}

interface Part<T> {
  readonly key: string;
  readonly id: (item: T) => string;
  readonly same: (left: T, right: T) => boolean;
  readonly notice: (diff: Diff<T>) => string | undefined;
  readonly cleared: string;
}

interface SyncSlot<T> {
  readonly part: Part<T>;
  valuePresent(): boolean;
  base(live: readonly T[]): readonly T[] | undefined;
  live(): readonly T[];
  stale(live: readonly T[]): boolean;
  set(items: readonly T[]): void;
}

type SyncLoop = Pick<Loop, 'state' | 'remind' | 'subscribe'>;

const systemPromptPart: Part<PromptSection> = {
  key: SYSTEM_PROMPT_NOTICE_KEY,
  id: (section) => section.id,
  same: (left, right) => left.text === right.text,
  notice: ({ put, removed }) =>
    put.length === 0 && removed.length === 0
      ? undefined
      : [
          'The system prompt has changed since this conversation started. Apply the sections below on top of it; ' +
            'removed sections no longer apply. This notice replaces any earlier system prompt change notice.',
          ...put.map((section) => `<section_updated id="${section.id}">\n${section.text}\n</section_updated>`),
          ...removed.map((section) => `<section_removed id="${section.id}">\n${section.text}\n</section_removed>`),
        ].join('\n\n'),
  cleared: 'The system prompt is current; disregard any earlier system prompt change notice.',
};

const toolsPart: Part<ToolDescription> = {
  key: TOOLS_NOTICE_KEY,
  id: (tool) => tool.name,
  same: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  notice: ({ removed }) =>
    removed.length === 0
      ? undefined
      : `These tools are no longer available; do not call them: ${removed.map((tool) => tool.name).join(', ')}. ` +
        'This list replaces any earlier tool availability notice.',
  cleared: 'Every tool in your tool list is available; disregard any earlier tool availability notice.',
};

function diffOf<T>(part: Part<T>, base: readonly T[], live: readonly T[]): Diff<T> {
  const before = new Map(base.map((item) => [part.id(item), item]));
  const after = new Set(live.map(part.id));
  return {
    put: live.filter((item) => {
      const previous = before.get(part.id(item));
      return previous === undefined || !part.same(previous, item);
    }),
    removed: base.filter((item) => !after.has(part.id(item))),
  };
}

function lastNotice(seen: readonly HistoryMessage[], key: string): string | undefined {
  const entry = seen.findLast((item) => item.meta?.key === key);
  return entry === undefined ? undefined : extractText(entry.message);
}

function createSync<T>(
  loop: SyncLoop,
  slot: SyncSlot<T>,
  onPending: ((pending: readonly string[]) => void) | undefined,
): ProfileSync {
  let sent = slot.valuePresent();
  let pending: readonly string[] = [];
  const unsubscribe = loop.subscribe((event) => {
    if (event.type === 'step.started') sent = true;
  });
  const refresh = (): void => {
    const { messages, inbox } = loop.state;
    const live = slot.live();
    const base = slot.base(live);
    const set = base === undefined || (!sent && slot.stale(live)) ? live : undefined;
    const diff = diffOf(slot.part, set ?? base ?? [], live);
    const last = lastNotice([...messages, ...inbox.remind], slot.part.key);
    const text = slot.part.notice(diff) ?? (last === undefined ? undefined : slot.part.cleared);
    if (set !== undefined) slot.set(set);
    if (text !== undefined && text !== last) {
      loop.remind(
        createSystemEntry({ role: 'system', content: [{ type: 'text', text }] }, { source: 'reminder', key: slot.part.key }),
      );
    }
    const nextPending = [...diff.put, ...diff.removed].map(slot.part.id);
    if (JSON.stringify(nextPending) === JSON.stringify(pending)) return;
    pending = nextPending;
    onPending?.(pending);
  };
  return {
    refresh,
    reload: () => {
      sent = false;
      refresh();
    },
    dispose: unsubscribe,
  };
}

export function createSystemPromptSync(
  loop: SyncLoop & Pick<Loop, 'setSystemPrompt'>,
  source: () => readonly PromptSection[],
  onPending?: (pending: readonly string[]) => void,
): ProfileSync {
  let known: readonly PromptSection[] | undefined;
  let knownText: string | undefined;
  const join = (sections: readonly PromptSection[]): string =>
    sections.map((section) => section.text).join('\n\n');
  const live = (): PromptSection[] => {
    const sections = new Map<string, PromptSection>();
    for (const section of source()) {
      if (section.text.trim() !== '') sections.set(section.id, { id: section.id, text: section.text });
    }
    return [...sections.values()];
  };
  return createSync(
    loop,
    {
      part: systemPromptPart,
      valuePresent: () => loop.state.profile.systemPrompt !== undefined,
      base: (sections) => {
        const text = loop.state.profile.systemPrompt;
        if (text === undefined) return undefined;
        if (join(sections) === text) {
          known = sections;
          knownText = text;
          return sections;
        }
        return knownText === text ? known : [];
      },
      live,
      stale: (sections) => join(sections) !== loop.state.profile.systemPrompt,
      set: (sections) => {
        const text = join(sections);
        loop.setSystemPrompt(text);
        known = sections;
        knownText = text;
      },
    },
    onPending,
  );
}

export function createToolsSync(
  loop: SyncLoop & Pick<Loop, 'setTools'>,
  source: () => readonly ToolDescription[],
  onPending?: (pending: readonly string[]) => void,
): ProfileSync {
  return createSync(
    loop,
    {
      part: toolsPart,
      valuePresent: () => loop.state.profile.tools !== undefined,
      base: () => loop.state.profile.tools,
      live: () => source().filter((tool) => tool.deferred !== true),
      stale: (tools) => JSON.stringify(loop.state.profile.tools) !== JSON.stringify(tools),
      set: (tools) => {
        loop.setTools(tools);
      },
    },
    onPending,
  );
}
