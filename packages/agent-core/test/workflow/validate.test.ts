import { describe, expect, it } from 'vitest';

import { KimiConfigSchema, KimiConfigPatchSchema } from '../../src/config/schema';
import { FLAG_DEFINITIONS } from '../../src/flags';
import {
  DEFAULT_WORKFLOW_LIMITS,
  WorkflowValidationError,
  compileWorkflowScript,
  extractWorkflowMeta,
  resolveWorkflowLimits,
  validateWorkflowMeta,
  validateWorkflowName,
} from '../../src/workflow';

const VALID_META = {
  name: 'deep-research',
  description: 'Research a topic in depth.',
  phases: [{ title: 'Plan' }, { title: 'Execute', detail: 'run the agents' }],
};

function scriptWithMeta(meta: unknown, body = 'return 1;'): string {
  return `export const meta = ${JSON.stringify(meta)};\n${body}\n`;
}

describe('validateWorkflowName', () => {
  it('accepts kebab-case names', () => {
    for (const name of ['a', 'deep-research', 'x1-y2-z3', 'a'.repeat(64)]) {
      expect(() => validateWorkflowName(name)).not.toThrow();
    }
  });

  it('rejects invalid names', () => {
    for (const name of ['', 'Upper', 'has_underscore', '-lead', 'trail-', 'a--b', 'ção', 'a'.repeat(65), '../evil']) {
      expect(() => validateWorkflowName(name)).toThrow(WorkflowValidationError);
    }
  });
});

describe('validateWorkflowMeta', () => {
  it('accepts a valid meta and returns it typed', () => {
    const meta = validateWorkflowMeta(VALID_META);
    expect(meta.name).toBe('deep-research');
    expect(meta.phases).toHaveLength(2);
  });

  it('rejects empty phases', () => {
    expect(() => validateWorkflowMeta({ ...VALID_META, phases: [] })).toThrow(
      WorkflowValidationError,
    );
  });

  it('rejects duplicate phase titles', () => {
    expect(() =>
      validateWorkflowMeta({ ...VALID_META, phases: [{ title: 'A' }, { title: 'A' }] }),
    ).toThrow(/unique/);
  });

  it('rejects more than 24 phases', () => {
    const phases = Array.from({ length: 25 }, (_, i) => ({ title: `Phase ${i}` }));
    expect(() => validateWorkflowMeta({ ...VALID_META, phases })).toThrow(WorkflowValidationError);
  });

  it('rejects invalid name and empty/overlong description', () => {
    expect(() => validateWorkflowMeta({ ...VALID_META, name: 'Bad Name' })).toThrow(
      WorkflowValidationError,
    );
    expect(() => validateWorkflowMeta({ ...VALID_META, description: '' })).toThrow(
      WorkflowValidationError,
    );
    expect(() => validateWorkflowMeta({ ...VALID_META, description: 'x'.repeat(501) })).toThrow(
      WorkflowValidationError,
    );
  });

  it('rejects non-object values', () => {
    expect(() => validateWorkflowMeta('nope')).toThrow(WorkflowValidationError);
  });

  it('accepts an optional argumentHint', () => {
    const meta = validateWorkflowMeta({ ...VALID_META, argumentHint: '<research question>' });
    expect(meta.argumentHint).toBe('<research question>');
  });

  it('rejects an argumentHint longer than 200 chars', () => {
    expect(() => validateWorkflowMeta({ ...VALID_META, argumentHint: 'x'.repeat(201) })).toThrow(
      WorkflowValidationError,
    );
  });
});

describe('compileWorkflowScript', () => {
  it('rejects a script without export const meta', () => {
    expect(() =>
      compileWorkflowScript('return 1;', { maxScriptBytes: 1024 }),
    ).toThrow(/missing export const meta/);
  });

  it('rejects a script with more than one export const meta', () => {
    const script = `${scriptWithMeta(VALID_META)}\nexport const meta = {};`;
    expect(() => compileWorkflowScript(script, { maxScriptBytes: 4096 })).toThrow(/exactly once/);
  });

  it('rejects syntax errors with a clear message', () => {
    const script = 'export const meta = {;\nreturn 1;';
    expect(() => compileWorkflowScript(script, { maxScriptBytes: 4096 })).toThrow(/syntax error/);
  });

  it('rejects a script exceeding maxScriptBytes', () => {
    const script = scriptWithMeta(VALID_META, `// ${'x'.repeat(2048)}\nreturn 1;`);
    expect(() => compileWorkflowScript(script, { maxScriptBytes: 128 })).toThrow(/too large/);
  });
});

describe('extractWorkflowMeta', () => {
  it('extracts and validates meta from a deep-research-like script', () => {
    const script = `export const meta = {
  name: 'deep-research',
  description: 'Research a topic in depth.',
  whenToUse: 'When the user asks for deep research.',
  phases: [
    { title: 'Plan', detail: 'design the research plan' },
    { title: 'Fan-out' },
    { title: 'Synthesize' },
  ],
};

phase('Plan');
const plan = await agent('Make a plan for: ' + args);
return plan;
`;
    const meta = extractWorkflowMeta(script);
    expect(meta.name).toBe('deep-research');
    expect(meta.whenToUse).toContain('deep research');
    expect(meta.phases.map((p) => p.title)).toEqual(['Plan', 'Fan-out', 'Synthesize']);
  });

  it('extracts argumentHint from the meta export', () => {
    const script = `export const meta = {
  name: 'deep-research',
  description: 'Research a topic in depth.',
  argumentHint: '<research question>',
  phases: [{ title: 'Plan' }],
};
return 1;`;
    const meta = extractWorkflowMeta(script);
    expect(meta.argumentHint).toBe('<research question>');
  });

  it('does not execute the body after the meta export (no side effects)', () => {
    // If the body ran, agent() would throw asynchronously; the sentinel must
    // stop execution right at the meta assignment.
    const script = scriptWithMeta(VALID_META, 'while (true) {}');
    expect(extractWorkflowMeta(script).name).toBe('deep-research');
  });

  it('throws when the workflow API is used before the meta export', () => {
    const script = `log('early');\nexport const meta = ${JSON.stringify(VALID_META)};\nreturn 1;`;
    expect(() => extractWorkflowMeta(script)).toThrow(/API used before meta export/);
  });

  it('propagates meta validation errors', () => {
    const script = scriptWithMeta({ ...VALID_META, name: 'Bad Name' });
    expect(() => extractWorkflowMeta(script)).toThrow(WorkflowValidationError);
  });

  it('throws when the script never assigns meta synchronously', () => {
    // The `export` keyword is stripped by the transform, so this becomes a
    // plain `const` inside a dead branch: meta is never captured.
    const script = 'if (false) { export const meta = {}; }\nreturn 1;';
    expect(() => extractWorkflowMeta(script)).toThrow(/did not define meta/);
  });
});

describe('resolveWorkflowLimits', () => {
  it('returns defaults when config is absent', () => {
    expect(resolveWorkflowLimits()).toEqual(DEFAULT_WORKFLOW_LIMITS);
    expect(DEFAULT_WORKFLOW_LIMITS).toEqual({
      maxConcurrency: 4,
      maxAgentCalls: 50,
      maxDurationMs: 30 * 60_000,
      maxScriptBytes: 256 * 1024,
    });
  });

  it('overlays partial config over defaults', () => {
    const limits = resolveWorkflowLimits({ maxConcurrency: 2, maxDurationMs: 5000 });
    expect(limits.maxConcurrency).toBe(2);
    expect(limits.maxDurationMs).toBe(5000);
    expect(limits.maxAgentCalls).toBe(DEFAULT_WORKFLOW_LIMITS.maxAgentCalls);
    expect(limits.maxScriptBytes).toBe(DEFAULT_WORKFLOW_LIMITS.maxScriptBytes);
  });
});

describe('workflows config section', () => {
  it('parses a valid workflows section', () => {
    const config = KimiConfigSchema.parse({ workflows: { maxConcurrency: 2 } });
    expect(config.workflows?.maxConcurrency).toBe(2);
  });

  it('rejects invalid values', () => {
    expect(() => KimiConfigSchema.parse({ workflows: { maxConcurrency: 0 } })).toThrow();
    expect(() => KimiConfigSchema.parse({ workflows: { maxConcurrency: 32 } })).toThrow();
    expect(() => KimiConfigSchema.parse({ workflows: { maxDurationMs: 10 } })).toThrow();
    expect(() => KimiConfigSchema.parse({ workflows: { maxScriptBytes: 1 } })).toThrow();
    expect(() => KimiConfigSchema.parse({ workflows: { extraWorkflowDirs: [1] } })).toThrow();
  });

  it('is accepted by the strict patch schema', () => {
    expect(() =>
      KimiConfigPatchSchema.parse({ workflows: { maxAgentCalls: 10, extraWorkflowDirs: ['x'] } }),
    ).not.toThrow();
  });
});

describe('dynamic-workflows flag', () => {
  it('is registered with the expected env and default off', () => {
    const def = FLAG_DEFINITIONS.find((d) => d.id === 'dynamic-workflows');
    expect(def).toBeDefined();
    expect(def?.env).toBe('KIMI_CODE_EXPERIMENTAL_DYNAMIC_WORKFLOWS');
    expect(def?.default).toBe(false);
    expect(def?.surface).toBe('core');
  });
});
