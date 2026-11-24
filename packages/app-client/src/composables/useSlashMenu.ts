import { nextTick, ref, watch, type Ref } from 'vue';
import type { AppSkill } from '@moonshot-ai/app-core/api';
import { buildSlashItems, filterCommandMatches, stripSkillPrefix, type SlashCommand, type SlashMatchRanges } from '@moonshot-ai/app-core/lib';
import type { TextFieldLike } from '@moonshot-ai/app-composer/runtime';

export interface SlashMenuDeps {
  text: Ref<string>;
  editorRef: Ref<TextFieldLike | null>;
  skills: () => AppSkill[];
  emitCommand: (cmd: string) => void;
  historyPush: (entry: string) => void;
  clearDraft?: () => void;
  insertSkillMention?: (
    entry: { kind: 'skill'; name: string; path: string },
    range: { start: number; end: number },
  ) => void;
  resolveDesc?: (item: SlashCommand) => string;
  towerEnabled?: () => boolean;
  extraBuiltins?: () => readonly SlashCommand[] | undefined;
}

const SLASH_MENU_TOKEN = /^[/、](\S*)$/;

export function slashMenuQuery(text: string): string | null {
  return SLASH_MENU_TOKEN.exec(text)?.[1] ?? null;
}

export function useSlashMenu(deps: SlashMenuDeps) {
  const { text, editorRef, skills, emitCommand, historyPush, clearDraft, insertSkillMention, resolveDesc, towerEnabled, extraBuiltins } = deps;

  const open = ref(false);
  const items = ref<SlashCommand[]>([]);
  const ranges = ref<SlashMatchRanges[]>([]);
  const active = ref(0);

  let dismissed = false;
  let completed: SlashCommand | null = null;

  watch(
    text,
    (val) => {
      if (slashMenuQuery(val) === null) dismissed = false;
      if (completed !== null && val !== completed.name) completed = null;
    },
    { flush: 'sync' },
  );

  function update(): void {
    const val = text.value;
    const query = slashMenuQuery(val);
    if (query === null || dismissed) {
      open.value = false;
      return;
    }
    const matches = filterCommandMatches(`/${query}`, buildSlashItems(skills(), { towerEnabled: towerEnabled?.() === true, extraBuiltins: extraBuiltins?.() }), resolveDesc);
    items.value = matches.map((match) => match.item);
    ranges.value = matches.map((match) => match.ranges);
    const kept = completed;
    active.value = kept === null
      ? 0
      : Math.max(0, items.value.findIndex((item) => item.name === kept.name && item.skillPath === kept.skillPath));
    open.value = val.startsWith('/') || matches.length > 0;
  }

  function close(): void {
    dismissed = false;
    open.value = false;
  }

  function dismiss(): void {
    dismissed = slashMenuQuery(text.value) !== null;
    open.value = false;
  }

  function complete(item: SlashCommand): void {
    if (/\s/.test(item.name)) {
      select(item);
      return;
    }
    completed = item;
    if (text.value === item.name) return;
    text.value = item.name;
    update();
    void nextTick(() => {
      const el = editorRef.value;
      if (!el) return;
      const pos = text.value.length;
      el.setSelectionRange(pos, pos);
      el.focus();
    });
  }

  function select(item: SlashCommand): void {
    open.value = false;
    if (item.isSkill === true && insertSkillMention) {
      insertSkillMention(
        { kind: 'skill', name: stripSkillPrefix(item.name), path: item.skillPath ?? '' },
        { start: 0, end: text.value.length },
      );
      return;
    }
    if (item.acceptsInput) {
      text.value = `${item.name} `;
      void nextTick(() => {
        const el = editorRef.value;
        if (!el) return;
        const pos = text.value.length;
        el.setSelectionRange(pos, pos);
        el.focus();
      });
      return;
    }
    text.value = '';
    clearDraft?.();
    historyPush(item.name);
    emitCommand(item.name);
  }

  return { open, items, ranges, active, update, close, dismiss, select, complete };
}
