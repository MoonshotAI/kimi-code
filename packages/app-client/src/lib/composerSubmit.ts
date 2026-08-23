// packages/app-client/src/lib/composerSubmit.ts
// The composer submit orchestration as a PURE decision function — both apps'
// Composer.vue reduce handleSubmit to an executor over the returned plan
// (ref mutations, editor calls, emits). Everything branch-deciding lives here
// so it can be unit-tested without a component: the send gate, the work-mode
// command match, the slash-command resolution order, the skill-pill
// auto-activation vetoes, and per-branch cmd/attachments/history semantics.
// DOM-free so node tests can drive it.

import { parseSlash, matchSlashItem, buildSlashItems, SKILL_COMMAND_PREFIX, stripSkillPrefix } from '@moonshot-ai/app-core/lib';
import { removeAttachmentLinks, stripAttachmentLinks } from '@moonshot-ai/app-composer';
import type { SkillMentionRef } from '@moonshot-ai/app-composer';
import type { PromptAttachment } from '../client/types';

export interface SubmitDecisionInput {
  /** text.value.trim() — the pre-rewrite draft. */
  text: string;
  /** rewriteForSubmit(text, assembly.rewriteAttIds) — the submit copy with
   *  attachment links rewritten (file pills → 1..N payload indices, folder
   *  pills → real-path mentions, links without a ready entry → bare names).
   *  Computed by the caller: folder-path resolution needs the live registry. */
  rewritten: string;
  /** The send gate: any uploading / errored / missing chip or pill entry.
   *  Applied ONLY to the branches that SEND attachments (a plain submit and
   *  the skill commands) — submitting through it would silently send the
   *  message WITHOUT the file: an in-flight upload heals itself (the user
   *  submits again in a moment); an errored or missing pill blocks until
   *  the user deletes the pill or re-drops the file. Non-consuming branches
   *  (the mode toggles and built-in commands) never touch the attachments —
   *  their pills stay pending — so they run even when the gate is closed
   *  (chip-era parity: a failed chip never locked `/new` or `/plan` out). */
  blocked: boolean;
  /** submitAssembly()'s result: ready media chips plus the doc's ready file
   *  pills interleaved by add-order stamp, and the link-rewrite attId list. */
  assembly: { promptAttachments: PromptAttachment[]; rewriteAttIds: string[] };
  /** editor.getSkillMentions() — the doc's skill pills in document order. */
  skillMentions: readonly SkillMentionRef[];
  /** The session's skills (the catalog behind the `/` menu). */
  skills: ReadonlyArray<{ name: string; description: string; source?: string }>;
  skillsLoaded: boolean;
  working: boolean;
  running: boolean;
  queueLength: number;
  goalMode: boolean;
}

/** What handleSubmit should do, with every branch-specific payload
 *  precomputed. `historyText` rides every non-noop plan — the executor pushes
 *  it for ↑/↓ recall BEFORE acting (commands are recallable too; the push
 *  ignores empty/whitespace, so an attachment-only send adds nothing). The
 *  text is STRIPPED to bare names first: a recalled entry revives pills from
 *  its link forms, and the submit-time 1..N index ids would come back as
 *  dead pills whose resend leaks dangling links — the chip era never
 *  restored attachments through history either. */
export type SubmitDecision =
  | { kind: 'noop' }
  /** A bare work-mode command consumed locally — it toggles the composer's
   *  mode pill instead of traveling as a slash command. The executor
   *  preserves the doc's pills across the text clear. */
  | { kind: 'mode'; mode: 'plan' | 'goal' | 'swarm'; historyText: string }
  /** Single-skill-pill auto-activation. restoreText: the gate-failure
   *  restore loads the PRE-REWRITE draft back (every pill's attId link
   *  intact — the rewrite would have turned a folder pill into a plain path
   *  mention, degrading it irreversibly; the executor pairs it with the
   *  original registry entries) — restoring the synthesized cmd would also
   *  prefix another `/skill:<name>` on every gate retry. skillName rides
   *  structured: a name with SPACES can't survive the space-delimited cmd
   *  string. */
  | { kind: 'skill-activation'; cmd: string; skillName: string; restoreText: string; attachments: PromptAttachment[]; historyText: string }
  /** An explicit known skill command (`/skill:<name>` or a bare `/<name>`
   *  that resolves to a skill menu entry), attachments consumed along.
   *  restoreText is the pre-rewrite draft, same contract as the
   *  activation's. */
  | { kind: 'skill-command'; cmd: string; skillName: string; restoreText: string; attachments: PromptAttachment[]; historyText: string }
  /** A known built-in command — never carries attachments. `leave` marks
   *  `/new` / `/clear`: the App leaves the session and unmounts the composer
   *  in the same flush, so the executor must persist the kept pills
   *  SYNCHRONOUSLY instead of the nextTick restore. */
  | { kind: 'builtin-command'; cmd: string; leave: boolean; historyText: string }
  /** A NO-ARG built-in command (SlashCommand.noArgs) with junk after it —
   *  a usage error. The executor shows a notice and keeps the draft
   *  untouched: emitting the parameterized cmd would fall through to the
   *  app's skill-activation default (skill.not_found) even though the
   *  command is NOT a skill. */
  | { kind: 'invalid-command'; cmd: string }
  /** An explicit `/skill:<name>` that resolves against NOTHING in the
   *  current catalog — still an activation attempt (the daemon's
   *  skill.not_found surfaces with the composer restore). restoreText is
   *  the pre-rewrite draft, same contract as the activation's. */
  | { kind: 'unresolved-skill-command'; cmd: string; restoreText: string; attachments: PromptAttachment[]; historyText: string }
  /** A plain prompt submit. restoreText is the PRE-REWRITE draft (every
   *  pill's attId link intact) — the gate-failure restore loads it back
   *  with the original registry entries (the executor's restoreEntries),
   *  or a folder pill would degrade into a plain path mention and a
   *  path-backed file would come back pathless. */
  | { kind: 'submit'; text: string; restoreText: string; attachments: PromptAttachment[]; historyText: string };

/** Decide what a submit does. The branch order is load-bearing and mirrors
 *  the long-standing handleSubmit flow: empty → bare mode command → (with
 *  text) single-skill-pill activation → known slash command → unresolved
 *  `/skill:` → plain submit. The send gate is checked PER BRANCH (see
 *  SubmitDecisionInput.blocked), not up front. */
export function decideComposerSubmit(input: SubmitDecisionInput): SubmitDecision {
  const { text: trimmed, rewritten, blocked, assembly, skillMentions, skills, skillsLoaded, working, running, queueLength, goalMode } = input;

  // Allow submission with attachments even when text is empty: ready media
  // chips plus the doc's ready file pills (files first — see submitAssembly).
  if (!trimmed && assembly.promptAttachments.length === 0) return { kind: 'noop' };

  // Bare work-mode commands are consumed locally — they toggle the composer's
  // mode pill instead of traveling as a slash command. `/plan` and `/goal`
  // swap each other out; with a live goal, `/goal` just focuses its panel.
  // The match ignores attachment pills (removeAttachmentLinks drops them
  // WHOLESALE — degrading to bare names would read as args): `/plan` plus
  // only pills is still the bare command, NOT a `/plan file.pdf` args
  // command. The pills stay pending for the next message, re-seeded after
  // the text clear exactly like the built-in branch's (chip-era parity:
  // toggling a mode never touched the attachment strip).
  const bareModeCommand = removeAttachmentLinks(trimmed).trim();

  // ↑/↓ recall must not record a pill-ONLY message as a fake typed text:
  // the stripped bare name would come back as a registry-less plain draft
  // whose resend sends just the filename. A message with real text keeps
  // the bare-name form (it recalls naturally); an attachment-only one
  // records nothing (push ignores empty/whitespace). The non-consuming
  // branches below record what actually EXECUTED (their cmd), not this
  // form: a recalled `/plan report.pdf` would no longer match the bare
  // mode branch, and a recalled `/new report.pdf` would be a usage error.
  const historyText = trimmed !== '' && bareModeCommand === '' ? '' : stripAttachmentLinks(rewritten);

  if (bareModeCommand === '/plan') return { kind: 'mode', mode: 'plan', historyText: bareModeCommand };
  if (bareModeCommand === '/goal') return { kind: 'mode', mode: 'goal', historyText: bareModeCommand };
  // `/swarm`: same enable-only consumption as the menu pick — the chip's × is
  // the off switch, so a click-send must not toggle the mode off (the App's
  // bare-/swarm handler would). `/swarm off` still travels as a command.
  if (bareModeCommand === '/swarm') return { kind: 'mode', mode: 'swarm', historyText: bareModeCommand };

  // If it's a known slash command, keep the optional tail as command input
  // instead of submitting it as normal chat text. This covers `/goal <task>`,
  // `/swarm <task>`, `/btw <question>`, slash skills with args, and bare
  // commands such as `/model`. A hand-typed bare skill name (`/deploy`) also
  // resolves to its prefixed menu entry (`/skill:deploy`), mirroring the TUI.
  //
  // A message carrying exactly ONE skill pill takes the same activation path:
  // the pill stands for `/skill:<name>` and the WHOLE text becomes the args —
  // the pill travels in its serialized mention-link form, so the sent bubble
  // shows the original message verbatim (the link revives into a pill there).
  // With TWO or more skill pills the message stays a plain prompt with link
  // references — each activation is its own turn, so multi-activation from
  // one message would be a mess. And while the session is BUSY the command
  // path would lose the message to a busy refusal, so the branch is skipped
  // and the normal submit queues the text like any other send.
  //
  // Attachment semantics across the command branches below: SKILL commands
  // (the single-skill-pill activation, an explicit `/skill:<name>`, and the
  // unresolved-`/skill:` fallback) take the composer's attachments along —
  // the daemon appends them to the activation's user message, so the cmd's
  // attachment links keep their rewritten 1..N form and the pills/chips are
  // consumed with the command. BUILT-IN commands never carry attachments:
  // their cmd's attachment links degrade to bare names (stripAttachmentLinks
  // — no payload rides along, so a link would dangle) and the doc's pills
  // are re-seeded (preserveAttachmentPills) so the attachments stay pending
  // for the next send, exactly what the chip era did by leaving the strip
  // untouched.
  if (trimmed) {
    // An explicit known slash command always wins over the single-skill-pill
    // auto-activation: '/compact [deploy](kimi-code://skill/deploy)' must run
    // compact (the pill is a plain reference in its args), not hijack into a
    // skill activation. Resolve the command FIRST — and recognize the command
    // TOKEN pill-insensitively: a pill inserted directly after the command
    // (no space — buildAttachmentInsertion only pads the tail) must not glue
    // itself into the token (`/new[file](…)` would otherwise read as an
    // unknown command and fall through to a plain prompt instead of running
    // /new). The token itself is rewrite-invariant, so the rewritten text's
    // remainder after it is the args (skill commands keep their
    // payload-aligned 1..N links there; built-ins re-strip from the
    // pre-rewrite text below).
    const cmdToken = parseSlash(removeAttachmentLinks(trimmed))?.cmd;
    const matched = cmdToken ? matchSlashItem(buildSlashItems(skills), cmdToken) : undefined;
    // A pill revived from a draft/history/edit-resend may name a skill GONE
    // from the workspace: the daemon would refuse the activation, the failure
    // restore would load the same text back, and every retry would loop the
    // same refusal — the message could never go out as a plain prompt. Once
    // the list is loaded, an unresolvable name degrades to a plain reference
    // (the same rule as multi-pill messages); while it is still loading the
    // name can't be verified, so the old attempt path stays.
    const staleSkillPill =
      skillMentions.length === 1 && skillsLoaded && !skills.some((s) => s.name === skillMentions[0]!.name);
    // Only activate when the session is FULLY idle with an empty queue.
    // A busy session makes the command path fire activateSkill immediately
    // into a running turn — and the composer has already cleared by the time
    // a busy refusal comes back, losing the message and its attachments. A
    // non-empty queue would let the later skill jump the FIFO order the
    // normal submit path preserves (sendPrompt enqueues + flushes), and a
    // running-but-not-working state (approval/question pending) is the same
    // bypass. An armed GOAL intent also vetoes the shortcut: its objective
    // IS this message's text, and only the normal submit path writes
    // goalObjective and cashes the intent — activating here would drop the
    // goal entirely and leave the intent armed for the next message. Let
    // the normal submit path run instead: it queues the full serialized
    // text like any other busy send; on replay it goes out as a plain
    // prompt, matching the multi-pill degradation.
    if (skillMentions.length === 1 && !staleSkillPill && !working && !running && queueLength === 0 && !matched && !goalMode) {
      // The send gate applies here: the activation CARRIES the attachments.
      if (blocked) return { kind: 'noop' };
      const mention = skillMentions[0]!;
      return {
        kind: 'skill-activation',
        cmd: `/${SKILL_COMMAND_PREFIX}${mention.name} ${rewritten}`,
        skillName: mention.name,
        restoreText: trimmed,
        attachments: assembly.promptAttachments,
        historyText,
      };
    }

    if (cmdToken && matched) {
      if (matched.isSkill === true) {
        // Skill commands carry the attachments — the gate applies.
        if (blocked) return { kind: 'noop' };
        const arg = rewritten.slice(cmdToken.length).trim();
        return {
          kind: 'skill-command',
          cmd: arg ? `${cmdToken} ${arg}` : cmdToken,
          skillName: stripSkillPrefix(matched.name),
          restoreText: trimmed,
          attachments: assembly.promptAttachments,
          historyText,
        };
      }
      // Built-in command: no attachment payload (see the branch-semantics
      // comment above) — the doc's pills survive the text clear (the
      // executor's pill restore is invoked AFTER the clear, so the restore
      // lands on the fresh doc). Nothing rides along, so these run even
      // when the send gate is closed.
      if (matched.noArgs === true) {
        // A NO-ARG command: anything after the command token is a usage
        // error — EXCEPT attachment pills, which are not user-typed args
        // (they stay pending in the composer, so the cmd never mentions
        // them). Validate on the pre-rewrite text with pills removed
        // WHOLESALE (bareModeCommand): `/new` + only pills is the bare
        // command and runs; `/new foo` — with or without pills — is
        // rejected LOCALLY instead of falling through to the app's
        // skill-activation default (skill.not_found — the command is NOT
        // a skill).
        const bareParsed = parseSlash(bareModeCommand) ?? { cmd: cmdToken, arg: '' };
        if (bareParsed.arg.trim() !== '') return { kind: 'invalid-command', cmd: cmdToken };
        return { kind: 'builtin-command', cmd: cmdToken, leave: cmdToken === '/new' || cmdToken === '/clear', historyText: cmdToken };
      }
      // An arg-taking built-in: the links in the args degrade to bare names.
      // Strip from the PRE-REWRITE text: the rewrite has already turned a
      // folder pill into a plain path mention that stripAttachmentLinks no
      // longer recognizes, so stripping the rewritten args would send
      // `/btw [src](…/)` — a markdown link where the user typed plain text.
      const rawArg = trimmed.slice(cmdToken.length).trim();
      const cmd = stripAttachmentLinks(rawArg ? `${cmdToken} ${rawArg}` : cmdToken);
      return { kind: 'builtin-command', cmd, leave: cmdToken === '/new' || cmdToken === '/clear', historyText: cmd };
    }

    // An explicit `/skill:<name>` line that resolves against NOTHING in the
    // current catalog (list still loading, listSkills failed, or the skill
    // was removed — e.g. an undo refill for a since-deleted skill) must not
    // fall through to a plain prompt: the user plainly asked for an
    // activation, so send it down the command path anyway and let the
    // daemon's skill.not_found surface (with the composer restore) instead
    // of silently dropping the activation. It carries the attachments too —
    // the gate applies.
    if (cmdToken?.startsWith(`/${SKILL_COMMAND_PREFIX}`)) {
      if (blocked) return { kind: 'noop' };
      const arg = rewritten.slice(cmdToken.length).trim();
      return {
        kind: 'unresolved-skill-command',
        cmd: arg ? `${cmdToken} ${arg}` : cmdToken,
        restoreText: trimmed,
        attachments: assembly.promptAttachments,
        historyText,
      };
    }
  }

  // A plain submit sends the attachments — the gate applies.
  if (blocked) return { kind: 'noop' };
  return { kind: 'submit', text: rewritten, restoreText: trimmed, attachments: assembly.promptAttachments, historyText };
}
