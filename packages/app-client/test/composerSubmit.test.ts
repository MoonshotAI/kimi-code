import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LINK_BASE, rewriteAttachmentLinksForSubmit, serializeAttachment, serializePastedText, serializeQuote } from '@moonshot-ai/app-composer/model';
import { decideComposerSubmit, decideSubmitKind, steerHistoryText, type SubmitDecisionInput } from '../src/lib/composerSubmit';
import type { PromptAttachment } from '../src/client/types';

const FILE_ATT: PromptAttachment = { fileId: 'f_pdf', kind: 'file', name: 'a.pdf' };
const IMG_ATT: PromptAttachment = { fileId: 'f_img', kind: 'image', name: 'x.png' };
const DEPLOY = { name: 'deploy', description: 'Deploy it' };

function input(partial: Partial<SubmitDecisionInput> = {}): SubmitDecisionInput {
  return {
    text: 'hello',
    rewritten: 'hello',
    blocked: false,
    assembly: { promptAttachments: [], fileAttIds: [], mediaAttIds: [] },
    skillMentions: [],
    skills: [],
    skillsLoaded: true,
    working: false,
    running: false,
    queueLength: 0,
    goalMode: false,
    towerEnabled: true,
    ...partial,
  };
}

const fileLink = (attId: string, name = 'a.pdf') => `[${name}](${ATTACHMENT_LINK_BASE}${attId})`;
const quoteLink = (text: string) => serializeQuote({ text });

describe('decideComposerSubmit — the gate', () => {
  it('is a noop while the send gate is blocked', () => {
    expect(decideComposerSubmit(input({ blocked: true })).kind).toBe('noop');
  });

  it('is a noop for empty text without attachments, but submits an attachments-only send', () => {
    expect(decideComposerSubmit(input({ text: '', rewritten: '' })).kind).toBe('noop');
    const plan = decideComposerSubmit(input({ text: '', rewritten: '', assembly: { promptAttachments: [IMG_ATT], fileAttIds: [], mediaAttIds: [] } }));
    expect(plan).toMatchObject({ kind: 'submit', text: '', attachments: [IMG_ATT] });
  });
});

describe('decideComposerSubmit — plain submit', () => {
  it('submits a screenshot annotation with its readable comment instead of treating it as a command', () => {
    const text = serializeAttachment({ attId: 'shot1', name: '截图.png', kind: 'image', comment: '/plan' });
    const indexes = { fileAttIds: [], mediaAttIds: ['shot1'] };
    const plan = decideComposerSubmit(input({
      text,
      rewritten: rewriteAttachmentLinksForSubmit(text, indexes),
      assembly: { ...indexes, promptAttachments: [IMG_ATT] },
    }));
    expect(plan).toMatchObject({
      kind: 'submit',
      text: '> [截图.png](kimi-code-composer://attachments/m1)\n\n/plan',
      attachments: [IMG_ATT],
      restoreText: text,
      historyText: '截图.png\n/plan',
    });
  });
  it('passes the rewritten text and assembly attachments through', () => {
    const plan = decideComposerSubmit(
      input({
        text: `read ${fileLink('abc12345')} please`,
        rewritten: `read ${fileLink('1')} please`,
        assembly: { promptAttachments: [FILE_ATT], fileAttIds: ['abc12345'], mediaAttIds: [] },
      }),
    );
    expect(plan).toEqual({
      kind: 'submit',
      text: `read ${fileLink('1')} please`,
      restoreText: `read ${fileLink('abc12345')} please`,
      editText: `read ${fileLink('1')} please`,
      attachments: [FILE_ATT],
      historyText: 'read a.pdf please',
    });
  });

  it('expands pasted text verbatim in what is sent while history and edit keep the pill', () => {
    const body = 'line one\nline (two) [x]';
    const text = `look at ${serializePastedText({ text: body })} now`;
    const plan = decideComposerSubmit(input({ text, rewritten: text }));
    expect(plan).toMatchObject({
      kind: 'submit',
      text: `look at ${body} now`,
      editText: text,
      historyText: text,
    });
    const command = decideComposerSubmit(input({ text: `/btw ${text}`, rewritten: `/btw ${text}` }));
    expect(command).toMatchObject({ kind: 'prompt-command', cmd: `/btw look at ${body} now` });
  });

  it('records NO history for a pill-only message (a bare name is not a draft)', () => {
    const plan = decideComposerSubmit(
      input({
        text: fileLink('abc12345'),
        rewritten: fileLink('1'),
        assembly: { promptAttachments: [FILE_ATT], fileAttIds: ['abc12345'], mediaAttIds: [] },
      }),
    );
    expect(plan).toMatchObject({ kind: 'submit', historyText: '' });
    const mixed = decideComposerSubmit(
      input({
        text: `read ${fileLink('abc12345')}`,
        rewritten: `read ${fileLink('1')}`,
        assembly: { promptAttachments: [FILE_ATT], fileAttIds: ['abc12345'], mediaAttIds: [] },
      }),
    );
    expect(mixed).toMatchObject({ kind: 'submit', historyText: 'read a.pdf' });
  });

  it('records non-consuming commands by what actually executes, not the pill-stripped draft', () => {
    const mode = decideComposerSubmit(input({ text: `/plan ${fileLink('abc12345')}`, rewritten: `/plan ${fileLink('1')}` }));
    expect(mode).toMatchObject({ kind: 'mode', mode: 'plan', historyText: '/plan' });
    const noArg = decideComposerSubmit(input({ text: `/new ${fileLink('xyz789ab', 'src')}`, rewritten: '/new [src](/home/user/src/)' }));
    expect(noArg).toMatchObject({ kind: 'builtin-command', cmd: '/new', historyText: '/new' });
    const argTaking = decideComposerSubmit(input({ text: `/btw what is ${fileLink('abc12345')}`, rewritten: `/btw what is ${fileLink('1')}` }));
    expect(argTaking).toMatchObject({ kind: 'prompt-command', cmd: `/btw what is ${fileLink('1')}`, historyText: '/btw what is a.pdf' });
  });
});

describe('decideComposerSubmit — bare work-mode commands', () => {
  it.each(['/plan', '/goal', '/swarm'] as const)('consumes %s locally', (cmd) => {
    expect(decideComposerSubmit(input({ text: cmd, rewritten: cmd }))).toMatchObject({
      kind: 'mode',
      mode: cmd.slice(1),
    });
  });

  it('still matches the bare command when attachment pills ride along (wholesale removal, no fake args)', () => {
    const text = `/plan ${fileLink('abc12345')}`;
    const plan = decideComposerSubmit(input({ text, rewritten: `/plan ${fileLink('1')}` }));
    expect(plan).toMatchObject({ kind: 'mode', mode: 'plan' });
  });

  it('does NOT consume a mode command with real args — it travels as a slash command', () => {
    const plan = decideComposerSubmit(input({ text: '/goal fix the flake', rewritten: '/goal fix the flake' }));
    expect(plan).toMatchObject({ kind: 'prompt-command', cmd: '/goal fix the flake' });
  });

  it('does NOT consume bare /tower locally — it travels to the App for flag gating', () => {
    const plan = decideComposerSubmit(input({ text: '/tower', rewritten: '/tower' }));
    expect(plan).not.toMatchObject({ kind: 'mode', mode: 'tower' });
    expect(plan).toMatchObject({ kind: 'builtin-command', cmd: '/tower' });
  });

  it('leaves /tower commands as plain submits when the tower experiment is off', () => {
    const plan = decideComposerSubmit(input({ text: '/tower on', rewritten: '/tower on', towerEnabled: false }));
    expect(plan).toMatchObject({ kind: 'submit', text: '/tower on' });
  });
});

describe('decideComposerSubmit — single skill pill auto-activation', () => {
  const activation = (partial: Partial<SubmitDecisionInput> = {}) =>
    input({
      text: 'please deploy this',
      rewritten: 'please deploy this',
      skillMentions: [{ name: 'deploy' }],
      skills: [DEPLOY],
      ...partial,
    });

  it('activates when the session is fully idle', () => {
    const plan = decideComposerSubmit(activation());
    expect(plan).toEqual({
      kind: 'skill-activation',
      cmd: '/skill:deploy please deploy this',
      skillName: 'deploy',
      restoreText: 'please deploy this',
      attachments: [],
      historyText: 'please deploy this',
    });
  });

  it('preserves the selected variant path for a single pill activation', () => {
    const variant = { name: 'deploy', description: 'Secondary', path: '/work/B/deploy/SKILL.md' };
    const plan = decideComposerSubmit(
      activation({ skillMentions: [{ name: 'deploy', path: variant.path }], skills: [variant] }),
    );
    expect(plan).toMatchObject({ kind: 'skill-activation', skillName: 'deploy', skillPath: variant.path });
  });

  it('restores the PRE-REWRITE text on a gate failure (a folder pill must not degrade to a path mention)', () => {
    const text = `deploy ${fileLink('xyz789ab', 'src')}`;
    const plan = decideComposerSubmit(
      activation({
        text,
        rewritten: 'deploy [src](/home/user/src/)',
      }),
    );
    expect(plan).toMatchObject({ kind: 'skill-activation', restoreText: text });
  });

  it.each([
    ['working', { working: true }],
    ['running', { running: true }],
    ['a non-empty queue', { queueLength: 1 }],
    ['an armed goal intent', { goalMode: true }],
    ['a stale pill (skill gone from a loaded catalog)', { skills: [] }],
  ])('degrades to a plain submit when vetoed by %s', (_label, veto) => {
    expect(decideComposerSubmit(activation(veto)).kind).toBe('submit');
  });

  it('still activates on an unverifiable pill while the catalog is loading', () => {
    expect(decideComposerSubmit(activation({ skills: [], skillsLoaded: false })).kind).toBe('skill-activation');
  });

  it('an explicit known command wins over the pill', () => {
    const text = '/compact [deploy](kimi-code://skill/deploy)';
    const plan = decideComposerSubmit(activation({ text, rewritten: text }));
    expect(plan).toMatchObject({ kind: 'builtin-command', cmd: text });
  });
});

describe('decideComposerSubmit — multi skill pill bundled activation', () => {
  const REVIEW = { name: 'review', description: 'Review it' };
  const activation = (partial: Partial<SubmitDecisionInput> = {}) =>
    input({
      text: 'check this [deploy](kimi-code://skill/deploy) then [review](kimi-code://skill/review)',
      rewritten: 'check this [deploy](kimi-code://skill/deploy) then [review](kimi-code://skill/review)',
      skillMentions: [{ name: 'deploy' }, { name: 'review' }],
      skills: [DEPLOY, REVIEW],
      ...partial,
    });

  it('bundles every pill into ONE multi-skill-activation when fully idle', () => {
    const plan = decideComposerSubmit(activation());
    expect(plan).toEqual({
      kind: 'multi-skill-activation',
      text: 'check this [deploy](kimi-code://skill/deploy) then [review](kimi-code://skill/review)',
      skills: [{ name: 'deploy' }, { name: 'review' }],
      restoreText:
        'check this [deploy](kimi-code://skill/deploy) then [review](kimi-code://skill/review)',
      editText:
        'check this [deploy](kimi-code://skill/deploy) then [review](kimi-code://skill/review)',
      attachments: [],
      historyText:
        'check this [deploy](kimi-code://skill/deploy) then [review](kimi-code://skill/review)',
    });
  });

  it('dedupes repeated activations of the same skill (first occurrence wins)', () => {
    const plan = decideComposerSubmit(
      activation({ skillMentions: [{ name: 'deploy' }, { name: 'deploy' }, { name: 'review' }] }),
    );
    expect(plan).toMatchObject({
      kind: 'multi-skill-activation',
      skills: [{ name: 'deploy' }, { name: 'review' }],
    });
  });

  it('keeps same-name variants distinct by path', () => {
    const primary = { name: 'deploy', description: 'Primary', path: '/work/A/deploy/SKILL.md' };
    const secondary = { name: 'deploy', description: 'Secondary', path: '/work/B/deploy/SKILL.md' };
    const plan = decideComposerSubmit(
      activation({
        skillMentions: [
          { name: 'deploy', path: primary.path },
          { name: 'deploy', path: secondary.path },
        ],
        skills: [primary, secondary],
      }),
    );
    expect(plan).toMatchObject({
      kind: 'multi-skill-activation',
      skills: [
        { name: 'deploy', path: primary.path },
        { name: 'deploy', path: secondary.path },
      ],
    });
  });

  it('merges a pathless pill with the current default variant only', () => {
    const primary = { name: 'deploy', description: 'Primary', path: '/work/A/deploy/SKILL.md' };
    const secondary = { name: 'deploy', description: 'Secondary', path: '/work/B/deploy/SKILL.md' };
    const plan = decideComposerSubmit(
      activation({
        skillMentions: [
          { name: 'deploy' },
          { name: 'deploy', path: primary.path },
          { name: 'deploy', path: secondary.path },
        ],
        skills: [primary, secondary],
      }),
    );
    expect(plan).toMatchObject({
      kind: 'multi-skill-activation',
      skills: [
        { name: 'deploy', path: primary.path },
        { name: 'deploy', path: secondary.path },
      ],
    });
  });

  it('carries the attachments (the send gate applies)', () => {
    const plan = decideComposerSubmit(
      activation({
        text: 'x [a.pdf](kimi-code-attachment://abc12345)',
        rewritten: 'x [a.pdf](kimi-code-attachment://1)',
        assembly: { promptAttachments: [FILE_ATT], fileAttIds: ['abc12345'], mediaAttIds: [] },
      }),
    );
    expect(plan).toMatchObject({ kind: 'multi-skill-activation', attachments: [FILE_ATT] });
    expect(decideComposerSubmit(activation({ blocked: true })).kind).toBe('noop');
  });

  it.each([
    ['one pill stale on a loaded catalog', { skills: [DEPLOY] }],
  ])('degrades to a plain submit when vetoed by %s', (_label, veto) => {
    expect(decideComposerSubmit(activation(veto)).kind).toBe('submit');
  });

  it('keeps the bundled activation while the catalog is still loading (daemon validates the names)', () => {
    const plan = decideComposerSubmit(activation({ skills: [], skillsLoaded: false }));
    expect(plan).toMatchObject({
      kind: 'multi-skill-activation',
      skills: [{ name: 'deploy' }, { name: 'review' }],
    });
  });

  it.each([
    ['working', { working: true }],
    ['running', { running: true }],
    ['a non-empty queue', { queueLength: 1 }],
    ['an armed goal intent', { goalMode: true }],
  ])('stays a bundled activation when %s (the queue preserves the skills)', (_label, state) => {
    const plan = decideComposerSubmit(activation(state));
    expect(plan).toMatchObject({
      kind: 'multi-skill-activation',
      skills: [{ name: 'deploy' }, { name: 'review' }],
    });
  });

  it('an explicit known command wins over the pills', () => {
    const text = '/compact [deploy](kimi-code://skill/deploy) [review](kimi-code://skill/review)';
    const plan = decideComposerSubmit(activation({ text, rewritten: text }));
    expect(plan).toMatchObject({ kind: 'builtin-command', cmd: text });
  });

  it('an explicit UNRESOLVED `/skill:<name>` token owns the message (bundled activation must not hijack it)', () => {
    const text = '/skill:missing [deploy](kimi-code://skill/deploy) [review](kimi-code://skill/review)';
    const plan = decideComposerSubmit(activation({ text, rewritten: text }));
    expect(plan).toMatchObject({ kind: 'unresolved-skill-command', cmd: text });
  });
});

describe('decideComposerSubmit — slash commands', () => {
  it('skill command: attachments come along, skillName is prefix-stripped', () => {
    const plan = decideComposerSubmit(
      input({
        text: '/skill:deploy now please',
        rewritten: '/skill:deploy now please',
        skills: [DEPLOY],
        assembly: { promptAttachments: [IMG_ATT], fileAttIds: [], mediaAttIds: [] },
      }),
    );
    expect(plan).toEqual({
      kind: 'skill-command',
      cmd: '/skill:deploy now please',
      skillName: 'deploy',
      restoreText: '/skill:deploy now please',
      attachments: [IMG_ATT],
      historyText: '/skill:deploy now please',
    });
  });

  it('a hand-typed bare skill name resolves to its prefixed menu entry (TUI parity)', () => {
    const plan = decideComposerSubmit(input({ text: '/deploy now', rewritten: '/deploy now', skills: [DEPLOY] }));
    expect(plan).toMatchObject({ kind: 'skill-command', cmd: '/deploy now', skillName: 'deploy' });
  });

  it('built-in command: /new and /clear are marked leave, the rest are not', () => {
    expect(decideComposerSubmit(input({ text: '/new', rewritten: '/new' }))).toMatchObject({ kind: 'builtin-command', cmd: '/new', leave: true });
    expect(decideComposerSubmit(input({ text: '/clear', rewritten: '/clear' }))).toMatchObject({ kind: 'builtin-command', cmd: '/clear', leave: true });
    expect(decideComposerSubmit(input({ text: '/status', rewritten: '/status' }))).toMatchObject({ kind: 'builtin-command', cmd: '/status', leave: false });
  });

  it('a no-arg command with only pills riding along runs BARE (pills are not args — they stay pending)', () => {
    const text = `/new ${fileLink('xyz789ab', 'src')}`;
    const rewritten = '/new [src](/home/user/src/)';
    const plan = decideComposerSubmit(input({ text, rewritten }));
    expect(plan).toMatchObject({ kind: 'builtin-command', cmd: '/new', leave: true });
  });

  it('a no-arg command with junk after it is an invalid command — rejected LOCALLY, not sent to the skill default', () => {
    expect(decideComposerSubmit(input({ text: '/new foo', rewritten: '/new foo' }))).toEqual({ kind: 'invalid-command', cmd: '/new' });
    const text = `/new ${fileLink('xyz789ab', 'src')} foo`;
    expect(decideComposerSubmit(input({ text, rewritten: '/new [src](/x/) foo' }))).toEqual({ kind: 'invalid-command', cmd: '/new' });
    expect(decideComposerSubmit(input({ text: '/status now', rewritten: '/status now' }))).toEqual({ kind: 'invalid-command', cmd: '/status' });
  });

  it('a prompt command preserves rewritten attachment links', () => {
    const text = `/btw what is ${fileLink('abc12345')}`;
    const plan = decideComposerSubmit(input({ text, rewritten: `/btw what is ${fileLink('1')}` }));
    expect(plan).toMatchObject({ kind: 'prompt-command', target: 'side', cmd: `/btw what is ${fileLink('1')}` });
    expect(decideComposerSubmit(input({ text: '/goal fix the flake', rewritten: '/goal fix the flake' }))).toMatchObject({
      kind: 'prompt-command',
      target: 'main',
      cmd: '/goal fix the flake',
    });
  });

  it('an arg-taking built-in rewrites quote pills to `> ` blocks — the private scheme never leaks into args', () => {
    const text = `/btw ${quoteLink('引用')}`;
    const plan = decideComposerSubmit(input({ text, rewritten: text }));
    expect(plan).toMatchObject({ kind: 'prompt-command', cmd: '/btw > 引用' });
    expect((plan as { cmd?: string }).cmd).not.toContain('kimi-code-composer://');
    expect((plan as { historyText?: string }).historyText).toBe(text);
    expect((plan as { restoreText?: string }).restoreText).toBe(text);
    const multi = decideComposerSubmit(
      input({ text: `/goal 看这里 ${quoteLink('a\nb')} 对吗`, rewritten: `/goal 看这里 ${quoteLink('a\nb')} 对吗` }),
    );
    expect(multi).toMatchObject({ kind: 'prompt-command', cmd: '/goal 看这里\n\n> a\n> b\n\n\n对吗' });
  });

  it('an arg-taking built-in carries the arg-level editText for the busy-enqueue edit-reload', () => {
    const text = `/swarm 看 ${fileLink('abc12345')} 和 ${quoteLink('引用')}`;
    const plan = decideComposerSubmit(input({ text, rewritten: `/swarm 看 ${fileLink('1')} 和 ${quoteLink('引用')}` }));
    expect(plan).toMatchObject({ kind: 'prompt-command', cmd: `/swarm 看 ${fileLink('1')} 和\n\n> 引用` });
    const editText = (plan as { editText?: string }).editText!;
    expect(editText).toBe(`看 ${fileLink('1')} 和 ${quoteLink('引用')}`);
    expect(editText).toContain('kimi-code-composer://quote/');
    expect(editText).not.toContain('abc12345');
  });

  it('submit serializes quote pills for the daemon but keeps the pill link in history/restore', () => {
    const draft = quoteLink('引用');
    const plan = decideComposerSubmit(input({ text: draft, rewritten: draft }));
    expect(plan).toMatchObject({ kind: 'submit', text: '> 引用', restoreText: draft });
    expect((plan as { text?: string }).text).not.toContain('kimi-code-composer://');
    expect((plan as { historyText?: string }).historyText).toContain('kimi-code-composer://quote/');
    expect((plan as { restoreText?: string }).restoreText).toContain('kimi-code-composer://quote/');
    const withComment = decideComposerSubmit(
      input({ text: `${quoteLink('引用')} 评论`, rewritten: `${quoteLink('引用')} 评论` }),
    );
    expect(withComment).toMatchObject({ kind: 'submit', text: '> 引用\n\n\n评论' });
  });

  it('editText is the attachment-rewritten (1..N), quote-link-INTACT form the queue edit-reload expects', () => {
    const draft = `看 ${fileLink('abc12345')} 和 ${quoteLink('引用')}`;
    const rewritten = `看 ${fileLink('1')} 和 ${quoteLink('引用')}`;
    const plan = decideComposerSubmit(
      input({
        text: draft,
        rewritten,
        assembly: { promptAttachments: [FILE_ATT], rewriteAttIds: ['abc12345'] },
      }),
    );
    expect(plan).toMatchObject({ kind: 'submit', restoreText: draft });
    expect((plan as { text?: string }).text).toBe(`看 ${fileLink('1')} 和\n\n> 引用`);
    const editText = (plan as { editText?: string }).editText!;
    expect(editText).toBe(rewritten);
    expect(editText).toContain(`${ATTACHMENT_LINK_BASE}1`);
    expect(editText).toContain('kimi-code-composer://quote/');
    expect(editText).not.toContain('abc12345');
  });

  it('an unresolved /skill: line still travels as an activation attempt', () => {
    const plan = decideComposerSubmit(
      input({
        text: '/skill:ghost run',
        rewritten: '/skill:ghost run',
        skills: [DEPLOY],
        assembly: { promptAttachments: [IMG_ATT], fileAttIds: [], mediaAttIds: [] },
      }),
    );
    expect(plan).toEqual({
      kind: 'unresolved-skill-command',
      cmd: '/skill:ghost run',
      restoreText: '/skill:ghost run',
      attachments: [IMG_ATT],
      historyText: '/skill:ghost run',
    });
  });

  it('an unknown non-skill slash line falls through to a plain submit', () => {
    expect(decideComposerSubmit(input({ text: '/nosuch thing', rewritten: '/nosuch thing' })).kind).toBe('submit');
  });
});

describe('decideComposerSubmit — pill-adjacent command tokens', () => {
  it('recognizes a command glued to a pill (no space after the token) instead of falling through to a prompt', () => {
    const text = `/new${fileLink('xyz789ab', 'src')}`;
    const plan = decideComposerSubmit(input({ text, rewritten: `/new${fileLink('1', 'src')}` }));
    expect(plan).toMatchObject({ kind: 'builtin-command', cmd: '/new', leave: true });
  });

  it('separates the glued pill into the args of a skill command', () => {
    const text = `/skill:deploy${fileLink('abc12345')}`;
    const plan = decideComposerSubmit(input({ text, rewritten: `/skill:deploy${fileLink('1')}`, skills: [DEPLOY] }));
    expect(plan).toMatchObject({ kind: 'skill-command', cmd: `/skill:deploy ${fileLink('1')}` });
  });

  it('an explicit command glued to a pill still wins over the single-pill activation', () => {
    const text = `/compact${fileLink('abc12345')}`;
    const plan = decideComposerSubmit(
      input({ text, rewritten: `/compact${fileLink('1')}`, skillMentions: [{ name: 'deploy' }], skills: [DEPLOY] }),
    );
    expect(plan).toMatchObject({ kind: 'builtin-command', cmd: '/compact a.pdf' });
  });
});

describe('decideComposerSubmit — the gate only covers attachment-carrying branches', () => {
  it('runs non-consuming commands even when blocked (the pills stay pending)', () => {
    expect(decideComposerSubmit(input({ text: '/new', rewritten: '/new', blocked: true }))).toMatchObject({ kind: 'builtin-command', cmd: '/new' });
    expect(decideComposerSubmit(input({ text: '/plan', rewritten: '/plan', blocked: true }))).toMatchObject({ kind: 'mode', mode: 'plan' });
    expect(decideComposerSubmit(input({ text: '/btw hi', rewritten: '/btw hi', blocked: true }))).toEqual({ kind: 'noop' });
  });

  it('still rejects junk after a no-arg command when blocked', () => {
    expect(decideComposerSubmit(input({ text: '/new foo', rewritten: '/new foo', blocked: true }))).toEqual({ kind: 'invalid-command', cmd: '/new' });
  });

  it.each([
    ['a plain submit', input({ blocked: true })],
    ['a skill command', input({ text: '/skill:deploy x', rewritten: '/skill:deploy x', skills: [DEPLOY], blocked: true })],
    ['an unresolved /skill:', input({ text: '/skill:ghost x', rewritten: '/skill:ghost x', blocked: true })],
    ['a single-pill activation', input({ text: 'go', rewritten: 'go', skillMentions: [{ name: 'deploy' }], skills: [DEPLOY], blocked: true })],
  ])('blocks %s while the gate is closed', (_label, gateInput) => {
    expect(decideComposerSubmit(gateInput).kind).toBe('noop');
  });
});

describe('steerHistoryText', () => {
  it('keeps quote links, degrades attachments to bare names (or nothing)', () => {
    expect(steerHistoryText(quoteLink('引用'))).toBe(quoteLink('引用'));
    expect(steerHistoryText(fileLink('abc12345'))).toBe('');
    expect(steerHistoryText(`看 ${fileLink('abc12345')} 和 ${quoteLink('引用')}`)).toBe(
      `看 a.pdf 和 ${quoteLink('引用')}`,
    );
  });
});

it.each(['/swarm', '/goal', '/btw'])('%s arguments retain attachments and obey the upload gate', (command) => {
  const data = input({ text: `${command} inspect this`, rewritten: `${command} inspect this`, assembly: { promptAttachments: [IMG_ATT], fileAttIds: [], mediaAttIds: ['image'] } });
  expect(decideComposerSubmit(data)).toMatchObject({ kind: 'prompt-command', attachments: [IMG_ATT] });
  expect(decideComposerSubmit({ ...data, blocked: true })).toEqual({ kind: 'noop' });
});

describe('decideSubmitKind — agrees with decideComposerSubmit without rewriting the text', () => {
  const cases: Array<[string, Partial<SubmitDecisionInput>]> = [
    ['empty text', { text: '', rewritten: '' }],
    ['attachments only', { text: '', rewritten: '', assembly: { promptAttachments: [IMG_ATT], fileAttIds: [], mediaAttIds: [] } }],
    ['blocked plain text', { blocked: true }],
    ['mode command', { text: '/plan', rewritten: '/plan' }],
    ['builtin without arguments', { text: '/new', rewritten: '/new' }],
    ['builtin without arguments while blocked', { text: '/new', rewritten: '/new', blocked: true }],
    ['invalid command', { text: '/new extra', rewritten: '/new extra' }],
    ['builtin with argument', { text: '/compact keep tests', rewritten: '/compact keep tests' }],
    ['prompt command', { text: '/btw hello there', rewritten: '/btw hello there' }],
    ['prompt command while blocked', { text: '/btw hello there', rewritten: '/btw hello there', blocked: true }],
    ['unresolved skill command', { text: '/skill:zzz go', rewritten: '/skill:zzz go' }],
    ['skill command', { text: '/skill:deploy now', rewritten: '/skill:deploy now', skills: [DEPLOY] }],
    ['single skill mention', { text: 'use it', rewritten: 'use it', skillMentions: [{ name: 'deploy' }], skills: [DEPLOY] }],
    ['multiple skill mentions', { text: 'use both', rewritten: 'use both', skillMentions: [{ name: 'deploy' }, { name: 'review' }], skills: [DEPLOY, { name: 'review', description: 'Review it' }] }],
    ['attachment pill followed by a mode command', { text: `${fileLink('a1')} /plan`, rewritten: `${fileLink('a1')} /plan` }],
    ['attachment pill followed by text', { text: `${fileLink('a1')} please read`, rewritten: `${fileLink('a1')} please read` }],
    ['plain text', {}],
  ];
  for (const [name, partial] of cases) {
    it(name, () => {
      const data = input(partial);
      expect(decideSubmitKind(data).kind).toBe(decideComposerSubmit(data).kind);
    });
  }
});
