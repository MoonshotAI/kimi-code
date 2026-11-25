
import Fuse, { type FuseResultMatch, type IFuseOptions } from 'fuse.js';
import { pinyin } from 'pinyin-pro';
import { replaceWithSourceMap, sourceOffsetAfter, sourceOffsetAt, trimSpans, type SourceMappedText } from './sourceMappedText';

export interface SlashCommand {
  name: string;
  desc: string;
  isSkill?: boolean;
  skillPath?: string;
  sourceKind?: 'global' | 'builtin' | 'plugin';
  workspaceLabel?: string;
  acceptsInput?: boolean;
  argHint?: string;
  noArgs?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/new',        desc: 'commands.new.desc', noArgs: true },
  { name: '/clear',      desc: 'commands.clear.desc', noArgs: true },
  { name: '/login',      desc: 'commands.login.desc', noArgs: true },
  { name: '/plan',       desc: 'commands.plan.desc' },
  { name: '/swarm',      desc: 'commands.swarm.desc' },
  { name: '/tower',      desc: 'commands.tower.desc' },
  { name: '/goal',       desc: 'commands.goal.desc' },
  { name: '/btw',        desc: 'commands.btw.desc', acceptsInput: true, argHint: 'commands.btw.argHint' },
  { name: '/compact',    desc: 'commands.compact.desc', acceptsInput: true, argHint: 'commands.compact.argHint' },
  { name: '/undo',       desc: 'commands.undo.desc', noArgs: true },
  { name: '/fork',       desc: 'commands.fork.desc', noArgs: true },
  { name: '/reload',     desc: 'commands.reload.desc', noArgs: true },
  { name: '/export',     desc: 'commands.export.desc', noArgs: true },
  { name: '/status',     desc: 'commands.status.desc', noArgs: true },
];

export const MODE_COMMANDS = {
  '/plan': 'plan',
  '/goal': 'goal',
  '/swarm': 'swarm',
} as const;

export type SlashModeCommand = (typeof MODE_COMMANDS)[keyof typeof MODE_COMMANDS];

export function modeCommandFor(bare: string): SlashModeCommand | undefined {
  return Object.hasOwn(MODE_COMMANDS, bare) ? MODE_COMMANDS[bare as keyof typeof MODE_COMMANDS] : undefined;
}

export function parseSlash(input: string): { cmd: string; arg: string } | null {
  if (!input.startsWith('/')) return null;
  const spaceIdx = input.indexOf(' ');
  if (spaceIdx === -1) {
    return { cmd: input, arg: '' };
  }
  return {
    cmd: input.slice(0, spaceIdx),
    arg: input.slice(spaceIdx + 1),
  };
}

export interface LeadingSlashCommandMatch {
  item: SlashCommand;
  commandRange: { start: number; end: number };
  argumentRange: { start: number; end: number };
  needsArgumentSeparator: boolean;
}

export function analyzeLeadingSlashCommand(
  input: string | SourceMappedText,
  items: ReadonlyArray<SlashCommand> = defaultHighlightCommands(),
): LeadingSlashCommandMatch | null {
  const mapped = typeof input === 'string' ? replaceWithSourceMap(input, trimSpans(input)) : input;
  const found = findLeadingCommand(mapped.text);
  if (!found) return null;
  const item = items.find((candidate) => candidate.isSkill !== true && candidate.name === found.cmd);
  if (!item) return null;
  if (item.noArgs === true && found.arg.trim() !== '') return null;

  const { source } = mapped;
  const commandStart = sourceOffsetAt(mapped, found.start);
  const commandEnd = sourceOffsetAfter(mapped, found.start + found.cmd.length);
  let argumentStart = commandEnd;
  while (source[argumentStart] === ' ') argumentStart += 1;
  return {
    item,
    commandRange: { start: commandStart, end: commandEnd },
    argumentRange: { start: argumentStart, end: source.length },
    needsArgumentSeparator: argumentStart === commandEnd,
  };
}

function findLeadingCommand(text: string): { cmd: string; arg: string; start: number } | null {
  const start = text.length - text.trimStart().length;
  if (modeCommandFor(text.slice(start, text.trimEnd().length)) !== undefined) {
    return { cmd: text.slice(start, text.trimEnd().length), arg: '', start };
  }
  const parsed = parseSlash(text);
  return parsed === null ? null : { cmd: parsed.cmd, arg: parsed.arg, start: 0 };
}

let highlightCommands: ReadonlyArray<SlashCommand> | null = null;

function defaultHighlightCommands(): ReadonlyArray<SlashCommand> {
  highlightCommands ??= buildSlashItems();
  return highlightCommands;
}

export const SKILL_COMMAND_PREFIX = 'skill:';

export function matchSlashItem(
  items: ReadonlyArray<SlashCommand>,
  cmd: string,
): SlashCommand | undefined {
  const exact = items.find((item) => item.name === cmd);
  if (exact !== undefined) return exact;
  const prefixed = `/${SKILL_COMMAND_PREFIX}${cmd.slice(1)}`;
  const bareSkill = items.find((item) => item.name === prefixed);
  if (bareSkill !== undefined) return bareSkill;
  if (!cmd.startsWith(`/${SKILL_COMMAND_PREFIX}`)) return undefined;
  const name = cmd.slice(1 + SKILL_COMMAND_PREFIX.length);
  if (name.length === 0 || name.includes(' ')) return undefined;
  return items.find((item) => item.isSkill === true && stripSkillPrefix(item.name) === name);
}

export function stripSkillPrefix(name: string): string {
  const bare = name.startsWith('/') ? name.slice(1) : name;
  return bare.startsWith(SKILL_COMMAND_PREFIX) ? bare.slice(SKILL_COMMAND_PREFIX.length) : bare;
}

export interface SkillRef {
  name: string;
  path?: string;
}

export function skillIdentity(skill: SkillRef): string {
  return `${skill.name.toLowerCase()}\0${skill.path ?? ''}`;
}

export function defaultSkillPath(skills: readonly SkillRef[], name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return skills.find((skill) => skill.name.toLowerCase() === normalizedName)?.path;
}

export function skillRefMatches(skill: SkillRef, ref: SkillRef): boolean {
  return skill.name.toLowerCase() === ref.name.toLowerCase() &&
    (ref.path === undefined || skill.path === ref.path);
}

export function skillSourceKind(source?: string): 'global' | 'builtin' | 'plugin' | undefined {
  if (source === 'builtin') return 'builtin';
  if (source === 'plugin') return 'plugin';
  if (source === 'user' || source === 'extra') return 'global';
  return undefined;
}

export function skillDirectoryName(workspaceDir?: string): string | undefined {
  if (workspaceDir === undefined || workspaceDir.length === 0) return undefined;
  const trimmed = workspaceDir.replace(/[\\/]+$/, '');
  if (trimmed.length === 0) return workspaceDir;
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const name = index === -1 ? trimmed : trimmed.slice(index + 1);
  return name.length === 0 ? workspaceDir : name;
}

export function skillCommandArgs(cmd: string, skillName: string, restoreText?: string): string | undefined {
  for (const head of [`/${SKILL_COMMAND_PREFIX}${skillName}`, `/${skillName}`]) {
    if (cmd === head) return undefined;
    if (cmd.startsWith(`${head} `)) return cmd.slice(head.length + 1).trim() || undefined;
  }
  return (restoreText ?? '').trim() || undefined;
}

export function buildSlashItems(
  skills: ReadonlyArray<{ name: string; description: string; source?: string; path?: string; workspaceDir?: string }> = [],
  opts?: {
    towerEnabled?: boolean;
    planEnabled?: boolean;
    swarmEnabled?: boolean;
    goalEnabled?: boolean;
    extraBuiltins?: readonly SlashCommand[];
  },
): SlashCommand[] {
  const builtins = SLASH_COMMANDS.filter((item) => {
    if (item.name === '/tower') return opts?.towerEnabled === true;
    if (item.name === '/plan') return opts?.planEnabled !== false;
    if (item.name === '/swarm') return opts?.swarmEnabled !== false;
    if (item.name === '/goal') return opts?.goalEnabled !== false;
    return true;
  });
  const skillItems: SlashCommand[] = skills.map((s) => ({
    name: s.source === 'builtin' ? `/${s.name}` : `/${SKILL_COMMAND_PREFIX}${s.name}`,
    desc: s.description,
    isSkill: true,
    skillPath: s.path,
    sourceKind: skillSourceKind(s.source),
    workspaceLabel: skillDirectoryName(s.workspaceDir),
    acceptsInput: true,
  }));
  return [...builtins, ...(opts?.extraBuiltins ?? []), ...skillItems];
}

interface DescPinyin {
  full: string;
  first: string;
}

interface DescPinyinUnits {
  full: string[];
  first: string[];
  offsets: number[];
  literal: boolean[];
}

const pinyinUnitCache = new Map<string, DescPinyinUnits>();

function descPinyinUnits(text: string): DescPinyinUnits {
  let hit = pinyinUnitCache.get(text);
  if (!hit) {
    const full = pinyin(text, { toneType: 'none', type: 'array' });
    const first = pinyin(text, { pattern: 'first', toneType: 'none', type: 'array' });
    hit = buildUnits(text, full, first);
    pinyinUnitCache.set(text, hit);
  }
  return hit;
}

const EMPTY_UNITS: DescPinyinUnits = { full: [], first: [], offsets: [], literal: [] };

function buildUnits(text: string, full: string[], first: string[]): DescPinyinUnits {
  if (full.length !== first.length) return EMPTY_UNITS;
  const offsets: number[] = [];
  const literal: boolean[] = [];
  let pos = 0;
  for (let i = 0; i < full.length; i++) {
    offsets.push(pos);
    const item = full[i]!;
    if (item.length > 0 && text.slice(pos, pos + item.length).toLowerCase() === item.toLowerCase()) {
      literal.push(true);
      pos += item.length;
    } else {
      literal.push(false);
      pos += Array.from(text.slice(pos))[0]?.length ?? 0;
    }
  }
  offsets.push(pos);
  if (pos !== text.length) return EMPTY_UNITS;
  return { full, first, offsets, literal };
}

function pinyinSpanToText(
  units: DescPinyinUnits,
  which: 'full' | 'first',
  start: number,
  endExclusive: number,
): [number, number] | undefined {
  const arr = units[which];
  let offset = 0;
  let startUnit = -1;
  let endUnit = -1;
  let startUnitBegin = 0;
  let endUnitBegin = 0;
  for (let i = 0; i < arr.length; i++) {
    const next = offset + (arr[i]?.length ?? 0);
    if (startUnit < 0 && start < next) {
      startUnit = i;
      startUnitBegin = offset;
    }
    if (endExclusive <= next) {
      endUnit = i;
      endUnitBegin = offset;
      break;
    }
    offset = next;
  }
  if (startUnit < 0 || endUnit < 0) return undefined;
  const from = units.literal[startUnit]
    ? units.offsets[startUnit]! + (start - startUnitBegin)
    : units.offsets[startUnit]!;
  const to = units.literal[endUnit]
    ? units.offsets[endUnit]! + (endExclusive - endUnitBegin)
    : units.offsets[endUnit + 1]!;
  return [from, to];
}

const pinyinCache = new Map<string, DescPinyin>();

function descPinyin(text: string): DescPinyin {
  let hit = pinyinCache.get(text);
  if (!hit) {
    hit = {
      full: pinyin(text, { toneType: 'none', type: 'string', separator: '' }),
      first: pinyin(text, { pattern: 'first', toneType: 'none', type: 'string', separator: '' }),
    };
    pinyinCache.set(text, hit);
  }
  return hit;
}

function literalRange(text: string, q: string): [number, number] | undefined {
  const i = text.toLowerCase().indexOf(q);
  return i < 0 ? undefined : [i, i + q.length];
}

function subsequenceRange(text: string, q: string): [number, number] | undefined {
  const lower = text.toLowerCase();
  let qi = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) {
      if (qi === 0) start = i;
      end = i;
      qi++;
    }
  }
  return qi === q.length ? [start, end + 1] : undefined;
}

function nameMatchRange(name: string, q: string): [number, number] | undefined {
  return literalRange(name, q) ?? subsequenceRange(name, q);
}

function descMatchRange(desc: string, q: string): [number, number] | undefined {
  const literal = literalRange(desc, q);
  if (literal) return literal;
  if (!/^[\x21-\x7e]+$/.test(q)) return undefined;
  const units = descPinyinUnits(desc);
  const ii = units.first.join('').indexOf(q);
  if (ii >= 0) return pinyinSpanToText(units, 'first', ii, ii + q.length);
  const si = units.full.join('').indexOf(q);
  if (si < 0) return undefined;
  return pinyinSpanToText(units, 'full', si, si + q.length);
}

export function matchRanges(
  query: string,
  name: string,
  desc: string,
): SlashMatchRanges {
  const q = query.trim().replace(/^\//, '').toLowerCase();
  if (q === '') return {};
  const n = nameMatchRange(name, q);
  const d = descMatchRange(desc, q);
  return { name: n ? [n] : undefined, desc: d ? [d] : undefined };
}

interface SearchDoc {
  index: number;
  item: SlashCommand;
  name: string;
  desc: string;
  pinyinFull: string;
  pinyinFirst: string;
}

const FUSE_OPTIONS: IFuseOptions<SearchDoc> = {
  keys: [
    { name: 'name', weight: 3 },
    { name: 'desc', weight: 1 },
    { name: 'pinyinFull', weight: 1 },
    { name: 'pinyinFirst', weight: 1 },
  ],
  includeScore: true,
  includeMatches: true,
  ignoreLocation: true,
  threshold: 0.4,
};

function nameRank(name: string, q: string): number {
  const n = name.toLowerCase();
  const query = q.toLowerCase();
  if (n === query) return 0;
  if (n.startsWith(query)) return 1;
  return 2;
}

export interface SlashMatchRanges {
  name?: [number, number][];
  desc?: [number, number][];
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

export interface SlashMatch {
  item: SlashCommand;
  ranges: SlashMatchRanges;
}

function collectRanges(doc: SearchDoc, matches: readonly FuseResultMatch[] | undefined): SlashMatchRanges {
  const name: [number, number][] = [];
  const desc: [number, number][] = [];
  for (const match of matches ?? []) {
    for (const [s, e] of match.indices) {
      if (match.key === 'name') {
        name.push([s + 1, e + 2]);
      } else if (match.key === 'desc') {
        desc.push([s, e + 1]);
      } else if (match.key === 'pinyinFirst' || match.key === 'pinyinFull') {
        const mapped = pinyinSpanToText(
          descPinyinUnits(doc.desc),
          match.key === 'pinyinFirst' ? 'first' : 'full',
          s,
          e + 1,
        );
        if (mapped) desc.push(mapped);
      }
    }
  }
  return {
    name: name.length > 0 ? mergeRanges(name) : undefined,
    desc: desc.length > 0 ? mergeRanges(desc) : undefined,
  };
}

export function filterCommandMatches(
  query: string,
  items: SlashCommand[] = SLASH_COMMANDS,
  resolveDesc: (item: SlashCommand) => string = (item) => item.desc,
): SlashMatch[] {
  const q = query.trim().replace(/^\//, '');
  if (q === '') {
    return [...items]
      .sort((a, b) => Number(a.isSkill === true) - Number(b.isSkill === true))
      .map((item) => ({ item, ranges: {} }));
  }

  const docs: SearchDoc[] = items.map((item, index) => {
    const desc = resolveDesc(item);
    const py = descPinyin(desc);
    return {
      index,
      item,
      name: item.name.replace(/^\//, ''),
      desc,
      pinyinFull: py.full,
      pinyinFirst: py.first,
    };
  });
  const ranked = new Fuse(docs, FUSE_OPTIONS)
    .search(q)
    .map(({ item: doc, score, matches }) => ({
      doc,
      score: score ?? 1,
      rank: nameRank(doc.name, q),
      ranges: collectRanges(doc, matches),
    }))
    .sort((a, b) =>
      a.doc.item.isSkill !== b.doc.item.isSkill
        ? Number(a.doc.item.isSkill === true) - Number(b.doc.item.isSkill === true)
        : a.rank !== b.rank
          ? a.rank - b.rank
          : a.score !== b.score ? a.score - b.score : a.doc.index - b.doc.index,
    );
  const groupKey = (match: (typeof ranked)[number]): string =>
    `${Number(match.doc.item.isSkill === true)}\0${match.rank}\0${match.doc.item.name}`;
  const groupOrder = new Map<string, number>();
  for (const [index, match] of ranked.entries()) {
    const key = groupKey(match);
    if (!groupOrder.has(key)) groupOrder.set(key, index);
  }
  return ranked.sort((a, b) =>
    a.doc.item.isSkill !== b.doc.item.isSkill
      ? Number(a.doc.item.isSkill === true) - Number(b.doc.item.isSkill === true)
      : a.rank !== b.rank
        ? a.rank - b.rank
        : groupOrder.get(groupKey(a))! - groupOrder.get(groupKey(b))! || a.doc.index - b.doc.index,
  ).map(({ doc, ranges }) => ({ item: doc.item, ranges }));
}

export function filterCommands(
  query: string,
  items: SlashCommand[] = SLASH_COMMANDS,
  resolveDesc: (item: SlashCommand) => string = (item) => item.desc,
): SlashCommand[] {
  return filterCommandMatches(query, items, resolveDesc).map((match) => match.item);
}
