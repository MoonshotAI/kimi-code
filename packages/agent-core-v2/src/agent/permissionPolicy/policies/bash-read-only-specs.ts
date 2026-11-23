export type FlagValueKind = 'none' | 'optional' | 'string' | 'number';

export interface SafeFlagSpec {
  readonly flags: Readonly<Record<string, FlagValueKind>>;
  readonly respectsDoubleDash?: boolean;
  readonly allowNumericDash?: boolean;
  readonly allowAttachedString?: boolean;
  readonly allowCombinedTrailingValue?: boolean;
}

export interface ParsedSafeFlags {
  readonly positionals: string[];
  readonly flagValues: [string, string][];
  readonly seenFlags: Set<string>;
}

function flagMap(
  noneFlags: string,
  stringFlags = '',
  numberFlags = '',
  optionalFlags = '',
): Readonly<Record<string, FlagValueKind>> {
  const map: Record<string, FlagValueKind> = {};
  for (const flag of noneFlags.split(' ')) {
    if (flag.length > 0) map[flag] = 'none';
  }
  for (const flag of stringFlags.split(' ')) {
    if (flag.length > 0) map[flag] = 'string';
  }
  for (const flag of numberFlags.split(' ')) {
    if (flag.length > 0) map[flag] = 'number';
  }
  for (const flag of optionalFlags.split(' ')) {
    if (flag.length > 0) map[flag] = 'optional';
  }
  return map;
}

function wordSet(words: string): ReadonlySet<string> {
  return new Set(words.split(' ').filter((word) => word.length > 0));
}

export const NO_ARG_READ_ONLY_COMMANDS = wordSet('pwd whoami alias true false');

export const EXACT_READ_ONLY_INVOCATIONS: readonly (readonly string[])[] = [
  ['kimi', '-h'],
  ['kimi', '--help'],
  ['kimi', '-v'],
  ['kimi', '--version'],
  ['node', '-v'],
  ['node', '--version'],
  ['python', '--version'],
  ['python3', '--version'],
  ['ip', 'addr'],
];

export const BASIC_FILE_READ_COMMANDS = wordSet(
  'ls cat head tail wc stat diff du df strings hexdump od nl cut column tac rev cmp basename dirname realpath readlink sha256sum sha1sum md5sum paste fold expand unexpand fmt comm',
);

export const CWD_READING_COMMANDS = wordSet('ls cd du df diff rg fd fdfind find tree git');

export const SAFE_ENV_VARS = wordSet(
  'LANG LANGUAGE LC_ALL LC_CTYPE LC_TIME CHARSET TERM COLORTERM NO_COLOR FORCE_COLOR TZ COLUMNS LINES CLICOLOR CLICOLOR_FORCE CI GIT_TERMINAL_PROMPT PAGER GIT_PAGER',
);

const LOCALE_ENV_VARS: ReadonlySet<string> = new Set(['LANG', 'LC_ALL', 'LC_CTYPE']);
const LOCALE_VALUE_RE = /^(?:C|POSIX|UTF-?8|[\w-]+\.UTF-?8(?:@\w+)?)$/i;
const SIMPLE_ENV_VALUE_RE = /^[A-Za-z0-9_.:+-]*$/;

export function isSafeEnvValue(name: string, value: string): boolean {
  if (!SAFE_ENV_VARS.has(name)) return false;
  if (name === 'PAGER' || name === 'GIT_PAGER') return value === '' || value === 'cat';
  if (LOCALE_ENV_VARS.has(name)) return value === '' || LOCALE_VALUE_RE.test(value);
  return SIMPLE_ENV_VALUE_RE.test(value);
}

export const ZERO_FILE_COMMAND_SPECS: Readonly<Record<string, SafeFlagSpec>> = {
  uname: {
    flags: flagMap(
      '-a -s -n -r -v -m -p -i -o --all --kernel-name --nodename --kernel-release --kernel-version --machine --processor --hardware-platform --operating-system --help --version',
    ),
  },
  id: {
    flags: flagMap('-u -g -G -n -r -z --user --group --groups --name --real --zero --help --version'),
  },
  uptime: {
    flags: flagMap('-p -s -V --pretty --since --version --help'),
  },
  nproc: {
    flags: flagMap('--all --help --version', '', '--ignore'),
  },
  free: {
    flags: flagMap(
      '-b -k -m -g -h -t -l -w --bytes --kibi --mebi --gibi --human --total --lohi --wide --si --help --version',
    ),
  },
  locale: {
    flags: flagMap('-a -m --all-locales --charmaps --help --version'),
  },
  groups: {
    flags: flagMap('--help --version'),
  },
  hostname: {
    flags: flagMap(
      '-f -s -i -I -a -d -A -v -h -V --fqdn --long --short --ip-address --all-ip-addresses --alias --domain --all-fqdns --verbose --help --version',
    ),
  },
  date: {
    flags: flagMap(
      '-u --utc --universal -R --rfc-email --debug --help --version',
      '-d --date --rfc-3339',
      '',
      '-I --iso-8601',
    ),
  },
  which: {
    flags: flagMap(
      '-a --all -s -p -w --skip-dot --skip-tilde --show-dot --show-tilde --skip-alias --skip-functions -v -V --version --help',
    ),
  },
  type: {
    flags: flagMap('-a -f -p -P -t'),
  },
  seq: {
    flags: flagMap('-w --equal-width --help --version', '-s --separator -f --format'),
  },
  tr: {
    flags: flagMap(
      '-c -C -d -s -t --complement --delete --squeeze-repeats --truncate-set1 --help --version',
    ),
  },
};

export const FILE_COMMAND_SPECS: Readonly<Record<string, SafeFlagSpec>> = {
  sort: {
    flags: flagMap(
      '-b --ignore-leading-blanks -d --dictionary-order -f --ignore-case -g --general-numeric-sort -h --human-numeric-sort -i --ignore-nonprinting -M --month-sort -n --numeric-sort -R --random-sort -r --reverse -s --stable -u --unique -V --version-sort -z --zero-terminated -c --check -C --check-char-order -m --merge --help --version',
      '--sort -k --key -t --field-separator -S --buffer-size',
      '--parallel --batch-size',
    ),
    allowAttachedString: true,
  },
  file: {
    flags: flagMap(
      '-b --brief -i --mime --mime-type --mime-encoding --apple --check-encoding -c -0 --print0 --help --version -v -h --no-dereference -L --dereference -k --keep-going -l --list -n --no-buffer -p --preserve-date -r --raw -s --special-files -z',
      '--exclude --exclude-quiet -F --separator',
    ),
  },
  base64: {
    flags: flagMap(
      '-d -D --decode --ignore-garbage -h --help --version',
      '',
      '-b --break -w --wrap',
    ),
    respectsDoubleDash: false,
  },
  tree: {
    flags: flagMap(
      '-d -l -f -x --gitignore --ignore-case --matchdirs --metafirst --prune --noreport -q -N -Q -p -u -g -s -h --si --du -D -F --inodes --device -v -t -c -U -r --dirsfirst --filesfirst -i -A -S -n -C -X -J --nolinks --help --version',
      '-P -I --charset --timefmt --sort',
      '-L --filelimit',
    ),
  },
  jq: {
    flags: flagMap(
      '-r --raw-output -c --compact-output -e --exit-status -n --null-input -R --raw-input -s --slurp -S --sort-keys -a --ascii-output -M --monochrome-output -C --color-output -j --join-output -0 --raw-output0 --tab -V --version -h --help',
      '',
      '--indent',
    ),
  },
};

export const GREP_FLAG_SPEC: SafeFlagSpec = {
  flags: flagMap(
    '-F --fixed-strings -G --basic-regexp -E --extended-regexp -P --perl-regexp -i --ignore-case --no-ignore-case -v --invert-match -w --word-regexp -x --line-regexp -c --count -L --files-without-match -l --files-with-matches -o --only-matching -q --quiet --silent -s --no-messages -b --byte-offset -H --with-filename -h --no-filename -n --line-number -T --initial-tab -u --unix-byte-offsets -Z --null -z --null-data --no-group-separator -a --text -I -r --recursive -R --dereference-recursive --line-buffered -U --binary --help -V --version',
    '-e --regexp -f --file --label --group-separator --binary-files -D --devices -d --directories --exclude --exclude-from --exclude-dir --include',
    '-m --max-count -A --after-context -B --before-context -C --context',
    '--color --colour',
  ),
  allowAttachedString: true,
  allowCombinedTrailingValue: true,
};

export const RG_FLAG_SPEC: SafeFlagSpec = {
  flags: flagMap(
    '-i --ignore-case -S --smart-case -s --case-sensitive -F --fixed-strings -w --word-regexp -v --invert-match -c --count --count-matches -l --files-with-matches --files-without-match --files -n --line-number -N --no-line-number -o --only-matching -H --with-filename -h --no-filename --heading --no-heading -q --quiet --column --vimgrep -a --text -L --follow --json --stats --type-list --multiline -U --multiline-dotall --passthru --no-messages --sort-files -0 --null --help -V --version',
    '-e --regexp -f --file -g --glob --iglob -t --type -T --type-not --color --sort --sortr',
    '-A --after-context -B --before-context -C --context -m --max-count -d --max-depth -j --threads',
  ),
  allowAttachedString: true,
  allowCombinedTrailingValue: true,
};

export const FD_FLAG_SPEC: SafeFlagSpec = {
  flags: flagMap(
    '-h --help -V --version -s --case-sensitive -i --ignore-case -g --glob --regex -F --fixed-strings -a --absolute-path -L --follow -p --full-path -0 --print0 -1 -q --quiet --show-errors --strip-cwd-prefix --one-file-system --prune --no-require-git',
    '-t --type -e --extension -S --size --changed-within --changed-before -o --owner -E --exclude -c --color --search-path --path-separator --and --format',
    '-d --max-depth --min-depth --exact-depth -j --threads --max-results --batch-size',
  ),
  allowAttachedString: true,
};

const GIT_DIFF_STAT_NONE = '--stat --numstat --shortstat --name-only --name-status';
const GIT_COLOR_OPT = '--color --no-color';
const GIT_PATCH_NONE = '--patch -p --no-patch --no-ext-diff -s';
const GIT_LOG_COMMON_NONE =
  '--oneline --graph --all --branches --tags --remotes --abbrev-commit --full-history --dense --sparse --simplify-merges --ancestry-path --source --first-parent --merges --no-merges --reverse --walk-reflogs --no-min-parents --no-max-parents --follow --no-walk --left-right --cherry-mark --cherry-pick --boundary --topo-order --date-order --author-date-order --pickaxe-regex --pickaxe-all --no-decorate';
const GIT_LOG_COMMON_STR =
  '--author --committer --grep --since --after --until --before --date --pretty --format --diff-filter -S -G -L';
const GIT_LOG_COMMON_NUM = '-n --max-count --skip --max-age --min-age';
const GIT_LOG_COMMON_OPT = '--decorate --abbrev';

export const GIT_SUBCOMMAND_SPECS: Readonly<Record<string, SafeFlagSpec>> = {
  status: {
    flags: flagMap(
      '--short -s --branch -b --porcelain --long --verbose -v --ignored --column --no-column --ahead-behind --no-ahead-behind --renames --no-renames',
      '--ignore-submodules',
      '',
      '-u --untracked-files --find-renames -M',
    ),
  },
  diff: {
    flags: flagMap(
      `${GIT_DIFF_STAT_NONE} ${GIT_PATCH_NONE} --dirstat --summary --patch-with-stat --color-words --no-renames --check --full-index --binary --break-rewrites --find-renames --find-copies --find-copies-harder --irreversible-delete --histogram --patience --minimal --ignore-space-at-eol --ignore-space-change --ignore-all-space --ignore-blank-lines --function-context --exit-code --quiet --cached --staged --pickaxe-regex --pickaxe-all --no-index -u -M -C -B -D -l -R -w -b`,
      '--word-diff-regex --ws-error-highlight --diff-algorithm --relative --diff-filter -S -G',
      '--inter-hunk-context -U --unified',
      `${GIT_COLOR_OPT} --word-diff --abbrev`,
    ),
  },
  log: {
    flags: flagMap(
      `${GIT_DIFF_STAT_NONE} ${GIT_PATCH_NONE} ${GIT_LOG_COMMON_NONE}`,
      GIT_LOG_COMMON_STR,
      GIT_LOG_COMMON_NUM,
      `${GIT_COLOR_OPT} ${GIT_LOG_COMMON_OPT}`,
    ),
    allowNumericDash: true,
  },
  show: {
    flags: flagMap(
      `${GIT_DIFF_STAT_NONE} ${GIT_PATCH_NONE} --oneline --abbrev-commit --color-words --first-parent --raw -m --quiet`,
      '--word-diff-regex --pretty --format --diff-filter',
      '',
      `${GIT_COLOR_OPT} --word-diff --abbrev`,
    ),
  },
  branch: {
    flags: flagMap(
      '-l --list -a --all -r --remotes -v -vv --verbose --column --no-column --no-abbrev --merged --no-merged --show-current -i --ignore-case',
      '--contains --no-contains --points-at --sort',
      '',
      `${GIT_COLOR_OPT} --abbrev`,
    ),
  },
  tag: {
    flags: flagMap(
      '-l --list --column --no-column -i --ignore-case',
      '--contains --no-contains --merged --no-merged --sort --format --points-at',
      '-n',
    ),
  },
  'rev-parse': {
    flags: flagMap(
      '--verify --abbrev-ref --symbolic --symbolic-full-name --show-toplevel --show-cdup --show-prefix --git-dir --git-common-dir --absolute-git-dir --show-superproject-working-tree --is-inside-work-tree --is-inside-git-dir --is-bare-repository --is-shallow-repository --is-shallow-update --path-prefix',
      '',
      '',
      '--short',
    ),
  },
  'ls-files': {
    flags: flagMap(
      '--cached -c --deleted -d --modified -m --others -o --ignored -i --stage -s --killed -k --unmerged -u --directory --no-empty-directory --eol --full-name --debug -z -t -v -f --exclude-standard --error-unmatch --recurse-submodules',
      '--exclude -x',
      '',
      '--abbrev',
    ),
  },
  blame: {
    flags: flagMap(
      '--porcelain -p --line-porcelain --incremental --root --show-stats --show-name --show-number -n --show-email -e -f -w -M -C --score-debug -s -l -t',
      '-L --date --ignore-rev',
      '',
      `${GIT_COLOR_OPT} --abbrev`,
    ),
    respectsDoubleDash: false,
  },
  remote: {
    flags: flagMap('-v --verbose'),
  },
  'stash list': {
    flags: flagMap(GIT_LOG_COMMON_NONE, GIT_LOG_COMMON_STR, GIT_LOG_COMMON_NUM, GIT_LOG_COMMON_OPT),
    respectsDoubleDash: false,
    allowNumericDash: true,
  },
  'stash show': {
    flags: flagMap(
      `${GIT_DIFF_STAT_NONE} ${GIT_PATCH_NONE} --color-words`,
      '--word-diff-regex --diff-filter',
      '',
      `${GIT_COLOR_OPT} --word-diff --abbrev`,
    ),
  },
  'worktree list': {
    flags: flagMap('--porcelain -v --verbose', '--expire'),
  },
  'merge-base': {
    flags: flagMap('--is-ancestor --fork-point --octopus --independent --all'),
  },
  describe: {
    flags: flagMap(
      '--tags --long --always --contains --first-match --exact-match --broken',
      '--match --exclude',
      '--candidates',
      '--abbrev --dirty',
    ),
  },
  shortlog: {
    flags: flagMap(
      '-s --summary -n --numbered -e --email -c --committer --no-merges --all --branches --tags --remotes',
      '--group --format --author --since --after --until --before',
    ),
  },
  'rev-list': {
    flags: flagMap(
      '--count --reverse --first-parent --ancestry-path --merges --no-merges --no-min-parents --no-max-parents --walk-reflogs --oneline --abbrev-commit --full-history --dense --sparse --source --graph --all --branches --tags --remotes',
      '--author --committer --grep --since --after --until --before --pretty --format',
      '-n --max-count --skip --max-age --min-age --min-parents --max-parents',
      '--abbrev',
    ),
    allowNumericDash: true,
  },
};

export const DOCKER_READ_ONLY_SPECS: Readonly<Record<string, SafeFlagSpec>> = {
  ps: {
    flags: flagMap(
      '-a --all -l --latest --no-trunc -q --quiet -s --size',
      '-f --filter --format',
      '-n --last',
    ),
  },
  images: {
    flags: flagMap(
      '-a --all --digests --no-trunc -q --quiet',
      '-f --filter --format',
    ),
  },
};

const GIT_SIGNATURE_RE = /%[-+ ]?G|%\(\*?signature|signature/i;
const GIT_PRETTY_FORMATS: ReadonlySet<string> = new Set([
  'oneline',
  'short',
  'medium',
  'full',
  'fuller',
  'email',
  'raw',
]);

export function hasUnsafeGitFormat(flagValues: readonly [string, string][]): boolean {
  for (const [flag, value] of flagValues) {
    if (GIT_SIGNATURE_RE.test(value)) return true;
    if (flag === '--format' || flag === '--pretty' || flag === '--sort' || flag === '--group') {
      if (value.includes('~')) return true;
      if (
        (flag === '--format' || flag === '--pretty') &&
        value !== '' &&
        !value.includes('%') &&
        !value.startsWith('format:') &&
        !value.startsWith('tformat:') &&
        !GIT_PRETTY_FORMATS.has(value)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function validateSafeFlags(
  args: readonly string[],
  spec: SafeFlagSpec,
): ParsedSafeFlags | undefined {
  const positionals: string[] = [];
  const flagValues: [string, string][] = [];
  const seenFlags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      if (spec.respectsDoubleDash !== false) {
        positionals.push(...args.slice(index + 1));
        break;
      }
      continue;
    }
    if (arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (spec.allowNumericDash && /^-\d+$/.test(arg)) {
      seenFlags.add(arg);
      continue;
    }
    const eqIndex = arg.indexOf('=');
    const hasEq = eqIndex >= 0;
    const flagName = hasEq ? arg.slice(0, eqIndex) : arg;
    const eqValue = hasEq ? arg.slice(eqIndex + 1) : '';
    const kind = spec.flags[flagName];
    if (kind !== undefined) {
      seenFlags.add(flagName);
      if (kind === 'none') {
        if (hasEq) return undefined;
        continue;
      }
      if (kind === 'optional') {
        if (hasEq) flagValues.push([flagName, eqValue]);
        continue;
      }
      const value = hasEq ? eqValue : args[++index];
      if (value === undefined) return undefined;
      if (kind === 'number' && !/^\d+$/.test(value)) return undefined;
      flagValues.push([flagName, value]);
      continue;
    }
    if (!hasEq && !flagName.startsWith('--') && flagName.length > 2) {
      const firstShort = flagName.slice(0, 2);
      const rest = flagName.slice(2);
      const firstKind = spec.flags[firstShort];
      if (firstKind === 'number' && /^\d+$/.test(rest)) {
        seenFlags.add(firstShort);
        flagValues.push([firstShort, rest]);
        continue;
      }
      if (firstKind === 'string' && spec.allowAttachedString) {
        seenFlags.add(firstShort);
        flagValues.push([firstShort, rest]);
        continue;
      }
      let combinedOk = true;
      for (let charIndex = 1; charIndex < flagName.length; charIndex++) {
        const shortFlag = `-${flagName[charIndex]}`;
        const shortKind = spec.flags[shortFlag];
        if (shortKind === 'none') {
          seenFlags.add(shortFlag);
          continue;
        }
        if (
          spec.allowCombinedTrailingValue &&
          charIndex === flagName.length - 1 &&
          (shortKind === 'string' || shortKind === 'number')
        ) {
          const nextValue = args[++index];
          if (nextValue === undefined || (shortKind === 'number' && !/^\d+$/.test(nextValue))) {
            return undefined;
          }
          seenFlags.add(shortFlag);
          flagValues.push([shortFlag, nextValue]);
          continue;
        }
        if (spec.allowAttachedString && shortKind === 'string' && charIndex < flagName.length - 1) {
          seenFlags.add(shortFlag);
          flagValues.push([shortFlag, flagName.slice(charIndex + 1)]);
          break;
        }
        combinedOk = false;
        break;
      }
      if (combinedOk) continue;
    }
    return undefined;
  }
  return { positionals, flagValues, seenFlags };
}

export function hasUnsafeControlOrBidi(source: string): boolean {
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return true;
    }
    if (
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = source.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const WINDOWS_NT_DEVICE_RE = /(?:^|[^A-Za-z0-9_])[\\/]\?\?(?:[\\/]|$)/;
const WINDOWS_UNC_RE = /^(?:\\\\|\/\/)[^ \t\r\n\f\v\\/]+/;
const WINDOWS_MIXED_UNC_RE = /^(?:\/\\+|\\+\/)[^ \t\r\n\f\v\\/]+/;
const WINDOWS_WEBDAV_RE = /@SSL@\d+|@\d+@SSL|DavWWWRoot/i;

export function isRiskyWindowsPath(path: string): boolean {
  return (
    WINDOWS_UNC_RE.test(path) ||
    WINDOWS_MIXED_UNC_RE.test(path) ||
    WINDOWS_NT_DEVICE_RE.test(path) ||
    WINDOWS_WEBDAV_RE.test(path)
  );
}
