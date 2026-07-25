/**
 * Prompt Optimizer — Prompt parser.
 *
 * Parses system.md into sections, computes token estimates,
 * and generates variants (with sections removed/modified).
 */

import { readFileSync } from 'fs';
import type { PromptSection, PromptVariant } from './types';

/**
 * Rough token estimation: ~4 chars per token for English,
 * ~2 chars per token for CJK. Good enough for relative comparison.
 */
export function estimateTokens(text: string): number {
  let count = 0;
  for (const char of text) {
    count += char.charCodeAt(0) > 0x4e00 ? 0.5 : 0.25;
  }
  return Math.ceil(count);
}

/**
 * Parse a markdown prompt into sections by heading level.
 * Splits at lines starting with `#` (any level).
 */
export function parsePromptSections(content: string): PromptSection[] {
  const lines = content.split('\n');
  const sections: PromptSection[] = [];
  let currentHeading = '(preamble)';
  let currentStart = 0;
  let currentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#{1,3}\s/.test(line) && i > 0) {
      // Flush previous section
      const sectionContent = currentLines.join('\n');
      sections.push({
        heading: currentHeading,
        content: sectionContent,
        tokens: estimateTokens(sectionContent),
        startLine: currentStart + 1,
        endLine: i,
      });
      currentHeading = line.replace(/^#+\s*/, '').trim();
      currentStart = i;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  // Flush last section
  if (currentLines.length > 0) {
    const sectionContent = currentLines.join('\n');
    sections.push({
      heading: currentHeading,
      content: sectionContent,
      tokens: estimateTokens(sectionContent),
      startLine: currentStart + 1,
      endLine: lines.length,
    });
  }

  return sections;
}

/**
 * Load and parse a system prompt file.
 */
export function loadPrompt(path: string): { raw: string; sections: PromptSection[] } {
  const raw = readFileSync(path, 'utf-8');
  return { raw, sections: parsePromptSections(raw) };
}

/**
 * Generate a variant with a specific section removed.
 */
export function generatePruneVariant(
  sections: PromptSection[],
  removeHeading: string,
): PromptVariant {
  const remaining = sections.filter((s) => s.heading !== removeHeading);
  return {
    name: `prune:${removeHeading}`,
    description: `Removed section "${removeHeading}"`,
    content: remaining.map((s) => s.content).join('\n'),
    modifiedSections: [removeHeading],
  };
}

/**
 * Generate the baseline (unmodified) variant.
 */
export function generateBaselineVariant(sections: PromptSection[]): PromptVariant {
  return {
    name: 'baseline',
    description: 'Original unmodified prompt',
    content: sections.map((s) => s.content).join('\n'),
    modifiedSections: [],
  };
}
