import { isAbsolute, join } from 'node:path';
import { lstat, stat } from 'node:fs/promises';
import { readClaudeSession } from '#/claude-code';
import { readRolloutSession } from '#/rollout';
import { saveEffectiveHistory, saveSourceCopy } from '#/archive';
import { DEFAULT_IMPORT_RATIO, renderHistory } from '#/render';
import type { ConversionIssue, ConversionOptions, ConversionResult, EffectiveHistory, HistoryTurn } from '#/types';

const CONTROL_WRAPPER = /^\s*<(command-message|command-name|command-args|local-command-caveat|local-command-stderr|local-command-stdout|task-notification|system-reminder|ide_opened_file|ide_selection)>[\s\S]*?<\/\1>/;
const IDE_REQUEST = /^## My request(?: for Codex)?:[ \t]*$/m;
const IMAGE_LINES = /^(?:\[Imported image reference: .*\]|<image name=.*>|<\/image>)$/gm;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function promptText(user: string): string {
  let text = user;
  for (let wrapper = CONTROL_WRAPPER.exec(text); wrapper; wrapper = CONTROL_WRAPPER.exec(text)) text = text.slice(wrapper[0].length);
  const request = IDE_REQUEST.exec(text);
  if (request) text = text.slice(request.index + request[0].length);
  return text.replaceAll(IMAGE_LINES, '').trim();
}

function fallbackTitle(turns: readonly HistoryTurn[]): string | undefined {
  for (const turn of turns) {
    const line = promptText(turn.user).split('\n').map(part => part.trim()).find(part => /[\p{L}\p{N}]/u.test(part));
    if (!line) continue;
    const graphemes = Array.from(GRAPHEMES.segment(line), ({ segment }) => segment);
    return graphemes.length > 120 ? `${graphemes.slice(0, 117).join('')}...` : line;
  }
  return undefined;
}

export function sourceIssues(history: EffectiveHistory): ConversionIssue[] {
  const fields: Array<[string, string, string]> = [
    ['invalidJsonLines', 'INVALID_SOURCE_RECORDS', 'Malformed JSON records were skipped.'],
    ['invalidRecords', 'INVALID_SOURCE_RECORDS', 'Invalid source records were skipped.'],
    ['unresolvedParentReferences', 'INCOMPLETE_SOURCE_CHAIN', 'Some source parent records could not be found.'],
    ['unresolvedPreservedReferences', 'INCOMPLETE_PRESERVED_HISTORY', 'Some preserved source history could not be reconstructed.'],
    ['chainCycles', 'INCOMPLETE_SOURCE_CHAIN', 'The source history contains a cycle.'],
    ['missingCompactionSummaries', 'UNAVAILABLE_COMPACTION_SUMMARY', 'A source compaction summary is missing.'],
    ['opaqueCompactionSteps', 'UNAVAILABLE_COMPACTION_SUMMARY', 'A source compaction checkpoint has no available plaintext.'],
    ['documentBlocks', 'OMITTED_NON_IMAGE_MEDIA', 'Source document payloads were omitted; the originals are in the source copy.'],
    ['binaryPayloadsOmitted', 'OMITTED_NON_IMAGE_MEDIA', 'Non-image binary payloads were omitted; the originals are in the source copy.'],
    ['metadataBinaryPayloads', 'OMITTED_NON_IMAGE_MEDIA', 'Non-image binary payloads in source metadata were omitted; the originals are in the source copy.'],
    ['unknownBlocks', 'UNRECOGNIZED_SOURCE_CONTENT', 'Unrecognized source content was retained where possible; its meaning was not interpreted.'],
    ['unknownContentBlocks', 'UNRECOGNIZED_SOURCE_CONTENT', 'Unrecognized source content was retained where possible; its meaning was not interpreted.'],
    ['unknownRecords', 'UNRECOGNIZED_SOURCE_CONTENT', 'Unrecognized source records were retained where possible; their meaning was not interpreted.'],
    ['unmatchedToolResults', 'UNMATCHED_TOOL_RESULTS', 'Some source tool results have no matching call in the effective history.'],
  ];
  const issues: ConversionIssue[] = [];
  for (const [field, code, message] of fields) {
    const value = history.stats[field];
    if (typeof value === 'number' && value > 0) issues.push({ code, stage: 'source', message, count: value });
  }
  const unresolved = history.imageReferences.filter(reference => reference.unresolved).length;
  if (unresolved) issues.push({ code: 'UNRESOLVED_IMAGE_REFERENCES', stage: 'attachment', message: 'Some image references could not be resolved against the source location.', count: unresolved });
  return issues;
}

export async function convertSession(options: ConversionOptions): Promise<ConversionResult> {
  let stage: ConversionIssue['stage'] = 'source';
  try {
    if (options.source !== 'claude-code' && options.source !== 'codex') throw Object.assign(new Error('Unsupported session source.'), { code: 'INVALID_SOURCE' });
    if (!Number.isSafeInteger(options.contextWindow) || options.contextWindow <= 0) throw Object.assign(new Error('contextWindow must be a positive safe integer.'), { code: 'INVALID_CONTEXT_WINDOW' });
    if (!isAbsolute(options.attachmentDirectory)) throw Object.assign(new Error('attachmentDirectory must be an absolute destination session attachment path.'), { code: 'INVALID_ATTACHMENT_DIRECTORY' });
    const tokenBudget = options.tokenBudget ?? Math.floor(options.contextWindow * DEFAULT_IMPORT_RATIO);
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0 || tokenBudget > options.contextWindow) throw Object.assign(new Error('tokenBudget must be positive and no larger than contextWindow.'), { code: 'INVALID_TOKEN_BUDGET' });
    stage = 'attachment';
    try {
      const destination = await lstat(options.attachmentDirectory);
      if (!destination.isDirectory() || destination.isSymbolicLink()) throw Object.assign(new Error('The attachment destination must be a real directory, not a symbolic link.'), { code: 'INVALID_ATTACHMENT_DIRECTORY' });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const readOptions = { imageDirectory: join(options.attachmentDirectory, 'images'), stateDatabasePath: options.stateDatabasePath };
    stage = 'source';
    const before = await stat(options.sourcePath, { bigint: true });
    const parsed = options.source === 'claude-code'
      ? await readClaudeSession(options.sourcePath, readOptions)
      : await readRolloutSession(options.sourcePath, readOptions);
    const history = { ...parsed, title: parsed.title ?? fallbackTitle(parsed.turns) };
    if (!history.summary?.trim() && !history.turns.some(turn => turn.user.trim())) throw Object.assign(new Error('The source session contains no conversation to import.'), { code: 'EMPTY_SOURCE_HISTORY' });
    const issues = sourceIssues(history);
    stage = 'attachment';
    const historyPath = await saveEffectiveHistory(history, options.attachmentDirectory, issues);
    const sourceCopy = await saveSourceCopy(history.source, options.sourcePath, options.attachmentDirectory, options.subagentPaths);
    const after = await stat(options.sourcePath, { bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ino !== before.ino) {
      stage = 'source';
      throw Object.assign(new Error('The source session changed while it was being imported.'), { code: 'SOURCE_CHANGED' });
    }
    stage = 'context';
    const { messages, stats, truncated } = renderHistory(history, { historyPath, sourceCopy }, tokenBudget, issues);
    if (truncated) issues.push({
      code: 'CONTEXT_TRUNCATED', stage: 'context',
      message: 'The model context contains only the most recent history that fits the budget. The full effective history is saved in the attachment.',
      count: stats.omittedTurns || undefined,
    });
    return { status: issues.length > 0 ? 'partial' : 'complete', source: history.source, sourceId: history.sourceId,
      title: history.title, cwd: history.cwd, lastPrompt: history.turns.map(turn => promptText(turn.user)).findLast(Boolean), messages, historyPath,
      sourceCopyDirectory: sourceCopy.directory, imageReferenceIndexPath: history.imageReferenceIndexPath, imageReferences: history.imageReferences, stats, issues };
  } catch (error) {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'CONVERSION_FAILED';
    const message = error instanceof Error ? error.message : 'Session conversion failed.';
    if (code.includes('IMAGE')) stage = 'attachment';
    return { status: 'unreliable', error: { code, message }, issues: [{ code, stage, message }] };
  }
}
