// packages/app-core/test/slashCommands.test.ts
import { describe, expect, it } from 'vitest';
import { buildSlashItems, filterCommandMatches, filterCommands, matchRanges, stripSkillPrefix, type SlashCommand } from '../src/lib/slashCommands';

const passThrough = (item: SlashCommand): string => item.desc;

const zhItems: SlashCommand[] = [
  { name: '/new', desc: '创建新会话' },
  { name: '/clear', desc: '清空并新建会话' },
  { name: '/goal', desc: '创建/控制目标' },
  { name: '/write-goal', desc: 'Help craft a goal objective', isSkill: true },
];

describe('filterCommands', () => {
  it('returns everything for an empty or bare-slash query', () => {
    expect(filterCommands('', zhItems, passThrough)).toHaveLength(zhItems.length);
    expect(filterCommands('/', zhItems, passThrough)).toHaveLength(zhItems.length);
  });

  it('ranks an exact name match before a name substring match', () => {
    const names = filterCommands('goal', zhItems, passThrough).map((i) => i.name);
    expect(names[0]).toBe('/goal');
    expect(names).toContain('/write-goal');
  });

  it('ranks a name prefix match before a mid-name substring match', () => {
    const items: SlashCommand[] = [
      { name: '/skill:preview-tools', desc: 'Preview tools', isSkill: true },
      { name: '/preview', desc: 'Preview the result' },
    ];
    expect(filterCommands('preview', items, passThrough)[0]?.name).toBe('/preview');
  });

  it('is case-insensitive', () => {
    expect(filterCommands('GOAL', zhItems, passThrough)[0]?.name).toBe('/goal');
  });

  it('matches against the resolved description text', () => {
    const names = filterCommands('会话', zhItems, passThrough).map((i) => i.name);
    expect(names).toContain('/new');
    expect(names).toContain('/clear');
    expect(names).not.toContain('/goal');
  });

  it('matches full pinyin syllables of the description', () => {
    // Exact substring in /new's pinyin; /clear (新建会话) may follow as a
    // legitimate fuzzy match, but the exact one leads.
    const names = filterCommands('xinhuihua', zhItems, passThrough).map((i) => i.name);
    expect(names[0]).toBe('/new');
  });

  it('matches pinyin initials of the description', () => {
    const names = filterCommands('xhh', zhItems, passThrough).map((i) => i.name);
    expect(names[0]).toBe('/new');
  });

  it('returns nothing when nothing matches', () => {
    expect(filterCommands('zzzzzz', zhItems, passThrough)).toEqual([]);
  });

  it('defaults to the raw desc when no resolver is given', () => {
    const skills = buildSlashItems([{ name: 'lark-base', description: '飞书多维表格操作' }]);
    const names = filterCommands('duoweibiaoge', skills).map((i) => i.name);
    expect(names).toContain('/skill:lark-base');
  });
});

describe('matchRanges', () => {
  it('highlights a literal name substring', () => {
    expect(matchRanges('go', '/goal', '创建/控制目标').name).toEqual([[1, 3]]);
  });

  it('highlights a fuzzy subsequence across the name', () => {
    expect(matchRanges('gl', '/goal', '创建/控制目标').name).toEqual([[1, 5]]);
  });

  it('maps pinyin-initial hits back onto the description characters', () => {
    expect(matchRanges('xhh', '/new', '创建新会话').desc).toEqual([[2, 5]]);
  });

  it('maps full-pinyin hits back onto the description characters', () => {
    expect(matchRanges('xinhui', '/new', '创建新会话').desc).toEqual([[2, 4]]);
  });

  it('maps polyphonic characters by context, matching the search document', () => {
    // 音乐 resolves to yinyue in context — not the per-char yinle — so a
    // yinyue hit highlights exactly 音乐 and must not spill onto 模.
    expect(matchRanges('yinyue', '/music', '音乐模式').desc).toEqual([[0, 2]]);
  });

  it('keeps the highlight mapping for mixed-language descriptions', () => {
    // Passed-through latin runs are segmented by pinyin-pro however it
    // likes; the span walk must still land 模式 exactly.
    expect(matchRanges('moshi', '/swarm', '切换 swarm 模式').desc).toEqual([[9, 11]]);
  });

  it('returns no ranges when nothing matches', () => {
    expect(matchRanges('zzz', '/goal', '创建新会话')).toEqual({});
  });
});

describe('filterCommandMatches', () => {
  it('reports the real Fuse range for an edit-distance name hit', () => {
    const items: SlashCommand[] = [{ name: '/status', desc: 'Show the status' }];
    const matches = filterCommandMatches('statuz', items, passThrough);
    expect(matches[0]?.item.name).toBe('/status');
    // Fuse's range is on the stripped name; the report shifts it past the `/`.
    expect(matches[0]?.ranges.name).toEqual([[1, 7]]);
  });

  it('maps a pinyin-key hit back onto the description characters', () => {
    const items: SlashCommand[] = [{ name: '/new', desc: '创建新会话' }];
    const matches = filterCommandMatches('xhh', items, passThrough);
    expect(matches[0]?.ranges.desc).toEqual([[2, 5]]);
  });

  it('maps a polyphonic pinyin hit back onto the exact characters', () => {
    // Same contextual-reading case through the Fuse path: the highlight must
    // come from the same whole-sentence conversion as the search document.
    const items: SlashCommand[] = [{ name: '/music', desc: '音乐模式' }];
    const matches = filterCommandMatches('yinyue', items, passThrough);
    expect(matches[0]?.ranges.desc).toEqual([[0, 2]]);
  });

  it('maps a pinyin hit inside a mixed-language description', () => {
    const items: SlashCommand[] = [{ name: '/swarm', desc: '切换 swarm 模式' }];
    const matches = filterCommandMatches('moshi', items, passThrough);
    expect(matches[0]?.ranges.desc).toEqual([[9, 11]]);
  });

  it('never widens a latin-run hit to the whole passed-through unit', () => {
    // 'war' must highlight exactly those three letters of 'swarm' — whether
    // pinyin-pro segments the run per character or as one grouped item.
    const items: SlashCommand[] = [{ name: '/swarm', desc: '切换 swarm 模式' }];
    const matches = filterCommandMatches('war', items, passThrough);
    expect(matches[0]?.ranges.desc).toEqual([[4, 7]]);
  });
});

describe('stripSkillPrefix', () => {
  it('strips the skill: prefix with or without the leading slash', () => {
    // The slash menu builds skill items as '/skill:<name>' — sending that
    // verbatim as the structured skillName would activate '/skill:deploy'
    // and earn a skill.not_found from the daemon.
    expect(stripSkillPrefix('/skill:deploy')).toBe('deploy');
    expect(stripSkillPrefix('skill:deploy')).toBe('deploy');
  });

  it('strips the bare slash of builtin-sourced skill names', () => {
    expect(stripSkillPrefix('/lark-task')).toBe('lark-task');
  });

  it('returns skill:-less, slash-less input unchanged', () => {
    expect(stripSkillPrefix('deploy')).toBe('deploy');
  });
});
