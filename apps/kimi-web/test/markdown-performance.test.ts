import { describe, expect, it } from 'vitest';

import { markdownRenderPlan } from '../src/lib/markdownPerformance';

describe('markdown render plan', () => {
  it('keeps normal code blocks highlighted', () => {
    const plan = markdownRenderPlan('```ts\nconst ok = true;\n```');
    expect(plan.codeRenderer).toBe('shiki');
    expect(plan.codeFenceCount).toBe(1);
  });

  it('uses plain pre rendering for one very large code block', () => {
    const plan = markdownRenderPlan(`\`\`\`txt\n${'x'.repeat(31_000)}\n\`\`\``);
    expect(plan.codeRenderer).toBe('pre');
  });

  it('uses plain pre rendering when many code blocks mount together', () => {
    const blocks = Array.from({ length: 33 }, (_, i) => `\`\`\`ts\nconst n${i} = ${i};\n\`\`\``).join('\n');
    const plan = markdownRenderPlan(blocks);
    expect(plan.codeRenderer).toBe('pre');
  });

  it('uses plain pre rendering for very large messages', () => {
    const plan = markdownRenderPlan(`intro\n\n${'text\n'.repeat(24_000)}`);
    expect(plan.codeRenderer).toBe('pre');
  });
});
