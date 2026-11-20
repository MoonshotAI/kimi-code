import { createUserMessage, type ContentPart } from '@moonshot-ai/core/llm/message';
import { sliceOnCodePointBoundary } from '#/_base/text/code-points';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { isUserPromptSubmitHookPart } from '#/agent/contextMemory/hookParts';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';

import REVIEW_REQUEST from './auto-review-request.md?raw';

const SECTION_TAG = /<(\/?(?:environment|project_instructions|history|pending_action)\b)/gi;
const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';
const MAX_ASSISTANT_MESSAGE_CHARS = 3_000;
const MAX_TOOL_ARGUMENTS_CHARS = 3_000;
const MAX_TOOL_RESULT_CHARS = 2_000;
const MAX_RECENT_TOOL_RESULTS = 15;
const MAX_NON_AUTHORITATIVE_HISTORY_CHARS = 40_000;

export interface VerifiedQuestionAnswer {
  readonly question: string;
  readonly answer: string;
}

export type ReviewText =
  | {
      readonly role: 'human-instruction' | 'direct-parent-instruction';
      readonly content: readonly ContentPart[];
    }
  | {
      readonly role: 'verified-user-answer';
      readonly answers: readonly VerifiedQuestionAnswer[];
    };

export interface ReviewGitStatus {
  readonly branch: string;
  readonly clean: boolean;
  readonly entries?: Readonly<Record<string, string>>;
}

interface TranscriptCandidate {
  readonly authoritative: boolean;
  readonly entry: Record<string, unknown>;
}

export function buildReviewMessages(
  messages: readonly ContextMessage[],
  rootAuthorization: readonly ReviewText[],
  instructions: string | undefined,
  instructionPaths: readonly string[] | undefined,
  cwd: string,
  context: ResolvedToolExecutionHookContext,
  approvedToolCallIds?: ReadonlySet<string>,
  gitStatus?: ReviewGitStatus,
): ReturnType<typeof createUserMessage>[] {
  const pendingIndex = context.toolCalls.findIndex((call) => call.id === context.toolCall.id);
  const pendingIds = new Set(
    pendingIndex < 0
      ? [context.toolCall.id]
      : context.toolCalls.slice(pendingIndex).map((call) => call.id),
  );
  const transcript = applyHistoryBudget(
    collectTranscriptCandidates(messages, pendingIds, approvedToolCallIds),
  );
  const historyPayload = rootAuthorization.length > 0
    ? { rootAuthorization, transcript }
    : { transcript };
  return [createUserMessage(renderPrompt(REVIEW_REQUEST, {
    environment: sectionJson({ cwd }),
    project_instructions: sectionJson({
      role: 'constraint',
      paths: instructionPaths ?? [],
      content: instructions ?? '',
    }),
    history: sectionJson(historyPayload),
    pending_action: sectionJson({
      name: context.toolCall.name,
      arguments: context.args,
      gitStatus,
    }),
  }))];
}

function sectionJson(value: unknown): string {
  return JSON.stringify(value).replace(SECTION_TAG, '\\u003c$1');
}

export function extractAuthorization(messages: readonly ContextMessage[]): ReviewText[] {
  const toolResults = collectToolResults(messages);
  const entries: ReviewText[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const entry = userAuthorizationEntry(message);
      if (entry !== undefined) entries.push(entry);
      continue;
    }
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (call.name !== ASK_USER_QUESTION_TOOL) continue;
      const verified = extractVerifiedAnswer(call.arguments, toolResults.get(call.id));
      if (verified !== undefined) {
        entries.push({ role: 'verified-user-answer', answers: verified });
      }
    }
  }
  return entries;
}

export function sameAuthorization(
  left: readonly ReviewText[],
  right: readonly ReviewText[],
): boolean {
  return left.length === right.length && left.every((entry, index) => sameAuthorizationEntry(entry, right[index]!));
}

function sameAuthorizationEntry(left: ReviewText, right: ReviewText): boolean {
  if (left.role !== right.role) return false;
  if (left.role === 'verified-user-answer' && right.role === 'verified-user-answer') {
    return left.answers.length === right.answers.length
      && left.answers.every((item, idx) =>
        item.question === right.answers[idx]!.question && item.answer === right.answers[idx]!.answer);
  }
  if (left.role !== 'verified-user-answer' && right.role !== 'verified-user-answer') {
    return left.content.length === right.content.length
      && left.content.every((part, idx) => {
        const other = right.content[idx]!;
        return part.type === 'text' && other.type === 'text' && part.text === other.text;
      });
  }
  return false;
}

function collectTranscriptCandidates(
  messages: readonly ContextMessage[],
  pendingIds: ReadonlySet<string>,
  approvedToolCallIds: ReadonlySet<string> | undefined,
): TranscriptCandidate[] {
  const toolResults = collectToolResults(messages, pendingIds);
  const completedToolIds: string[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (pendingIds.has(call.id) || call.name === ASK_USER_QUESTION_TOOL) continue;
      if (toolResults.has(call.id)) completedToolIds.push(call.id);
    }
  }
  const recentResultIds = new Set(completedToolIds.slice(-MAX_RECENT_TOOL_RESULTS));
  const candidates: TranscriptCandidate[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      if (message.origin?.kind === 'compaction_summary') {
        candidates.push({ authoritative: true, entry: { kind: 'compaction-marker' } });
        continue;
      }
      const auth = userAuthorizationEntry(message);
      if (auth !== undefined && auth.role !== 'verified-user-answer') {
        candidates.push({
          authoritative: true,
          entry: { kind: auth.role, content: auth.content },
        });
      }
      continue;
    }
    if (message.role !== 'assistant') continue;
    const text = renderTextContent(message.content, false).trim();
    if (text.length > 0) {
      candidates.push({
        authoritative: false,
        entry: {
          kind: 'assistant-message',
          role: 'context',
          text: truncateField(text, MAX_ASSISTANT_MESSAGE_CHARS),
        },
      });
    }
    for (const call of message.toolCalls) {
      if (pendingIds.has(call.id)) continue;
      const resultMessage = toolResults.get(call.id);
      if (call.name === ASK_USER_QUESTION_TOOL) {
        const verified = extractVerifiedAnswer(call.arguments, resultMessage);
        if (verified !== undefined) {
          candidates.push({
            authoritative: true,
            entry: { kind: 'verified-user-answer', answers: verified },
          });
        }
        continue;
      }
      const approved = approvedToolCallIds?.has(call.id) === true;
      candidates.push({
        authoritative: approved,
        entry: {
          kind: 'tool-call',
          role: 'fact',
          id: call.id,
          name: call.name,
          arguments: truncateField(call.arguments ?? '', MAX_TOOL_ARGUMENTS_CHARS),
          approved: approved ? true : undefined,
        },
      });
      if (resultMessage !== undefined && recentResultIds.has(call.id)) {
        const output = renderTextContent(resultMessage.content, true).trim();
        if (output.length > 0) {
          candidates.push({
            authoritative: false,
            entry: {
              kind: 'untrusted-tool-output',
              toolCallId: call.id,
              name: call.name,
              output: truncateField(output, MAX_TOOL_RESULT_CHARS),
            },
          });
        }
      }
    }
  }
  return candidates;
}

function applyHistoryBudget(candidates: readonly TranscriptCandidate[]): Record<string, unknown>[] {
  const kept = Array.from({ length: candidates.length }, () => false);
  let usedChars = 0;
  let droppedNonAuthoritative = false;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    if (candidate.authoritative) {
      kept[index] = true;
      continue;
    }
    if (droppedNonAuthoritative) continue;
    const length = JSON.stringify(candidate.entry).length;
    if (usedChars + length <= MAX_NON_AUTHORITATIVE_HISTORY_CHARS) {
      kept[index] = true;
      usedChars += length;
    } else {
      droppedNonAuthoritative = true;
    }
  }

  const result: Record<string, unknown>[] = [];
  let omittedCount = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    if (kept[index]) {
      if (omittedCount > 0) {
        result.push({ kind: 'history-truncated', omittedEntries: omittedCount });
        omittedCount = 0;
      }
      result.push(candidates[index]!.entry);
    } else {
      omittedCount += 1;
    }
  }
  if (omittedCount > 0) {
    result.push({ kind: 'history-truncated', omittedEntries: omittedCount });
  }
  return result;
}

function collectToolResults(
  messages: readonly ContextMessage[],
  pendingIds?: ReadonlySet<string>,
): Map<string, Extract<ContextMessage, { role: 'tool' }>> {
  const map = new Map<string, Extract<ContextMessage, { role: 'tool' }>>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    if (pendingIds?.has(message.toolCallId) === true) continue;
    map.set(message.toolCallId, message);
  }
  return map;
}

function userAuthorizationEntry(message: ContextMessage): ReviewText | undefined {
  if (message.role !== 'user') return undefined;
  const role = authorizationRole(message);
  if (role === undefined) return undefined;
  const content = message.content.flatMap(reviewPart);
  return content.length === 0 ? undefined : { role, content };
}

function authorizationRole(
  message: ContextMessage,
): 'human-instruction' | 'direct-parent-instruction' | undefined {
  const { origin } = message;
  if (origin === undefined) {
    const imported = message.content.some((part) =>
      part.type === 'text' && part.text.includes('<imported_conversation>'));
    return imported ? undefined : 'human-instruction';
  }
  if (origin.kind === 'user' || origin.kind === 'plugin_command') return 'human-instruction';
  if (origin.kind === 'skill_activation' && origin.trigger === 'user-slash') return 'human-instruction';
  if (origin.kind === 'system_trigger' && origin.name === 'subagent') return 'direct-parent-instruction';
  return undefined;
}

function extractVerifiedAnswer(
  rawArgs: string | null | undefined,
  resultMessage: Extract<ContextMessage, { role: 'tool' }> | undefined,
): VerifiedQuestionAnswer[] | undefined {
  if (resultMessage === undefined || resultMessage.isError === true) return undefined;
  const parsedResult = parseJsonObject(renderTextContent(resultMessage.content, false));
  const rawAnswers = parsedResult?.['answers'];
  if (!isPlainRecord(rawAnswers)) return undefined;
  const entries = Object.entries(rawAnswers).filter(([, value]) => typeof value === 'string' && value.length > 0);
  if (entries.length === 0) return undefined;
  const questionLabels = parseQuestionLabels(rawArgs);
  return entries.map(([key, value]) => ({
    question: questionLabels.get(key) ?? key,
    answer: String(value),
  }));
}

function parseQuestionLabels(rawArgs: string | null | undefined): Map<string, string> {
  const labels = new Map<string, string>();
  const parsed = parseJsonObject(rawArgs ?? '');
  const questions = parsed?.['questions'];
  if (!Array.isArray(questions)) return labels;
  for (const item of questions) {
    if (!isPlainRecord(item)) continue;
    const question = typeof item['question'] === 'string' ? item['question'] : undefined;
    const header = typeof item['header'] === 'string' ? item['header'] : undefined;
    if (question !== undefined) {
      labels.set(question, question);
      if (header !== undefined) labels.set(header, `${header}: ${question}`);
    }
  }
  return labels;
}

function renderTextContent(
  content: ContextMessage['content'],
  includeAttachmentPlaceholder: boolean,
): string {
  if (typeof content === 'string') return content;
  return content
    .flatMap((part) => {
      if (isUserPromptSubmitHookPart(part)) return [];
      if (part.type === 'text') return [part.text];
      return includeAttachmentPlaceholder ? [`[${part.type} attachment omitted]`] : [];
    })
    .join('\n');
}

function reviewPart(part: ContentPart): ContentPart[] {
  if (isUserPromptSubmitHookPart(part)) return [];
  if (part.type === 'text') return [part];
  return [{ type: 'text', text: `[${part.type} attachment omitted]` }];
}

function truncateField(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const kept = sliceOnCodePointBoundary(text, maxChars);
  return `${kept}[auto_review_truncated: ${String(text.length - kept.length)} chars omitted]`;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (text.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
