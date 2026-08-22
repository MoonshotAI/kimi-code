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

const ENTER = '\r';
const ESC = '\x1b';
const TAB = '\t';

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
    selector.handleInput(ENTER);
    let rendered = text(selector);
    expect(rendered).toContain('Skills › cv');
    expect(rendered).toContain('ops');
    expect(rendered).toContain('cv_ssh-ops');
    expect(rendered).toContain('cv_semaphore-ops');

    // Enter on 'ops'
    selector.handleInput(ENTER);
    rendered = text(selector);
    expect(rendered).toContain('Skills › cv › ops');
    expect(rendered).toContain('semaphore');
    expect(rendered).toContain('cv_ssh-ops');

    // Escape back to 'cv'
    selector.handleInput(ESC);
    rendered = text(selector);
    expect(rendered).toContain('Skills › cv');

    // Escape back to root
    selector.handleInput(ESC);
    rendered = text(selector);
    expect(rendered).toContain('Select skill group');

    // Escape at root cancels
    selector.handleInput(ESC);
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
    selector.handleInput(ENTER); // cv
    selector.handleInput(ENTER); // ops
    selector.handleInput(ENTER); // semaphore

    const rendered = text(selector);
    expect(rendered).toContain('Skills › cv › ops › semaphore');
    expect(rendered).toContain('cv_semaphore-ops');
    expect(rendered).toContain('Semaphore operations');

    // Press Enter on cv_semaphore-ops
    selector.handleInput(ENTER);
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

  it('cycles through top-level group tabs with Tab key like /model chooser', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const selector = new SkillSelectorComponent({
      skills,
      onSelect,
      onCancel,
    });

    // Initial state: "All" tab active
    let rendered = text(selector);
    expect(rendered).toContain('Select skill group');

    // Press Tab to cycle to next tab ("cv")
    selector.handleInput(TAB);
    rendered = text(selector);
    expect(rendered).toContain('Skills › cv');

    // Press Tab to cycle to next tab ("Uncategorized")
    selector.handleInput(TAB);
    rendered = text(selector);
    expect(rendered).toContain('Skills › Uncategorized');

    // Press Tab again to wrap back to "All" tab
    selector.handleInput(TAB);
    rendered = text(selector);
    expect(rendered).toContain('Select skill group');
  });
});
