import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const ROOTS = ['apps/desktop/src/renderer', 'packages/app-components/src'];
const IMG_TAG = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;

function vueFiles(root: string): string[] {
  const dir = join(REPO, root);
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.vue'))
    .map((file) => join(dir, file));
}

it('renders every site icon through the Favicon primitive', () => {
  const sources = ROOTS.flatMap(vueFiles).map((file) => ({ file: relative(REPO, file).split(sep).join('/'), text: readFileSync(file, 'utf8') }));
  const rawFavicons = sources.flatMap(({ file, text }) =>
    Array.from(text.matchAll(IMG_TAG), (match) => match[0]).filter((tag) => /favicon/i.test(tag)).map((tag) => `${file}: ${tag}`));
  expect(rawFavicons).toEqual([]);
  expect(sources.filter(({ text }) => /<Favicon\b/.test(text)).map(({ file }) => file)).toEqual(expect.arrayContaining([
    'apps/desktop/src/renderer/components/browser-overlay/BrowserOverlayMenuEntry.vue',
    'apps/desktop/src/renderer/components/browser/BrowserSettingsTab.vue',
    'apps/desktop/src/renderer/components/panel/PanelTabBar.vue',
    'packages/app-components/src/chat/tool-calls/browser/BrowserSources.vue',
    'packages/app-components/src/panel/PanelTabLabel.vue',
  ]));
});
