// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue';
import { expect, it, vi } from 'vitest';
import { OpenFileLinkKey, type OpenFileLink } from '@moonshot-ai/app-core/contracts';
import ComposerText from '../../src/transcript/ComposerText.vue';
import { createComposerSnapshot, type ComposerDocumentSnapshot } from '../../src/model/snapshot';
import { textToDoc } from '../../src/model/documentCodec';

async function clickMention(openFileLink?: OpenFileLink, text = 'see [index.html](site/index.html)', snapshot?: ComposerDocumentSnapshot) {
  const host = document.createElement('div');
  document.body.append(host);
  const openFile = vi.fn();
  const app = createApp({ render: () => h(ComposerText, { text, snapshot, openFile }) });
  if (openFileLink !== undefined) app.provide(OpenFileLinkKey, openFileLink);
  app.mount(host);
  await nextTick();
  const pill = host.querySelector<HTMLElement>('[role="button"]');
  expect(pill).not.toBeNull();
  pill!.click();
  app.unmount();
  host.remove();
  return openFile;
}

it('opens a mentioned file through the host file link hook when one is provided', async () => {
  const openFileLink = vi.fn<OpenFileLink>();
  const openFile = await clickMention(openFileLink);
  expect(openFileLink).toHaveBeenCalledWith({ path: 'site/index.html' }, openFile);
  expect(openFile).not.toHaveBeenCalled();
});

it('opens a mentioned file directly without a hook', async () => {
  const openFile = await clickMention();
  expect(openFile).toHaveBeenCalledWith({ path: 'site/index.html' });
});

it('keeps the query and fragment of a mentioned HTML file link', async () => {
  const openFileLink = vi.fn<OpenFileLink>();
  const openFile = await clickMention(openFileLink, 'see [index.html](site/index.html?tab=2#intro)');
  expect(openFileLink).toHaveBeenCalledWith({ path: 'site/index.html', urlSuffix: '?tab=2#intro' }, openFile);
  expect(openFile).not.toHaveBeenCalled();
});

it('opens the file and line from a colon-suffixed file link', async () => {
  const openFileLink = vi.fn<OpenFileLink>();
  const openFile = await clickMention(openFileLink, 'see [情况.md](docs/情况.md:78)');
  expect(openFileLink).toHaveBeenCalledWith({ path: 'docs/情况.md', line: 78 }, openFile);
  expect(openFile).not.toHaveBeenCalled();
});

it('unescapes a Markdown destination after stripping its line suffix', async () => {
  const openFileLink = vi.fn<OpenFileLink>();
  const openFile = await clickMention(openFileLink, 'see [旧版](docs/foo\\(old\\).ts:78)');
  expect(openFileLink).toHaveBeenCalledWith({ path: 'docs/foo(old).ts', line: 78 }, openFile);
  expect(openFile).not.toHaveBeenCalled();
});

it('opens a bare filename with a line suffix', async () => {
  const openFileLink = vi.fn<OpenFileLink>();
  const openFile = await clickMention(openFileLink, 'see [README](README.md:78)');
  expect(openFileLink).toHaveBeenCalledWith({ path: 'README.md', line: 78 }, openFile);
  expect(openFile).not.toHaveBeenCalled();
});

it('opens a bare extensionless filename with a line suffix', async () => {
  const openFileLink = vi.fn<OpenFileLink>();
  const openFile = await clickMention(openFileLink, 'see [Makefile](Makefile:10)');
  expect(openFileLink).toHaveBeenCalledWith({ path: 'Makefile', line: 10 }, openFile);
  expect(openFile).not.toHaveBeenCalled();
});

function snapshotWithPath(path: string, name: string): ComposerDocumentSnapshot {
  return {
    version: 1,
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { kind: 'file', name, path } }] }] },
    attachments: [],
    attachmentOrder: [],
  };
}

it('opens the file and line from a snapshot mention path', async () => {
  const openFileLink = vi.fn<OpenFileLink>();
  const openFile = await clickMention(openFileLink, '', snapshotWithPath('docs/情况.md:78', '情况.md'));
  expect(openFileLink).toHaveBeenCalledWith({ path: 'docs/情况.md', line: 78 }, openFile);
  expect(openFile).not.toHaveBeenCalled();
});

it('opens an extensionless snapshot file and line', async () => {
  const openFileLink = vi.fn<OpenFileLink>();
  const openFile = await clickMention(openFileLink, '', snapshotWithPath('docs/Makefile:10', 'Makefile'));
  expect(openFileLink).toHaveBeenCalledWith({ path: 'docs/Makefile', line: 10 }, openFile);
  expect(openFile).not.toHaveBeenCalled();
});

it.each(['docs/foo.ts#L78', 'docs/foo.ts#78'])('opens a legacy snapshot hash line in $path', async (path) => {
  const openFileLink = vi.fn<OpenFileLink>();
  const openFile = await clickMention(openFileLink, '', snapshotWithPath(path, 'foo.ts'));
  expect(openFileLink).toHaveBeenCalledWith({ path: 'docs/foo.ts', line: 78 }, openFile);
  expect(openFile).not.toHaveBeenCalled();
});

it('uses the original snapshot destination when the label also has a line suffix', async () => {
  const openFileLink = vi.fn<OpenFileLink>();
  const snapshot = createComposerSnapshot(textToDoc('[foo.ts:78](docs/foo.ts:78)', { reviveMentions: true }), [], []);
  const openFile = await clickMention(openFileLink, '', snapshot);
  expect(openFileLink).toHaveBeenCalledWith({ path: 'docs/foo.ts', line: 78 }, openFile);
  expect(openFile).not.toHaveBeenCalled();
});

it.each([
  { path: 'docs/#notes.md', name: '#notes.md' },
  { path: 'docs/a?b.md', name: 'a?b.md' },
  { path: 'report:78', name: 'report:78' },
])('preserves the literal snapshot path $path', async ({ path, name }) => {
  const openFileLink = vi.fn<OpenFileLink>();
  const openFile = await clickMention(openFileLink, '', snapshotWithPath(path, name));
  expect(openFileLink).toHaveBeenCalledWith({ path }, openFile);
  expect(openFile).not.toHaveBeenCalled();
});

it('keeps numeric HTML fragments as URL suffixes', async () => {
  const openFileLink = vi.fn<OpenFileLink>();
  const openFile = await clickMention(openFileLink, 'see [section](site/index.html#78)');
  expect(openFileLink).toHaveBeenCalledWith({ path: 'site/index.html', urlSuffix: '#78' }, openFile);
  expect(openFile).not.toHaveBeenCalled();
});
