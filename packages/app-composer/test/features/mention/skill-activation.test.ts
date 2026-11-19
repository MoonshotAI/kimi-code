import { describe, expect, it } from 'vitest';
import {
  canUndoSkillActivation,
  canUndoSkillActivations,
  skillActivationEditText,
  skillActivationHasPill,
  skillActivationsBubbleText,
  skillActivationsEditText,
  skillActivationsMatchText,
  skillActivationsMissingPills,
  skillSnapshotWithVariantPaths,
} from '../../../src/features/mention/skillActivation';
import { createComposerSnapshot, composerSnapshotDocument, docToText, serializeMention, textToDoc } from '../../../src/model';

const PILL_ARGS = '[deploy](kimi-code://skill/deploy) 帮我发一版';
const BARE_ARGS = '帮我发一版';

describe('skillActivationHasPill', () => {
  it('true when args carry exactly the activated skill as a pill', () => {
    expect(skillActivationHasPill({ name: 'deploy', args: PILL_ARGS })).toBe(true);
  });

  it('false for slash-typed bare args (no pill)', () => {
    expect(skillActivationHasPill({ name: 'deploy', args: BARE_ARGS })).toBe(false);
  });

  it('false when the pill names a DIFFERENT skill', () => {
    expect(
      skillActivationHasPill({ name: 'deploy', args: '[release](kimi-code://skill/release) go' }),
    ).toBe(false);
  });

  it('false when args carry extra skill links (revival would degrade)', () => {
    const args = '[deploy](kimi-code://skill/deploy) and [release](kimi-code://skill/release)';
    expect(skillActivationHasPill({ name: 'deploy', args })).toBe(false);
  });

  it('false without args', () => {
    expect(skillActivationHasPill({ name: 'deploy' })).toBe(false);
  });
});

describe('skillActivationEditText', () => {
  it('pill-composed args refill verbatim on a pill-capable composer', () => {
    expect(skillActivationEditText({ name: 'deploy', args: PILL_ARGS }, { revivePill: true })).toBe(
      PILL_ARGS,
    );
  });

  it('pill-composed args stay non-editable on a plain-text composer', () => {
    expect(skillActivationEditText({ name: 'deploy', args: PILL_ARGS }, { revivePill: false })).toBeNull();
    expect(canUndoSkillActivation({ name: 'deploy', args: PILL_ARGS }, { revivePill: false })).toBe(false);
  });

  it('slash-typed bare args refill as the synthesized command on both composers', () => {
    for (const revivePill of [true, false]) {
      expect(skillActivationEditText({ name: 'deploy', args: BARE_ARGS }, { revivePill })).toBe(
        `/skill:deploy ${BARE_ARGS}`,
      );
    }
  });

  it('synthesizes the bare command when the activation had no args', () => {
    expect(skillActivationEditText({ name: 'deploy' }, { revivePill: false })).toBe('/skill:deploy');
  });

  it('args with extra skill links take the command form (no pill revival)', () => {
    const args = '[deploy](kimi-code://skill/deploy) and [release](kimi-code://skill/release)';
    expect(skillActivationEditText({ name: 'deploy', args }, { revivePill: true })).toBe(
      `/skill:deploy ${args}`,
    );
  });

  it('a skill name with spaces cannot ride the command form — non-editable', () => {
    expect(
      skillActivationEditText({ name: 'write goal', args: 'x' }, { revivePill: true }),
    ).toBeNull();
    expect(canUndoSkillActivation({ name: 'write goal', args: 'x' }, { revivePill: true })).toBe(false);
  });
});

describe('skillActivationsMissingPills', () => {
  const ACTS = [{ name: 'deploy' }, { name: 'review' }];

  it('empty when every activation has a pill in the text', () => {
    const text = '[deploy](kimi-code://skill/deploy) then [review](kimi-code://skill/review)';
    expect(skillActivationsMissingPills(ACTS, text)).toEqual([]);
  });

  it('lists the activations the text does not name (CLI/TUI token text)', () => {
    expect(skillActivationsMissingPills(ACTS, '[deploy](kimi-code://skill/deploy) then review')).toEqual([
      { name: 'review' },
    ]);
    expect(skillActivationsMissingPills(ACTS, 'plain text')).toEqual(ACTS);
  });

  it('respects multiplicity: two activations of one skill need two pills', () => {
    const dupes = [{ name: 'deploy' }, { name: 'deploy' }];
    expect(skillActivationsMissingPills(dupes, '[deploy](kimi-code://skill/deploy) x')).toEqual([
      { name: 'deploy' },
    ]);
    expect(skillActivationsMissingPills(dupes, '[deploy](kimi-code://skill/deploy) [deploy](kimi-code://skill/deploy)')).toEqual([]);
  });

  it('a pill for a different skill does not count', () => {
    expect(
      skillActivationsMissingPills(ACTS, '[release](kimi-code://skill/release) go'),
    ).toEqual(ACTS);
  });
});

describe('same-name skill variants', () => {
  const primary = {
    name: 'deploy',
    path: '/work/A/deploy/SKILL.md',
  };
  const secondary = {
    name: 'deploy',
    path: '/work/B/deploy/SKILL.md',
  };
  const primaryPill = serializeMention({ kind: 'skill', ...primary });
  const secondaryPill = serializeMention({ kind: 'skill', ...secondary });
  const acts = [primary, secondary];
  const text = `${primaryPill} then ${secondaryPill}`;

  it('matches and restores activations by name and path', () => {
    expect(skillActivationsMissingPills(acts, text)).toEqual([]);
    expect(skillActivationsMatchText(acts, text)).toBe(true);
    expect(skillActivationsEditText(acts, text, { revivePill: true })).toBe(text);
    expect(skillActivationsBubbleText(acts, text)).toBe(text);
  });

  it('does not revive an explicit variant as a bare command', () => {
    expect(skillActivationEditText(secondary, { revivePill: true })).toBeNull();
  });

  it('restores a default-resolved command without discarding an explicit variant', () => {
    const act = { ...primary, args: 'src/app.ts' };

    expect(skillActivationEditText(act, { revivePill: true, defaultPath: primary.path })).toBe('/skill:deploy src/app.ts');
    expect(canUndoSkillActivation(act, { revivePill: true, defaultPath: primary.path })).toBe(true);
    expect(skillActivationEditText({ ...secondary, args: 'src/app.ts' }, { revivePill: true, defaultPath: primary.path })).toBeNull();
  });

  it('pins a legacy pathless pill to its resolved path when the default is unknown', () => {
    const legacy = '[deploy](kimi-code://skill/deploy)';
    const act = { ...secondary, args: legacy };

    expect(skillActivationHasPill(act)).toBe(true);
    expect(skillActivationEditText(act, { revivePill: true })).toBe(secondaryPill);
    expect(skillActivationsBubbleText([secondary], legacy)).toBe(legacy);
  });

  it('pins a legacy pathless pill to its resolved path when the default changes', () => {
    const legacy = '[deploy](kimi-code://skill/deploy)';
    const act = { ...secondary, args: `${legacy} src/app.ts` };

    expect(skillActivationEditText(act, { revivePill: true, defaultPath: primary.path })).toBe(
      `${secondaryPill} src/app.ts`,
    );
  });

  it('pins bundled legacy pills to their resolved variants when the default is unknown', () => {
    const legacy = '[deploy](kimi-code://skill/deploy)';
    const text = `${legacy} then ${secondaryPill}`;

    expect(skillActivationsMissingPills(acts, text)).toEqual([]);
    expect(skillActivationsMatchText(acts, text)).toBe(true);
    expect(skillActivationsBubbleText(acts, text)).toBe(text);
    expect(skillActivationsEditText(acts, text, { revivePill: true })).toBe(
      `${primaryPill} then ${secondaryPill}`,
    );
    expect(canUndoSkillActivations(acts, text, { revivePill: true })).toBe(true);
  });

  it('rejects bundled pathless pills whose same-name variants are ambiguous', () => {
    const legacy = '[deploy](kimi-code://skill/deploy)';
    const text = `${legacy} then ${legacy}`;

    expect(skillActivationsEditText(acts, text, { revivePill: true })).toBeNull();
    expect(canUndoSkillActivations(acts, text, { revivePill: true })).toBe(false);
  });

  it('restores uniquely named legacy activations when their defaults are available', () => {
    const legacyActs = [{ name: 'deploy' }, { name: 'review' }];
    const text = '[deploy](kimi-code://skill/deploy) then [review](kimi-code://skill/review)';
    const opts = {
      revivePill: true,
      defaultPath: (name: string) => `/work/A/${name}/SKILL.md`,
    };

    expect(skillActivationsEditText(legacyActs, text, opts)).toBe(text);
    expect(canUndoSkillActivations(legacyActs, text, opts)).toBe(true);
  });

  it('pins bundled legacy pills to a known non-default variant', () => {
    const legacy = '[deploy](kimi-code://skill/deploy)';
    const text = `${legacy} then ${legacy}`;
    const opts = { revivePill: true, defaultPath: () => primary.path };

    expect(skillActivationsEditText([secondary], text, opts)).toBe(
      `${secondaryPill} then ${secondaryPill}`,
    );
    expect(canUndoSkillActivations([secondary], text, opts)).toBe(true);
  });

  it('prefers an unclaimed variant over the current default for bundled legacy pills', () => {
    const legacy = '[deploy](kimi-code://skill/deploy)';
    const text = `${legacy} then ${secondaryPill}`;
    const opts = { revivePill: true, defaultPath: () => secondary.path };

    expect(skillActivationsEditText(acts, text, opts)).toBe(`${primaryPill} then ${secondaryPill}`);
    expect(canUndoSkillActivations(acts, text, opts)).toBe(true);
  });

  it('pins skill mentions inside composer snapshots without dropping metadata', () => {
    const legacy = '[deploy](kimi-code://skill/deploy)';
    const snapshot = createComposerSnapshot(
      textToDoc(`${legacy} then ${secondaryPill}`, { reviveMentions: true }),
      [],
      [],
    );

    const restored = skillSnapshotWithVariantPaths(acts, snapshot, { defaultPath: () => secondary.path });

    expect(docToText(composerSnapshotDocument(restored))).toBe(`${primaryPill} then ${secondaryPill}`);
    expect(restored.attachments).toBe(snapshot.attachments);
    expect(restored.attachmentOrder).toBe(snapshot.attachmentOrder);
  });
});

describe('skillActivationsEditText', () => {
  const ACTS = [{ name: 'deploy' }, { name: 'review' }];
  const TEXT = '[deploy](kimi-code://skill/deploy) then [review](kimi-code://skill/review)';

  it('refills verbatim when every activation revives as a pill', () => {
    expect(skillActivationsEditText(ACTS, TEXT, { revivePill: true })).toBe(TEXT);
    expect(canUndoSkillActivations(ACTS, TEXT, { revivePill: true })).toBe(true);
  });

  it('stays non-editable when any activation lacks a pill (synthesized multi commands would degrade)', () => {
    expect(skillActivationsEditText(ACTS, '/deploy then review', { revivePill: true })).toBeNull();
    expect(canUndoSkillActivations(ACTS, '/deploy then review', { revivePill: true })).toBe(false);
  });

  it('stays non-editable on a plain-text composer', () => {
    expect(skillActivationsEditText(ACTS, TEXT, { revivePill: false })).toBeNull();
    expect(canUndoSkillActivations(ACTS, TEXT, { revivePill: false })).toBe(false);
  });

  it('stays non-editable for a single-item bundled origin', () => {
    const acts = [{ name: 'deploy' }];
    const text = '[deploy](kimi-code://skill/deploy)';
    expect(skillActivationsEditText(acts, text, { revivePill: true })).toBeNull();
    expect(canUndoSkillActivations(acts, text, { revivePill: true })).toBe(false);
  });

  it('replays a single deduped activation when two same-name pills preserve the bundled path', () => {
    const acts = [{ name: 'deploy' }];
    const text = '[deploy](kimi-code://skill/deploy) [deploy](kimi-code://skill/deploy)';
    expect(skillActivationsEditText(acts, text, { revivePill: true })).toBe(text);
    expect(canUndoSkillActivations(acts, text, { revivePill: true })).toBe(true);
  });

  it('merges legacy and current default pills when restoring bundled text', () => {
    const defaultPath = '/work/A/review/SKILL.md';
    const legacy = serializeMention({ kind: 'skill', name: 'review' });
    const selected = serializeMention({ kind: 'skill', name: 'review', path: defaultPath });
    const text = `${legacy} then ${selected}`;
    const acts = [{ name: 'review', path: defaultPath }];
    const opts = {
      revivePill: true,
      defaultPath: (name: string) => name === 'review' ? defaultPath : undefined,
    };

    expect(skillActivationsEditText(acts, text, opts)).toBe(text);
    expect(canUndoSkillActivations(acts, text, opts)).toBe(true);
  });

  it('does not replay a duplicate-pill bundle whose text will be intercepted as a command', () => {
    const pill = '[deploy](kimi-code://skill/deploy)';
    const acts = [{ name: 'deploy' }];
    for (const text of [
      `/compact ${pill} ${pill}`,
      `/deploy ${pill} ${pill}`,
      `/skill:deploy ${pill} ${pill}`,
      `/review ${pill} ${pill}`,
      `/unknown ${pill} ${pill}`,
    ]) {
      expect(skillActivationsEditText(acts, text, { revivePill: true })).toBeNull();
      expect(canUndoSkillActivations(acts, text, { revivePill: true })).toBe(false);
    }
  });

  it('stays non-editable when any activation carries structured args (a verbatim resend would drop them)', () => {
    const withArgs = [{ name: 'deploy', args: 'to prod' }, { name: 'review' }];
    expect(skillActivationsEditText(withArgs, TEXT, { revivePill: true })).toBeNull();
    expect(canUndoSkillActivations(withArgs, TEXT, { revivePill: true })).toBe(false);
  });

  it('stays non-editable when the text carries an EXTRA reference-only pill (resend would activate it)', () => {
    const extraPill = `${TEXT} and [cleanup](kimi-code://skill/cleanup)`;
    expect(skillActivationsEditText(ACTS, extraPill, { revivePill: true })).toBeNull();
    expect(canUndoSkillActivations(ACTS, extraPill, { revivePill: true })).toBe(false);
  });

  it('ALLOWS extra occurrences of an already-active name (the submit dedupes by name)', () => {
    const duped = '[deploy](kimi-code://skill/deploy) [deploy](kimi-code://skill/deploy) [review](kimi-code://skill/review)';
    expect(skillActivationsEditText([{ name: 'deploy' }, { name: 'review' }], duped, { revivePill: true })).toBe(duped);
    expect(canUndoSkillActivations([{ name: 'deploy' }, { name: 'review' }], duped, { revivePill: true })).toBe(true);
  });

  it('rejects replay when the source pill order differs from the activation order', () => {
    const reversed = '[review](kimi-code://skill/review) [deploy](kimi-code://skill/deploy)';
    expect(skillActivationsEditText(ACTS, reversed, { revivePill: true })).toBeNull();
    expect(canUndoSkillActivations(ACTS, reversed, { revivePill: true })).toBe(false);
  });

  it('REJECTS when the origin itself carries a duplicated activation name (resend dedupe would collapse it)', () => {
    const foreignDupes = [{ name: 'deploy' }, { name: 'deploy' }];
    const twoPills = '[deploy](kimi-code://skill/deploy) x [deploy](kimi-code://skill/deploy)';
    expect(skillActivationsEditText(foreignDupes, twoPills, { revivePill: true })).toBeNull();
    expect(canUndoSkillActivations(foreignDupes, twoPills, { revivePill: true })).toBe(false);
  });

  it('respects multiplicity in the exact-match gate (two same-skill activations need two pills)', () => {
    const dupes = [{ name: 'deploy' }, { name: 'deploy' }];
    const two = '[deploy](kimi-code://skill/deploy) x [deploy](kimi-code://skill/deploy)';
    expect(skillActivationsMatchText(dupes, two)).toBe(true);
    expect(skillActivationsMatchText(dupes, '[deploy](kimi-code://skill/deploy) x')).toBe(false);
  });
});

describe('skillActivationsBubbleText', () => {
  it('shows structured args behind an in-text pill (the args otherwise vanish from the bubble)', () => {
    const acts = [{ name: 'deploy', args: 'to prod' }];
    const text = '[deploy](kimi-code://skill/deploy)';
    expect(skillActivationsBubbleText(acts, text)).toBe('[deploy](kimi-code://skill/deploy) to prod');
  });

  it('does not duplicate args the text already carries verbatim', () => {
    const acts = [{ name: 'deploy', args: 'to prod' }];
    const text = '[deploy](kimi-code://skill/deploy) to prod';
    expect(skillActivationsBubbleText(acts, text)).toBe(text);
  });

  it('does not mistake an adjacent word containing short args for the args itself', () => {
    const pill = '[deploy](kimi-code://skill/deploy)';
    expect(skillActivationsBubbleText([{ name: 'deploy', args: 'prod' }], `${pill} production notes`)).toBe(
      `${pill} prod production notes`,
    );
    expect(skillActivationsBubbleText([{ name: 'deploy', args: 'prod' }], `${pill} prod notes`)).toBe(
      `${pill} prod notes`,
    );
  });

  it('still synthesizes a pill (with args) for activations the text does not name', () => {
    const acts = [{ name: 'deploy' }, { name: 'review', args: 'strict' }];
    const text = '[deploy](kimi-code://skill/deploy)';
    expect(skillActivationsBubbleText(acts, text)).toBe(
      '[deploy](kimi-code://skill/deploy) [review](kimi-code://skill/review) strict',
    );
  });

  it('inserts partially missing pills in structured activation order', () => {
    const deploy = '[deploy](kimi-code://skill/deploy)';
    const review = '[review](kimi-code://skill/review)';
    expect(
      skillActivationsBubbleText([{ name: 'deploy' }, { name: 'review' }], review),
    ).toBe(`[deploy](kimi-code://skill/deploy) ${review}`);
    expect(
      skillActivationsBubbleText(
        [{ name: 'deploy' }, { name: 'review' }, { name: 'test' }],
        review,
      ),
    ).toBe(`[deploy](kimi-code://skill/deploy) ${review} [test](kimi-code://skill/test)`);
    expect(
      skillActivationsBubbleText(
        [{ name: 'deploy', args: 'to prod' }, { name: 'review' }],
        deploy,
      ),
    ).toBe(`${deploy} to prod ${review}`);
  });

  it('does not count the args inside the pill’s hidden link target as visible', () => {
    const acts = [{ name: 'deploy', args: 'deploy' }];
    const text = '[deploy](kimi-code://skill/deploy)';
    expect(skillActivationsBubbleText(acts, text)).toBe(
      '[deploy](kimi-code://skill/deploy) deploy',
    );
  });

  it('preserves a structured mention arg unless its full link is already adjacent', () => {
    const deploy = '[deploy](kimi-code://skill/deploy)';
    const review = '[review](kimi-code://skill/review)';
    const acts = [{ name: 'deploy', args: review }];
    expect(skillActivationsBubbleText(acts, `${deploy} review`)).toBe(
      `${deploy} ${review} review`,
    );
    expect(skillActivationsBubbleText(acts, `${deploy} ${review}`)).toBe(
      `${deploy} ${review}`,
    );
  });

  it('returns the text verbatim when nothing needs arguing about', () => {
    const acts = [{ name: 'deploy' }];
    const text = '[deploy](kimi-code://skill/deploy) go';
    expect(skillActivationsBubbleText(acts, text)).toBe(text);
  });

  it('binds same-named activations to their own pills in occurrence order', () => {
    const pill = '[deploy](kimi-code://skill/deploy)';
    expect(
      skillActivationsBubbleText(
        [{ name: 'deploy', args: 'one' }, { name: 'deploy', args: 'two' }],
        `${pill} and ${pill}`,
      ),
    ).toBe(`${pill} one and ${pill} two`);
    expect(
      skillActivationsBubbleText(
        [{ name: 'deploy', args: 'one' }, { name: 'deploy', args: 'two' }],
        `${pill} one and ${pill}`,
      ),
    ).toBe(`${pill} one and ${pill} two`);
  });

  it('lets an args-free activation consume its pill before binding later args', () => {
    const pill = '[deploy](kimi-code://skill/deploy)';
    expect(
      skillActivationsBubbleText(
        [{ name: 'deploy' }, { name: 'deploy', args: 'to prod' }],
        `${pill} and ${pill}`,
      ),
    ).toBe(`${pill} and ${pill} to prod`);
  });

  it('does not bind later args to a Skill pill synthesized inside earlier args', () => {
    const deploy = '[deploy](kimi-code://skill/deploy)';
    const review = '[review](kimi-code://skill/review)';
    expect(
      skillActivationsBubbleText(
        [
          { name: 'deploy', args: `consult ${review}` },
          { name: 'review', args: 'strict' },
        ],
        `${deploy} then ${review}`,
      ),
    ).toBe(`${deploy} consult ${review} then ${review} strict`);
  });

  it('locates a non-canonical pill by its link range ([发布](kimi-code://skill/deploy)) — no double pill', () => {
    const text = '发 [发布](kimi-code://skill/deploy) 一版';
    expect(skillActivationsBubbleText([{ name: 'deploy', args: 'to prod' }], text)).toBe(
      '发 [发布](kimi-code://skill/deploy) to prod 一版',
    );
  });

  it('does not mistake args equal to ANOTHER skill pill’s URL tail for visible text', () => {
    const text = '[deploy](kimi-code://skill/deploy) x [review](kimi-code://skill/review)';
    expect(
      skillActivationsBubbleText(
        [{ name: 'deploy', args: 'kimi-code://skill/review' }, { name: 'review' }],
        text,
      ),
    ).toBe('[deploy](kimi-code://skill/deploy) kimi-code://skill/review x [review](kimi-code://skill/review)');
  });
});
