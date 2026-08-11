<!-- apps/web/src/components/SessionEmojiPicker.vue -->
<!-- Session emoji picker popover (SessionRow's "Set Emoji…" entry / title emoji
     click): bare search row → scrollable sections (Recently used from
     localStorage, cap 8 → the grouped dataset) → MenuItem footer. -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, Menu, MenuItem, useImeComposition } from '@moonshot-ai/app-ui';
import {
  EMOJI_ENTRIES,
  EMOJI_GROUPS,
  pushRecentEmoji,
  searchEmojis,
  type EmojiGroup,
} from '@moonshot-ai/app-core/lib';

const { t } = useI18n();

// IME guard: Enter that only confirms a composition candidate must not pick.
const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

const props = withDefaults(
  defineProps<{
    current?: string | null;
    /** False when the title is emoji-only: removing would leave an empty title. */
    removable?: boolean;
  }>(),
  { current: null, removable: true },
);
const emit = defineEmits<{ pick: [emoji: string | null] }>();

// Random's pool: a small curated set of safe bets (all round-trip through
// splitSessionEmoji's conservative detection).
const RANDOM_POOL = [
  '⏳', '⚠️', '🐛', '✨', '🔥', '🚀', '🎯', '🧪',
  '📝', '🔍', '🛠️', '💡', '📦', '🎨', '🔒', '📈',
  '🧹', '🚧', '✅', '❓', '🌙', '☕', '🐳', '🗂️',
  '📊', '🤖', '🧩', '⚙️', '🌱', '📌', '💥', '🕐',
];

const GROUP_LABEL_KEY: Record<EmojiGroup, string> = {
  faces: 'sidebar.emojiGroupFaces',
  nature: 'sidebar.emojiGroupNature',
  food: 'sidebar.emojiGroupFood',
  activity: 'sidebar.emojiGroupActivity',
  objects: 'sidebar.emojiGroupObjects',
  symbols: 'sidebar.emojiGroupSymbols',
};
const grouped = EMOJI_GROUPS.map((id) => ({
  id,
  labelKey: GROUP_LABEL_KEY[id],
  emojis: EMOJI_ENTRIES.filter((e) => e.group === id).map((e) => e.emoji),
}));

const STORAGE_KEY = 'kimi-web.recent-emojis';
const recents = ref<string[]>(readRecents());
function readRecents(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

function onPick(emoji: string): void {
  recents.value = pushRecentEmoji(recents.value, emoji);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recents.value));
  } catch {
    // Quota / private mode: recents just don't persist.
  }
  emit('pick', emoji);
}

const query = ref('');
const searching = computed(() => query.value.trim().length > 0);
const results = computed(() => searchEmojis(query.value));

const inputRef = ref<HTMLInputElement | null>(null);
onMounted(() => inputRef.value?.focus());

// Enter picks the first search result.
function onEnter(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) return;
  const first = results.value[0];
  if (searching.value && first) onPick(first);
}

function pickRandom(): void {
  let next: string | undefined = props.current ?? undefined;
  while (next === undefined || next === props.current) {
    next = RANDOM_POOL[Math.floor(Math.random() * RANDOM_POOL.length)];
  }
  onPick(next);
}

// Mirror Menu/IconButton's exposed-el pattern so the consumer can outside-click
// against the panel (positioning is left to the consumer, same as Menu); the
// IME guard is shared for the consumer's Escape handling (Safari reports
// isComposing=false on the candidate-cancelling Escape).
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
defineExpose({ el: computed(() => menuRef.value?.el), isComposingKeyEvent });
</script>

<template>
  <Menu ref="menuRef" class="emoji-picker" role="dialog" :aria-label="t('sidebar.sessionEmojiTitle')" @keydown.stop>
    <div class="ep-search">
      <Icon name="search" size="sm" />
      <input
        ref="inputRef"
        v-model="query"
        class="ep-input"
        type="text"
        :placeholder="t('sidebar.searchEmoji')"
        autocomplete="off"
        spellcheck="false"
        @keydown.enter="onEnter"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
      />
    </div>

    <div class="ep-scroll">
      <template v-if="searching">
        <div v-if="results.length" class="ep-grid">
          <button
            v-for="e in results"
            :key="e"
            class="ep-e"
            :class="{ sel: e === current }"
            type="button"
            @click="onPick(e)"
          >{{ e }}</button>
        </div>
        <div v-else class="ep-empty">{{ t('sidebar.noEmojiResults') }}</div>
      </template>

      <template v-else>
        <template v-if="recents.length">
          <div class="ep-label">{{ t('sidebar.recentEmojis') }}</div>
          <div class="ep-grid">
            <button
              v-for="e in recents"
              :key="e"
              class="ep-e"
              :class="{ sel: e === current }"
              type="button"
              @click="onPick(e)"
            >{{ e }}</button>
          </div>
        </template>
        <template v-for="g in grouped" :key="g.id">
          <div class="ep-label">{{ t(g.labelKey) }}</div>
          <div class="ep-grid">
            <button
              v-for="e in g.emojis"
              :key="e"
              class="ep-e"
              :class="{ sel: e === current }"
              type="button"
              @click="onPick(e)"
            >{{ e }}</button>
          </div>
        </template>
      </template>
    </div>

    <MenuItem separator />
    <MenuItem role="button" :disabled="!(current && removable)" @click="emit('pick', null)">
      <Icon name="close" size="sm" />
      {{ t('sidebar.removeEmoji') }}
    </MenuItem>
    <MenuItem role="button" @click="pickRandom">
      <Icon name="sparkles" size="sm" />
      {{ t('sidebar.randomEmoji') }}
    </MenuItem>
  </Menu>
</template>

<style scoped>
/* Cell size drives every picker metric (matches the IconButton-sm footprint):
   8-column grid + derived input height, scroll height and panel width. */
.emoji-picker { --ep-cell: 26px; }
/* Bare list-style search row (the sidebar Search vocabulary): icon + input,
   no border; the row shows a sunken wash on hover / focus-within. */
.ep-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-1);
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--color-text-faint);
}
.ep-search:hover,
.ep-search:focus-within { background: var(--color-surface-sunken); }
.ep-input {
  flex: 1;
  min-width: 0;
  height: calc(var(--ep-cell) + 2px);
  font-size: var(--text-sm);
  color: var(--color-text);
  background: transparent;
  border: none;
  outline: none;
}
.ep-input::placeholder { color: var(--color-text-faint); }
.ep-scroll { max-height: calc(var(--ep-cell) * 10 + var(--space-1)); overflow-y: auto; padding: 0 var(--space-1); }
/* Section labels — the .side-section-label recipe (xs / 600 / uppercase / faint). */
.ep-label {
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-xs);
  font-weight: var(--weight-section-label);
  text-transform: uppercase;
  color: var(--color-text-faint);
  user-select: none;
}
.ep-grid { display: grid; grid-template-columns: repeat(8, var(--ep-cell)); gap: var(--space-1); padding-bottom: var(--space-1); }
.ep-e {
  height: var(--ep-cell);
  display: grid;
  place-items: center;
  padding: 0;
  font-size: var(--text-lg);
  background: transparent;
  border: none;
  border-radius: var(--radius-xs);
  cursor: pointer;
}
.ep-e:hover { background: var(--color-hover); }
.ep-e:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.ep-e.sel { background: var(--color-accent-soft); }
.ep-empty {
  padding: var(--space-3) var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  text-align: center;
  user-select: none;
}
</style>
