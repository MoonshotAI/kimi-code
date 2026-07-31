/**
 * `_base` text helpers — Markdown frontmatter parsing.
 *
 * Splits a Markdown document into its YAML frontmatter block and body. Pure
 * text processing with no IO and no domain knowledge: skill definitions,
 * agent-definition files, and plugin command files all share this one parser
 * instead of depending on each other's domains for it. A document without a
 * leading `---` fence parses as all body with `data: null`; an unterminated
 * fence is a `FrontmatterError`.
 */

import { load as loadYaml } from 'js-yaml';

export class FrontmatterError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'FrontmatterError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause, configurable: true });
    }
  }
}

export interface ParsedFrontmatter {
  readonly data: unknown;
  readonly body: string;
}

const FENCE = '---';

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) {
    return { data: null, body: text };
  }

  const close = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE);
  if (close === -1) {
    throw new FrontmatterError('Missing closing frontmatter fence');
  }

  const yamlText = lines.slice(1, close).join('\n').trim();
  const body = lines.slice(close + 1).join('\n');
  if (yamlText === '') {
    return { data: {}, body };
  }

  try {
    return { data: loadYaml(yamlText) ?? {}, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FrontmatterError(message, error);
  }
}
