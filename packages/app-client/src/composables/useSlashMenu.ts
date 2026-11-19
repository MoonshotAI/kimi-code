import { nextTick, ref, type Ref } from 'vue';
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
}

export function useSlashMenu(deps: SlashMenuDeps) {
  const { text, editorRef, skills, emitCommand, historyPush, clearDraft, insertSkillMention, resolveDesc, towerEnabled } = deps;

  const open = ref(false);
  const items = ref<SlashCommand[]>([]);
  const ranges = ref<SlashMatchRanges[]>([]);
  const active = ref(0);

  function update(): void {
    const val = text.value;
    if (/^\/\S*$/.test(val)) {
      const matches = filterCommandMatches(val, buildSlashItems(skills(), { towerEnabled: towerEnabled?.() === true }), resolveDesc);
      items.value = matches.map((match) => match.item);
      ranges.value = matches.map((match) => match.ranges);
      active.value = 0;
      open.value = true;
    } else {
      open.value = false;
    }
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

  return { open, items, ranges, active, update, select };
}
