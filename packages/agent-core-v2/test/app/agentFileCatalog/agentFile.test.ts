/**
 * Scenario: agent-file parsing primitives — frontmatter validation, defaults,
 * and the AgentFileDefinition → AgentProfile factory (template substitution,
 * `${base_prompt}`, tool pass-through, explicit override intent).
 * Pure-function level, no IO.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/agentFileCatalog/agentFile.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { AgentFileParseError, parseAgentFileText } from '#/app/agentFileCatalog/agentFile';
import { agentProfileFromFile } from '#/app/agentFileCatalog/agentProfileFromFile';
import type { AgentFileDefinition } from '#/app/agentFileCatalog/types';

const FULL_FILE = `---
name: code-reviewer
description: 严格的代码审查 agent
whenToUse: 代码评审、PR 检查
override: true
tools:
  - Read
  - Grep
  - mcp__github__*
disallowedTools:
  - Bash
subagents:
  - explore
  - plan
unknownField: tolerated
---

你是严格的代码审查者。
`;

function parse(text: string): AgentFileDefinition {
  return parseAgentFileText({ path: '/tmp/agents/reviewer.md', source: 'project', text });
}

describe('parseAgentFileText', () => {
  it('parses a full agent file', () => {
    const def = parse(FULL_FILE);

    expect(def.name).toBe('code-reviewer');
    expect(def.description).toBe('严格的代码审查 agent');
    expect(def.whenToUse).toBe('代码评审、PR 检查');
    expect(def.override).toBe(true);
    expect(def.tools).toEqual(['Read', 'Grep', 'mcp__github__*']);
    expect(def.disallowedTools).toEqual(['Bash']);
    expect(def.subagents).toEqual(['explore', 'plan']);
    expect(def.prompt).toBe('你是严格的代码审查者。');
    expect(def.source).toBe('project');
  });

  it('leaves optional fields undefined when omitted', () => {
    const def = parse('---\nname: solo\ndescription: d\n---\n\nbody\n');

    expect(def.override).toBe(false);
    expect(def.modelPreference).toBeUndefined();
    expect(def.tools).toBeUndefined();
    expect(def.disallowedTools).toBeUndefined();
    expect(def.subagents).toBeUndefined();
    expect(def.whenToUse).toBeUndefined();
    expect(def.prompt).toBe('body');
  });

  it('parses a symbolic model preference', () => {
    const def = parse(
      '---\nname: solo\ndescription: d\nmodel_preference: primary\n---\n\nbody\n',
    );

    expect(def.modelPreference).toBe('primary');
  });

  it('rejects an unsupported model preference', () => {
    expect(() =>
      parse(
        '---\nname: solo\ndescription: d\nmodel_preference: provider/model\n---\n\nbody\n',
      ),
    ).toThrow(/"model_preference"/);
  });

  it('rejects missing frontmatter', () => {
    expect(() => parse('no frontmatter here')).toThrow(AgentFileParseError);
  });

  it('rejects non-mapping frontmatter', () => {
    expect(() => parse('---\n- just\n- a\n- list\n---\n\nbody\n')).toThrow(/mapping/);
  });

  it('rejects invalid yaml frontmatter', () => {
    expect(() => parse('---\nfoo: [unclosed\n---\n\nbody\n')).toThrow(AgentFileParseError);
  });

  it('derives the name from the file name when omitted', () => {
    const def = parse('---\ndescription: d\n---\n\nbody\n');

    expect(def.name).toBe('reviewer');
  });

  it('rejects when the name is neither provided nor derivable', () => {
    expect(() =>
      parseAgentFileText({
        path: '/tmp/agents/.md',
        source: 'project',
        text: '---\ndescription: d\n---\n\nbody\n',
      }),
    ).toThrow(/"name"/);
  });

  it('rejects a derived name that is not kebab-case', () => {
    expect(() =>
      parseAgentFileText({
        path: '/tmp/agents/My Agent.md',
        source: 'project',
        text: '---\ndescription: d\n---\n\nbody\n',
      }),
    ).toThrow(/kebab-case/);
  });

  it('rejects a missing description', () => {
    expect(() => parse('---\nname: solo\n---\n\nbody\n')).toThrow(/"description"/);
  });

  it('rejects non kebab-case names', () => {
    expect(() => parse('---\nname: CodeReviewer\ndescription: d\n---\n\nbody\n')).toThrow(
      /kebab-case/,
    );
    expect(() => parse('---\nname: code_reviewer\ndescription: d\n---\n\nbody\n')).toThrow(
      /kebab-case/,
    );
  });

  it('ignores a foreign mode field (e.g. OpenCode "mode: subagent")', () => {
    const def = parse('---\nname: solo\ndescription: d\nmode: subagent\n---\n\nbody\n');

    expect(def.name).toBe('solo');
    expect(def.prompt).toBe('body');
  });

  it('rejects a non-boolean override field', () => {
    expect(() => parse('---\nname: solo\ndescription: d\noverride: yes\n---\n\nbody\n')).toThrow(
      /"override"/,
    );
  });

  it('accepts a comma-separated tools string (Claude Code style)', () => {
    const def = parse(
      '---\nname: solo\ndescription: d\ntools: Read, Grep,mcp__github__*\ndisallowedTools: Bash\n---\n\nbody\n',
    );

    expect(def.tools).toEqual(['Read', 'Grep', 'mcp__github__*']);
    expect(def.disallowedTools).toEqual(['Bash']);
  });

  it('treats a lone "*" tools field as all tools', () => {
    const fromString = parse('---\nname: solo\ndescription: d\ntools: "*"\n---\n\nbody\n');
    const fromList = parse('---\nname: solo\ndescription: d\ntools:\n  - "*"\n---\n\nbody\n');

    expect(fromString.tools).toBeUndefined();
    expect(fromList.tools).toBeUndefined();
  });

  it('accepts a comma-separated subagents string', () => {
    const def = parse('---\nname: solo\ndescription: d\nsubagents: explore, plan\n---\n\nbody\n');

    expect(def.subagents).toEqual(['explore', 'plan']);
  });

  it('treats a lone "*" subagents field as all subagent types', () => {
    const def = parse('---\nname: solo\ndescription: d\nsubagents: "*"\n---\n\nbody\n');

    expect(def.subagents).toBeUndefined();
  });

  it('rejects a non-string, non-list subagents field', () => {
    expect(() => parse('---\nname: solo\ndescription: d\nsubagents: 42\n---\n\nbody\n')).toThrow(
      /"subagents"/,
    );
  });

  it('rejects a non-string, non-list tools field', () => {
    expect(() => parse('---\nname: solo\ndescription: d\ntools: 42\n---\n\nbody\n')).toThrow(
      /"tools"/,
    );
  });

  it('rejects non-string tool entries', () => {
    expect(() =>
      parse('---\nname: solo\ndescription: d\ntools:\n  - 42\n---\n\nbody\n'),
    ).toThrow(/non-empty strings/);
  });

  it('rejects an empty prompt body', () => {
    expect(() => parse('---\nname: solo\ndescription: d\n---\n')).toThrow(/prompt body/);
  });
});

describe('agentProfileFromFile', () => {
  const base: AgentFileDefinition = {
    name: 'reviewer',
    description: 'd',
    whenToUse: 'reviews',
    override: false,
    prompt: 'PROMPT_BODY',
    path: '/tmp/agents/reviewer.md',
    source: 'user',
  };
  const basePrompt = () => 'BASE_PROMPT';

  it('returns a plain body verbatim and injects no context', () => {
    const profile = agentProfileFromFile(base, basePrompt);
    const prompt = profile.systemPrompt({ agentsMd: 'AGENTS_MD_CONTENT', skills: 'SKILLS_LISTING' });

    expect(prompt).toBe('PROMPT_BODY');
    expect(profile.tools).toBeUndefined();
    expect(profile.whenToUse).toBe('reviews');
    expect(profile.override).toBe(false);
  });

  it('substitutes context variables in the body', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'cwd=${cwd} agents=${agents_md} skills=${skills}' },
      basePrompt,
    );
    const prompt = profile.systemPrompt({
      cwd: '/work',
      agentsMd: 'AGENTS_MD_CONTENT',
      skills: 'SKILLS_LISTING',
    });

    expect(prompt).toBe('cwd=/work agents=AGENTS_MD_CONTENT skills=SKILLS_LISTING');
  });

  it('empties ${skills} when the file allowlist drops the Skill tool', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'skills=${skills}', tools: ['Read'] },
      basePrompt,
    );

    expect(profile.systemPrompt({ skills: 'SKILLS_LISTING' })).toBe('skills=');
  });

  it('empties ${skills} when Skill is in disallowedTools', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'skills=${skills}', disallowedTools: ['Skill'] },
      basePrompt,
    );

    expect(profile.systemPrompt({ skills: 'SKILLS_LISTING' })).toBe('skills=');
  });

  it('embeds the effective default prompt via ${base_prompt}', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'extra instructions\n\n${base_prompt}' },
      basePrompt,
    );

    expect(profile.systemPrompt({})).toBe('extra instructions\n\nBASE_PROMPT');
  });

  it('passes tools and disallowedTools through', () => {
    const profile = agentProfileFromFile(
      { ...base, tools: ['Read'], disallowedTools: ['Bash'] },
      basePrompt,
    );

    expect(profile.tools).toEqual(['Read']);
    expect(profile.disallowedTools).toEqual(['Bash']);
  });

  it('passes subagents through', () => {
    const profile = agentProfileFromFile({ ...base, subagents: ['explore'] }, basePrompt);

    expect(profile.subagents).toEqual(['explore']);
  });

  it('passes the model preference through', () => {
    const profile = agentProfileFromFile({ ...base, modelPreference: 'secondary' }, basePrompt);

    expect(profile.modelPreference).toBe('secondary');
  });

  it('treats an explicit file as an override intent', () => {
    const profile = agentProfileFromFile({ ...base, source: 'explicit' }, basePrompt);

    expect(profile.override).toBe(true);
  });
});
