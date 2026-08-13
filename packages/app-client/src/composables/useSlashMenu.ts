// packages/app-client/src/composables/useSlashMenu.ts
import { nextTick, ref, type Ref } from 'vue';
import type { AppSkill } from '@moonshot-ai/app-core/api';
import { buildSlashItems, filterCommandMatches, type SlashCommand, type SlashMatchRanges } from '@moonshot-ai/app-core/lib';
import type { TextFieldLike } from '../lib/textField';

export interface SlashMenuDeps {
  /** The live composer text — drives filtering and is rewritten on select. */
  text: Ref<string>;
  /** The editing surface, used to focus and place the caret for acceptsInput. */
  editorRef: Ref<TextFieldLike | null>;
  /** Current session skills (getter, so the menu stays reactive). */
  skills: () => AppSkill[];
  /** Emit a chosen slash command up to the parent. */
  emitCommand: (cmd: string) => void;
  /** Record a sent command for ↑/↓ recall. */
  historyPush: (entry: string) => void;
  /**
   * Synchronously clear the persisted draft when a bare command is chosen.
   * Mirrors the explicit clear in Composer's submit/steer paths so a draft
   * is not left behind if the Composer unmounts before the text watcher flushes.
   */
  clearDraft?: () => void;
  /**
   * Map an item to its display description (built-in descs are i18n keys, so
   * callers with a `t()` should pass one). Optional so the composable stays
   * usable outside a setup context; defaults to the raw `desc`.
   */
  resolveDesc?: (item: SlashCommand) => string;
}

/**
 * `/` slash-command menu: filtering, keyboard navigation state, and selection.
 *
 * The composer keeps the keydown orchestration (arrow keys / Enter / Escape)
 * because it also juggles the mention menu and history recall; this composable
 * owns the menu's open/items/active state, the filter logic, and what happens
 * when an item is chosen.
 */
export function useSlashMenu(deps: SlashMenuDeps) {
  const { text, editorRef, skills, emitCommand, historyPush, clearDraft, resolveDesc } = deps;

  const open = ref(false);
  const items = ref<SlashCommand[]>([]);
  const ranges = ref<SlashMatchRanges[]>([]);
  const active = ref(0);

  function update(): void {
    const val = text.value;
    // Open on any single `/token` — even with zero matches, so the menu can
    // show its empty state instead of silently staying shut. Any whitespace
    // (a pasted newline or Tab) means real text, not a command token.
    if (/^\/\S*$/.test(val)) {
      // Built-in commands + the active session's skills (shown as /<skill-name>).
      const matches = filterCommandMatches(val, buildSlashItems(skills()), resolveDesc);
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
    // Menu-selected bare commands (e.g. /model, /login) reach here directly and
    // never go through handleSubmit, so record them for recall too. acceptsInput
    // commands are pushed later by handleSubmit together with their argument.
    historyPush(item.name);
    emitCommand(item.name);
  }

  return { open, items, ranges, active, update, select };
}
