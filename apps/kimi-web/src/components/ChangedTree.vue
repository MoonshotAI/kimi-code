<!-- apps/kimi-web/src/components/ChangedTree.vue -->
<!-- The changed-file set rendered as a directory TREE (GitHub PR "file tree"
     style), built purely from the change paths — no lazy loading, the whole set
     is known up front. Single-child directory chains are collapsed (src/api/x).
     Tapping a file emits `open(path)` so the parent loads its diff. -->
<script setup lang="ts">
import { computed, reactive } from 'vue';

const props = defineProps<{
  changes: { path: string; status: string }[];
}>();

const emit = defineEmits<{ open: [path: string] }>();

// ---- status badge (same vocabulary as DiffView / FileTree) ----
type BadgeKind =
  | 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  | 'conflicted' | 'ignored' | 'clean' | 'unknown';

function badgeKind(s: string): BadgeKind {
  const lower = s.toLowerCase();
  const known: BadgeKind[] = [
    'modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted', 'ignored', 'clean',
  ];
  return (known as string[]).includes(lower) ? (lower as BadgeKind) : 'unknown';
}
const BADGE_GLYPH: Record<BadgeKind, string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U',
  conflicted: 'C', ignored: 'I', clean: '·', unknown: '?',
};

// ---- build a collapsed directory tree from the change paths ----
interface DirNode {
  kind: 'dir';
  name: string; // possibly a collapsed "a/b/c"
  path: string; // full directory path (for expand state)
  dirs: DirNode[];
  files: { name: string; path: string; status: string }[];
}

function emptyDir(name: string, path: string): DirNode {
  return { kind: 'dir', name, path, dirs: [], files: [] };
}

const tree = computed<DirNode>(() => {
  const root = emptyDir('', '');
  for (const ch of props.changes) {
    const parts = ch.path.split('/').filter(Boolean);
    let cur = root;
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      acc = acc ? `${acc}/${seg}` : seg;
      let next = cur.dirs.find((d) => d.path === acc);
      if (!next) {
        next = emptyDir(seg, acc);
        cur.dirs.push(next);
      }
      cur = next;
    }
    const fileName = parts[parts.length - 1] ?? ch.path;
    cur.files.push({ name: fileName, path: ch.path, status: ch.status });
  }
  collapseChains(root);
  sortDir(root);
  return root;
});

// Collapse a dir that has exactly one child dir and no files into "parent/child".
function collapseChains(node: DirNode): void {
  for (const d of node.dirs) collapseChains(d);
  for (let i = 0; i < node.dirs.length; i++) {
    let d = node.dirs[i]!;
    while (d.dirs.length === 1 && d.files.length === 0) {
      const child = d.dirs[0]!;
      d = { kind: 'dir', name: `${d.name}/${child.name}`, path: child.path, dirs: child.dirs, files: child.files };
    }
    node.dirs[i] = d;
  }
}

function sortDir(node: DirNode): void {
  node.dirs.sort((a, b) => a.name.localeCompare(b.name));
  node.files.sort((a, b) => a.name.localeCompare(b.name));
  for (const d of node.dirs) sortDir(d);
}

// ---- expand/collapse state (default expanded) ----
const collapsed = reactive<Record<string, boolean>>({});
function toggleDir(path: string): void {
  collapsed[path] = !collapsed[path];
}

// Flatten to render rows honoring collapsed state.
interface Row {
  kind: 'dir' | 'file';
  depth: number;
  name: string;
  path: string;
  status?: string;
  open?: boolean; // for dirs
}
const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  const walk = (node: DirNode, depth: number): void => {
    for (const d of node.dirs) {
      const open = !collapsed[d.path];
      out.push({ kind: 'dir', depth, name: d.name, path: d.path, open });
      if (open) walk(d, depth + 1);
    }
    for (const f of node.files) {
      out.push({ kind: 'file', depth, name: f.name, path: f.path, status: f.status });
    }
  };
  walk(tree.value, 0);
  return out;
});
</script>

<template>
  <div class="changed-tree" role="tree">
    <button
      v-for="row in rows"
      :key="row.kind + ':' + row.path"
      type="button"
      class="ct-row"
      :class="row.kind"
      :style="{ paddingLeft: 8 + row.depth * 14 + 'px' }"
      :title="row.path"
      @click="row.kind === 'dir' ? toggleDir(row.path) : emit('open', row.path)"
    >
      <template v-if="row.kind === 'dir'">
        <span class="ct-chevron" :class="{ open: row.open }" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4" /></svg>
        </span>
        <span class="ct-dirname">{{ row.name }}</span>
      </template>
      <template v-else>
        <span class="ct-spacer" aria-hidden="true"></span>
        <span class="badge" :class="badgeKind(row.status!)">{{ BADGE_GLYPH[badgeKind(row.status!)] }}</span>
        <span class="ct-fname">{{ row.name }}</span>
      </template>
    </button>
  </div>
</template>

<style scoped>
.changed-tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg);
  font-family: var(--mono);
  padding: 4px 0;
  user-select: none;
}
.ct-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  color: inherit;
  padding: 4px 12px 4px 8px;
  font-size: 14px;
  line-height: 1.5;
}
.ct-row:hover { background: var(--panel2, #f5f6f8); }
.ct-row:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
.ct-chevron {
  flex: none;
  width: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--faint);
  transition: transform 0.12s;
}
.ct-chevron.open { transform: rotate(90deg); }
.ct-dirname { color: var(--dim); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ct-spacer { flex: none; width: 12px; }
.ct-fname { color: var(--ink); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

/* status badge (matches DiffView) */
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 2px;
  font-size: 10px;
  font-weight: 700;
  flex: none;
}
.badge.modified  { background: #e8f0fe; color: #1565C0; }
.badge.added     { background: #e6f4ea; color: #1e7e34; }
.badge.deleted   { background: #fce8e6; color: #c5221f; }
.badge.renamed   { background: #fef3e2; color: #b06000; }
.badge.untracked { background: var(--soft, #f0f0f5); color: var(--muted, #9098a0); }
.badge.conflicted{ background: #fce8e6; color: #c5221f; font-size: 9px; }
.badge.ignored   { background: var(--soft, #f0f0f5); color: var(--faint, #c0c5cc); }
.badge.clean     { background: transparent; color: var(--faint, #c0c5cc); }
.badge.unknown   { background: var(--soft, #f0f0f5); color: var(--muted, #9098a0); }

@media (max-width: 640px) {
  .ct-row { min-height: 40px; font-size: 13px; padding-top: 7px; padding-bottom: 7px; }
  .badge { width: 18px; height: 18px; }
}
</style>
