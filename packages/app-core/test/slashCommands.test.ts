import { describe, expect, it } from 'vitest';
import { analyzeLeadingSlashCommand, buildSlashItems, filterCommandMatches, filterCommands, matchRanges, matchSlashItem, skillCommandArgs, skillDirectoryName, skillIdentity, skillRefMatches, skillSourceKind, stripSkillPrefix, type SlashCommand } from '../src/lib/slashCommands';
import { replaceWithSourceMap } from '../src/lib/sourceMappedText';

const passThrough = (item: SlashCommand): string => item.desc;

const zhItems: SlashCommand[] = [
  { name: '/new', desc: '创建新会话' },
  { name: '/clear', desc: '清空并新建会话' },
  { name: '/goal', desc: '创建/控制目标' },
  { name: '/write-goal', desc: 'Help craft a goal objective', isSkill: true },
];

describe('analyzeLeadingSlashCommand', () => {
  it('matches a known command at the start of the input', () => {
    const match = analyzeLeadingSlashCommand('/compact keep the API details');
    expect(match?.item.name).toBe('/compact');
    expect(match?.commandRange).toEqual({ start: 0, end: 8 });
    expect(match?.argumentRange).toEqual({ start: 9, end: 29 });
    expect(match?.needsArgumentSeparator).toBe(false);
  });

  it('allows leading spaces without including them in the highlighted range', () => {
    const match = analyzeLeadingSlashCommand('  /compact');
    expect(match?.commandRange).toEqual({ start: 2, end: 10 });
    expect(match?.argumentRange).toEqual({ start: 10, end: 10 });
    expect(match?.needsArgumentSeparator).toBe(true);
  });

  it('anchors an empty argument after every typed separator', () => {
    const match = analyzeLeadingSlashCommand('/compact   ');
    expect(match?.argumentRange).toEqual({ start: 11, end: 11 });
    expect(match?.needsArgumentSeparator).toBe(false);
  });

  it('rejects commands preceded by text, unknown heads, and partial names', () => {
    expect(analyzeLeadingSlashCommand('explain /compact')).toBeNull();
    expect(analyzeLeadingSlashCommand('/unknown')).toBeNull();
    expect(analyzeLeadingSlashCommand('/compactx')).toBeNull();
  });

  it('rejects arguments for commands declared as no-args', () => {
    expect(analyzeLeadingSlashCommand('/new session')).toBeNull();
    expect(analyzeLeadingSlashCommand('/new   ')?.item.name).toBe('/new');
  });

  it('does not treat skills as built-in commands', () => {
    const items = buildSlashItems([{ name: 'deploy', description: 'Ship it' }]);
    expect(analyzeLeadingSlashCommand('/skill:deploy now', items)).toBeNull();
  });

  it('accepts a command the submit path reaches past a leading newline', () => {
    const source = '\n/clear';
    const match = analyzeLeadingSlashCommand(source);
    expect(match?.item.name).toBe('/clear');
    expect(source.slice(match!.commandRange.start, match!.commandRange.end)).toBe('/clear');
    expect(match?.commandRange).toEqual({ start: 1, end: 7 });
  });

  it('still rejects a command that ordinary text precedes across lines', () => {
    expect(analyzeLeadingSlashCommand('explain\n/clear')).toBeNull();
  });

  it('does not count a dropped span as an argument for a no-argument command', () => {
    const source = '/clear <<pill>>';
    const mapped = replaceWithSourceMap(source, [{ start: 7, end: 15 }]);
    const match = analyzeLeadingSlashCommand(mapped);
    expect(match?.item.name).toBe('/clear');
    expect(source.slice(match!.commandRange.start, match!.commandRange.end)).toBe('/clear');
    expect(match?.argumentRange).toEqual({ start: 7, end: source.length });
  });

  it('rejects a command that a dropped span leaves behind a space, as the submit path does', () => {
    const source = '<<pill>> /new';
    expect(analyzeLeadingSlashCommand(replaceWithSourceMap(source, [{ start: 0, end: 8 }]))).toBeNull();
  });

  it('maps the command range past a dropped span that abuts it', () => {
    const source = '<<pill>>/new';
    const mapped = replaceWithSourceMap(source, [{ start: 0, end: 8 }]);
    const match = analyzeLeadingSlashCommand(mapped);
    expect(match?.item.name).toBe('/new');
    expect(source.slice(match!.commandRange.start, match!.commandRange.end)).toBe('/new');
    expect(match?.commandRange).toEqual({ start: 8, end: 12 });
  });

  it('keeps rejecting a real argument on a no-argument command after normalisation', () => {
    const source = '/new <<pill>> session';
    const mapped = replaceWithSourceMap(source, [{ start: 5, end: 13 }]);
    expect(analyzeLeadingSlashCommand(mapped)).toBeNull();
  });

  it('reads a bare mode command through the submit path\'s dedicated second trim', () => {
    for (const cmd of ['/plan', '/goal', '/swarm']) {
      const source = `<<pill>> ${cmd}`;
      const mapped = replaceWithSourceMap(source, [{ start: 0, end: 8 }]);
      const match = analyzeLeadingSlashCommand(mapped);
      expect(match?.item.name).toBe(cmd);
      expect(source.slice(match!.commandRange.start, match!.commandRange.end)).toBe(cmd);
      expect(match?.commandRange).toEqual({ start: 9, end: 9 + cmd.length });
    }
  });

  it('keeps the mode reading to the bare form only', () => {
    const withArg = '<<pill>> /swarm on';
    expect(analyzeLeadingSlashCommand(replaceWithSourceMap(withArg, [{ start: 0, end: 8 }]))).toBeNull();
    const notMode = '<<pill>> /compact';
    expect(analyzeLeadingSlashCommand(replaceWithSourceMap(notMode, [{ start: 0, end: 8 }]))).toBeNull();
  });

  it('leaves a flag-gated command undecorated while a plain command still matches', () => {
    expect(analyzeLeadingSlashCommand('/tower')).toBeNull();
    expect(analyzeLeadingSlashCommand('/tower main')).toBeNull();
    expect(analyzeLeadingSlashCommand('/clear')?.item.name).toBe('/clear');
    expect(analyzeLeadingSlashCommand('/tower', buildSlashItems([], { towerEnabled: true }))?.item.name).toBe('/tower');
  });
});

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

describe('skill grouping', () => {
  it('places ordinary commands before one continuous skill group with and without fuzzy matching', () => {
    const items: SlashCommand[] = [
      { name: '/skill:lark-calendar', desc: 'Calendar', isSkill: true },
      { name: '/plan', desc: 'Toggle plan mode' },
      { name: '/skill:lark-approval', desc: 'Approval', isSkill: true },
      { name: '/skill:lark-vc', desc: 'Video calls', isSkill: true },
    ];
    const expected = [
      '/plan',
      '/skill:lark-calendar',
      '/skill:lark-approval',
      '/skill:lark-vc',
    ];

    expect(filterCommands('/', items, passThrough).map((item) => item.name)).toEqual(expected);
    expect(filterCommands('la', items, passThrough).map((item) => item.name)).toEqual(expected);
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
    expect(matchRanges('yinyue', '/music', '音乐模式').desc).toEqual([[0, 2]]);
  });

  it('keeps the highlight mapping for mixed-language descriptions', () => {
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
    expect(matches[0]?.ranges.name).toEqual([[1, 7]]);
  });

  it('maps a pinyin-key hit back onto the description characters', () => {
    const items: SlashCommand[] = [{ name: '/new', desc: '创建新会话' }];
    const matches = filterCommandMatches('xhh', items, passThrough);
    expect(matches[0]?.ranges.desc).toEqual([[2, 5]]);
  });

  it('maps a polyphonic pinyin hit back onto the exact characters', () => {
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
    const items: SlashCommand[] = [{ name: '/swarm', desc: '切换 swarm 模式' }];
    const matches = filterCommandMatches('war', items, passThrough);
    expect(matches[0]?.ranges.desc).toEqual([[4, 7]]);
  });
});

describe('stripSkillPrefix', () => {
  it('strips the skill: prefix with or without the leading slash', () => {
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

describe('matchSlashItem', () => {
  const skills = [
    { name: 'deploy', description: 'Ship it' },
    { name: 'commit', description: 'Builtin-sourced skill', source: 'builtin' },
    { name: 'compact', description: 'Skill sharing a builtin name', source: 'builtin' },
  ];
  const items = buildSlashItems(skills);

  it('matches a built-in command exactly', () => {
    expect(matchSlashItem(items, '/new')?.name).toBe('/new');
  });

  it('resolves a bare skill name to its prefixed menu item (TUI parity)', () => {
    const match = matchSlashItem(items, '/deploy');
    expect(match?.name).toBe('/skill:deploy');
    expect(match?.isSkill).toBe(true);
  });

  it('matches the prefixed form of a non-builtin skill directly', () => {
    expect(matchSlashItem(items, '/skill:deploy')?.isSkill).toBe(true);
  });

  it('matches the prefixed form of a builtin-sourced skill (menu item is bare)', () => {
    const match = matchSlashItem(items, '/skill:commit');
    expect(match?.name).toBe('/commit');
    expect(match?.isSkill).toBe(true);
  });

  it('an explicit /skill: prefix activates the skill even when a builtin command shares the name', () => {
    const match = matchSlashItem(items, '/skill:compact');
    expect(match?.isSkill).toBe(true);
    expect(stripSkillPrefix(match!.name)).toBe('compact');
  });

  it('a bare builtin command still wins over a same-named skill', () => {
    const match = matchSlashItem(items, '/compact');
    expect(match?.name).toBe('/compact');
    expect(match?.isSkill).toBeUndefined();
  });

  it('returns undefined for unknown commands and space-carrying heads', () => {
    expect(matchSlashItem(items, '/nonexistent')).toBeUndefined();
    expect(matchSlashItem(items, '/skill:')).toBeUndefined();
    expect(matchSlashItem(items, '/skill:write goal')).toBeUndefined();
  });
});

describe('same-name skill variants', () => {
  const variants = [
    { name: 'review', description: 'Primary', path: '/work/A/review/SKILL.md', workspaceDir: '/work/A' },
    { name: 'review', description: 'Secondary', path: '/work/B/review/SKILL.md', workspaceDir: '/work/B' },
  ];

  it('keeps duplicate menu entries with distinct selectors and basename labels', () => {
    const items = buildSlashItems(variants).filter((item) => item.isSkill);
    expect(items.map((item) => item.name)).toEqual(['/skill:review', '/skill:review']);
    expect(items.map((item) => item.skillPath)).toEqual(variants.map((skill) => skill.path));
    expect(items.map((item) => item.workspaceLabel)).toEqual(['A', 'B']);
    expect(matchSlashItem(items, '/skill:review')?.skillPath).toBe(variants[0]!.path);
    expect(skillIdentity(variants[0]!)).not.toBe(skillIdentity(variants[1]!));
    expect(skillRefMatches(variants[1]!, { name: 'review', path: variants[1]!.path })).toBe(true);
    expect(skillRefMatches(variants[0]!, { name: 'review' })).toBe(true);
  });

  it('keeps the default variant first when descriptions score differently', () => {
    const ordered = [
      { ...variants[0]!, description: 'Primary documentation' },
      { ...variants[1]!, description: 'skill:review' },
    ];

    const matches = filterCommandMatches('/skill:review', buildSlashItems(ordered));

    expect(matches.map((match) => match.item.skillPath)).toEqual([
      variants[0]!.path,
      variants[1]!.path,
    ]);
  });

  it('keeps the default variant first when another name shares the rank', () => {
    const ordered = [
      { ...variants[0]!, description: 'primary' },
      { ...variants[1]!, description: 'review' },
      { name: 'reviewer', description: 'review', path: '/work/C/reviewer/SKILL.md', workspaceDir: '/work/C' },
    ];

    const matches = filterCommandMatches('revi', buildSlashItems(ordered));

    expect(matches.map((match) => match.item.skillPath)).toEqual([
      variants[0]!.path,
      variants[1]!.path,
      '/work/C/reviewer/SKILL.md',
    ]);
  });

  it('normalizes directory basenames across separators', () => {
    expect(skillDirectoryName('/work/project/')).toBe('project');
    expect(skillDirectoryName('C:\\work\\project\\')).toBe('project');
    expect(skillDirectoryName('/')).toBe('/');
    expect(skillDirectoryName(undefined)).toBeUndefined();
  });
});

describe('skill source labels', () => {
  it('classifies global and built-in sources without changing project defaults', () => {
    expect(skillSourceKind('user')).toBe('global');
    expect(skillSourceKind('extra')).toBe('global');
    expect(skillSourceKind('plugin')).toBe('global');
    expect(skillSourceKind('builtin')).toBe('builtin');
    expect(skillSourceKind('project')).toBeUndefined();
    expect(skillSourceKind(undefined)).toBeUndefined();

    const items = buildSlashItems([
      { name: 'global-skill', description: 'Global', source: 'user' },
      { name: 'builtin-skill', description: 'Built-in', source: 'builtin' },
      { name: 'project-skill', description: 'Project', source: 'project' },
    ]).filter((item) => item.isSkill);
    expect(items.map((item) => item.sourceKind)).toEqual(['global', 'builtin', undefined]);
  });
});

describe('buildSlashItems /tower listing gate', () => {
  it('keeps /tower out of listings unless towerEnabled opts in (daemon-reported flag)', () => {
    const gated = buildSlashItems();
    expect(gated.some((item) => item.name === '/tower')).toBe(false);
    expect(gated.some((item) => item.name === '/swarm')).toBe(true);
    const open = buildSlashItems([], { towerEnabled: true });
    expect(open.some((item) => item.name === '/tower')).toBe(true);
  });

  it('a typed /tower resolves from the decision list (always opted in)', () => {
    expect(matchSlashItem(buildSlashItems([], { towerEnabled: true }), '/tower')?.name).toBe('/tower');
    expect(matchSlashItem(buildSlashItems(), '/tower')).toBeUndefined();
  });
});

describe('skillCommandArgs', () => {
  it('a bare skill command (no args) activates with NO args — not the command itself', () => {
    expect(skillCommandArgs('/update-config', 'update-config', '/update-config')).toBeUndefined();
    expect(skillCommandArgs('/skill:update-config', 'update-config', '/skill:update-config')).toBeUndefined();
  });

  it('slices the args after a recognized head', () => {
    expect(skillCommandArgs('/update-config ship it', 'update-config')).toBe('ship it');
    expect(skillCommandArgs('/skill:update-config ship it', 'update-config')).toBe('ship it');
  });

  it('matches the bare head of a builtin-sourced skill reached via the prefixed form', () => {
    expect(skillCommandArgs('/skill:commit amend', 'commit')).toBe('amend');
    expect(skillCommandArgs('/skill:commit', 'commit', '/skill:commit')).toBeUndefined();
  });

  it('keeps a pill command’s args verbatim (the pill link revives in the bubble)', () => {
    const args = '[deploy](kimi-code://skill/deploy) go';
    expect(skillCommandArgs(`/skill:deploy ${args}`, 'deploy', 'deploy go')).toBe(args);
  });

  it('handles a spaced skill name riding the pill command', () => {
    expect(skillCommandArgs('/skill:write goal x', 'write goal')).toBe('x');
    expect(skillCommandArgs('/skill:write goal ', 'write goal')).toBeUndefined();
  });

  it('falls back to the original text only when the head is unrecognizable', () => {
    expect(skillCommandArgs('/mystery', 'deploy', 'original message')).toBe('original message');
    expect(skillCommandArgs('/mystery', 'deploy')).toBeUndefined();
    expect(skillCommandArgs('/mystery', 'deploy', '   ')).toBeUndefined();
  });
});
