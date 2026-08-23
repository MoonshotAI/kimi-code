import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LINK_BASE } from '@moonshot-ai/app-composer';
import { decideComposerSubmit, type SubmitDecisionInput } from '../src/lib/composerSubmit';
import type { PromptAttachment } from '../src/client/types';

const FILE_ATT: PromptAttachment = { fileId: 'f_pdf', kind: 'file', name: 'a.pdf' };
const IMG_ATT: PromptAttachment = { fileId: 'f_img', kind: 'image', name: 'x.png' };
const DEPLOY = { name: 'deploy', description: 'Deploy it' };

function input(partial: Partial<SubmitDecisionInput> = {}): SubmitDecisionInput {
  return {
    text: 'hello',
    rewritten: 'hello',
    blocked: false,
    assembly: { promptAttachments: [], rewriteAttIds: [] },
    skillMentions: [],
    skills: [],
    skillsLoaded: true,
    working: false,
    running: false,
    queueLength: 0,
    goalMode: false,
    ...partial,
  };
}

const fileLink = (attId: string, name = 'a.pdf') => `[${name}](${ATTACHMENT_LINK_BASE}${attId})`;

describe('decideComposerSubmit — the gate', () => {
  it('is a noop while the send gate is blocked', () => {
    expect(decideComposerSubmit(input({ blocked: true })).kind).toBe('noop');
  });

  it('is a noop for empty text without attachments, but submits an attachments-only send', () => {
    expect(decideComposerSubmit(input({ text: '', rewritten: '' })).kind).toBe('noop');
    const plan = decideComposerSubmit(input({ text: '', rewritten: '', assembly: { promptAttachments: [IMG_ATT], rewriteAttIds: [] } }));
    expect(plan).toMatchObject({ kind: 'submit', text: '', attachments: [IMG_ATT] });
  });
});

describe('decideComposerSubmit — plain submit', () => {
  it('passes the rewritten text and assembly attachments through', () => {
    const plan = decideComposerSubmit(
      input({
        text: `read ${fileLink('abc12345')} please`,
        rewritten: `read ${fileLink('1')} please`,
        assembly: { promptAttachments: [FILE_ATT], rewriteAttIds: ['abc12345'] },
      }),
    );
    expect(plan).toEqual({
      kind: 'submit',
      text: `read ${fileLink('1')} please`,
      // The gate-failure restore carries the PRE-REWRITE draft (attId links
      // intact) — the rewrite would degrade pills on the way back.
      restoreText: `read ${fileLink('abc12345')} please`,
      attachments: [FILE_ATT],
      // History recall is stripped to bare names — a recalled entry must not
      // revive dead pills out of the submit-time 1..N index links.
      historyText: 'read a.pdf please',
    });
  });

  it('records NO history for a pill-only message (a bare name is not a draft)', () => {
    const plan = decideComposerSubmit(
      input({
        text: fileLink('abc12345'),
        rewritten: fileLink('1'),
        assembly: { promptAttachments: [FILE_ATT], rewriteAttIds: ['abc12345'] },
      }),
    );
    expect(plan).toMatchObject({ kind: 'submit', historyText: '' });
    // Mixed text keeps the bare-name recall form.
    const mixed = decideComposerSubmit(
      input({
        text: `read ${fileLink('abc12345')}`,
        rewritten: `read ${fileLink('1')}`,
        assembly: { promptAttachments: [FILE_ATT], rewriteAttIds: ['abc12345'] },
      }),
    );
    expect(mixed).toMatchObject({ kind: 'submit', historyText: 'read a.pdf' });
  });

  it('records non-consuming commands by what actually executes, not the pill-stripped draft', () => {
    // `/plan` + a file pill executes the BARE command — recalling
    // `/plan report.pdf` would no longer match the mode branch.
    const mode = decideComposerSubmit(input({ text: `/plan ${fileLink('abc12345')}`, rewritten: `/plan ${fileLink('1')}` }));
    expect(mode).toMatchObject({ kind: 'mode', mode: 'plan', historyText: '/plan' });
    // `/new` + a folder pill executes bare `/new` — recalling `/new src`
    // would be a usage error.
    const noArg = decideComposerSubmit(input({ text: `/new ${fileLink('xyz789ab', 'src')}`, rewritten: '/new [src](/home/user/src/)' }));
    expect(noArg).toMatchObject({ kind: 'builtin-command', cmd: '/new', historyText: '/new' });
    // An arg-taking built-in recalls its executed cmd (bare names, no links).
    const argTaking = decideComposerSubmit(input({ text: `/btw what is ${fileLink('abc12345')}`, rewritten: `/btw what is ${fileLink('1')}` }));
    expect(argTaking).toMatchObject({ kind: 'builtin-command', cmd: '/btw what is a.pdf', historyText: '/btw what is a.pdf' });
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
    expect(plan).toMatchObject({ kind: 'builtin-command', cmd: '/goal fix the flake' });
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

  it('restores the PRE-REWRITE text on a gate failure (a folder pill must not degrade to a path mention)', () => {
    const text = `deploy ${fileLink('xyz789ab', 'src')}`;
    const plan = decideComposerSubmit(
      activation({
        text,
        // The submit rewrite turned the folder pill into a real-path mention.
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
    ['two skill pills', { skillMentions: [{ name: 'deploy' }, { name: 'deploy' }] }],
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
    // compact runs — the pill is a plain reference in its args (mention links
    // survive the attachment strip byte-identical).
    expect(plan).toMatchObject({ kind: 'builtin-command', cmd: text });
  });
});

describe('decideComposerSubmit — slash commands', () => {
  it('skill command: attachments come along, skillName is prefix-stripped', () => {
    const plan = decideComposerSubmit(
      input({
        text: '/skill:deploy now please',
        rewritten: '/skill:deploy now please',
        skills: [DEPLOY],
        assembly: { promptAttachments: [IMG_ATT], rewriteAttIds: [] },
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
    // The submit rewrite turned the folder pill into a real-path mention —
    // stripping the REWRITTEN text would leak `/new [src](/home/user/src/)`.
    const rewritten = '/new [src](/home/user/src/)';
    const plan = decideComposerSubmit(input({ text, rewritten }));
    expect(plan).toMatchObject({ kind: 'builtin-command', cmd: '/new', leave: true });
  });

  it('a no-arg command with junk after it is an invalid command — rejected LOCALLY, not sent to the skill default', () => {
    expect(decideComposerSubmit(input({ text: '/new foo', rewritten: '/new foo' }))).toEqual({ kind: 'invalid-command', cmd: '/new' });
    // Pills don't launder the junk: a typed arg stays a usage error.
    const text = `/new ${fileLink('xyz789ab', 'src')} foo`;
    expect(decideComposerSubmit(input({ text, rewritten: '/new [src](/x/) foo' }))).toEqual({ kind: 'invalid-command', cmd: '/new' });
    expect(decideComposerSubmit(input({ text: '/status now', rewritten: '/status now' }))).toEqual({ kind: 'invalid-command', cmd: '/status' });
  });

  it('an arg-taking built-in keeps the bare-name degrade on pre-rewrite args', () => {
    const text = `/btw what is ${fileLink('abc12345')}`;
    const plan = decideComposerSubmit(input({ text, rewritten: `/btw what is ${fileLink('1')}` }));
    expect(plan).toMatchObject({ kind: 'builtin-command', cmd: '/btw what is a.pdf', leave: false });
    // `/goal <objective>` legitimately travels the command path with args.
    expect(decideComposerSubmit(input({ text: '/goal fix the flake', rewritten: '/goal fix the flake' }))).toMatchObject({
      kind: 'builtin-command',
      cmd: '/goal fix the flake',
    });
  });

  it('an unresolved /skill: line still travels as an activation attempt', () => {
    const plan = decideComposerSubmit(
      input({
        text: '/skill:ghost run',
        rewritten: '/skill:ghost run',
        skills: [DEPLOY],
        assembly: { promptAttachments: [IMG_ATT], rewriteAttIds: [] },
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
    // `/new[pill]` — buildAttachmentInsertion only pads the tail, so the pill
    // lands directly after the token. The pill must not glue into it.
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
    expect(decideComposerSubmit(input({ text: '/btw hi', rewritten: '/btw hi', blocked: true }))).toMatchObject({ kind: 'builtin-command', cmd: '/btw hi' });
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
