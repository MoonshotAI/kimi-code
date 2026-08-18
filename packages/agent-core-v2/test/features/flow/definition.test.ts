import { describe, expect, it } from 'vitest';

import {
  FlowDefinitionParseError,
  parseFlowDefinition,
} from '#/features/flow/definition';

const VALID = `---
id: issue-fix
when: GitHub issue bugs
stages:
  - id: triage
    objective: Find the root cause
    completion: Root cause located to file and line
    gate: human
  - id: implement
    objective: Make the issue stop reproducing
    completion: A reproducing test exists and passes
---

## implement
Do not refactor unrelated code paths.
`;

describe('parseFlowDefinition', () => {
  it('parses frontmatter stages and attaches prose notes by stage id', () => {
    const definition = parseFlowDefinition(VALID);
    expect(definition.id).toBe('issue-fix');
    expect(definition.when).toBe('GitHub issue bugs');
    expect(definition.stages.map((stage) => stage.id)).toEqual(['triage', 'implement']);
    expect(definition.stages[0]!.gate).toBe('human');
    expect(definition.stages[0]!.notes).toBeUndefined();
    expect(definition.stages[1]!.gate).toBe('ai');
    expect(definition.stages[1]!.notes).toBe('Do not refactor unrelated code paths.');
  });

  it('rejects a file without frontmatter', () => {
    expect(() => parseFlowDefinition('# just prose')).toThrow(FlowDefinitionParseError);
  });

  it('rejects an empty stage list and invalid gate values', () => {
    expect(() =>
      parseFlowDefinition('---\nid: empty\nstages: []\n---\n'),
    ).toThrow(FlowDefinitionParseError);
    expect(() =>
      parseFlowDefinition(
        '---\nid: bad-gate\nstages:\n  - id: a\n    objective: x\n    completion: y\n    gate: maybe\n---\n',
      ),
    ).toThrow(FlowDefinitionParseError);
  });

  it('rejects whitespace-only objectives and completions', () => {
    expect(() =>
      parseFlowDefinition(
        '---\nid: blank\nstages:\n  - id: a\n    objective: "   "\n    completion: y\n---\n',
      ),
    ).toThrow(FlowDefinitionParseError);
    expect(() =>
      parseFlowDefinition(
        '---\nid: blank\nstages:\n  - id: a\n    objective: x\n    completion: "   "\n---\n',
      ),
    ).toThrow(FlowDefinitionParseError);
  });

  it('rejects unknown keys so a misspelled gate cannot silently weaken the workflow', () => {
    expect(() =>
      parseFlowDefinition(
        '---\nid: typo\nstages:\n  - id: a\n    objective: x\n    completion: y\n    gates: human\n---\n',
      ),
    ).toThrow(FlowDefinitionParseError);
  });

  it('rejects duplicate stage ids', () => {
    expect(() =>
      parseFlowDefinition(
        '---\nid: dup\nstages:\n  - id: a\n    objective: x\n    completion: y\n  - id: a\n    objective: x2\n    completion: y2\n---\n',
      ),
    ).toThrow(FlowDefinitionParseError);
  });

  it('rejects duplicate notes headings instead of letting the later one overwrite the earlier', () => {
    expect(() =>
      parseFlowDefinition(
        '---\nid: dup-notes\nstages:\n  - id: triage\n    objective: x\n    completion: y\n---\n\n## triage\n\nFirst constraints.\n\n## triage\n\nSecond constraints.\n',
      ),
    ).toThrow(FlowDefinitionParseError);
  });

  it('ignores headings inside fenced code blocks in stage notes', () => {
    const definition = parseFlowDefinition(
      '---\nid: fenced\nstages:\n  - id: triage\n    objective: x\n    completion: y\n---\n\n## triage\n\nUse this pattern:\n\n```md\n## example\nnot a stage heading\n```\n\nDone.\n',
    );
    expect(definition.stages[0]!.notes).toContain('## example');
    expect(definition.stages[0]!.notes).toContain('Done.');
  });

  it('keeps a tilde fence open across inner backtick lines and vice versa', () => {
    const definition = parseFlowDefinition(
      '---\nid: fences\nstages:\n  - id: triage\n    objective: x\n    completion: y\n---\n\n## triage\n\n~~~md\n```\n## example\n```\n~~~\n\nDone.\n',
    );
    expect(definition.stages[0]!.notes).toContain('## example');
    expect(definition.stages[0]!.notes).toContain('Done.');
  });

  it('does not close a fence on a same-marker line carrying an info string', () => {
    const definition = parseFlowDefinition(
      '---\nid: infostr\nstages:\n  - id: triage\n    objective: x\n    completion: y\n---\n\n## triage\n\n````md\n```ts\n## example\n```\n````\n\nDone.\n',
    );
    expect(definition.stages[0]!.notes).toContain('## example');
    expect(definition.stages[0]!.notes).toContain('Done.');
  });

  it('strips an optional closing hash sequence from a stage heading', () => {
    const definition = parseFlowDefinition(
      '---\nid: closing\nstages:\n  - id: triage\n    objective: x\n    completion: y\n---\n\n## triage ##\n\nClosed-style heading.\n',
    );
    expect(definition.stages[0]!.notes).toBe('Closed-style heading.');
  });

  it('recognizes an ATX heading indented by up to three spaces', () => {
    const definition = parseFlowDefinition(
      '---\nid: indent\nstages:\n  - id: triage\n    objective: x\n    completion: y\n---\n\n   ## triage\n\nIndented but valid.\n',
    );
    expect(definition.stages[0]!.notes).toBe('Indented but valid.');
  });

  it('rejects a notes heading that matches no stage id, so a typo cannot silently drop the notes', () => {
    expect(() =>
      parseFlowDefinition(
        '---\nid: typo\nstages:\n  - id: implement\n    objective: x\n    completion: y\n---\n\n## implemnt\n\nImportant guidance.\n',
      ),
    ).toThrow(FlowDefinitionParseError);
  });
});
