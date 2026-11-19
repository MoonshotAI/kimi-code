import { describe, expect, it } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import type { AppSkill } from '@moonshot-ai/app-core/api';
import { useSlashMenu } from '../src/composables';
import type { TextFieldLike } from '@moonshot-ai/app-composer/runtime';

interface MockEditor {
  value: string;
  selectionStart: number;
  setSelectionRange: (start: number, end: number) => void;
  focus: () => void;
}

function setup(
  initialText = '',
  skills: AppSkill[] = [],
  insertSkillMention?: (
    entry: { kind: 'skill'; name: string },
    range: { start: number; end: number },
  ) => void,
) {
  const editor: MockEditor = {
    value: initialText,
    selectionStart: 0,
    setSelectionRange(start: number) {
      this.selectionStart = start;
    },
    focus: () => {},
  };
  const text = ref(initialText);
  const editorRef = ref(editor as unknown as TextFieldLike) as Ref<TextFieldLike | null>;
  const emitted: string[] = [];
  const pushed: string[] = [];
  const slash = useSlashMenu({
    text,
    editorRef,
    skills: () => skills,
    emitCommand: (cmd) => emitted.push(cmd),
    historyPush: (entry) => pushed.push(entry),
    insertSkillMention,
  });
  return { text, editor, emitted, pushed, slash };
}

describe('useSlashMenu — update', () => {
  it('stays closed for empty text', () => {
    const { slash } = setup('');
    slash.update();
    expect(slash.open.value).toBe(false);
  });

  it('opens and lists commands for a lone slash', () => {
    const { slash } = setup('/');
    slash.update();
    expect(slash.open.value).toBe(true);
    expect(slash.items.value.length).toBeGreaterThan(0);
    expect(slash.active.value).toBe(0);
  });

  it('filters to matching commands', () => {
    const { slash } = setup('/com');
    slash.update();
    expect(slash.open.value).toBe(true);
    expect(slash.items.value.map((i) => i.name)).toContain('/compact');
  });

  it('offers the session export command for an export prefix', () => {
    const { slash } = setup('/exp');
    slash.update();
    expect(slash.items.value.map((item) => item.name)).toContain('/export');
  });

  it('opens with an empty state when nothing matches', () => {
    const { slash } = setup('/zzzznotacommand');
    slash.update();
    expect(slash.open.value).toBe(true);
    expect(slash.items.value).toEqual([]);
  });

  it('closes once the token contains a space', () => {
    const { slash } = setup('/goal some task');
    slash.update();
    expect(slash.open.value).toBe(false);
  });

  it('closes for text that does not start with a slash', () => {
    const { slash } = setup('hello');
    slash.update();
    expect(slash.open.value).toBe(false);
  });

  it('includes session skills as /skill:<skill-name>', () => {
    const { slash } = setup('/', [{ name: 'deploy', description: 'deploy stuff', source: 'project' } as AppSkill]);
    slash.update();
    const names = slash.items.value.map((i) => i.name);
    expect(names).toContain('/skill:deploy');
  });

  it('keeps builtin-sourced skills unprefixed', () => {
    const { slash } = setup('/', [{ name: 'update-config', description: 'edit config', source: 'builtin' } as AppSkill]);
    slash.update();
    const names = slash.items.value.map((i) => i.name);
    expect(names).toContain('/update-config');
    expect(names).not.toContain('/skill:update-config');
  });

  it('matches a prefixed skill when filtering by its bare name', () => {
    const { slash } = setup('/depl', [{ name: 'deploy', description: 'deploy stuff', source: 'project' } as AppSkill]);
    slash.update();
    expect(slash.items.value.map((i) => i.name)).toContain('/skill:deploy');
  });

  it('opens for the Chinese enumeration comma an IME types for the slash key', () => {
    const { slash } = setup('、com');
    slash.update();
    expect(slash.open.value).toBe(true);
    expect(slash.items.value.map((i) => i.name)).toContain('/compact');
  });

  it('stays closed for text that starts with 、 but matches no command', () => {
    const { slash } = setup('、zzzznotacommand');
    slash.update();
    expect(slash.open.value).toBe(false);
  });
});

describe('useSlashMenu — dismiss (Esc)', () => {
  function type(ctx: ReturnType<typeof setup>, value: string): void {
    ctx.text.value = value;
    ctx.slash.update();
  }

  it('stays closed while the dismissed token keeps being edited', () => {
    const ctx = setup('/co');
    ctx.slash.update();
    ctx.slash.dismiss();
    expect(ctx.slash.open.value).toBe(false);
    type(ctx, '/com');
    expect(ctx.slash.open.value).toBe(false);
  });

  it('reopens once the slash is deleted and typed again', () => {
    const ctx = setup('/co');
    ctx.slash.update();
    ctx.slash.dismiss();
    type(ctx, '');
    type(ctx, '/');
    expect(ctx.slash.open.value).toBe(true);
  });

  it('a plain close does not suppress the next keystroke', () => {
    const ctx = setup('/co');
    ctx.slash.update();
    ctx.slash.close();
    type(ctx, '/com');
    expect(ctx.slash.open.value).toBe(true);
  });
});

describe('useSlashMenu — complete (Tab)', () => {
  it('fills in the command name without running it and keeps the menu open', () => {
    const { text, emitted, pushed, slash } = setup('/ne');
    slash.update();
    slash.complete({ name: '/new', desc: '' });
    expect(text.value).toBe('/new');
    expect(emitted).toEqual([]);
    expect(pushed).toEqual([]);
    expect(slash.open.value).toBe(true);
    expect(slash.items.value[0]?.name).toBe('/new');
  });

  it('normalizes a 、 trigger to a slash', () => {
    const { text, slash } = setup('、ne');
    slash.update();
    slash.complete({ name: '/new', desc: '' });
    expect(text.value).toBe('/new');
  });

  it('inserts the skill pill for a name that cannot stay a single token', () => {
    const inserted: string[] = [];
    const { text, slash } = setup('/wri', [], (entry) => inserted.push(entry.name));
    slash.update();
    slash.complete({ name: '/skill:write goal', desc: '', isSkill: true, acceptsInput: true });
    expect(inserted).toEqual(['write goal']);
    expect(text.value).toBe('/wri');
  });
});

describe('useSlashMenu — select', () => {
  it('non-acceptsInput: clears text, pushes history, emits the command', () => {
    const { text, emitted, pushed, slash } = setup('/new');
    slash.select({ name: '/new', desc: '' });
    expect(text.value).toBe('');
    expect(pushed).toEqual(['/new']);
    expect(emitted).toEqual(['/new']);
    expect(slash.open.value).toBe(false);
  });

  it('replaces a 、 trigger with the selected command', () => {
    const { text, slash } = setup('、goal');
    slash.select({ name: '/goal', desc: '', acceptsInput: true });
    expect(text.value).toBe('/goal ');
  });

  it('acceptsInput: keeps the command in the box and does not emit yet', async () => {
    const { text, emitted, pushed, slash } = setup('/goal');
    slash.select({ name: '/goal', desc: '', acceptsInput: true });
    expect(text.value).toBe('/goal ');
    expect(emitted).toEqual([]);
    expect(pushed).toEqual([]);
    expect(slash.open.value).toBe(false);
    await nextTick();
  });

  it.each([
    ['/skill:deploy', 'deploy'],
    ['/update-config', 'update-config'],
    ['/skill:write goal', 'write goal'],
  ])('skill %s delegates to the mention-pill insertion path without source metadata', (command, name) => {
    const inserted: Array<{
      entry: { kind: 'skill'; name: string };
      range: { start: number; end: number };
    }> = [];
    const { text, emitted, pushed, slash } = setup('/ski', [], (entry, range) => {
      inserted.push({ entry, range });
    });

    slash.select({ name: command, desc: '', isSkill: true, acceptsInput: true });

    expect(inserted).toEqual([
      { entry: { kind: 'skill', name, path: '' }, range: { start: 0, end: 4 } },
    ]);
    expect(text.value).toBe('/ski');
    expect(emitted).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it('keeps the plain-text skill fallback when no pill insertion surface is available', async () => {
    const { text, emitted, pushed, slash } = setup('/dep');

    slash.select({ name: '/skill:deploy', desc: '', isSkill: true, acceptsInput: true });

    expect(text.value).toBe('/skill:deploy ');
    expect(emitted).toEqual([]);
    expect(pushed).toEqual([]);
    await nextTick();
  });
});
