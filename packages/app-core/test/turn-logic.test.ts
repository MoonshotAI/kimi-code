import { describe, expect, it } from 'vitest';
import type { AppMessage, AppMessageContent } from '../src/api/types';
import { latestTodos } from '../src/client';
import { messagesToTurns } from '../src/client';

function message(
  id: string,
  role: AppMessage['role'],
  content: AppMessageContent[],
  extra: Partial<AppMessage> = {},
): AppMessage {
  return {
    id,
    sessionId: 'session-1',
    role,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('messagesToTurns', () => {
  it('merges an assistant turn and folds tool results into it', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'hello' }]),
        message('a1', 'assistant', [
          { type: 'thinking', thinking: 'plan' },
          { type: 'toolUse', toolCallId: 'tool-1', toolName: 'read', input: { path: 'src/a.ts' } },
        ]),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'tool-1', output: 'alpha\nbeta' }]),
        message('a2', 'assistant', [{ type: 'text', text: 'done' }]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
      role: 'assistant',
      thinking: 'plan',
      text: 'done',
    });
    expect(turns[1]?.tools).toMatchObject([
      { id: 'tool-1', status: 'ok', output: ['alpha', 'beta'] },
    ]);
  });

  it('splits assistant turns when prompt ids differ', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [{ type: 'text', text: 'one' }], { promptId: 'p1' }),
        message('a2', 'assistant', [{ type: 'text', text: 'two' }], { promptId: 'p2' }),
      ],
      [],
      undefined,
      false,
    );

    expect(turns.map((turn) => turn.text)).toEqual(['one', 'two']);
  });

  it('takes the turn end from a live settle stamp (endedAt), even on the opener message', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'hi' }]),
        message('a1', 'assistant', [{ type: 'text', text: 'done' }], {
          durationMs: 20_000,
          endedAt: '2026-01-01T00:00:20.000Z',
        }),
      ],
      [],
      undefined,
      false,
    );

    expect(turns[1]?.endedAt).toBe('2026-01-01T00:00:20.000Z');
  });

  it('leaves the turn end unset for a single history message without a settle stamp', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'hi' }]),
        message('a1', 'assistant', [{ type: 'text', text: 'done' }], { durationMs: 20_000 }),
      ],
      [],
      undefined,
      false,
    );

    expect(turns[1]?.endedAt).toBeUndefined();
    expect(turns[1]?.durationMs).toBe(20_000);
  });

  it('renders compaction summaries as divider turns', () => {
    const turns = messagesToTurns(
      [
        message('s1', 'assistant', [{ type: 'text', text: 'summary' }], {
          metadata: { origin: { kind: 'compaction_summary' } },
        }),
      ],
      [],
      undefined,
      false,
    );

    expect(turns).toMatchObject([{ role: 'compaction', text: 'summary' }]);
  });

  it('renders a live multi-member swarm inline as a tool card', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'run a swarm' }]),
        message('a1', 'assistant', [
          { type: 'toolUse', toolCallId: 'swarm-1', toolName: 'AgentSwarm', input: {} },
        ]),
      ],
      [],
      undefined,
      true,
    );

    const assistant = turns.at(-1);
    expect(assistant?.tools).toContainEqual(
      expect.objectContaining({ id: 'swarm-1', name: 'AgentSwarm', status: 'running' }),
    );
    expect(assistant?.blocks ?? []).not.toContainEqual(
      expect.objectContaining({ kind: 'agentGroup' }),
    );
  });

  it('renders a completed multi-member swarm inline as a tool card', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'run a swarm' }]),
        message('a1', 'assistant', [
          { type: 'toolUse', toolCallId: 'swarm-2', toolName: 'AgentSwarm', input: {} },
        ]),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'swarm-2', output: 'all done' }]),
      ],
      [],
      undefined,
      false,
    );

    const assistant = turns.at(-1);
    expect(assistant?.tools).toContainEqual(
      expect.objectContaining({ id: 'swarm-2', name: 'AgentSwarm', status: 'ok' }),
    );
    expect(assistant?.blocks ?? []).not.toContainEqual(
      expect.objectContaining({ kind: 'agentGroup' }),
    );
  });

  it('renders a single subagent spawn as a tool card, not an agent block', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'go explore' }]),
        message('a1', 'assistant', [
          {
            type: 'toolUse',
            toolCallId: 'agent-call-1',
            toolName: 'Agent',
            input: { description: 'explore the repo', prompt: 'list the top-level dirs' },
          },
        ]),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'agent-call-1', output: 'done' }]),
      ],
      [],
      undefined,
      false,
    );

    const assistant = turns.at(-1);
    // The spawning `Agent` call renders as a normal tool card (args + result)…
    expect(assistant?.tools).toContainEqual(
      expect.objectContaining({ id: 'agent-call-1', name: 'Agent', status: 'ok' }),
    );
    // …and never as an inline agent/agentGroup block (live progress moves to
    // the right-side panel).
    expect(assistant?.blocks ?? []).not.toContainEqual(expect.objectContaining({ kind: 'agent' }));
    expect(assistant?.blocks ?? []).not.toContainEqual(
      expect.objectContaining({ kind: 'agentGroup' }),
    );
  });

  it('renders a `<video path>` text tag as a video attachment, not raw text', () => {
    const fileId = 'f_01KWK39A0ZC8R2ATZEQMD8716C';
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text: 'look at this' },
          {
            type: 'text',
            text: `<video path="/Users/me/.kimi-code/cache/${fileId}.mp4"></video>`,
          },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: 'user', text: 'look at this' });
    expect(turns[0]?.attachments).toEqual([
      { url: `/api/v1/files/${fileId}`, kind: 'video', fileId, orderHint: 0 },
    ]);
  });

  it('renders a non-media file part as a file attachment with name and size', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text: 'check these' },
          { type: 'file', fileId: 'f_yaml', name: 'api-spec.yaml', mediaType: 'application/yaml', size: 18432 },
          { type: 'file', fileId: 'f_pdf', name: '设计文档.pdf', mediaType: 'application/pdf', size: 2516582 },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.attachments).toEqual([
      {
        kind: 'file',
        url: '/api/v1/files/f_yaml',
        fileId: 'f_yaml',
        name: 'api-spec.yaml',
        mediaType: 'application/yaml',
        size: 18432,
        orderHint: 0,
      },
      {
        kind: 'file',
        url: '/api/v1/files/f_pdf',
        fileId: 'f_pdf',
        name: '设计文档.pdf',
        mediaType: 'application/pdf',
        size: 2516582,
        orderHint: 1,
      },
    ]);
  });

  it('renders an extensionless file part with no mediaType as a file attachment', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'file', fileId: 'f_make', name: 'Makefile', mediaType: '', size: 512 },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]?.attachments).toEqual([
      { kind: 'file', url: '/api/v1/files/f_make', fileId: 'f_make', name: 'Makefile', mediaType: undefined, size: 512, orderHint: 0 },
    ]);
  });

  it('recovers a file attachment from the server’s "Attached file" notice, not raw text', () => {
    // After a resync the file part is gone from history — the kap-server prompt
    // route replaced it with this notice. The chip must be rebuilt from the
    // notice (fileId lives in the materialized basename) instead of dumping the
    // absolute server path into the bubble.
    const fileId = 'f_01KWK39A0ZC8R2ATZEQMD8716C';
    const notice =
      `Attached file "report.pdf" (application/pdf, 24 bytes): ` +
      `/home/u/.kimi-code/sessions/s_1/attachments/${fileId}-report.pdf — open it with the Read tool`;
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text: 'summarize this' },
          { type: 'text', text: notice },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: 'user', text: 'summarize this' });
    expect(turns[0]?.attachments).toEqual([
      {
        kind: 'file',
        url: `/api/v1/files/${fileId}`,
        fileId,
        name: 'report.pdf',
        mediaType: 'application/pdf',
        size: 24,
        orderHint: 0,
      },
    ]);
  });

  it('recovers a non-clickable chip from an inline-base64 attachment notice (no fileId)', () => {
    // Inline base64 uploads are materialized under a content hash, not a file
    // id — the chip keeps name/size but has no bytes to open.
    const notice =
      'Attached file "image.avif" (image/avif, 100 bytes): ' +
      '/home/u/.kimi-code/sessions/s_1/attachments/9f86d081884c7d659a2feaa0c55ad015-image.avif — open it with the Read tool';
    const turns = messagesToTurns(
      [message('u1', 'user', [{ type: 'text', text: notice }])],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]?.text).toBe('');
    expect(turns[0]?.attachments).toEqual([
      { kind: 'file', url: '', fileId: undefined, name: 'image.avif', mediaType: 'image/avif', size: 100, orderHint: 0 },
    ]);
  });

  it('recovers the full UUID file id from a v2 "Attached file" notice', () => {
    // v2 file ids are `f_`<randomUUID> and contain hyphens themselves — a naive
    // first-hyphen split would truncate the id and lose the clickable URL.
    const fileId = 'f_550e8400-e29b-41d4-a716-446655440000';
    const notice =
      `Attached file "api-spec-v2.yaml" (application/yaml, 18 bytes): ` +
      `/home/u/.kimi-code/sessions/s_1/attachments/${fileId}-api-spec-v2.yaml — open it with the Read tool`;
    const turns = messagesToTurns(
      [message('u1', 'user', [{ type: 'text', text: notice }])],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]?.attachments).toEqual([
      {
        kind: 'file',
        url: `/api/v1/files/${fileId}`,
        fileId,
        name: 'api-spec-v2.yaml',
        mediaType: 'application/yaml',
        size: 18,
        orderHint: 0,
      },
    ]);
  });

  it('renders a `<video path>` tag with a v2 UUID file id as a video attachment', () => {
    const fileId = 'f_550e8400-e29b-41d4-a716-446655440000';
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          {
            type: 'text',
            text: `<video path="/Users/me/.kimi-code/cache/${fileId}.mp4"></video>`,
          },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]?.attachments).toEqual([
      { url: `/api/v1/files/${fileId}`, kind: 'video', fileId, orderHint: 0 },
    ]);
  });

  it('keeps lookalike text that is not an attachment notice as text', () => {
    const text = 'Attached file "a.pdf" (application/pdf, 3 bytes): /tmp/x - open it with the Read tool';
    const turns = messagesToTurns(
      [message('u1', 'user', [{ type: 'text', text }])],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]).toMatchObject({ role: 'user', text });
    expect(turns[0]?.attachments).toBeUndefined();
  });

  it('drops file chips when the message references them via inline attachment links (pill flow)', () => {
    // Pill-flow messages carry `kimi-code-composer://attachments/<index>` links
    // in their text (the bubble revives them as inline pills) — recovering the
    // trailing notices into chips would show the same files twice. Media parts
    // (no pill form) must survive the filter. The scheme literal matches the
    // app-composer wire contract (wire-format.md §6).
    const fileId = 'f_01KWK39A0ZC8R2ATZEQMD8716C';
    const mediaId = 'f_550e8400-e29b-41d4-a716-446655440000';
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          {
            type: 'text',
            text: 'compare [report.pdf](kimi-code-composer://attachments/1) with the shot',
          },
          {
            type: 'text',
            text:
              `Attached file "report.pdf" (application/pdf, 24 bytes): ` +
              `/home/u/.kimi-code/sessions/s_1/attachments/${fileId}-report.pdf — open it with the Read tool`,
          },
          {
            type: 'text',
            text: `<image path="/Users/me/.kimi-code/cache/${mediaId}.png"></image>`,
          },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]?.text).toBe('compare [report.pdf](kimi-code-composer://attachments/1) with the shot');
    expect(turns[0]?.attachments).toEqual([{ url: `/api/v1/files/${mediaId}`, kind: 'image', fileId: mediaId, orderHint: 1 }]);
    // The filtered-out file rides along in pill-index order, so the bubble can
    // revive the inline pill's open target (attId "1" → the first file).
    expect(turns[0]?.inlineAttachments).toEqual([
      {
        url: `/api/v1/files/${fileId}`,
        kind: 'file',
        fileId,
        name: 'report.pdf',
        mediaType: 'application/pdf',
        size: 24,
        orderHint: 0,
      },
    ]);
  });

  it('detects the pill flow for a skill activation too (links live in skillArgs, not textParts)', () => {
    // A skill activation's display text is origin.skillArgs — its textParts
    // hold the dropped skill-prompt XML — so the pill-flow check must read
    // the args. Without it the same file would render TWICE (a chip row AND
    // an inline pill in the args) and the pill would have no open target
    // (inlineAttachments empty). The file order stays the notices' order,
    // matching the args' 1..N links.
    const fileId = 'f_01KWK39A0ZC8R2ATZEQMD8716C';
    const args = 'deploy with [config.yaml](kimi-code-composer://attachments/1) applied';
    const turns = messagesToTurns(
      [
        message(
          'u1',
          'user',
          [
            { type: 'text', text: '<skill-prompt>deploy the thing</skill-prompt>' },
            {
              type: 'text',
              text:
                `Attached file "config.yaml" (application/yaml, 12 bytes): ` +
                `/home/u/.kimi-code/sessions/s_1/attachments/${fileId}-config.yaml — open it with the Read tool`,
            },
          ],
          {
            metadata: {
              origin: { kind: 'skill_activation', trigger: 'user-slash', skillName: 'deploy', skillArgs: args },
            },
          },
        ),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]?.text).toBe(args);
    expect(turns[0]?.skillActivation).toEqual({ name: 'deploy', args });
    // The file is filtered OUT of the chip row and rides inline instead.
    expect(turns[0]?.attachments).toBeUndefined();
    expect(turns[0]?.inlineAttachments).toEqual([
      {
        url: `/api/v1/files/${fileId}`,
        kind: 'file',
        fileId,
        name: 'config.yaml',
        mediaType: 'application/yaml',
        size: 12,
        orderHint: 0,
      },
    ]);
  });

  it('keeps the chip row when the text only mentions the scheme literally (no real link)', () => {
    // A message that quotes the scheme without carrying a parseable
    // attachment link is NOT a pill flow — hiding its files would make them
    // completely inaccessible (no pill revives to open them).
    const fileId = 'f_01KWK39A0ZC8R2ATZEQMD8716C';
    const text = 'the docs say kimi-code-composer://attachments/1 is the wire form';
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text },
          {
            type: 'text',
            text:
              `Attached file "report.pdf" (application/pdf, 24 bytes): ` +
              `/home/u/.kimi-code/sessions/s_1/attachments/${fileId}-report.pdf — open it with the Read tool`,
          },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]?.text).toBe(text);
    expect(turns[0]?.attachments).toEqual([
      {
        url: `/api/v1/files/${fileId}`,
        kind: 'file',
        fileId,
        name: 'report.pdf',
        mediaType: 'application/pdf',
        size: 24,
        orderHint: 0,
      },
    ]);
    expect(turns[0]?.inlineAttachments).toBeUndefined();
  });

  it('keeps the chip row when every attachment link points past the file count', () => {
    // A forged/stale link with no file at its index: the file stays in the
    // legacy row (the link itself renders as an inert pill message-side).
    const fileId = 'f_01KWK39A0ZC8R2ATZEQMD8716C';
    const text = 'see [x.pdf](kimi-code-composer://attachments/5)';
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text },
          {
            type: 'text',
            text:
              `Attached file "report.pdf" (application/pdf, 24 bytes): ` +
              `/home/u/.kimi-code/sessions/s_1/attachments/${fileId}-report.pdf — open it with the Read tool`,
          },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]?.attachments).toEqual([
      {
        url: `/api/v1/files/${fileId}`,
        kind: 'file',
        fileId,
        name: 'report.pdf',
        mediaType: 'application/pdf',
        size: 24,
        // The forged link is no file's hint source — the file simply takes
        // its content-part position.
        orderHint: 0,
      },
    ]);
    expect(turns[0]?.inlineAttachments).toBeUndefined();
  });

  it('hides only the files a valid link targets; unreferenced files keep the chip row', () => {
    // A link to index 2 references the SECOND file only: the first stays in
    // the chip row, and inlineAttachments keeps the full positional list so
    // the bubble can resolve index 2 to the second file.
    const fileA = 'f_01KWK39A0ZC8R2ATZEQMD8716C';
    const fileB = 'f_550e8400-e29b-41d4-a716-446655440000';
    const notice = (id: string, name: string, size: number) =>
      `Attached file "${name}" (application/pdf, ${size} bytes): ` +
      `/home/u/.kimi-code/sessions/s_1/attachments/${id}-${name} — open it with the Read tool`;
    const text = 'compare [b.pdf](kimi-code-composer://attachments/2)';
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text },
          { type: 'text', text: notice(fileA, 'a.pdf', 11) },
          { type: 'text', text: notice(fileB, 'b.pdf', 22) },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]?.attachments).toEqual([
      {
        url: `/api/v1/files/${fileA}`,
        kind: 'file',
        fileId: fileA,
        name: 'a.pdf',
        mediaType: 'application/pdf',
        size: 11,
        orderHint: 0,
      },
    ]);
    expect(turns[0]?.inlineAttachments).toEqual([
      {
        url: `/api/v1/files/${fileA}`,
        kind: 'file',
        fileId: fileA,
        name: 'a.pdf',
        mediaType: 'application/pdf',
        size: 11,
        orderHint: 0,
      },
      {
        url: `/api/v1/files/${fileB}`,
        kind: 'file',
        fileId: fileB,
        name: 'b.pdf',
        mediaType: 'application/pdf',
        size: 22,
        orderHint: 1,
      },
    ]);
  });

  it('does not count the Markdown IMAGE form as an inline reference (the parser rejects images)', () => {
    // `![alt](…/1)` tokenizes as ONE image construct in the real parser and
    // never revives into a pill — counting it as a reference would hide the
    // file from the legacy row and make it completely inaccessible.
    const fileId = 'f_01KWK39A0ZC8R2ATZEQMD8716C';
    const text = 'look ![preview](kimi-code-composer://attachments/1) here';
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text },
          {
            type: 'text',
            text:
              `Attached file "report.pdf" (application/pdf, 24 bytes): ` +
              `/home/u/.kimi-code/sessions/s_1/attachments/${fileId}-report.pdf — open it with the Read tool`,
          },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]?.text).toBe(text);
    expect(turns[0]?.attachments).toEqual([
      {
        url: `/api/v1/files/${fileId}`,
        kind: 'file',
        fileId,
        name: 'report.pdf',
        mediaType: 'application/pdf',
        size: 24,
        orderHint: 0,
      },
    ]);
    expect(turns[0]?.inlineAttachments).toBeUndefined();
  });

  it('does not count a link nested in an image description as an inline reference (the parser flattens images)', () => {
    // `![caption [report](…/1)](preview.png)` — the inner link lives inside
    // the image's alt text. micromark/mdast flattens the whole image into
    // one node, so no pill revives from it; counting it as a reference would
    // hide the file from the legacy row and make it completely inaccessible.
    const fileId = 'f_01KWK39A0ZC8R2ATZEQMD8716C';
    const text = 'look ![caption [report](kimi-code-composer://attachments/1)](preview.png) here';
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text },
          {
            type: 'text',
            text:
              `Attached file "report.pdf" (application/pdf, 24 bytes): ` +
              `/home/u/.kimi-code/sessions/s_1/attachments/${fileId}-report.pdf — open it with the Read tool`,
          },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]?.text).toBe(text);
    expect(turns[0]?.attachments).toEqual([
      {
        url: `/api/v1/files/${fileId}`,
        kind: 'file',
        fileId,
        name: 'report.pdf',
        mediaType: 'application/pdf',
        size: 24,
        orderHint: 0,
      },
    ]);
    expect(turns[0]?.inlineAttachments).toBeUndefined();
  });

  it('still counts a real link that CONTAINS an image in its text', () => {
    // `[see ![x](y)](…/1)` — the outer construct is a genuine link (the image
    // is its child), so the pill revives and the file rides inline.
    const fileId = 'f_01KWK39A0ZC8R2ATZEQMD8716C';
    const text = '[see ![x](y)](kimi-code-composer://attachments/1)';
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text },
          {
            type: 'text',
            text:
              `Attached file "report.pdf" (application/pdf, 24 bytes): ` +
              `/home/u/.kimi-code/sessions/s_1/attachments/${fileId}-report.pdf — open it with the Read tool`,
          },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]?.inlineAttachments).toEqual([
      {
        url: `/api/v1/files/${fileId}`,
        kind: 'file',
        fileId,
        name: 'report.pdf',
        mediaType: 'application/pdf',
        size: 24,
        orderHint: 0,
      },
    ]);
  });

  it('does not count an escaped `\\[` form as an inline reference (the `[` is a literal)', () => {
    // `\[file](…/1)` has its bracket escaped — the wire parser treats it as
    // literal text, no pill revives, so the file must stay in the legacy
    // row or it becomes completely inaccessible.
    const fileId = 'f_01KWK39A0ZC8R2ATZEQMD8716C';
    const text = 'look \\[report.pdf](kimi-code-composer://attachments/1) here';
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text },
          {
            type: 'text',
            text:
              `Attached file "report.pdf" (application/pdf, 24 bytes): ` +
              `/home/u/.kimi-code/sessions/s_1/attachments/${fileId}-report.pdf — open it with the Read tool`,
          },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]?.text).toBe(text);
    expect(turns[0]?.attachments).toEqual([
      {
        url: `/api/v1/files/${fileId}`,
        kind: 'file',
        fileId,
        name: 'report.pdf',
        mediaType: 'application/pdf',
        size: 24,
        orderHint: 0,
      },
    ]);
    expect(turns[0]?.inlineAttachments).toBeUndefined();
  });

  it('assigns add-order hints from the content-part sequence (the submit payload’s own order)', () => {
    // The persisted message is [text part, then attachment-derived parts in
    // payload order]: the file notices replace their file parts in place,
    // so here — text (with both links), image, notice A, notice B — the
    // image was submitted BEFORE the files, and the hints must not reorder
    // it behind them.
    const fileA = 'f_01KWK39A0ZC8R2ATZEQMD8716C';
    const fileB = 'f_550e8400-e29b-41d4-a716-446655440000';
    const img = 'f_550e8400-e29b-41d4-a716-446655440001';
    const notice = (id: string, name: string, size: number) =>
      `Attached file "${name}" (application/pdf, ${size} bytes): ` +
      `/home/u/.kimi-code/sessions/s_1/attachments/${id}-${name} — open it with the Read tool`;
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text: 'see [a.pdf](kimi-code-composer://attachments/1)' },
          { type: 'text', text: `<image path="/Users/me/.kimi-code/cache/${img}.png"></image>` },
          { type: 'text', text: 'and [b.pdf](kimi-code-composer://attachments/2) too' },
          { type: 'text', text: notice(fileA, 'a.pdf', 11) },
          { type: 'text', text: notice(fileB, 'b.pdf', 22) },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]?.attachments).toEqual([
      { url: `/api/v1/files/${img}`, kind: 'image', fileId: img, orderHint: 0 },
    ]);
    expect(turns[0]?.inlineAttachments?.map((a) => [a.name, a.orderHint])).toEqual([
      ['a.pdf', 1],
      ['b.pdf', 2],
    ]);
  });

  it('falls back to payload order for files without links (legacy message)', () => {
    // A legacy message has no links — the files' hints follow the media
    // tag's appearance order in payload/notice order.
    const fileA = 'f_01KWK39A0ZC8R2ATZEQMD8716C';
    const fileB = 'f_550e8400-e29b-41d4-a716-446655440000';
    const img = 'f_550e8400-e29b-41d4-a716-446655440001';
    const notice = (id: string, name: string, size: number) =>
      `Attached file "${name}" (application/pdf, ${size} bytes): ` +
      `/home/u/.kimi-code/sessions/s_1/attachments/${id}-${name} — open it with the Read tool`;
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text: 'look at these' },
          { type: 'text', text: `<image path="/Users/me/.kimi-code/cache/${img}.png"></image>` },
          { type: 'text', text: notice(fileA, 'a.pdf', 11) },
          { type: 'text', text: notice(fileB, 'b.pdf', 22) },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]?.attachments?.map((a) => [a.name ?? a.kind, a.orderHint])).toEqual([
      ['image', 0],
      ['a.pdf', 1],
      ['b.pdf', 2],
    ]);
    expect(turns[0]?.inlineAttachments).toBeUndefined();
  });

  it('keeps the video tag as text when no file resolver is provided', () => {
    const tag =
      '<video path="/Users/me/.kimi-code/cache/f_01KWK39A0ZC8R2ATZEQMD8716C.mp4"></video>';
    const turns = messagesToTurns(
      [message('u1', 'user', [{ type: 'text', text: tag }])],
      [],
      undefined,
      false,
    );

    expect(turns[0]).toMatchObject({ role: 'user', text: tag });
    expect(turns[0]?.attachments).toBeUndefined();
  });

  it('leaves non-file-store media paths as text instead of fabricating a url', () => {
    // TUI/legacy cache names are not shaped like a file-store id (`f_…`), so the
    // tag must stay as text rather than becoming a broken /files/<name> request.
    const tag =
      '<video path="/tmp/550e8400-e29b-41d4-a716-446655440000-clip.mp4"></video>';
    const turns = messagesToTurns(
      [message('u1', 'user', [{ type: 'text', text: tag }])],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]).toMatchObject({ role: 'user', text: tag });
    expect(turns[0]?.attachments).toBeUndefined();
  });

  it('recovers a playable fileId for an uploaded-video tool result (ms:// url)', () => {
    // ReadMediaFile on an uploaded video returns the provider-side `ms://…`
    // id as the media url — unloadable in the browser. The daemon serves the
    // same bytes at /files/<fileId>, and that id rides in the `<video path>`
    // cache tag, so the tool media must carry it for the player to work.
    const fileId = 'f_d328dfaf-67b1-41a3-9858-bcfeb4faf0ef';
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          {
            type: 'toolUse',
            toolCallId: 'tool-1',
            toolName: 'ReadMediaFile',
            input: { path: `/Users/me/.kimi-code/cache/${fileId}.mov` },
          },
        ]),
        message('t1', 'tool', [
          {
            type: 'toolResult',
            toolCallId: 'tool-1',
            output: [
              { type: 'text', text: `<video path="/Users/me/.kimi-code/cache/${fileId}.mov">` },
              { type: 'video_url', videoUrl: { url: 'ms://fbgg8drsrxmi11ewk411', id: 'fbgg8drsrxmi11ewk411' } },
              { type: 'text', text: '</video>' },
            ],
          },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]?.tools).toHaveLength(1);
    expect(turns[0]?.tools?.[0]?.media).toMatchObject({
      kind: 'video',
      url: 'ms://fbgg8drsrxmi11ewk411',
      path: `/Users/me/.kimi-code/cache/${fileId}.mov`,
      fileId,
    });
  });

  it('leaves a tool-result video without a file-store path without fileId', () => {
    // TUI/legacy cache names are not file-store ids: no fileId to fetch with,
    // the raw (likely data:) url stays the only playable source.
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          { type: 'toolUse', toolCallId: 'tool-1', toolName: 'ReadMediaFile', input: {} },
        ]),
        message('t1', 'tool', [
          {
            type: 'toolResult',
            toolCallId: 'tool-1',
            output: [
              { type: 'text', text: '<video path="/tmp/550e8400-e29b-41d4-a716-446655440000-clip.mp4">' },
              { type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,AAAA' } },
              { type: 'text', text: '</video>' },
            ],
          },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    const media = turns[0]?.tools?.[0]?.media;
    expect(media).toMatchObject({ kind: 'video', url: 'data:video/mp4;base64,AAAA' });
    expect(media?.fileId).toBeUndefined();
  });

  it('does not attach the original upload’s fileId to a returned image', () => {
    // A region/crop read of an uploaded image returns the crop as a data: URL
    // while the path tag still names the original upload. The preview prefers
    // fileId over url (useFilePreview), so attaching it here would open the
    // original file instead of the returned crop — fileId must stay undefined
    // for anything but the unplayable ms:// case.
    const fileId = 'f_d328dfaf-67b1-41a3-9858-bcfeb4faf0ef';
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          { type: 'toolUse', toolCallId: 'tool-1', toolName: 'ReadMediaFile', input: {} },
        ]),
        message('t1', 'tool', [
          {
            type: 'toolResult',
            toolCallId: 'tool-1',
            output: [
              { type: 'text', text: `<image path="/Users/me/.kimi-code/cache/${fileId}.png">` },
              { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
              { type: 'text', text: '</image>' },
            ],
          },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    const media = turns[0]?.tools?.[0]?.media;
    expect(media).toMatchObject({ kind: 'image', url: 'data:image/png;base64,AAAA' });
    expect(media?.fileId).toBeUndefined();
  });

  it('strips the hidden image-compression caption from a user bubble', () => {
    // The server persists this `<system>` note as its own text part next to a
    // compressed upload (buildImageCompressionCaption). It is model-facing
    // harness metadata and must never render as user-typed text.
    const caption =
      '<system>Image compressed to fit model limits: original 3024x1834 image/png (934 KB) -> ' +
      'sent 2000x1213 image/png (518 KB). Fine detail may be lost. The uncompressed original ' +
      'is saved at "/Users/me/.kimi-code/files/f_0000000000000000000000000"; if you need fine ' +
      'detail, call ReadMediaFile on that path with the region parameter to view a crop at full ' +
      'fidelity.</system>';
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text: 'look at this' },
          { type: 'text', text: caption },
        ]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: 'user', text: 'look at this' });
    expect(turns[0]?.text).not.toContain('<system>');
  });

  it('drops a caption-only text part and strips captions merged into prose', () => {
    const caption =
      '<system>Image compressed to fit model limits: original 100x100 image/png (1 KB) -> ' +
      'sent 100x100 image/png (1 KB). Fine detail may be lost.</system>';

    // Image-only upload: the caption is the sole text part, so nothing
    // user-typed remains and the bubble text is empty (the image still renders).
    const captionOnly = messagesToTurns(
      [message('u1', 'user', [{ type: 'text', text: caption }])],
      [],
      undefined,
      false,
    );
    expect(captionOnly[0]).toMatchObject({ role: 'user', text: '' });

    // TUI-paste style: a caption merged into the surrounding text segment is
    // stripped without eating the prose around it.
    const merged = messagesToTurns(
      [message('u2', 'user', [{ type: 'text', text: `before ${caption} after` }])],
      [],
      undefined,
      false,
    );
    expect(merged[0]?.text).not.toContain('<system>');
    expect(merged[0]?.text).toContain('before');
    expect(merged[0]?.text).toContain('after');
  });

  it('preserves a literal `<system>` block the user typed themselves', () => {
    // Only the image-compression caption is harness metadata. A `<system>` tag
    // the user pasted on purpose (e.g. an XML / prompt example) is their own
    // text, so it must reach the bubble and the edit/resend payload verbatim.
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text: 'hi <system>some example markup</system> there' },
        ]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns[0]?.text).toBe('hi <system>some example markup</system> there');
  });

  it('leaves ordinary user text and stray angle brackets untouched', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text: 'a < b and c > d, no system tag here' },
        ]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns[0]).toMatchObject({ role: 'user', text: 'a < b and c > d, no system tag here' });
  });
});

describe('latestTodos', () => {
  it('returns the newest todo write and ignores later read-only queries', () => {
    expect(
      latestTodos([
        message('a1', 'assistant', [
          {
            type: 'toolUse',
            toolCallId: 'todo-1',
            toolName: 'TodoWrite',
            input: { todos: [{ title: 'old', status: 'pending' }] },
          },
        ]),
        message('a2', 'assistant', [
          {
            type: 'toolUse',
            toolCallId: 'todo-2',
            toolName: 'TodoWrite',
            input: JSON.stringify({ todos: [{ content: 'new', status: 'completed' }] }),
          },
        ]),
        message('a3', 'assistant', [
          { type: 'toolUse', toolCallId: 'todo-3', toolName: 'TodoRead', input: {} },
        ]),
      ]),
    ).toEqual([{ title: 'new', status: 'done' }]);
  });
});

describe('messagesToTurns cron', () => {
  it('renders a cron_job injection as a cron notice with the unwrapped prompt', () => {
    const envelope =
      '<cron-fire jobId="a3f9c2" cron="*/5 * * * *" recurring="true" coalescedCount="2" stale="false">\n' +
      '<prompt>\nCheck the deploy status\n</prompt>\n</cron-fire>';
    const turns = messagesToTurns(
      [
        message('c1', 'user', [{ type: 'text', text: envelope }], {
          metadata: {
            origin: {
              kind: 'cron_job',
              jobId: 'a3f9c2',
              cron: '*/5 * * * *',
              recurring: true,
              coalescedCount: 2,
              stale: false,
            },
          },
        }),
      ],
      [],
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      role: 'cron',
      text: 'Check the deploy status',
      cron: {
        jobId: 'a3f9c2',
        cron: '*/5 * * * *',
        recurring: true,
        coalescedCount: 2,
        stale: false,
      },
    });
  });

  it('renders a cron_missed injection as a cron notice carrying the missed count', () => {
    const envelope = '<cron-fire missed="3">\nDaily report\n</cron-fire>';
    const turns = messagesToTurns(
      [
        message('c2', 'user', [{ type: 'text', text: envelope }], {
          metadata: { origin: { kind: 'cron_missed', count: 3 } },
        }),
      ],
      [],
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      role: 'cron',
      text: 'Daily report',
      cron: { missedCount: 3 },
    });
  });

  it('does not also render a user bubble for a cron injection', () => {
    const turns = messagesToTurns(
      [
        message(
          'c3',
          'user',
          [{ type: 'text', text: '<cron-fire>\n<prompt>\nhi\n</prompt>\n</cron-fire>' }],
          {
            metadata: {
              origin: {
                kind: 'cron_job',
                jobId: 'j',
                cron: '* * * * *',
                recurring: true,
                coalescedCount: 1,
                stale: false,
              },
            },
          },
        ),
      ],
      [],
    );

    expect(turns.some((t) => t.role === 'user')).toBe(false);
    expect(turns).toHaveLength(1);
  });


  it('flushes an idle cron fire as its own turn even when no prompt ids are present', () => {
    const envelope =
      '<cron-fire jobId="j" cron="* * * * *" recurring="true" coalescedCount="1" stale="false">\n' +
      '<prompt>\nCheck BTC\n</prompt>\n</cron-fire>';
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'hi' }]),
        message('a1', 'assistant', [{ type: 'text', text: 'answer' }]),
        message('c1', 'user', [{ type: 'text', text: envelope }], {
          metadata: {
            origin: {
              kind: 'cron_job',
              jobId: 'j',
              cron: '* * * * *',
              recurring: true,
              coalescedCount: 1,
              stale: false,
            },
          },
        }),
        message('a2', 'assistant', [{ type: 'text', text: 'btc is 62k' }]),
      ],
      [],
    );

    // No prompt ids anywhere (REST-shaped): the cron still becomes its own
    // turn, and the cron-triggered reply does not merge into the first answer.
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'cron', 'assistant']);
  });
});

// Regression for kimi-code#2323: third-party OpenAI-compatible providers can
// persist one text part per stream chunk, so a history reload must concatenate
// adjacent same-kind parts within ONE message verbatim — joining them with
// '\n' renders long replies as vertical text.
describe('messagesToTurns stream-chunk parts', () => {
  it('concatenates chunked text parts within one assistant message verbatim', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          { type: 'text', text: 'grad' },
          { type: 'text', text: 'lew' },
          { type: 'text', text: '\n\nDone.' },
        ]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe('gradlew\n\nDone.');
    expect(turns[0]?.blocks).toEqual([{ kind: 'text', text: 'gradlew\n\nDone.' }]);
  });

  it('concatenates chunked thinking parts verbatim, merging their timing', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          {
            type: 'thinking',
            thinking: 'pla',
            startedAt: '2026-01-01T00:00:00.000Z',
            durationMs: 100,
          },
          {
            type: 'thinking',
            thinking: 'n',
            startedAt: '2026-01-01T00:00:00.100Z',
            durationMs: 100,
          },
          { type: 'text', text: 'answer' },
        ]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns[0]?.thinking).toBe('plan');
    expect(turns[0]?.blocks?.[0]).toMatchObject({
      kind: 'thinking',
      thinking: 'plan',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 200,
    });
  });

  it('keeps a newline between text segments from separate messages of one turn', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [{ type: 'text', text: 'step one' }]),
        message('a2', 'assistant', [{ type: 'text', text: 'step two' }]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe('step one\nstep two');
    expect(turns[0]?.blocks).toEqual([{ kind: 'text', text: 'step one\nstep two' }]);
  });

  it('keeps text segments split by a tool call as separate blocks', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          { type: 'text', text: 'before' },
          { type: 'toolUse', toolCallId: 'tool-1', toolName: 'read', input: { path: 'a.ts' } },
          { type: 'text', text: 'after' },
        ]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns[0]?.text).toBe('before\nafter');
    expect(turns[0]?.blocks?.map((b) => b.kind)).toEqual(['text', 'tool', 'text']);
  });

  it('dedupes a chunked persisted copy against its assembled live copy', () => {
    const chunked: AppMessageContent[] = [
      { type: 'text', text: 'grad' },
      { type: 'text', text: 'lew' },
    ];
    const assembled: AppMessageContent[] = [{ type: 'text', text: 'gradlew' }];
    const orders: [AppMessageContent[], AppMessageContent[]][] = [
      [assembled, chunked],
      [chunked, assembled],
    ];
    for (const [first, second] of orders) {
      const turns = messagesToTurns(
        [
          message('a1', 'assistant', first, { promptId: 'p1' }),
          message('a2', 'assistant', second, { promptId: 'p1' }),
        ],
        [],
        undefined,
        false,
      );

      expect(turns).toHaveLength(1);
      expect(turns[0]?.text).toBe('gradlew');
    }
  });
});
