import { t } from '#/i18n';

import { getLlmNotSetMessage, getNoActiveSessionMessage } from '../constant/kimi-tui';
import type { SlashCommandHost } from './dispatch';

interface ParsedDiscussArgs {
  topic: string;
  roles: string[];
  mode: 'discussion' | 'debate';
  stances: Record<string, string>;
}

/**
 * Parse `/discuss <topic> with <role1>,<role2>,...`
 * or `/discuss --debate <topic> with <role1>,<role2>,...`
 *
 * Returns `ParsedDiscussArgs` or an error string.
 */
function parseDiscussArgs(args: string): ParsedDiscussArgs | string {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return t('tui.messages.discussUsage');
  }

  // Check for --debate flag
  let mode: 'discussion' | 'debate' = 'discussion';
  let remaining = trimmed;
  if (/^--debate\b/i.test(remaining)) {
    mode = 'debate';
    remaining = remaining.replace(/^--debate\s*/i, '');
  }

  // Parse stances: role:stance pairs
  const stances: Record<string, string> = {};

  // Split on " with " (case-insensitive)
  const match = remaining.match(/^(.+?)\s+with\s+(.+)$/i);
  if (match === null) {
    // No "with" found — treat the whole thing as a topic with default roles
    return { topic: remaining, roles: ['researcher', 'architect', 'engineer'], mode, stances };
  }

  const topic = match[1]!.trim();
  const rolesRaw = match[2]!.split(',').map((r) => r.trim()).filter(Boolean);

  // Extract stances from roles: e.g. "engineer:argue for migration"
  const roles: string[] = [];
  for (const role of rolesRaw) {
    const stanceMatch = role.match(/^(.+?)\s*:\s*(.+)$/);
    if (stanceMatch) {
      roles.push(stanceMatch[1]!.trim());
      stances[stanceMatch[1]!.trim()] = stanceMatch[2]!.trim();
    } else {
      roles.push(role);
    }
  }

  if (topic.length === 0) {
    return t('tui.messages.discussNeedTopic');
  }
  if (roles.length < 2) {
    return t('tui.messages.discussNeedRoles');
  }

  return { topic, roles, mode, stances };
}

export async function handleDiscussCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  if (host.session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }

  if (host.state.appState.model.trim().length === 0) {
    host.showError(getLlmNotSetMessage());
    return;
  }

  const parsed = parseDiscussArgs(args);
  if (typeof parsed === 'string') {
    host.showError(parsed);
    return;
  }

  const { topic, roles, mode, stances } = parsed;

  // Enable swarm mode so SwarmDiscussion can auto-approve
  try {
    await host.requireSession().setSwarmMode(true, 'task');
  } catch (error) {
    host.showError(t('tui.messages.discussSwarmEnableFailed', { error: String(error) }));
    return;
  }
  host.setAppState({ swarmMode: true });

  // Build participant configs
  const participants = roles.map((role) => {
    // Escape quotes/backslashes so user-supplied roles can't break the
    // quoted string structure of the generated prompt.
    const safeRole = role.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const assignedStance = stances[role];
    const stanceField = assignedStance
      ? `, assignedStance: "${assignedStance.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      : '';
    return `{ profileName: "coder", roleDescription: "You are a ${safeRole} participating in a roundtable ${mode}.",${stanceField} }`;
  }).join(',\n      ');

  const prompt = [
    `Start a ${mode} on the following topic:`,
    ``,
    `Topic: ${topic}`,
    ``,
    `Participants: ${roles.join(', ')}`,
    ``,
    `Participant configs:`,
    `      ${participants}`,
    ``,
    mode === 'debate'
      ? [
          `Use the SwarmDiscussion tool with mode="debate" to start this structured debate.`,
          `Pass the topic, participants with their role descriptions and assigned stances,`,
          `and set maxRounds to ${Math.max(2, Math.ceil(roles.length / 2))}.`,
          `Set summaryPrompt to: "List points of consensus, remaining disagreements, and recommend a decision."`,
        ].join('\n')
      : [
          `Use the SwarmDiscussion tool to start this roundtable discussion.`,
          `Pass the topic, participants with their role descriptions,`,
          `and set maxRounds to ${Math.max(3, roles.length)}.`,
        ].join('\n'),
  ].join('\n');

  host.sendNormalUserInput(prompt);
}