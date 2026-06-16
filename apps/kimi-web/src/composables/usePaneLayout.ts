import { ref } from 'vue';
import type { PaneKey } from '../types';

export type PaneGroup = {
  type: 'group';
  id: string;
  views: PaneKey[];
  active: PaneKey;
};

export type PaneSplit = {
  type: 'split';
  id: string;
  dir: 'row' | 'col';
  children: PaneLayout[];
  sizes: number[];
};

export type PaneLayout = PaneGroup | PaneSplit;

const STORAGE_KEY = 'kimi-web.layout';
// Default tab set for a group. 'preview' is intentionally NOT here — it's a
// transient view added to a group only while a file/media preview is open, so
// groups don't show an empty "Preview" tab the rest of the time.
const ALL_VIEWS: PaneKey[] = ['chat', 'files'];

function nextId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function defaultGroup(active: PaneKey = 'chat'): PaneGroup {
  return { type: 'group', id: nextId('group'), views: [...ALL_VIEWS], active };
}

function isPaneKey(value: unknown): value is PaneKey {
  return (
    value === 'chat' ||
    value === 'files' ||
    value === 'tasks' ||
    value === 'todo' ||
    value === 'terminal' ||
    value === 'preview' ||
    value === 'btw'
  );
}

function isTabView(value: PaneKey): value is 'chat' | 'files' {
  return value === 'chat' || value === 'files';
}

/** First group id in the tree (depth-first), or null for an empty tree. */
function firstGroupId(node: PaneLayout): string | null {
  if (node.type === 'group') return node.id;
  for (const child of node.children) {
    const id = firstGroupId(child);
    if (id) return id;
  }
  return null;
}

/** Whether any group already hosts the 'preview' view. */
function hasPreviewGroup(node: PaneLayout): boolean {
  if (node.type === 'group') return node.views.includes('preview');
  return node.children.some(hasPreviewGroup);
}

/** Whether any group already hosts the 'btw' view. */
function hasBtwGroup(node: PaneLayout): boolean {
  if (node.type === 'group') return node.views.includes('btw');
  return node.children.some(hasBtwGroup);
}

function normalizeLayout(raw: unknown): PaneLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as Record<string, unknown>;
  if (node['type'] === 'group') {
    // Drop the transient 'preview' view on reload — its content isn't persisted,
    // so a restored preview pane would be empty. A preview-only group collapses
    // away entirely (return null) so the split that hosted it folds back.
    const rawViews = Array.isArray(node['views']) ? node['views'].filter(isPaneKey) : ALL_VIEWS;
    const views = rawViews.filter(isTabView);
    if (rawViews.length > 0 && views.length === 0) return null;
    const rawActive = isPaneKey(node['active']) ? node['active'] : 'chat';
    const active = isTabView(rawActive) ? rawActive : 'chat';
    return {
      type: 'group',
      id: typeof node['id'] === 'string' ? node['id'] : nextId('group'),
      views: views.length > 0 ? [...new Set(views)] : [...ALL_VIEWS],
      active,
    };
  }
  if (node['type'] === 'split') {
    const children = Array.isArray(node['children'])
      ? node['children'].map(normalizeLayout).filter((item): item is PaneLayout => item !== null)
      : [];
    if (children.length === 0) return null;
    if (children.length === 1) return children[0]!;
    const sizes = Array.isArray(node['sizes']) && node['sizes'].length === children.length
      ? node['sizes'].map((size) => typeof size === 'number' && Number.isFinite(size) ? size : 1)
      : children.map(() => 1);
    return {
      type: 'split',
      id: typeof node['id'] === 'string' ? node['id'] : nextId('split'),
      dir: node['dir'] === 'col' ? 'col' : 'row',
      children,
      sizes,
    };
  }
  return null;
}

function loadLayout(): PaneLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeLayout(JSON.parse(raw)) ?? defaultGroup();
  } catch {
    // ignore
  }
  return defaultGroup();
}

function saveLayout(layout: PaneLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // ignore
  }
}

function updateGroup(layout: PaneLayout, groupId: string, fn: (group: PaneGroup) => PaneLayout): PaneLayout {
  if (layout.type === 'group') return layout.id === groupId ? fn(layout) : layout;
  return {
    ...layout,
    children: layout.children.map((child) => updateGroup(child, groupId, fn)),
  };
}

function removeGroup(layout: PaneLayout, groupId: string): PaneLayout {
  if (layout.type === 'group') return layout;
  const children = layout.children
    .filter((child) => child.type !== 'group' || child.id !== groupId)
    .map((child) => removeGroup(child, groupId));
  if (children.length === 1) return children[0]!;
  return {
    ...layout,
    children,
    sizes: children.map((_, index) => layout.sizes[index] ?? 1),
  };
}

function countGroups(layout: PaneLayout): number {
  if (layout.type === 'group') return 1;
  return layout.children.reduce((sum, child) => sum + countGroups(child), 0);
}

export function usePaneLayout() {
  const layout = ref<PaneLayout>(loadLayout());

  function commit(next: PaneLayout): void {
    layout.value = next;
    saveLayout(next);
  }

  function setActive(groupId: string, active: PaneKey): void {
    commit(updateGroup(layout.value, groupId, (group) => ({
      ...group,
      views: group.views.includes(active) ? group.views : [...group.views, active],
      active,
    })));
  }

  function removeView(groupId: string, pane: PaneKey): void {
    commit(updateGroup(layout.value, groupId, (group) => {
      if (!group.views.includes(pane)) return group;
      const views = group.views.filter((v) => v !== pane);
      return {
        ...group,
        views,
        active: group.active === pane ? (views[0] ?? 'chat') : group.active,
      };
    }));
  }

  function split(groupId: string, dir: 'row' | 'col'): void {
    commit(updateGroup(layout.value, groupId, (group) => ({
      type: 'split',
      id: nextId('split'),
      dir,
      children: [group, defaultGroup(group.active === 'files' ? 'chat' : 'files')],
      sizes: [1, 1],
    })));
  }

  function close(groupId: string): void {
    if (countGroups(layout.value) <= 1) return;
    commit(removeGroup(layout.value, groupId));
  }

  function resize(splitId: string, sizes: number[]): void {
    function visit(node: PaneLayout): PaneLayout {
      if (node.type === 'group') return node;
      if (node.id === splitId) return { ...node, sizes };
      return { ...node, children: node.children.map(visit) };
    }
    commit(visit(layout.value));
  }

  function reset(): void {
    commit(defaultGroup());
  }

  /** Open (or focus) a 'preview' pane at the chat/files level. If no preview
      group exists yet, split the first group and give the new one a 'preview'
      view; otherwise just make the existing preview group active. */
  function openPreview(): void {
    if (hasPreviewGroup(layout.value)) {
      commit(
        mapGroups(layout.value, (group) =>
          group.views.includes('preview') ? { ...group, active: 'preview' } : group,
        ),
      );
      return;
    }
    const targetId = firstGroupId(layout.value);
    if (!targetId) {
      commit({ type: 'group', id: nextId('group'), views: ['preview'], active: 'preview' });
      return;
    }
    commit(
      updateGroup(layout.value, targetId, (group) => ({
        type: 'split',
        id: nextId('split'),
        dir: 'row',
        children: [group, { type: 'group', id: nextId('group'), views: ['preview'], active: 'preview' }],
        sizes: [1, 1],
      })),
    );
  }

  /** Close any preview pane: a preview-only group collapses its split; a group
      that also holds other views just switches away from preview. */
  function closePreview(): void {
    if (!hasPreviewGroup(layout.value)) return;
    let next = layout.value;
    // Collapse preview-only groups (they exist only for the preview).
    const previewOnlyIds: string[] = [];
    function collect(node: PaneLayout): void {
      if (node.type === 'group') {
        if (node.views.length === 1 && node.views[0] === 'preview') previewOnlyIds.push(node.id);
      } else {
        node.children.forEach(collect);
      }
    }
    collect(next);
    for (const id of previewOnlyIds) next = removeGroup(next, id);
    // Any remaining group still listing 'preview' (mixed group) drops it.
    next = mapGroups(next, (group) =>
      group.views.includes('preview')
        ? {
            ...group,
            views: group.views.filter((v) => v !== 'preview'),
            active: group.active === 'preview' ? 'chat' : group.active,
          }
        : group,
    );
    commit(next);
  }

  /** Open (or focus) a 'btw' side-chat pane as a split next to the main group.
      Like preview, it lives in its own transient group and is not persisted. */
  function openBtw(): void {
    if (hasBtwGroup(layout.value)) {
      commit(
        mapGroups(layout.value, (group) =>
          group.views.includes('btw') ? { ...group, active: 'btw' } : group,
        ),
      );
      return;
    }
    const targetId = firstGroupId(layout.value);
    if (!targetId) {
      commit({ type: 'group', id: nextId('group'), views: ['btw'], active: 'btw' });
      return;
    }
    commit(
      updateGroup(layout.value, targetId, (group) => ({
        type: 'split',
        id: nextId('split'),
        dir: 'row',
        children: [group, { type: 'group', id: nextId('group'), views: ['btw'], active: 'btw' }],
        sizes: [1, 1],
      })),
    );
  }

  /** Close any btw pane: a btw-only group collapses its split; a mixed group
      just switches away from 'btw'. */
  function closeBtw(): void {
    if (!hasBtwGroup(layout.value)) return;
    let next = layout.value;
    const btwOnlyIds: string[] = [];
    function collect(node: PaneLayout): void {
      if (node.type === 'group') {
        if (node.views.length === 1 && node.views[0] === 'btw') btwOnlyIds.push(node.id);
      } else {
        node.children.forEach(collect);
      }
    }
    collect(next);
    for (const id of btwOnlyIds) next = removeGroup(next, id);
    next = mapGroups(next, (group) =>
      group.views.includes('btw')
        ? {
            ...group,
            views: group.views.filter((v) => v !== 'btw'),
            active: group.active === 'btw' ? 'chat' : group.active,
          }
        : group,
    );
    commit(next);
  }

  return { layout, setActive, removeView, split, close, resize, reset, openPreview, closePreview, openBtw, closeBtw };
}

/** Apply `fn` to every group in the tree. */
function mapGroups(layout: PaneLayout, fn: (group: PaneGroup) => PaneGroup): PaneLayout {
  if (layout.type === 'group') return fn(layout);
  return { ...layout, children: layout.children.map((child) => mapGroups(child, fn)) };
}
