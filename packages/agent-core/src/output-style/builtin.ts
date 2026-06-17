import type { OutputStyle } from './types';
export const BUILTIN_OUTPUT_STYLES: readonly OutputStyle[] = [
  { name: 'concise', source: 'builtin', description: 'Terse, minimal-prose responses focused on the result.',
    body: ['Respond as briefly as the task allows. Prefer the answer or the action over explanation.',
      'Skip preamble, restating the question, and summaries unless explicitly asked.',
      'Use short sentences and compact lists. Never pad. Correctness and completeness still come first.'].join('\n') },
  { name: 'explanatory', source: 'builtin', description: 'Explains the reasoning and teaches as it works.',
    body: ['As you work, briefly explain the reasoning behind notable decisions and trade-offs so the user learns from the process.',
      'Call out alternatives you considered and why you rejected them, and surface non-obvious gotchas.',
      'Keep explanations proportional — enough to teach, never so much that it buries the result.'].join('\n') },
];
