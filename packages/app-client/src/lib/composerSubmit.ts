
import { parseSlash, matchSlashItem, buildSlashItems, modeCommandFor, SKILL_COMMAND_PREFIX, stripSkillPrefix, skillIdentity, skillRefMatches, defaultSkillPath, type SlashCommand, type SlashModeCommand } from '@moonshot-ai/app-core/lib';
import { removeAttachmentLinks, stripAttachmentLinks, type SkillMentionRef } from '@moonshot-ai/app-composer/model';
import { rewriteInlineLinksForSubmit } from './quoteSelection';
import type { PromptAttachment } from '../client/types';

export interface SubmitKindInput {
  text: string;
  blocked: boolean;
  assembly: { promptAttachments: PromptAttachment[]; fileAttIds: string[]; mediaAttIds: string[] };
  skillMentions: readonly SkillMentionRef[];
  skills: ReadonlyArray<{ name: string; description: string; source?: string }>;
  skillsLoaded: boolean;
  working: boolean;
  running: boolean;
  queueLength: number;
  goalMode: boolean;
  towerEnabled: boolean;
  extraBuiltins?: readonly SlashCommand[];
}

export interface SubmitDecisionInput extends SubmitKindInput {
  rewritten: string;
}

export type SubmitDecision =
  | { kind: 'noop' }
  | { kind: 'mode'; mode: 'plan' | 'goal' | 'swarm' | 'tower'; historyText: string }
  | { kind: 'skill-activation'; cmd: string; skillName: string; skillPath?: string; restoreText: string; attachments: PromptAttachment[]; historyText: string }
  | { kind: 'skill-command'; cmd: string; skillName: string; skillPath?: string; restoreText: string; attachments: PromptAttachment[]; historyText: string }
  | { kind: 'prompt-command'; cmd: string; target: 'main' | 'side'; attachments: PromptAttachment[]; restoreText: string; historyText: string; editText: string }
  | { kind: 'builtin-command'; cmd: string; leave: boolean; historyText: string; restoreText: string;
      editText?: string }
  | { kind: 'invalid-command'; cmd: string }
  | { kind: 'unresolved-skill-command'; cmd: string; restoreText: string; attachments: PromptAttachment[]; historyText: string }
  | { kind: 'multi-skill-activation'; text: string; skills: { name: string; path?: string }[]; restoreText: string; editText: string; attachments: PromptAttachment[]; historyText: string }
  | { kind: 'submit'; text: string; restoreText: string; editText: string; attachments: PromptAttachment[]; historyText: string };

export type SubmitKind =
  | { kind: 'noop' }
  | { kind: 'mode'; mode: SlashModeCommand; bareModeCommand: string }
  | { kind: 'multi-skill-activation'; skills: { name: string; path?: string }[] }
  | { kind: 'skill-activation'; skillName: string; skillPath?: string }
  | { kind: 'skill-command'; cmdToken: string; matched: SlashCommand }
  | { kind: 'invalid-command'; cmdToken: string }
  | { kind: 'builtin-command'; cmdToken: string; noArgs: boolean }
  | { kind: 'prompt-command'; cmdToken: string; target: 'main' | 'side' }
  | { kind: 'unresolved-skill-command'; cmdToken: string }
  | { kind: 'submit' };

export function steerHistoryText(trimmed: string): string {
  return trimmed !== '' && removeAttachmentLinks(trimmed).trim() === '' ? '' : stripAttachmentLinks(trimmed);
}

const COMMAND_CONTROLS: Record<string, readonly string[]> = { '/swarm': ['on', 'off'], '/goal': ['pause', 'resume', 'cancel'], '/btw': [] };

const leaves = (cmdToken: string): boolean => cmdToken === '/new' || cmdToken === '/clear';

export function commandNeedsProjectTrust(command: string): boolean {
  const parsed = parseSlash(command);
  if (parsed === null) return false;
  return leaves(parsed.cmd) ||
    parsed.cmd === '/compact' ||
    (parsed.cmd === '/tower' && ['status', 'teardown'].includes(parsed.arg.trim()));
}

export function isSessionBoundSubmit(decision: SubmitDecision): boolean {
  return decision.kind === 'submit' ||
    decision.kind === 'multi-skill-activation' ||
    decision.kind === 'skill-activation' ||
    decision.kind === 'skill-command' ||
    decision.kind === 'unresolved-skill-command' ||
    decision.kind === 'prompt-command' ||
    (decision.kind === 'builtin-command' && decision.leave);
}

export function decideSubmitKind(input: SubmitKindInput): SubmitKind {
  const { text: trimmed, blocked, assembly, skillMentions, skills, skillsLoaded, working, running, queueLength, goalMode } = input;

  if (!trimmed && assembly.promptAttachments.length === 0) return { kind: 'noop' };

  const bareText = removeAttachmentLinks(trimmed);
  const bareModeCommand = bareText.trim();

  const bareMode = modeCommandFor(bareModeCommand);
  if (bareMode !== undefined) return { kind: 'mode', mode: bareMode, bareModeCommand };
  if (trimmed) {
    const extraToken = bareModeCommand.match(/^\/\S+/)?.[0];
    const extra = input.extraBuiltins?.find((item) => item.name === extraToken);
    const cmdToken = extra?.name ?? parseSlash(bareText)?.cmd;
    const matched = extra ?? (cmdToken ? matchSlashItem(buildSlashItems(skills, { towerEnabled: input.towerEnabled }), cmdToken) : undefined);
    const staleSkillPill =
      skillMentions.length === 1 && skillsLoaded && !skills.some((skill) => {
        const mention = skillMentions[0]!;
        return skillRefMatches(skill, { name: mention.name, path: mention.path || undefined });
      });
    const multiActivatable =
      skillMentions.length >= 2 &&
      (!skillsLoaded ||
        skillMentions.every((mention) => skills.some((skill) =>
          skillRefMatches(skill, { name: mention.name, path: mention.path || undefined }),
        )));
    if (multiActivatable && !matched && !cmdToken?.startsWith(`/${SKILL_COMMAND_PREFIX}`)) {
      if (blocked) return { kind: 'noop' };
      const seen = new Set<string>();
      const activated = skillMentions
        .map((mention) => ({
          name: mention.name,
          path: mention.path || defaultSkillPath(skills, mention.name),
        }))
        .filter((mention) => {
          const key = skillIdentity(mention);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      return { kind: 'multi-skill-activation', skills: activated };
    }
    if (skillMentions.length === 1 && !staleSkillPill && !working && !running && queueLength === 0 && !matched && !goalMode) {
      if (blocked) return { kind: 'noop' };
      const mention = skillMentions[0]!;
      return { kind: 'skill-activation', skillName: mention.name, skillPath: mention.path || undefined };
    }

    if (cmdToken && matched) {
      if (matched.isSkill === true) {
        if (blocked) return { kind: 'noop' };
        return { kind: 'skill-command', cmdToken, matched };
      }
      if (matched.noArgs === true) {
        if (bareModeCommand.slice(cmdToken.length).trim() !== '') return { kind: 'invalid-command', cmdToken };
        return { kind: 'builtin-command', cmdToken, noArgs: true };
      }
      const argument = trimmed.slice(cmdToken.length).trim();
      if (argument !== '' && Object.hasOwn(COMMAND_CONTROLS, cmdToken) && !COMMAND_CONTROLS[cmdToken]!.includes(argument)) {
        if (blocked) return { kind: 'noop' };
        return { kind: 'prompt-command', cmdToken, target: cmdToken === '/btw' ? 'side' : 'main' };
      }
      return { kind: 'builtin-command', cmdToken, noArgs: false };
    }

    if (cmdToken?.startsWith(`/${SKILL_COMMAND_PREFIX}`)) {
      if (blocked) return { kind: 'noop' };
      return { kind: 'unresolved-skill-command', cmdToken };
    }
  }

  if (blocked) return { kind: 'noop' };
  return { kind: 'submit' };
}

export function decideComposerSubmit(input: SubmitDecisionInput): SubmitDecision {
  const plan = decideSubmitKind(input);
  const { text: trimmed, rewritten, assembly } = input;
  const historyText = (): string =>
    trimmed !== '' && removeAttachmentLinks(trimmed).trim() === '' ? '' : stripAttachmentLinks(rewritten);

  switch (plan.kind) {
    case 'noop':
      return { kind: 'noop' };
    case 'mode':
      return { kind: 'mode', mode: plan.mode, historyText: plan.bareModeCommand };
    case 'multi-skill-activation':
      return {
        kind: 'multi-skill-activation',
        text: rewriteInlineLinksForSubmit(rewritten).trim(),
        skills: plan.skills,
        restoreText: trimmed,
        editText: rewritten,
        attachments: assembly.promptAttachments,
        historyText: historyText(),
      };
    case 'skill-activation':
      return {
        kind: 'skill-activation',
        cmd: `/${SKILL_COMMAND_PREFIX}${plan.skillName} ${rewriteInlineLinksForSubmit(rewritten).trim()}`,
        skillName: plan.skillName,
        skillPath: plan.skillPath,
        restoreText: trimmed,
        attachments: assembly.promptAttachments,
        historyText: historyText(),
      };
    case 'skill-command': {
      const arg = rewriteInlineLinksForSubmit(rewritten.slice(plan.cmdToken.length)).trim();
      return {
        kind: 'skill-command',
        cmd: arg ? `${plan.cmdToken} ${arg}` : plan.cmdToken,
        skillName: stripSkillPrefix(plan.matched.name),
        restoreText: trimmed,
        attachments: assembly.promptAttachments,
        historyText: historyText(),
      };
    }
    case 'invalid-command':
      return { kind: 'invalid-command', cmd: plan.cmdToken };
    case 'builtin-command': {
      if (plan.noArgs) {
        return { kind: 'builtin-command', cmd: plan.cmdToken, leave: leaves(plan.cmdToken), historyText: plan.cmdToken, restoreText: trimmed };
      }
      const rawArg = rewriteInlineLinksForSubmit(trimmed.slice(plan.cmdToken.length)).trim();
      return {
        kind: 'builtin-command',
        cmd: stripAttachmentLinks(rawArg ? `${plan.cmdToken} ${rawArg}` : plan.cmdToken),
        leave: leaves(plan.cmdToken),
        historyText: stripAttachmentLinks(trimmed),
        restoreText: trimmed,
        editText: stripAttachmentLinks(trimmed.slice(plan.cmdToken.length)).trim(),
      };
    }
    case 'prompt-command': {
      const promptText = rewriteInlineLinksForSubmit(rewritten.slice(plan.cmdToken.length)).trim();
      return {
        kind: 'prompt-command',
        cmd: `${plan.cmdToken} ${promptText}`,
        target: plan.target,
        attachments: assembly.promptAttachments,
        restoreText: trimmed,
        historyText: historyText(),
        editText: rewritten.slice(plan.cmdToken.length).trim(),
      };
    }
    case 'unresolved-skill-command': {
      const arg = rewriteInlineLinksForSubmit(rewritten.slice(plan.cmdToken.length)).trim();
      return {
        kind: 'unresolved-skill-command',
        cmd: arg ? `${plan.cmdToken} ${arg}` : plan.cmdToken,
        restoreText: trimmed,
        attachments: assembly.promptAttachments,
        historyText: historyText(),
      };
    }
    case 'submit':
      return { kind: 'submit', text: rewriteInlineLinksForSubmit(rewritten).trim(), restoreText: trimmed, editText: rewritten, attachments: assembly.promptAttachments, historyText: historyText() };
  }
}
