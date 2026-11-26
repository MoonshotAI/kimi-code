import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareCounts } from './ratchet.mjs';
import { countBoundaries, extractImports, findRuntimeCycles, formatReport, isCheckedFile, packageOfFile } from './app-boundaries.mjs';

const CHAT_PANE = 'packages/app-components/src/chat/ChatPane.vue';
const MARKDOWN = 'packages/app-markdown/src/Markdown.vue';
const TOAST_TYPES = 'packages/app-ui/src/components/ui/toastTypes.ts';
const SESSIONS_STORE = 'packages/app-client/src/stores/sessions.ts';
const WORKSPACES_STORE = 'packages/app-client/src/stores/workspaces.ts';
const PINIA_STORE = 'packages/app-client/src/stores/pinia.ts';
const MENU = 'apps/desktop/src/main/shell/menu.ts';
const BROWSER_TAB = 'apps/desktop/src/renderer/components/browser/PanelBrowserTab.vue';
const CONVERSATION = 'apps/desktop/src/renderer/components/chat/ConversationPane.vue';

function measure(sources) {
  const files = Object.keys(sources).toSorted();
  return countBoundaries({
    files,
    readText: (file) => sources[file],
    resolveTarget: (specifier, fromFile) => {
      if (!specifier.startsWith('.')) {
        const match = /^(@moonshot-ai\/(app-[a-z]+))(\/[^'"]*)?$/.exec(specifier);
        return match ? { targetPkg: match[2] } : undefined;
      }
      const fromDir = fromFile.split('/').slice(0, -1);
      const parts = [...fromDir, ...specifier.split('/')];
      const normalized = [];
      for (const part of parts) {
        if (part === '' || part === '.') continue;
        if (part === '..') normalized.pop();
        else normalized.push(part);
      }
      const base = normalized.join('/');
      const targetFile = [`${base}.ts`, `${base}.vue`, `${base}/index.ts`, base].find((candidate) => candidate in sources);
      return targetFile === undefined ? undefined : { targetFile, targetPkg: packageOfFile(targetFile) };
    },
  });
}

await test('isCheckedFile scopes the check to Desktop and app-* production sources', () => {
  assert.equal(isCheckedFile(CHAT_PANE), true);
  assert.equal(isCheckedFile('apps/desktop/src/main/browser/browser-view.ts'), true);
  assert.equal(isCheckedFile('packages/app-ui/src/components/ui/Icon.vue'), true);
  assert.equal(isCheckedFile('packages/app-client/src/client/deps.ts'), true);
  assert.equal(isCheckedFile('packages/app-client/src/testing/workspaceRig.ts'), false);
  assert.equal(isCheckedFile('packages/app-client/test/app-dialogs.test.ts'), false);
  assert.equal(isCheckedFile('packages/app-components/src/chat/historyState.test.ts'), false);
  assert.equal(isCheckedFile('packages/app-core/src/api/types.d.ts'), false);
  assert.equal(isCheckedFile('apps/desktop/e2e/core-turn.spec.ts'), false);
  assert.equal(isCheckedFile('packages/core/src/loop.ts'), false);
  assert.equal(isCheckedFile('scripts/checks/app-boundaries.mjs'), false);
});

await test('extractImports distinguishes runtime edges from type-only imports and exports', () => {
  const imports = extractImports(
    'packages/app-components/src/a.ts',
    [
      'import type { A } from "./a";',
      'import { type B } from "./b";',
      'import { type C, runC } from "./c";',
      'import def from "./d";',
      'import "./side-effect";',
      'export type { E } from "./e";',
      'export { type F } from "./f";',
      'export { g } from "./g";',
      'export * from "./h";',
      'const lazy = () => import("./i");',
    ].join('\n'),
  );
  assert.deepEqual(imports, [
    { specifier: './a', typeOnly: true },
    { specifier: './b', typeOnly: true },
    { specifier: './c', typeOnly: false },
    { specifier: './d', typeOnly: false },
    { specifier: './side-effect', typeOnly: false },
    { specifier: './e', typeOnly: true },
    { specifier: './f', typeOnly: true },
    { specifier: './g', typeOnly: false },
    { specifier: './h', typeOnly: false },
    { specifier: './i', typeOnly: false },
  ]);
});

await test('extractImports reads every Vue script block and ignores template text', () => {
  const vue = [
    '<template><div>import fake from "./template-only"</div></template>',
    '<script lang="ts">import { a } from "./a";</script>',
    '<script setup lang="ts">import { b } from "./b";</script>',
  ].join('\n');
  assert.deepEqual(extractImports(CHAT_PANE, vue), [
    { specifier: './a', typeOnly: false },
    { specifier: './b', typeOnly: false },
  ]);
});

await test('self-package imports count while relative sibling imports do not', () => {
  const counts = measure({
    [CHAT_PANE]: '<script setup lang="ts">import { turnBlocks } from "@moonshot-ai/app-components";\nimport { helper } from "./helper";</script>',
    'packages/app-components/src/chat/helper.ts': 'export const helper = 1;',
  });
  assert.deepEqual(counts, { 'self-package-import': { [CHAT_PANE]: 1 } });
});

await test('lower-level packages and main/shared processes cannot import upper-level packages', () => {
  const counts = measure({
    [MARKDOWN]: '<script setup lang="ts">import { overlayScrollbarThumb } from "@moonshot-ai/app-client/composables";\nimport { Icon } from "@moonshot-ai/app-ui";</script>',
    [TOAST_TYPES]: 'import type { AppNoticeDetail } from "@moonshot-ai/app-core/api";\nimport { copyTextToClipboard } from "@moonshot-ai/app-core/lib";',
    [MENU]: 'import { Composer } from "@moonshot-ai/app-components";',
    'apps/desktop/src/shared/browser-panel-state.ts': 'import type { BrowserPanelSession } from "@moonshot-ai/app-core/browser-panel-state";',
    [CHAT_PANE]: '<script setup lang="ts">import { useKimiWebClient } from "@moonshot-ai/app-client/client";\nimport { formatTokens } from "@moonshot-ai/app-core/lib";</script>',
  });
  assert.deepEqual(counts, {
    'upward-package-import': {
      [MARKDOWN]: 1,
      [TOAST_TYPES]: 1,
      [MENU]: 1,
    },
  });
});

await test('stores cannot import each other, while stores/index.ts, stores/pinia.ts and client readers are exempt', () => {
  const counts = measure({
    [SESSIONS_STORE]: 'import { clientPinia } from "./pinia";\nimport { workspacesStore } from "./workspaces";',
    [WORKSPACES_STORE]: 'export const workspacesStore = () => ({});',
    [PINIA_STORE]: 'export const clientPinia = {};',
    'packages/app-client/src/stores/index.ts': 'export { useSessionsStore } from "./sessions";\nexport { useWorkspacesStore } from "./workspaces";',
    'packages/app-client/src/client/useKimiWebClient.ts': 'import { sessionsStore } from "../stores/sessions";',
  });
  assert.deepEqual(counts, { 'store-cross-import': { [SESSIONS_STORE]: 1 } });
});

await test('a store importing the stores barrel still forms a runtime cycle with that barrel', () => {
  const counts = measure({
    [SESSIONS_STORE]: 'import "../stores/index";',
    'packages/app-client/src/stores/index.ts': 'export { useSessionsStore } from "./sessions";',
  });
  assert.deepEqual(counts, {
    'runtime-cycle': {
      [SESSIONS_STORE]: 2,
      'packages/app-client/src/stores/index.ts': 2,
    },
  });
});

await test('non-browser Vue components calling API accessors, fetch or IPC bridges directly count', () => {
  const counts = measure({
    [CONVERSATION]: [
      '<script setup lang="ts">',
      'const api = getKimiWebApi();',
      'window.kimiDesktop?.show();',
      '</script>',
    ].join('\n'),
    'packages/app-components/src/chat/AuthMedia.vue': '<script setup lang="ts">await fetch(url); model.fetch(input);</script>',
    [BROWSER_TAB]: '<script setup lang="ts">window.kimiDesktop?.browserFocus(id); fetch(url);</script>',
  });
  assert.deepEqual(counts, {
    'view-direct-api': {
      [CONVERSATION]: 1,
      'packages/app-components/src/chat/AuthMedia.vue': 1,
    },
    'view-direct-ipc': {
      [CONVERSATION]: 1,
    },
  });
});

await test('runtime cycles record cycle size per member and ignore type-only back edges', () => {
  const cyclic = measure({
    'apps/desktop/src/main/a.ts': 'import { b } from "./b"; export const a = () => b();',
    'apps/desktop/src/main/b.ts': 'import { c } from "./c"; export const b = () => c();',
    'apps/desktop/src/main/c.ts': 'import { a } from "./a"; export const c = () => a();',
  });
  assert.deepEqual(cyclic, {
    'runtime-cycle': {
      'apps/desktop/src/main/a.ts': 3,
      'apps/desktop/src/main/b.ts': 3,
      'apps/desktop/src/main/c.ts': 3,
    },
  });

  const typeOnly = measure({
    'apps/desktop/src/main/a.ts': 'import { b } from "./b"; export const a = () => b();',
    'apps/desktop/src/main/b.ts': 'import { c } from "./c"; export const b = () => c();',
    'apps/desktop/src/main/c.ts': 'import type { a } from "./a"; export const c = () => 1;',
  });
  assert.deepEqual(typeOnly, {});
});

await test('findRuntimeCycles sorts cycles by size and breaks ties deterministically', () => {
  const edges = new Map([
    ['a.ts', ['b.ts']],
    ['b.ts', ['a.ts']],
    ['c.ts', ['d.ts']],
    ['d.ts', ['e.ts']],
    ['e.ts', ['c.ts']],
  ]);
  assert.deepEqual(findRuntimeCycles(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], edges), [
    ['c.ts', 'd.ts', 'e.ts'],
    ['a.ts', 'b.ts'],
  ]);
});

await test('formatReport explains new violations and asks to lower the baseline when violations shrink', () => {
  const baseline = { 'store-cross-import': { [SESSIONS_STORE]: 1 } };
  const added = formatReport(compareCounts(baseline, { 'store-cross-import': { [SESSIONS_STORE]: 2 } })).join('\n');
  assert.match(added, /new Desktop \/ app-\* boundary violations/);
  assert.match(added, /store-cross-import in packages\/app-client\/src\/stores\/sessions\.ts: 1 → 2/);
  assert.match(added, /compose them in business hooks/);
  const removed = formatReport(compareCounts(baseline, {})).join('\n');
  assert.match(removed, /allows more violations than the code has/);
  assert.match(removed, /app-boundaries\.mjs --update/);
  assert.deepEqual(formatReport(compareCounts(baseline, baseline)), []);
});
