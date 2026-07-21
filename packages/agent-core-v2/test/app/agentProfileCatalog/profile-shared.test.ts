/**
 * Scenario: shared system-prompt rendering — the single `${var}` variable
 * table (`systemPromptVars`), user-template rendering with a lazily bound
 * `${base_prompt}` (`renderPromptTemplate`), and the builtin template renderer
 * (`renderSystemPrompt`) including its code-composed conditional sections
 * (Windows notes, additional directories, skills). Pure functions, no IO.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/agentProfileCatalog/profile-shared.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  renderPromptTemplate,
  renderSystemPrompt,
  systemPromptVars,
} from '#/app/agentProfileCatalog/profile-shared';

describe('systemPromptVars', () => {
  it('builds the full variable table from the context', () => {
    const vars = systemPromptVars(
      {
        skills: 'SKILLS',
        agentsMd: 'AGENTS',
        cwd: '/work',
        cwdListing: 'LISTING',
        osKind: 'macOS',
        shellName: 'zsh',
        shellPath: '/bin/zsh',
        now: 'NOW',
        additionalDirsInfo: '/extra',
      },
      { skillActive: true },
    );

    expect(vars['role_additional']).toBe('');
    expect(vars['os']).toBe('macOS');
    expect(vars['windows_notes']).toBe('');
    expect(vars['shell']).toBe('zsh (`/bin/zsh`)');
    expect(vars['now']).toBe('NOW');
    expect(vars['cwd']).toBe('/work');
    expect(vars['cwd_listing']).toBe('LISTING');
    expect(vars['agents_md']).toBe('AGENTS');
    expect(vars['additional_dirs_info']).toBe('/extra');
    expect(vars['skills']).toBe('SKILLS');
    expect(vars['additional_dirs_section']).toContain('## Additional Directories');
    expect(vars['additional_dirs_section']).toContain('/extra');
    expect(vars['skills_section']).toContain('# Skills');
    expect(vars['skills_section']).toContain('SKILLS');
  });

  it('renders missing context fields as empty strings and defaults ${now}', () => {
    const vars = systemPromptVars({}, { skillActive: true });

    expect(vars['cwd']).toBe('');
    expect(vars['cwd_listing']).toBe('');
    expect(vars['shell']).toBe('');
    expect(vars['agents_md']).toBe('');
    expect(vars['additional_dirs_info']).toBe('');
    expect(vars['additional_dirs_section']).toBe('');
    expect(vars['skills']).toBe('');
    expect(vars['skills_section']).toBe('');
    expect(vars['windows_notes']).toBe('');
    expect(vars['role_additional']).toBe('');
    expect(Number.isNaN(Date.parse(vars['now'] ?? ''))).toBe(false);
  });

  it('empties skills and the skills section when the Skill tool is off', () => {
    const vars = systemPromptVars({ skills: 'SKILLS' }, { skillActive: false });

    expect(vars['skills']).toBe('');
    expect(vars['skills_section']).toBe('');
  });

  it('lets a context skillActive override the profile default', () => {
    const vars = systemPromptVars({ skills: 'SKILLS', skillActive: true }, { skillActive: false });

    expect(vars['skills']).toBe('SKILLS');
  });

  it('composes Windows notes only on Windows', () => {
    expect(
      systemPromptVars({ osKind: 'Windows' }, { skillActive: true })['windows_notes'],
    ).toContain('IMPORTANT: You are on Windows');
    expect(systemPromptVars({ osKind: 'macOS' }, { skillActive: true })['windows_notes']).toBe('');
  });
});

describe('renderPromptTemplate', () => {
  it('substitutes known variables and keeps unknown placeholders verbatim', () => {
    const out = renderPromptTemplate(
      'cwd=${cwd} unknown=${nope} bare=$cwd dollar=$${cwd}',
      { cwd: '/work' },
      { skillActive: true },
    );

    expect(out).toBe('cwd=/work unknown=${nope} bare=$cwd dollar=$/work');
  });

  it('resolves ${base_prompt} lazily and only when the template references it', () => {
    let calls = 0;
    const basePrompt = () => {
      calls += 1;
      return 'BASE';
    };

    expect(renderPromptTemplate('no base here', {}, { skillActive: true }, basePrompt)).toBe(
      'no base here',
    );
    expect(calls).toBe(0);

    expect(
      renderPromptTemplate('wrap\n\n${base_prompt}', {}, { skillActive: true }, basePrompt),
    ).toBe('wrap\n\nBASE');
    expect(calls).toBe(1);
  });

  it('keeps ${base_prompt} verbatim when no base prompt is provided', () => {
    expect(renderPromptTemplate('${base_prompt}', {}, { skillActive: true })).toBe(
      '${base_prompt}',
    );
  });
});

describe('renderSystemPrompt', () => {
  it('places the role text at the role slot and injects context sections', () => {
    const prompt = renderSystemPrompt(
      'ROLE_TEXT',
      { agentsMd: 'AGENTS', skills: 'SKILLS', cwd: '/work' },
      { skillActive: true },
    );

    expect(prompt).toContain('ROLE_TEXT');
    expect(prompt).toContain('AGENTS');
    expect(prompt).toContain('/work');
    expect(prompt).toContain('# Skills');
    expect(prompt).toContain('SKILLS');
  });

  it('omits the skills section when the profile disables the Skill tool', () => {
    const prompt = renderSystemPrompt('', { skills: 'SKILLS' }, { skillActive: false });

    expect(prompt).not.toContain('# Skills');
    expect(prompt).not.toContain('SKILLS');
  });

  it('shows Windows notes only on Windows', () => {
    expect(renderSystemPrompt('', { osKind: 'Windows' }, { skillActive: true })).toContain(
      'IMPORTANT: You are on Windows',
    );
    expect(renderSystemPrompt('', { osKind: 'macOS' }, { skillActive: true })).not.toContain(
      'IMPORTANT: You are on Windows',
    );
  });

  it('shows the additional directories section only when directories exist', () => {
    expect(
      renderSystemPrompt('', { additionalDirsInfo: '/extra' }, { skillActive: true }),
    ).toContain('## Additional Directories');
    expect(renderSystemPrompt('', {}, { skillActive: true })).not.toContain(
      '## Additional Directories',
    );
  });

  it('renders the builtin template with no leftover placeholders', () => {
    // Every placeholder in the builtin template must be bound in the variable
    // table — an unbound one would stay verbatim in the output.
    const prompt = renderSystemPrompt(
      'ROLE_TEXT',
      {
        skills: 'SKILLS',
        agentsMd: 'AGENTS',
        cwd: '/work',
        cwdListing: 'LISTING',
        osKind: 'Windows',
        shellName: 'cmd',
        shellPath: 'C:\\cmd.exe',
        now: 'NOW',
        additionalDirsInfo: '/extra',
      },
      { skillActive: true },
    );

    expect(prompt).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/);
  });
});
