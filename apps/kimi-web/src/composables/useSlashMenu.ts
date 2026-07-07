// apps/kimi-web/src/composables/useSlashMenu.ts
import { nextTick, ref, type Ref } from 'vue';
import type { AppSkill } from '../api/types';
import { buildSlashItems, filterCommands, type SlashCommand } from '../lib/slashCommands';

export interface SlashMenuDeps {
  /** The live composer text — drives filtering and is rewritten on select. */
  text: Ref<string>;
  /** The textarea element, used to focus and place the caret for acceptsInput. */
  textareaRef: Ref<HTMLTextAreaElement | null>;
  /** Re-fit the textarea after its text changes. */
  autosize: () => void;
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
}

/**
 * `/` slash-command menu: filtering, keyboard navigation state, and selection.
 *
 * The composer keeps the keydown orchestration (arrow keys, Enter/Tab, Escape)
 * because it also juggles the mention menu and history recall; this composable
 * owns the menu's open/items/active state, the filter logic, and what happens
 * when an item is chosen.
 */
export function useSlashMenu(deps: SlashMenuDeps) {
  const { text, textareaRef, autosize, skills, emitCommand, historyPush, clearDraft } = deps;

  const open = ref(false);
  const items = ref<SlashCommand[]>([]);
  const active = ref(0);

  function update(): void {
    const val = text.value;
    // Only show if the value starts with `/` and has no space yet (single token).
    if (val.startsWith('/') && !val.includes(' ')) {
      // Built-in commands + the active session's skills (shown as /<skill-name>).
      items.value = filterCommands(val, buildSlashItems(skills()));
      active.value = 0;
      open.value = items.value.length > 0;
    } else {
      open.value = false;
    }
  }

  function select(item: SlashCommand): void {
    open.value = false;
    if (item.acceptsInput) {
      text.value = `${item.name} `;
      void nextTick(() => {
        const el = textareaRef.value;
        if (!el) return;
        const pos = text.value.length;
        el.setSelectionRange(pos, pos);
        el.focus();
        autosize();
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

  return { open, items, active, update, select };
}
