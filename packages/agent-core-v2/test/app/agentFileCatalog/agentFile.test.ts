import { describe, expect, it } from 'vitest';

import { AgentFileParseError, parseAgentFileText } from '#/app/agentFileCatalog/agentFile';
import { agentProfileFromFile } from '#/app/agentFileCatalog/agentProfileFromFile';
import type { AgentFileDefinition } from '#/app/agentFileCatalog/types';

const FULL_FILE = `---
name: code-reviewer
description: 严格的代码审查 agent
whenToUse: 代码评审、PR 检查
mode: append
tools:
  - Read
  - Grep
  - mcp__github__*
disallowedTools:
  - Bash
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
    expect(def.mode).toBe('append');
    expect(def.tools).toEqual(['Read', 'Grep', 'mcp__github__*']);
    expect(def.disallowedTools).toEqual(['Bash']);
    expect(def.prompt).toBe('你是严格的代码审查者。');
    expect(def.source).toBe('project');
  });

  it('defaults mode to replace and leaves tool lists undefined', () => {
    const def = parse('---\nname: solo\ndescription: d\n---\n\nbody\n');

    expect(def.mode).toBe('replace');
    expect(def.tools).toBeUndefined();
    expect(def.disallowedTools).toBeUndefined();
    expect(def.whenToUse).toBeUndefined();
    expect(def.prompt).toBe('body');
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

  it('rejects a missing name', () => {
    expect(() => parse('---\ndescription: d\n---\n\nbody\n')).toThrow(/"name"/);
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

  it('rejects an invalid mode', () => {
    expect(() =>
      parse('---\nname: solo\ndescription: d\nmode: prepend\n---\n\nbody\n'),
    ).toThrow(/"mode"/);
  });

  it('rejects a non-list tools field', () => {
    expect(() => parse('---\nname: solo\ndescription: d\ntools: Read\n---\n\nbody\n')).toThrow(
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
    mode: 'replace',
    prompt: 'PROMPT_BODY',
    path: '/tmp/agents/reviewer.md',
    source: 'user',
  };

  it('replace mode returns the body verbatim and injects no context', () => {
    const profile = agentProfileFromFile(base);
    const prompt = profile.systemPrompt({ agentsMd: 'AGENTS_MD_CONTENT', skills: 'SKILLS_LISTING' });

    expect(prompt).toBe('PROMPT_BODY');
    expect(profile.tools).toBeUndefined();
    expect(profile.whenToUse).toBe('reviews');
  });

  it('append mode injects the body and keeps context injection', () => {
    const profile = agentProfileFromFile({ ...base, mode: 'append' });
    const prompt = profile.systemPrompt({ agentsMd: 'AGENTS_MD_CONTENT', skills: 'SKILLS_LISTING' });

    expect(prompt).toContain('PROMPT_BODY');
    expect(prompt).toContain('AGENTS_MD_CONTENT');
    expect(prompt).toContain('SKILLS_LISTING');
  });

  it('append mode with an allowlist without Skill skips the skills listing', () => {
    const profile = agentProfileFromFile({ ...base, mode: 'append', tools: ['Read'] });
    const prompt = profile.systemPrompt({ skills: 'SKILLS_LISTING' });

    expect(prompt).toContain('PROMPT_BODY');
    expect(prompt).not.toContain('SKILLS_LISTING');
  });

  it('passes tools and disallowedTools through', () => {
    const profile = agentProfileFromFile({
      ...base,
      tools: ['Read'],
      disallowedTools: ['Bash'],
    });

    expect(profile.tools).toEqual(['Read']);
    expect(profile.disallowedTools).toEqual(['Bash']);
  });
});
