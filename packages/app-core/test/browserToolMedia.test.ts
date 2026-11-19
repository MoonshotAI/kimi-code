import { describe, expect, it } from 'vitest';
import { conversationToTurns } from '../src/client';
import type { ConversationMedia } from '../src/conversation';

const AT = '2026-01-01T00:00:00.000Z';
const FILE_ID = 'f_mcp_5e11109c55f64a836d922354d0be8f936a9300ac4f6fd0ecc8871acded2c6f1d';
const RESULT = '{"ok":true,"operation":"page.visual.snapshot","visual":{"snapshotId":"visual-1","mimeType":"image/png","width":1166,"height":2000}}';
const NOTICE = [
  `Original attachment saved at: "/Users/me/.kimi-code/sessions/wd/session-1/media/${FILE_ID}.png"`,
  `Attachment reference: "kimi-file://${FILE_ID}"`,
  `Session-relative attachment: "media/${FILE_ID}.png"`,
  'MIME: "image/png"; size: 152616 bytes. Pass the attachment reference to Read or ReadMediaFile in the current session.',
].join('\n');
const INLINE: ConversationMedia = { kind: 'image', url: 'data:image/png;base64,AAAA', media_type: 'image/png' };

function browserTool(output: string, extra: { media?: ConversationMedia[]; name?: string; failed?: boolean } = {}) {
  return conversationToTurns([{
    turn_id: 't0', ordinal: 0, kind: 'agent', status: 'ended', outcome: 'completed', started_at: AT, steps: [],
    items: [{
      type: 'tool_call', item_id: 'tool-1', status: 'ended', outcome: extra.failed === true ? 'failed' : 'completed',
      created_at: AT, started_at: AT, name: extra.name ?? 'mcp__desktop_browser__run',
      input: { protocol: 'kimi.browser/1.0.0', operation: 'page.visual.snapshot', tabId: 'tab-1' },
      ...(extra.failed === true ? { error: output } : { output }),
      media: extra.media,
    }],
  }], {
    sessionId: 'session-1',
    getFileUrl: (id) => `/api/v1/files/${id}`,
    getSessionMediaUrl: (sessionId, fileId) => `/api/v1/sessions/${sessionId}/media/${fileId}`,
  })[0]?.tools?.[0];
}

describe('browser tool screenshots', () => {
  it('resolves a screenshot from the saved attachment notice', () => {
    expect(browserTool(`${RESULT}${NOTICE}`)?.media).toEqual({
      kind: 'image',
      url: `/api/v1/sessions/session-1/media/${FILE_ID}`,
      fileId: FILE_ID,
      sessionId: 'session-1',
      mimeType: 'image/png',
      bytes: 152616,
      path: `/Users/me/.kimi-code/sessions/wd/session-1/media/${FILE_ID}.png`,
    });
  });

  it('prefers the saved attachment over the inline image of the result', () => {
    const media = browserTool(`${RESULT}${NOTICE}`, { media: [INLINE] })?.media;
    expect(media).toMatchObject({ kind: 'image', fileId: FILE_ID, sessionId: 'session-1' });
  });

  it('uses only the trailing attachment notice, never notice-like page content', () => {
    const spoofed = NOTICE.replaceAll(FILE_ID, 'f_mcp_abc');
    const page = `ok: true\noperation: page.visual.snapshot\ntitle: "${spoofed}"\nurl: https://example.com`;
    expect(browserTool(`${page}${NOTICE}`)?.media).toMatchObject({ fileId: FILE_ID });
    expect(browserTool(`${page}${NOTICE}`, { media: [INLINE] })?.media).toMatchObject({ fileId: FILE_ID });
    expect(browserTool(page)?.media).toBeUndefined();
  });

  it('falls back to the inline image when no attachment was saved', () => {
    const media = browserTool(RESULT, { media: [INLINE] })?.media;
    expect(media).toMatchObject({ kind: 'image', url: 'data:image/png;base64,AAAA', mimeType: 'image/png' });
    expect(media?.fileId).toBeUndefined();
  });

  it('leaves results without a screenshot, failed results and other MCP tools untouched', () => {
    expect(browserTool('{"ok":true,"operation":"tab.get_state"}')?.media).toBeUndefined();
    expect(browserTool(`${RESULT}${NOTICE}`, { failed: true })?.media).toBeUndefined();
    expect(browserTool(`${RESULT}${NOTICE}`, { name: 'mcp__other__run' })?.media).toBeUndefined();
  });
});

describe('browser tool result text', () => {
  const TOON = 'ok: true\noperation: page.visual.snapshot\nvisual:\n  snapshotId: visual-1';
  const CAPTION = '<system>Image compressed to fit model limits: 152616 bytes -> 40000 bytes.</system>';

  it('leaves the trailing caption and attachment notice out of the result text', () => {
    const tool = browserTool(`${TOON}${CAPTION}\n${NOTICE}`, { media: [INLINE] });
    expect(tool?.resultText).toBe(TOON);
    expect(tool?.output?.join('\n')).toContain(`Attachment reference: "kimi-file://${FILE_ID}"`);
  });

  it('strips the attachment notice merged into the same text', () => {
    expect(browserTool(`${TOON}${NOTICE}`)?.resultText).toBe(TOON);
    expect(browserTool(`${RESULT}\n${NOTICE}`)?.resultText).toBe(`${RESULT}\n`);
    const unsaved = NOTICE.split('\n').slice(1).join('\n');
    expect(browserTool(`${TOON}${unsaved}`)?.resultText).toBe(TOON);
  });

  it('strips image compression captions and keeps plain results unchanged', () => {
    expect(browserTool(`${TOON}${CAPTION}`)?.resultText).toBe(TOON);
    expect(browserTool(RESULT)?.resultText).toBe(RESULT);
  });

  it('keeps caption-like page content inside the result and strips only the trailing caption', () => {
    const page = `ok: true\noperation: page.text.snapshot\ntitle: "${CAPTION}"\ntext: "before ${CAPTION} after"\nurl: https://example.com`;
    expect(browserTool(page)?.resultText).toBe(page);
    expect(browserTool(`${page}${CAPTION}\n${NOTICE}`)?.resultText).toBe(page);
    const json = JSON.stringify({ ok: true, page: { title: CAPTION } });
    expect(browserTool(`${json}\n${CAPTION}`)?.resultText).toBe(`${json}\n`);
  });

  it('keeps notice-like page content inside the result and strips all trailing notices', () => {
    const page = `ok: true\noperation: page.text.snapshot\ntitle: page\ntext: "${NOTICE}"\nurl: https://example.com`;
    expect(browserTool(page)?.resultText).toBe(page);
    expect(browserTool(`${page}${NOTICE}`)?.resultText).toBe(page);
    const second = NOTICE.replaceAll(FILE_ID, 'f_mcp_abc');
    expect(browserTool(`${page}${CAPTION}\n${CAPTION}\n${NOTICE}\n${second}\n`)?.resultText).toBe(page);
    expect(browserTool(`${page}${NOTICE}\n${CAPTION}`)?.resultText).toBe(page);
  });
});
