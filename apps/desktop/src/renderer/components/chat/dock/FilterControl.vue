<!-- apps/web/src/components/chat/dock/FilterControl.vue -->
<!-- Panel-head task filter: a SegmentedControl while the head has room, a
     dropdown menu once the title plus the chips would overflow — so the head
     title is never squeezed into wrapping. The switch is measured on the
     head element (panel width, not the viewport). The dropdown teleports to
     <body> and positions itself from the trigger: the panel clips and
     captures its descendants (overflow + backdrop-filter), so an in-panel
     menu would be squeezed by the container. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';
import { Icon, Menu, MenuItem, Pill, SegmentedControl, openDialogCount } from '@moonshot-ai/app-ui';

const props = defineProps<{
  modelValue: string;
  options: { value: string; label: string; icon?: string }[];
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const current = computed(() => props.options.find((o) => o.value === props.modelValue));
// Touch rows (≥44px) when the device can't hover; desktop keeps md rows.
const menuRowSize =
  typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches ? 'lg' : 'md';

// ---------------------------------------------------------------------------
// Responsive switch: segmented control ↔ dropdown.
// ---------------------------------------------------------------------------
const root = ref<HTMLElement | null>(null);
const compact = ref(false);
let segWidth = 0;
let resizeObserver: ResizeObserver | null = null;

async function recheck(): Promise<void> {
  const head = root.value?.closest('.dock-work-head') as HTMLElement | null;
  if (!head) return;
  const tab = head.querySelector('.wp-head-tab') as HTMLElement | null;
  const cs = getComputedStyle(head);
  const gaps = (parseFloat(cs.columnGap) || 0) * 2;
  const available = head.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - gaps;
  const tabWidth = tab?.scrollWidth ?? 0;
  if (!compact.value) {
    const seg = root.value?.querySelector('.ui-seg') as HTMLElement | null;
    if (seg !== null && seg.offsetWidth > 0) segWidth = seg.offsetWidth;
  }
  // In compact mode the remembered seg width keeps the threshold stable (no
  // flip-flopping at the boundary).
  const nextCompact = tabWidth + segWidth > available;
  compact.value = nextCompact;
  if (!nextCompact) {
    // Flipping back to the segmented control: measure it once it is actually
    // on the DOM — its width may have changed (locale), and the head's
    // ResizeObserver won't fire when its own width didn't change.
    await nextTick();
    const seg = root.value?.querySelector('.ui-seg') as HTMLElement | null;
    if (seg !== null && seg.offsetWidth > 0) segWidth = seg.offsetWidth;
    compact.value = tabWidth + segWidth > available;
  }
}

onMounted(() => {
  const head = root.value?.closest('.dock-work-head');
  if (!head || typeof ResizeObserver !== 'function') return;
  resizeObserver = new ResizeObserver(recheck);
  resizeObserver.observe(head);
  recheck();
});

// Leaving compact mode unmounts the trigger and menu in place — close
// first so the open state and the window listeners never leak.
watch(compact, (isCompact) => {
  if (!isCompact && open.value) closeMenu();
});

// A modal layer (settings, login, …) outranks the menu: close before its
// Escape reaches our window listener (which would otherwise swallow the
// dialog's first Escape).
watch(openDialogCount, (count) => {
  if (count > 0 && open.value) closeMenu();
});

// Labels change with locale (and chip count with the design) — re-measure.
watch(
  () => props.options,
  async () => {
    segWidth = 0;
    // Measure after the DOM carries the new labels; a pre-flush read would
    // measure the old ones, and the head's ResizeObserver won't fire when
    // its own width is unchanged.
    await nextTick();
    recheck();
  },
  { flush: 'post' },
);

// ---------------------------------------------------------------------------
// Compact dropdown (teleported to body).
// ---------------------------------------------------------------------------
const open = ref(false);
const triggerRef = ref<ComponentPublicInstance | null>(null);
// The Pill's root element — menu anchoring and focus restore.
function triggerEl(): HTMLElement | null {
  return (triggerRef.value?.$el as HTMLElement | undefined) ?? null;
}
const menuBoxRef = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({ left: '0px', top: '0px' });

async function toggleMenu(): Promise<void> {
  if (open.value) {
    closeMenu();
    return;
  }
  open.value = true;
  await nextTick();
  positionMenu();
  focusCurrentItem();
  window.addEventListener('mousedown', onWindowPointerDown, true);
  window.addEventListener('keydown', onWindowKeydown, true);
  window.addEventListener('resize', positionMenu);
  window.addEventListener('scroll', positionMenu, true);
}

function closeMenu(options?: { refocus?: boolean }): void {
  open.value = false;
  window.removeEventListener('mousedown', onWindowPointerDown, true);
  window.removeEventListener('keydown', onWindowKeydown, true);
  window.removeEventListener('resize', positionMenu);
  window.removeEventListener('scroll', positionMenu, true);
  // Keyboard closes and selections hand focus back to the trigger; outside
  // pointer presses deliberately don't (the user's click target owns focus).
  if (options?.refocus) triggerEl()?.focus();
}

function positionMenu(): void {
  const trigger = triggerEl();
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  const menuHeight = menuBoxRef.value?.offsetHeight ?? 0;
  // Spacing comes from the tokens (read as computed px so a scale change
  // cannot drift): --space-2 for the viewport gutter, --space-1 for the
  // trigger gap.
  const rootStyle = getComputedStyle(document.documentElement);
  const edge = Number.parseFloat(rootStyle.getPropertyValue('--space-2')) || 0;
  const gap = Number.parseFloat(rootStyle.getPropertyValue('--space-1')) || 0;
  // Clamp against the viewport's right edge: the menu's natural width follows
  // the LONGEST option, which the trigger's left edge alone can't guarantee.
  const menuWidth = menuBoxRef.value?.offsetWidth ?? 0;
  const left = Math.min(rect.left, Math.max(edge, window.innerWidth - menuWidth - edge));
  // Prefer opening downward; flip up when the viewport bottom is too close.
  if (rect.bottom + gap + menuHeight <= window.innerHeight - edge) {
    menuStyle.value = { left: `${left}px`, top: `${rect.bottom + gap}px` };
  } else {
    menuStyle.value = { left: `${left}px`, bottom: `${window.innerHeight - rect.top + gap}px` };
  }
}

// Keyboard open: move focus into the menu — the current option first.
function focusCurrentItem(): void {
  const box = menuBoxRef.value;
  if (!box) return;
  const active = box.querySelector<HTMLElement>('.ui-menu-item.is-active');
  (active ?? box.querySelector<HTMLElement>('.ui-menu-item'))?.focus();
}

function onTriggerArrow(): void {
  if (!open.value) void toggleMenu();
}

// Tabbing away closes the menu — the focus is moving on deliberately, so it
// is never yanked back to the trigger.
function onFocusLeave(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null;
  if (next && (menuBoxRef.value?.contains(next) || triggerEl()?.contains(next))) return;
  closeMenu();
}

function onWindowPointerDown(event: MouseEvent): void {
  const target = event.target as Node | null;
  if (!target) return;
  // Presses inside the menu are consumed HERE (window capture runs before
  // the dock's document-capture outside-press) so picking a filter never
  // dismisses the work panel underneath.
  if (menuBoxRef.value?.contains(target)) {
    event.stopImmediatePropagation();
    return;
  }
  if (triggerEl()?.contains(target)) return; // the trigger's click toggles
  closeMenu();
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  // Window capture runs before the dock panel's document-capture handler;
  // mark the key as consumed so the panel stays open (it checks
  // defaultPrevented).
  event.preventDefault();
  event.stopImmediatePropagation();
  closeMenu({ refocus: true });
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const items = Array.from(menuBoxRef.value?.querySelectorAll<HTMLElement>('.ui-menu-item') ?? []);
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === 'ArrowDown'
      ? (index + 1) % items.length
      : (index - 1 + items.length) % items.length;
  items[next]?.focus();
}

function choose(value: string): void {
  emit('update:modelValue', value);
  closeMenu({ refocus: true });
}

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  if (open.value) closeMenu();
});
</script>

<template>
  <span ref="root" class="filter-control">
    <template v-if="compact">
      <Pill
        ref="triggerRef"
        class="fc-trigger"
        aria-haspopup="menu"
        :aria-expanded="open"
        @click="toggleMenu"
        @keydown.down.prevent="onTriggerArrow"
        @keydown.up.prevent="onTriggerArrow"
        @focusout="onFocusLeave"
      >
        <Icon v-if="current?.icon" :name="current.icon" size="sm" />
        <span>{{ current?.label }}</span>
        <Icon class="fc-chevron" name="chevron-down" size="sm" />
      </Pill>
      <Teleport to="body">
        <div
          v-if="open"
          ref="menuBoxRef"
          class="fc-menu"
          :style="menuStyle"
          @keydown="onMenuKeydown"
          @focusout="onFocusLeave"
        >
          <Menu>
            <MenuItem
              v-for="opt in options"
              :key="opt.value"
              role="menuitemradio"
              :active="opt.value === modelValue"
              :aria-checked="opt.value === modelValue"
              :size="menuRowSize"
              @click="choose(opt.value)"
            >
              <Icon v-if="opt.icon" :name="opt.icon" size="sm" :data-icon="opt.icon" />
              <span class="fc-label">{{ opt.label }}</span>
              <Icon v-if="opt.value === modelValue" class="fc-check" name="check" size="sm" />
            </MenuItem>
          </Menu>
        </div>
      </Teleport>
    </template>
    <SegmentedControl
      v-else
      :model-value="modelValue"
      :options="options"
      size="md"
      @update:model-value="emit('update:modelValue', $event)"
    />
  </span>
</template>

<style scoped>
.filter-control {
  display: inline-flex;
  min-width: 0;
}
.fc-chevron {
  color: var(--color-text-faint);
  transition: transform var(--duration-base) var(--ease-out);
}
.fc-trigger[aria-expanded='true'] .fc-chevron {
  transform: rotate(180deg);
}
/* position: fixed + left/top from the trigger rect; teleported to body so
   the work panel's overflow and backdrop-filter never clip or squeeze it. */
.fc-menu {
  position: fixed;
  z-index: var(--z-dropdown);
}
.fc-menu :deep(.ui-menu) {
  min-width: 0;
}
.fc-label {
  flex: 1;
  white-space: nowrap;
}
/* circle-check is drawn full-bleed for the todo rows' ring family — scale it
   onto the shared 24-grid so the chips/menu read as one set. */
.filter-control :deep(.ui-seg__item[data-icon='circle-check'] .ui-seg__icon),
.fc-menu .kw-icon[data-icon='circle-check'] {
  transform: scale(0.91);
}
.fc-check {
  color: var(--color-accent);
}
</style>
