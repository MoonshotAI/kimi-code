import { describe, expect, it, vi } from 'vitest';
import {
  createLocalHtmlOpener,
  createLocalPagesCapability,
  isLocalHtmlContextCurrent,
  type LocalHtmlContext,
  localHtmlLinkHandler,
  localHtmlPathTarget,
  openFileOrLocalHtml,
  openLocalHtmlFileUrl,
  reportLocalHtmlOpenFailure,
} from '../../src/renderer/lib/localHtmlFiles';

function desktop(result: 'ok' | 'reject' = 'ok', enabled = true) {
  const layout = { enabled };
  const interaction = { version: 0 };
  const destroyed = new Set<string>();
  const viewed = { context: { sessionId: 'session-a', workspaceId: 'workspace-1' } as LocalHtmlContext, promotion: null as LocalHtmlContext | null };
  const bridge = {
    browserOpenLocalFile: vi.fn(async (_browserId: string, _target: string, _urlSuffix?: string) => {
      if (result === 'reject') throw new Error('browser-open-local-file: file not found');
    }),
    browserLocalPagesAllowed: vi.fn(async () => true),
  };
  const openTab = vi.fn();
  const addToSession = vi.fn();
  const discard = vi.fn();
  const opener = createLocalHtmlOpener({
    bridge, enabled: () => layout.enabled, context: () => viewed.context, draftPromotion: () => viewed.promotion, interactionVersion: () => interaction.version, openTab, addToSession, discard,
    sessionDestroyed: (sessionId) => destroyed.has(sessionId),
  });
  const hold = () => {
    let release: () => void = () => {};
    bridge.browserOpenLocalFile.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      release = () => (result === 'reject' ? reject(new Error('browser-open-local-file: file not found')) : resolve());
    }));
    return () => release();
  };
  return { bridge, openTab, addToSession, discard, viewed, layout, destroyed, interaction, opener, hold };
}

function webOpener() {
  return createLocalHtmlOpener({
    bridge: null, enabled: () => true, context: () => ({ sessionId: 'session-a', workspaceId: 'workspace-1' }), draftPromotion: () => null, interactionVersion: () => 0,
    openTab: vi.fn(), addToSession: vi.fn(), discard: vi.fn(), sessionDestroyed: () => false,
  });
}

describe('local pages capability', () => {
  it('notifies only when a local open reports failure', async () => {
    const notify = vi.fn();
    reportLocalHtmlOpenFailure(Promise.resolve('failed'), notify);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    const quiet = vi.fn();
    reportLocalHtmlOpenFailure(Promise.resolve('stale'), quiet);
    reportLocalHtmlOpenFailure(Promise.resolve('opened'), quiet);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(quiet).not.toHaveBeenCalled();
  });

  it('probes lazily and exposes the capability once resolved', async () => {
    const read = vi.fn(async () => true);
    const capability = createLocalPagesCapability(read);
    expect(read).not.toHaveBeenCalled();
    expect(capability.allowed.value).toBe(false);
    capability.probe();
    expect(read).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(capability.allowed.value).toBe(true));
    capability.probe();
    expect(read).toHaveBeenCalledOnce();
  });

  it('stays denied when the probe reports disallowed or fails', async () => {
    const disallowed = createLocalPagesCapability(vi.fn(async () => false));
    disallowed.probe();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(disallowed.allowed.value).toBe(false);
    const failing = createLocalPagesCapability(vi.fn(async () => { throw new Error('no'); }));
    failing.probe();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(failing.allowed.value).toBe(false);
  });
});

describe('local HTML targets', () => {
  it('resolves workspace-relative paths against the session directory and keeps absolute ones', () => {
    expect(localHtmlPathTarget('site/index.html', '/Users/me/project/')).toBe('/Users/me/project/site/index.html');
    expect(localHtmlPathTarget('../docs/page.HTM', '/Users/me/project')).toBe('/Users/me/project/../docs/page.HTM');
    expect(localHtmlPathTarget('/tmp/report.html', '/Users/me/project')).toBe('/tmp/report.html');
    expect(localHtmlPathTarget('C:\\site\\index.html', '')).toBe('C:\\site\\index.html');
    expect(localHtmlPathTarget('\\\\server\\share\\index.html', '')).toBe('\\\\server\\share\\index.html');
    expect(localHtmlPathTarget('My Site/100% #1.HTM', '/Users/me/project')).toBe('/Users/me/project/My Site/100% #1.HTM');
  });

  it('resolves relative paths against a root working directory', () => {
    expect(localHtmlPathTarget('site/index.html', '/')).toBe('/site/index.html');
    expect(localHtmlPathTarget('site/index.html', 'C:\\')).toBe('C:\\site/index.html');
    expect(localHtmlPathTarget('site\\index.html', 'C:/')).toBe('C:/site\\index.html');
    expect(localHtmlPathTarget('site/index.html', 'C:\\proj\\')).toBe('C:\\proj/site/index.html');
  });

  it('resolves Windows current-drive paths against the session drive or UNC root', () => {
    expect(localHtmlPathTarget('/site/index.html', 'D:\\repo')).toBe('D:/site/index.html');
    expect(localHtmlPathTarget('\\site\\index.html', 'D:\\repo')).toBe('D:\\site\\index.html');
    expect(localHtmlPathTarget('/site/index.html', '\\\\server\\share\\repo')).toBe('\\\\server\\share/site/index.html');
    expect(localHtmlPathTarget('/site/index.html', '/Users/me')).toBe('/site/index.html');
    expect(localHtmlPathTarget('/site/index.html', '')).toBe('/site/index.html');
    expect(localHtmlPathTarget('\\site\\index.html', '')).toBeNull();
  });

  it('leaves non-HTML files, home paths, URLs and unresolvable paths to the file preview', () => {
    expect(localHtmlPathTarget('src/main.ts', '/Users/me/project')).toBeNull();
    expect(localHtmlPathTarget('index.html.md', '/Users/me/project')).toBeNull();
    expect(localHtmlPathTarget('~/site/index.html', '/Users/me/project')).toBeNull();
    expect(localHtmlPathTarget('https://example.com/index.html', '/Users/me/project')).toBeNull();
    expect(localHtmlPathTarget('site/index.html', '')).toBeNull();
  });
});

describe('opening files from chat', () => {
  it('opens an HTML mention in a new browser tab on desktop', async () => {
    const { bridge, openTab, opener } = desktop();
    const preview = vi.fn();
    openFileOrLocalHtml({ path: 'site/index.html' }, opener, '/Users/me/project', preview);
    await vi.waitFor(() => expect(openTab).toHaveBeenCalledOnce());
    const browserId = openTab.mock.calls[0]![0] as string;
    expect(bridge.browserOpenLocalFile).toHaveBeenCalledWith(browserId, '/Users/me/project/site/index.html', '');
    expect(preview).not.toHaveBeenCalled();
  });

  it('passes the URL suffix of an HTML link through to the browser', async () => {
    const { bridge, openTab, opener } = desktop();
    const preview = vi.fn();
    openFileOrLocalHtml({ path: 'site/index.html', urlSuffix: '?tab=2#intro' }, opener, '/Users/me/project', preview);
    await vi.waitFor(() => expect(openTab).toHaveBeenCalledOnce());
    const browserId = openTab.mock.calls[0]![0] as string;
    expect(bridge.browserOpenLocalFile).toHaveBeenCalledWith(browserId, '/Users/me/project/site/index.html', '?tab=2#intro');
    expect(preview).not.toHaveBeenCalled();
  });

  it('keeps the file preview for non-HTML files on desktop', () => {
    const { bridge, opener } = desktop();
    const preview = vi.fn();
    openFileOrLocalHtml({ path: 'src/main.ts', line: 4 }, opener, '/Users/me/project', preview);
    expect(preview).toHaveBeenCalledWith({ path: 'src/main.ts', line: 4 });
    expect(bridge.browserOpenLocalFile).not.toHaveBeenCalled();
  });

  it('keeps the file preview for assumed HTML links so the resolution notice stays visible', () => {
    const { bridge, opener } = desktop();
    const preview = vi.fn();
    openFileOrLocalHtml({ path: 'site/index.html', assumed: true }, opener, '/Users/me/project', preview);
    expect(preview).toHaveBeenCalledWith({ path: 'site/index.html', assumed: true });
    expect(bridge.browserOpenLocalFile).not.toHaveBeenCalled();
  });

  it('keeps the file preview on the web, where there is no built-in browser', () => {
    const preview = vi.fn();
    openFileOrLocalHtml({ path: 'site/index.html' }, webOpener(), '/Users/me/project', preview);
    expect(preview).toHaveBeenCalledWith({ path: 'site/index.html' });
  });

  it('keeps the file preview when the browser panel cannot open', () => {
    const { bridge, opener } = desktop('ok', false);
    const preview = vi.fn();
    openFileOrLocalHtml({ path: 'site/index.html' }, opener, '/Users/me/project', preview);
    expect(preview).toHaveBeenCalledOnce();
    expect(bridge.browserOpenLocalFile).not.toHaveBeenCalled();
  });

  it('falls back to the file preview when the file cannot be opened', async () => {
    const { openTab, opener } = desktop('reject');
    const preview = vi.fn();
    openFileOrLocalHtml({ path: '/missing/index.html' }, opener, '/Users/me/project', preview);
    await vi.waitFor(() => expect(preview).toHaveBeenCalledWith({ path: '/missing/index.html' }));
    expect(openTab).not.toHaveBeenCalled();
  });

  it.each(['no native bridge', 'narrow layout'])('previews a file URL link when the browser panel is unavailable (%s)', async (reason) => {
    const opener = reason === 'no native bridge'
      ? webOpener()
      : desktop('ok', false).opener;
    const preview = vi.fn();
    const beforeOpen = vi.fn();
    const handler = localHtmlLinkHandler(opener, preview, beforeOpen)();
    expect(handler).toBeTypeOf('function');
    handler!('file:///Users/me/site/index.html');
    expect(beforeOpen).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(preview).toHaveBeenCalledWith({ path: '/Users/me/site/index.html' }));
  });

  it('opens a file URL link in a browser tab, or previews its path when that fails', async () => {
    const opened = desktop();
    const preview = vi.fn();
    openLocalHtmlFileUrl('file:///Users/me/site/index.html', opened.opener, preview);
    await vi.waitFor(() => expect(opened.openTab).toHaveBeenCalledOnce());
    expect(opened.bridge.browserOpenLocalFile).toHaveBeenCalledWith(expect.any(String), 'file:///Users/me/site/index.html', '');

    const failed = desktop('reject');
    openLocalHtmlFileUrl('file:///Users/me/site/missing.html', failed.opener, preview);
    await vi.waitFor(() => expect(preview).toHaveBeenCalledWith({ path: '/Users/me/site/missing.html' }));
  });

  it('keeps the source preview for requests that carry a line', () => {
    const { bridge, opener } = desktop();
    const preview = vi.fn();
    openFileOrLocalHtml({ path: 'site/index.html', line: 12 }, opener, '/Users/me/project', preview);
    expect(preview).toHaveBeenCalledWith({ path: 'site/index.html', line: 12 });
    expect(bridge.browserOpenLocalFile).not.toHaveBeenCalled();
  });

  it('adds the tab to the session the click came from when the viewed session changed meanwhile', async () => {
    const { bridge, openTab, addToSession, viewed, opener, hold } = desktop();
    const release = hold();
    const preview = vi.fn();
    openFileOrLocalHtml({ path: '/tmp/report.html' }, opener, '/Users/me/project', preview);
    viewed.context = { sessionId: 'session-b', workspaceId: 'workspace-1' };
    release();
    await vi.waitFor(() => expect(addToSession).toHaveBeenCalledOnce());
    expect(addToSession).toHaveBeenCalledWith('session-a', bridge.browserOpenLocalFile.mock.calls[0]![0]);
    expect(openTab).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it.each(['mention', 'file URL'])('drops the preview fallback of a failed %s open once the viewed session changed', async (entry) => {
    const { viewed, opener, hold } = desktop('reject');
    const release = hold();
    const preview = vi.fn();
    if (entry === 'mention') openFileOrLocalHtml({ path: 'site/missing.html' }, opener, '/Users/me/project', preview);
    else openLocalHtmlFileUrl('file:///Users/me/site/missing.html', opener, preview);
    viewed.context = { sessionId: 'session-b', workspaceId: 'workspace-2' };
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(preview).not.toHaveBeenCalled();
  });

  it('opens the tab when a draft was promoted to a session in the same workspace meanwhile', async () => {
    const { openTab, discard, viewed, opener, hold } = desktop();
    viewed.context = { sessionId: null, workspaceId: 'workspace-1' };
    const release = hold();
    const opened = opener.open('/tmp/report.html');
    viewed.context = { sessionId: 'session-new', workspaceId: 'workspace-1' };
    viewed.promotion = { sessionId: 'session-new', workspaceId: 'workspace-1' };
    release();
    await expect(opened).resolves.toBe('opened');
    expect(openTab).toHaveBeenCalledOnce();
    expect(discard).not.toHaveBeenCalled();
  });

  it('closes the page quietly when the draft context changed meanwhile', async () => {
    const { bridge, openTab, addToSession, discard, viewed, opener, hold } = desktop();
    viewed.context = { sessionId: null, workspaceId: 'workspace-1' };
    const release = hold();
    const opened = opener.open('/tmp/report.html');
    viewed.context = { sessionId: null, workspaceId: 'workspace-2' };
    release();
    await expect(opened).resolves.toBe('opened');
    expect(discard).toHaveBeenCalledWith(bridge.browserOpenLocalFile.mock.calls[0]![0]);
    expect(openTab).not.toHaveBeenCalled();
    expect(addToSession).not.toHaveBeenCalled();
  });

  it('matches origin contexts the way the terminal spawn check does', () => {
    const draft = { sessionId: null, workspaceId: 'w1' };
    expect(isLocalHtmlContextCurrent(draft, { sessionId: null, workspaceId: 'w1' }, null)).toBe(true);
    expect(isLocalHtmlContextCurrent(draft, { sessionId: null, workspaceId: 'w2' }, null)).toBe(false);
    expect(isLocalHtmlContextCurrent(draft, { sessionId: 's1', workspaceId: 'w1' }, { sessionId: 's1', workspaceId: 'w2' })).toBe(false);
    expect(isLocalHtmlContextCurrent({ sessionId: 's1', workspaceId: 'w1' }, { sessionId: 's1', workspaceId: 'w1' }, null)).toBe(true);
    expect(isLocalHtmlContextCurrent({ sessionId: 's1', workspaceId: 'w1' }, { sessionId: 's2', workspaceId: 'w1' }, null)).toBe(false);
  });

  it('closes the page instead of recreating a session that was destroyed meanwhile', async () => {
    const { bridge, openTab, addToSession, discard, viewed, destroyed, opener, hold } = desktop();
    const release = hold();
    const opened = opener.open('/tmp/report.html');
    viewed.context = { sessionId: 'session-b', workspaceId: 'workspace-1' };
    destroyed.add('session-a');
    release();
    await expect(opened).resolves.toBe('opened');
    expect(discard).toHaveBeenCalledWith(bridge.browserOpenLocalFile.mock.calls[0]![0]);
    expect(addToSession).not.toHaveBeenCalled();
    expect(openTab).not.toHaveBeenCalled();
  });

  it('closes the page when the still-viewed session was destroyed before the switch completed', async () => {
    const { bridge, openTab, addToSession, discard, destroyed, opener, hold } = desktop();
    const release = hold();
    const opened = opener.open('/tmp/report.html');
    destroyed.add('session-a');
    release();
    await expect(opened).resolves.toBe('opened');
    expect(discard).toHaveBeenCalledWith(bridge.browserOpenLocalFile.mock.calls[0]![0]);
    expect(openTab).not.toHaveBeenCalled();
    expect(addToSession).not.toHaveBeenCalled();
  });

  it('leaves the tab in the background when the user interacted with the panel meanwhile', async () => {
    const { bridge, openTab, addToSession, discard, interaction, opener, hold } = desktop();
    const release = hold();
    const opened = opener.open('/tmp/report.html');
    interaction.version += 1;
    release();
    await expect(opened).resolves.toBe('opened');
    expect(addToSession).toHaveBeenCalledWith('session-a', bridge.browserOpenLocalFile.mock.calls[0]![0]);
    expect(openTab).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it('reports a late failure as stale when the user interacted with the panel meanwhile', async () => {
    const { openTab, interaction, opener, hold } = desktop('reject');
    const release = hold();
    const preview = vi.fn();
    openFileOrLocalHtml({ path: '/missing/index.html' }, opener, '/Users/me/project', preview);
    interaction.version += 1;
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(preview).not.toHaveBeenCalled();
    expect(openTab).not.toHaveBeenCalled();
  });

  it('discards the tab when a draft user interacted with the panel meanwhile', async () => {
    const { bridge, openTab, addToSession, discard, viewed, interaction, opener, hold } = desktop();
    viewed.context = { sessionId: null, workspaceId: 'workspace-1' };
    const release = hold();
    const opened = opener.open('/tmp/report.html');
    interaction.version += 1;
    release();
    await expect(opened).resolves.toBe('opened');
    expect(discard).toHaveBeenCalledWith(bridge.browserOpenLocalFile.mock.calls[0]![0]);
    expect(openTab).not.toHaveBeenCalled();
    expect(addToSession).not.toHaveBeenCalled();
  });

  it('reports a failed open as stale when the still-viewed session was destroyed before the switch completed', async () => {
    const { openTab, destroyed, opener, hold } = desktop('reject');
    const release = hold();
    const preview = vi.fn();
    openFileOrLocalHtml({ path: '/missing/index.html' }, opener, '/Users/me/project', preview);
    destroyed.add('session-a');
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(preview).not.toHaveBeenCalled();
    expect(openTab).not.toHaveBeenCalled();
  });

  it('closes the page and previews the file when the browser panel became unavailable meanwhile', async () => {
    const { bridge, openTab, discard, layout, opener, hold } = desktop();
    const release = hold();
    const preview = vi.fn();
    openFileOrLocalHtml({ path: '/tmp/report.html' }, opener, '/Users/me/project', preview);
    layout.enabled = false;
    release();
    await vi.waitFor(() => expect(preview).toHaveBeenCalledWith({ path: '/tmp/report.html' }));
    expect(discard).toHaveBeenCalledWith(bridge.browserOpenLocalFile.mock.calls[0]![0]);
    expect(openTab).not.toHaveBeenCalled();
  });
});
