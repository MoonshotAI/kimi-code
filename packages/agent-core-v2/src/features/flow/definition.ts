import { z } from 'zod';

import { CoreErrors } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';
import { FrontmatterError, parseFrontmatter } from '#/_base/text/frontmatter';

import { FlowGateKindSchema, type FlowDefinition, type FlowStageDefinition } from './flow';

export class FlowDefinitionParseError extends Error2 {
  constructor(message: string, cause?: unknown) {
    super(CoreErrors.codes.VALIDATION_FAILED, message, {
      cause,
      name: 'FlowDefinitionParseError',
    });
  }
}

const FLOW_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const FlowStageFrontmatterSchema = z
  .object({
    id: z.string().regex(FLOW_ID_PATTERN, 'stage id must be kebab-case'),
    objective: z.string().trim().min(1),
    completion: z.string().trim().min(1),
    gate: FlowGateKindSchema.default('ai'),
  })
  .strict();

const FlowFrontmatterSchema = z
  .object({
    id: z.string().regex(FLOW_ID_PATTERN, 'flow id must be kebab-case'),
    when: z.string().optional(),
    stages: z.array(FlowStageFrontmatterSchema).min(1),
  })
  .strict();

export function parseFlowDefinition(text: string): FlowDefinition {
  let parsed: { data: unknown; body: string };
  try {
    parsed = parseFrontmatter(text);
  } catch (error) {
    if (error instanceof FrontmatterError) {
      throw new FlowDefinitionParseError(`Invalid flow frontmatter: ${error.message}`, error);
    }
    throw error;
  }
  if (parsed.data === null) {
    throw new FlowDefinitionParseError(
      'Flow definition must start with a YAML frontmatter block (--- ... ---).',
    );
  }

  const result = FlowFrontmatterSchema.safeParse(parsed.data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new FlowDefinitionParseError(`Invalid flow definition: ${issues}`);
  }

  const stageIds = new Set<string>();
  for (const stage of result.data.stages) {
    if (stageIds.has(stage.id)) {
      throw new FlowDefinitionParseError(`Duplicate stage id: ${stage.id}`);
    }
    stageIds.add(stage.id);
  }

  const notes = extractStageNotes(parsed.body);
  for (const key of notes.keys()) {
    if (!stageIds.has(key)) {
      throw new FlowDefinitionParseError(
        `Notes heading \`## ${key}\` does not match any stage id (stages: ${[...stageIds].join(', ')})`,
      );
    }
  }
  const stages: FlowStageDefinition[] = result.data.stages.map((stage) => ({
    ...stage,
    notes: notes.get(stage.id),
  }));

  return { id: result.data.id, when: result.data.when, stages };
}

function extractStageNotes(body: string): Map<string, string> {
  const notes = new Map<string, string>();
  const lines = body.split('\n');
  let current: string | undefined;
  let buffer: string[] = [];
  const flush = (): void => {
    if (current === undefined) return;
    const text = buffer.join('\n').trim();
    if (text.length > 0) notes.set(current, text);
  };
  let fence: { marker: string; length: number } | undefined;
  for (const line of lines) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch !== undefined && fenceMatch !== null) {
      const marker = fenceMatch[1]![0]!;
      const length = fenceMatch[1]!.length;
      const infoString = line.slice(line.indexOf(fenceMatch[1]!) + length);
      if (fence === undefined) {
        if (marker === '`' && infoString.includes('`')) {
          if (current !== undefined) buffer.push(line);
          continue;
        }
        fence = { marker, length };
      } else if (
        fence.marker === marker &&
        length >= fence.length &&
        /^ {0,3}(`{3,}|~{3,})\s*$/.test(line)
      ) {
        fence = undefined;
      }
      if (current !== undefined) buffer.push(line);
      continue;
    }
    if (fence !== undefined) {
      if (current !== undefined) buffer.push(line);
      continue;
    }
    const heading = /^ {0,3}##\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (heading !== null) {
      flush();
      if (heading[1] !== undefined && notes.has(heading[1])) {
        throw new FlowDefinitionParseError(
          `Duplicate notes heading \`## ${heading[1]}\` — merge the sections into one`,
        );
      }
      current = heading[1];
      buffer = [];
      continue;
    }
    if (current !== undefined) buffer.push(line);
  }
  flush();
  return notes;
}
