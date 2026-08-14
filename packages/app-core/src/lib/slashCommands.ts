// packages/app-core/src/lib/slashCommands.ts
// Pure TS — no Vue, no side effects. Slash-command metadata + parsers.

import Fuse, { type FuseResultMatch, type IFuseOptions } from 'fuse.js';
import { pinyin } from 'pinyin-pro';

export interface SlashCommand {
  name: string;
  /**
   * Description text. For built-in commands this is an i18n KEY (resolve with
   * t(desc)); for skills (`isSkill`) it is the skill's RAW description, rendered
   * verbatim.
   */
  desc: string;
  /**
   * True for a session skill (not a built-in command). Selecting one activates
   * the skill instead of running an app command, and its `desc` is raw text.
   */
  isSkill?: boolean;
  /**
   * Selecting the item should leave the command in the composer so the user can
   * type the message/argument that follows it.
   */
  acceptsInput?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/new',        desc: 'commands.new.desc' },
  { name: '/clear',      desc: 'commands.clear.desc' },
  { name: '/login',      desc: 'commands.login.desc' },
  { name: '/plan',       desc: 'commands.plan.desc' },
  { name: '/swarm',      desc: 'commands.swarm.desc' },
  // /goal arms the goal pill on select (the intent pill takes the objective
  // as the next message) — a typed `/goal <objective>` still creates
  // directly via the command path, so it is NOT acceptsInput.
  { name: '/goal',       desc: 'commands.goal.desc' },
  { name: '/btw',        desc: 'commands.btw.desc', acceptsInput: true },
  { name: '/auto',       desc: 'commands.auto.desc' },
  { name: '/yolo',       desc: 'commands.yolo.desc' },
  { name: '/thinking',   desc: 'commands.thinking.desc' },
  { name: '/compact',    desc: 'commands.compact.desc', acceptsInput: true },
  { name: '/undo',       desc: 'commands.undo.desc' },
  { name: '/fork',       desc: 'commands.fork.desc' },
  { name: '/export',     desc: 'commands.export.desc' },
  { name: '/status',     desc: 'commands.status.desc' },
];

/**
 * Parse a slash command from the start of the input string.
 * Returns { cmd, arg } if input starts with `/` at line start (no leading whitespace),
 * otherwise returns null.
 *
 * Examples:
 *   "/help"         -> { cmd: "/help", arg: "" }
 *   "/new session"  -> { cmd: "/new", arg: "session" }
 *   "hello /help"   -> null (slash not at line start)
 *   "  /help"       -> null (leading whitespace)
 */
export function parseSlash(input: string): { cmd: string; arg: string } | null {
  if (!input.startsWith('/')) return null;
  // Must start exactly at position 0 (no leading spaces)
  const spaceIdx = input.indexOf(' ');
  if (spaceIdx === -1) {
    return { cmd: input, arg: '' };
  }
  return {
    cmd: input.slice(0, spaceIdx),
    arg: input.slice(spaceIdx + 1),
  };
}

/** The prefix marking a slash item as a skill activation (`/skill:<name>`). */
export const SKILL_COMMAND_PREFIX = 'skill:';

/**
 * Strip the `skill:` prefix from a slash-command name (with or without the
 * leading `/`), returning the bare skill name. Non-prefixed input is returned
 * unchanged.
 */
export function stripSkillPrefix(name: string): string {
  return name.startsWith(SKILL_COMMAND_PREFIX) ? name.slice(SKILL_COMMAND_PREFIX.length) : name;
}

/**
 * Build the full slash-item list: built-in commands followed by the session's
 * skills. Non-builtin skills are shown as `/skill:<skill-name>` so the user can
 * tell them apart from built-in commands (mirroring the TUI); builtin-sourced
 * skills keep the bare `/<skill-name>`. Skills carry their raw description and
 * an `isSkill` flag so the caller knows to activate rather than run a command.
 */
export function buildSlashItems(
  skills: ReadonlyArray<{ name: string; description: string; source?: string }> = [],
): SlashCommand[] {
  const skillItems: SlashCommand[] = skills.map((s) => ({
    name: s.source === 'builtin' ? `/${s.name}` : `/${SKILL_COMMAND_PREFIX}${s.name}`,
    desc: s.description,
    isSkill: true,
    // Keep the selected skill in the composer so arguments can be appended.
    acceptsInput: true,
  }));
  return [...SLASH_COMMANDS, ...skillItems];
}

/**
 * Pinyin renderings of a description, for matching CJK text by romanization:
 * `full` concatenates whole syllables ('创建新会话' → 'chuangjianxinhuihua'),
 * `first` concatenates initials (→ 'cjxhh'). Latin text passes through both
 * unchanged-ish, so non-CJK descriptions gain nothing but a second copy.
 */
interface DescPinyin {
  full: string;
  first: string;
}

/** Per-token pinyin with the UTF-16 span each token covers in the source,
    so a letter span maps back to slice()-able indices. pinyin-pro renders
    one CJK code point per array item, but how it segments passed-through
    text (latin runs, digits, emoji) is its own choice and may change
    between versions — the spans are derived by walking the source, not
    assumed. `literal` marks the passed-through units, whose characters map
    1:1 onto the source. */
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
    // Convert the whole string in one call — the same conversion descPinyin
    // uses for the search document — so polyphonic characters resolve by
    // context (乐 → 'yue' in 音乐, not the per-char 'le') and the highlight
    // mapping can never disagree with the matched pinyin.
    const full = pinyin(text, { toneType: 'none', type: 'array' });
    const first = pinyin(text, { pattern: 'first', toneType: 'none', type: 'array' });
    hit = buildUnits(text, full, first);
    pinyinUnitCache.set(text, hit);
  }
  return hit;
}

const EMPTY_UNITS: DescPinyinUnits = { full: [], first: [], offsets: [], literal: [] };

/** Pair the conversion arrays with their source spans by walking the text:
    an item that literally matches the source at the cursor is a
    passed-through run (pinyin-pro may group one — 'swarm' as a single
    item); anything else is one CJK code point rendered as pinyin. */
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
      // Array.from: consume one code point, not one UTF-16 unit.
      pos += Array.from(text.slice(pos))[0]?.length ?? 0;
    }
  }
  offsets.push(pos);
  // The walk must consume the source exactly; anything else means the
  // segmentation isn't understood — empty units make pinyinSpanToText bail
  // (no highlight) rather than highlight wrong text.
  if (pos !== text.length) return EMPTY_UNITS;
  return { full, first, offsets, literal };
}

/** Map a span within one of the pinyin strings back to slice() offsets in
    the original text. */
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
  // A boundary inside a passed-through unit keeps its exact character
  // offset (the unit's letters map 1:1 onto the source) — otherwise 'war'
  // would widen to bolding the whole 'swarm' unit. A boundary inside a CJK
  // unit can't be placed, so it takes the unit's edge as before.
  const from = units.literal[startUnit]
    ? units.offsets[startUnit]! + (start - startUnitBegin)
    : units.offsets[startUnit]!;
  const to = units.literal[endUnit]
    ? units.offsets[endUnit]! + (endExclusive - endUnitBegin)
    : units.offsets[endUnit + 1]!;
  return [from, to];
}

// Descriptions repeat across every keystroke of a menu session; cache the
// conversion per source string.
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

/** First greedy left-to-right subsequence occurrence (the fuzzy-name case). */
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
  // The pinyin paths only make sense for plain-ASCII queries.
  if (!/^[\x21-\x7e]+$/.test(q)) return undefined;
  const units = descPinyinUnits(desc);
  const ii = units.first.join('').indexOf(q);
  if (ii >= 0) return pinyinSpanToText(units, 'first', ii, ii + q.length);
  const si = units.full.join('').indexOf(q);
  if (si < 0) return undefined;
  return pinyinSpanToText(units, 'full', si, si + q.length);
}

/**
 * The highlight ranges for a query against a row's name and description, in
 * the same vocabulary filterCommands searches — literal substring first, a
 * left-to-right subsequence for names, and pinyin (initials or full
 * syllables) mapped back onto the description's own characters. Ranges index
 * into the original strings; undefined when nothing matches.
 */
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
  /** Bare command name without the leading `/`. */
  name: string;
  /** Resolved description (display text, not an i18n key). */
  desc: string;
  pinyinFull: string;
  pinyinFirst: string;
}

const FUSE_OPTIONS: IFuseOptions<SearchDoc> = {
  keys: [
    // Command names dominate; description and its pinyin forms assist.
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

/**
 * Filter slash items by a query string — fuzzy matching over the command
 * name (dominant), the resolved description, and the description's pinyin
 * (full syllables and initials, so 'xinhuihua' and 'xhh' both find 新会话).
 * Results order by match quality, ties by original list order, so exact and
 * prefix name matches still surface first. If query is empty or just "/",
 * returns all items. Defaults to the built-in commands; pass a merged list
 * (see buildSlashItems) to include skills. `resolveDesc` maps an item to its
 * display description — built-in descs are i18n keys, so callers with a `t()`
 * should pass one; it defaults to the raw `desc`.
 */
/** Rank of a name match: exact > prefix > anywhere (ignoreLocation would
    otherwise let a mid-name substring beat a prefix). */
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

/** Sort and merge overlapping or adjacent ranges (multi-fragment fuzzy hits
    produce several disjoint ones). */
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

// Fuse reports [start, end] INCLUSIVE; we store half-open ranges into the
// row's original strings (the command name keeps its leading `/`). Every
// fragment is kept — a fuzzy hit like `gol`→`/goal` matches several.
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
        // Map the pinyin-string span back onto the description's own text.
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

/**
 * filterCommands plus Fuse's actual match ranges, so the highlight follows
 * whatever Fuse really hit — edit-distance matches included (e.g. `statuz`
 * still lights up `/status`).
 */
export function filterCommandMatches(
  query: string,
  items: SlashCommand[] = SLASH_COMMANDS,
  resolveDesc: (item: SlashCommand) => string = (item) => item.desc,
): SlashMatch[] {
  const q = query.trim().replace(/^\//, '');
  if (q === '') return items.map((item) => ({ item, ranges: {} }));

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
  return new Fuse(docs, FUSE_OPTIONS)
    .search(q)
    .map(({ item: doc, score, matches }) => ({
      doc,
      score: score ?? 1,
      rank: nameRank(doc.name, q),
      ranges: collectRanges(doc, matches),
    }))
    .sort((a, b) =>
      a.rank !== b.rank ? a.rank - b.rank : a.score !== b.score ? a.score - b.score : a.doc.index - b.doc.index,
    )
    .map(({ doc, ranges }) => ({ item: doc.item, ranges }));
}

export function filterCommands(
  query: string,
  items: SlashCommand[] = SLASH_COMMANDS,
  resolveDesc: (item: SlashCommand) => string = (item) => item.desc,
): SlashCommand[] {
  return filterCommandMatches(query, items, resolveDesc).map((match) => match.item);
}
