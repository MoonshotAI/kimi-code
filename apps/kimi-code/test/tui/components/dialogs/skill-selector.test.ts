import { describe, expect, it, vi } from 'vitest';
import type { SkillSummary } from '@moonshot-ai/kimi-code-sdk';
import { Key } from '@moonshot-ai/pi-tui';
import { SkillSelectorComponent } from '../../../../src/tui/components/dialogs/skill-selector';

function makeSkill(name: string, overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name,
    description: `${name} description`,
    path: `/test/skills/${name}/SKILL.md`,
    source: 'user',
    type: 'prompt',
    ...overrides,
  };
}

function text(component: SkillSelectorComponent, width = 120): string {
  return component.render(width).join('\n');
}

describe('SkillSelectorComponent', () => {
  const sshOps = makeSkill('cv_ssh-ops', {
    groups: ['cv', 'cv/ops'],
    description: 'SSH operations',
  });
  const semaphoreOps = makeSkill('cv_semaphore-ops', {
    groups: ['cv', 'cv/ops', 'cv/ops/semaphore'],
    description: 'Semaphore operations',
  });
  const flatSkill = makeSkill('flat-skill', {
    description: 'Flat skill without group',
  });

  const skills = [sshOps, semaphoreOps, flatSkill];

  it('renders root group level', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const selector = new SkillSelectorComponent({
      skills,
      onSelect,
      onCancel,
    });

    const rendered = text(selector);
    expect(rendered).toContain('Select skill group');
    expect(rendered).toContain('cv');
    expect(rendered).toContain('Uncategorized');
  });

  it('drills down into group on Enter and goes back on Escape', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const selector = new SkillSelectorComponent({
      skills,
      onSelect,
      onCancel,
    });

    // Enter on 'cv'
    selector.handleInput(Key.enter);
    let rendered = text(selector);
    expect(rendered).toContain('Skills › cv');
    expect(rendered).toContain('ops');
    expect(rendered).toContain('cv_ssh-ops');
    expect(rendered).toContain('cv_semaphore-ops');

    // Enter on 'ops'
    selector.handleInput(Key.enter);
    rendered = text(selector);
    expect(rendered).toContain('Skills › cv › ops');
    expect(rendered).toContain('semaphore');
    expect(rendered).toContain('cv_ssh-ops');

    // Escape back to 'cv'
    selector.handleInput(Key.escape);
    rendered = text(selector);
    expect(rendered).toContain('Skills › cv');

    // Escape back to root
    selector.handleInput(Key.escape);
    rendered = text(selector);
    expect(rendered).toContain('Select skill group');

    // Escape at root cancels
    selector.handleInput(Key.escape);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('selects a skill on Enter and calls onSelect', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const selector = new SkillSelectorComponent({
      skills,
      onSelect,
      onCancel,
    });

    // Drill down: Root -> cv -> ops -> semaphore
    selector.handleInput(Key.enter); // cv
    selector.handleInput(Key.enter); // ops
    selector.handleInput(Key.enter); // semaphore

    const rendered = text(selector);
    expect(rendered).toContain('Skills › cv › ops › semaphore');
    expect(rendered).toContain('cv_semaphore-ops');
    expect(rendered).toContain('Semaphore operations');

    // Press Enter on cv_semaphore-ops
    selector.handleInput(Key.enter);
    expect(onSelect).toHaveBeenCalledWith(semaphoreOps);
  });

  it('filters items with search query', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const selector = new SkillSelectorComponent({
      skills,
      searchable: true,
      onSelect,
      onCancel,
    });

    // Type search 'uncat' at root
    selector.handleInput('u');
    selector.handleInput('n');
    selector.handleInput('c');
    selector.handleInput('a');
    selector.handleInput('t');

    const rendered = text(selector);
    expect(rendered).toContain('Uncategorized');
    expect(rendered).not.toContain('  cv\n');
  });
});
