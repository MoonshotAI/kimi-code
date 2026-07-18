/**
 * User-facing output for the postinstall: where lines go, ANSI styling,
 * the fixed-width box layout, and the four outcome renderers:
 *
 *   - `logMigrationDone` — the takeover succeeded (one or more legacy
 *     shims were processed). Lists every action taken: renames,
 *     consolidates, delete-only, plain deletes, and harmless blocked
 *     leftovers. Footer branches three ways: preserved-somewhere
 *     (standard "type kimi-legacy"), only skippedForeignTarget (we
 *     couldn't save the old CLI because a user file took the name),
 *     and only blockedHarmless (just notes the leftovers, no
 *     phantom-file talk).
 *   - `logMigrationBlocked` — a legacy `kimi` we can't remove sits
 *     on PATH ahead of our shim. Nothing was touched; user is told
 *     which paths need their manual attention with sudo / admin.
 *   - `logForeignKimiInTheWay` — a `kimi` we don't recognize (not
 *     ours, not a legacy CLI) sits ahead of our shim on PATH. User
 *     needs to delete or rename their own file. Different remediation
 *     from `logMigrationBlocked`.
 *   - `logNewCliNotOnPath` — we found a legacy but our own shim
 *     isn't on the user's shell PATH at all. Same "touch nothing"
 *     behavior, different prose.
 *
 * This module is intentionally self-contained: no PATH walking, no fs
 * mutations, no shell spawning — just rendering. The orchestrator
 * (`postinstall.mjs`) makes the abort-or-proceed decision once and
 * calls exactly one renderer at the end.
 */

import { writeFileSync } from 'node:fs';

import { pmGlobalInstallCommand, pmGlobalBinCommand } from './reach.mjs';

// Fixed-width box rendering. 80 cols is the de facto terminal default.
// We can't reliably read TTY width from a piped postinstall context, so
// we pin the width and truncate long content with an ellipsis if needed.
const BOX_WIDTH = 80;
const BOX_INNER = BOX_WIDTH - 2; // chars between the two vertical borders
const BOX_PAD_LEFT = 2; // leading spaces inside the box for breathing room

// ANSI styling. Disabled when NO_COLOR is set (https://no-color.org/).
// We can't reliably tell whether `/dev/tty`'s far end supports color,
// but modern terminals all do; users who want plain output can set
// NO_COLOR.
const USE_COLOR = !process.env['NO_COLOR'];
const ANSI_ESCAPE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const C_RESET = USE_COLOR ? '\x1b[0m' : '';
const C_DIM = USE_COLOR ? '\x1b[2m' : '';
const C_BOLD_GREEN = USE_COLOR ? '\x1b[1;32m' : '';
const C_BOLD_YELLOW = USE_COLOR ? '\x1b[1;33m' : '';
const C_CYAN = USE_COLOR ? '\x1b[36m' : '';

function color(c, text) {
  return USE_COLOR ? c + text + C_RESET : text;
}

function visibleLength(s) {
  return s.replace(ANSI_ESCAPE, '').length;
}

function stripAnsi(s) {
  return s.replace(ANSI_ESCAPE, '');
}

// Platform-specific path to the controlling terminal device. Writing
// here bypasses the package manager's lifecycle stdout capture (npm 7+
// hides script stdout/stderr by default). On POSIX it's `/dev/tty`;
// on Windows it's the special filename `CON`, which Node resolves to
// the console device. (The fully-qualified `\\.\CON` form looks
// equivalent but Node appends a trailing backslash that breaks the
// open call — confirmed empirically on Windows 11 / Node 22.)
const TERMINAL_DEVICE = process.platform === 'win32' ? 'CON' : '/dev/tty';

/**
 * Print a user-facing line. npm 7+ captures lifecycle stdout/stderr by
 * default, so messages here would be invisible to a user running
 * `npm install -g`. Writing directly to the platform's terminal
 * device bypasses the manager's capture when one is available
 * (interactive terminals). In CI / non-TTY contexts the device isn't
 * writable; fall back to stdout so the message is still preserved in
 * npm's lifecycle log under `~/.npm/_logs/`, with ANSI stripped so
 * the log file stays readable.
 */
export function notify(line) {
  const text = line + '\n';
  try {
    writeFileSync(TERMINAL_DEVICE, text);
    return;
  } catch {
    // Terminal device not writable (CI, sandboxed environments).
  }
  process.stdout.write(stripAnsi(text));
}

// Single-quote `path` for safe interpolation in a POSIX `sh` command.
// Wraps in single quotes and escapes any embedded `'` as `'\''`.
function quotePosixPath(path) {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

// Single-quote `path` for safe interpolation in a PowerShell command.
// PowerShell single-quoted strings disable expansion; embedded `'` is
// escaped by doubling.
function quotePowerShellPath(path) {
  return "'" + path.replace(/'/g, "''") + "'";
}

function boxBorder(left, right, fill = '─') {
  return color(C_DIM, left + fill.repeat(BOX_INNER) + right);
}

function boxLine(content = '') {
  const visible = visibleLength(content);
  const padding =
    visible < BOX_INNER ? ' '.repeat(BOX_INNER - visible) : '';
  return color(C_DIM, '│') + content + padding + color(C_DIM, '│');
}

function pad(content) {
  return ' '.repeat(BOX_PAD_LEFT) + content;
}

function renderBox(lines) {
  const out = [boxBorder('╭', '╮'), boxLine('')];
  for (const line of lines) out.push(boxLine(line));
  out.push(boxLine(''), boxBorder('╰', '╯'));
  return out;
}

function emit(lines) {
  notify('');
  for (const line of lines) notify(line);
  notify('');
}

function pathInBox(path) {
  // 7-space lead = box pad (2) + prose indent (3) + nesting under
  // label (2). We intentionally do NOT truncate overflowing content:
  // for command lines (`sudo rm <path>`, `mv <a> <b>`), left-truncation
  // would swallow the command verb and leave the user with
  // un-copy-pasteable instructions. Long lines just overflow the box
  // border, which is visually less pretty but keeps the content
  // intact.
  const lead = ' '.repeat(BOX_PAD_LEFT + 5);
  return lead + color(C_CYAN, path);
}

function successHeading(text) {
  return pad(color(C_BOLD_GREEN, '✓  ' + text));
}

function warningHeading(text) {
  return pad(color(C_BOLD_YELLOW, '!  ' + text));
}

/**
 * The takeover completed. Renders one box that lists every action
 * taken, so the user sees a single coherent picture even when several
 * shims were involved.
 *
 * Sections (each only shown when non-empty):
 *   - "Renamed" — the first PATH-order shim, preserved as
 *     `kimi-legacy`. The "`kimi` now launches the new CLI" claim is
 *     safe to make here because the orchestrator already verified
 *     reachability after this set of removals.
 *   - "Consolidated" — first shim's `kimi-legacy` already pointed at
 *     a legacy file (re-migration case); we deleted the duplicate
 *     source and kept the existing target. Same end state, different
 *     mechanism.
 *   - "Couldn't preserve as kimi-legacy" — first shim's `kimi-legacy`
 *     slot was a user-managed file; we deleted the source `kimi` to
 *     remove the shadow but left their file alone, so no fallback
 *     exists in that dir.
 *   - "Also removed" — non-first PATH-order shims that would have
 *     shadowed our new shim. Just `unlink`ed.
 *   - "Note: legacy left behind" — blocked shims that couldn't be
 *     removed but PATH order means they don't shadow us; the user
 *     can clean them up at leisure.
 *   - "Errors" — anything that failed during execution despite
 *     pre-flight saying it should work (race conditions, transient
 *     fs errors). Listed last so the user can see what to retry.
 */
export function logMigrationDone(outcomes, pm) {
  const reinstallCmd = pmGlobalInstallCommand(pm, '@moonshot-ai/kimi-code');
  const {
    renames,
    consolidates,
    skippedForeignTarget,
    deletes,
    blockedHarmless,
    errors,
  } = outcomes;

  const lines = [successHeading('kimi now runs the new version'), ''];

  if (renames.length > 0) {
    lines.push(pad('   Renamed your old kimi so you can still run it as'));
    lines.push(pad('   kimi-legacy:'));
    for (const c of renames) {
      lines.push(pathInBox(c.shimPath + '  ->  ' + c.target));
    }
    lines.push('');
  }

  if (consolidates.length > 0) {
    lines.push(pad('   Removed an extra copy of your old kimi (kimi-legacy'));
    lines.push(pad('   was already set up here from before):'));
    for (const c of consolidates) {
      lines.push(pathInBox(c.shimPath));
      lines.push(pathInBox('  (kimi-legacy is at ' + c.target + ')'));
    }
    lines.push('');
  }

  if (skippedForeignTarget.length > 0) {
    lines.push(pad('   Removed your old kimi (a file you created was already'));
    lines.push(pad('   using the name kimi-legacy, so we left it alone):'));
    for (const c of skippedForeignTarget) {
      lines.push(pathInBox(c.shimPath));
      lines.push(pathInBox('  (your file at ' + c.target + ' is untouched)'));
    }
    lines.push('');
  }

  if (deletes.length > 0) {
    lines.push(pad('   Also removed (these would have run instead of the'));
    lines.push(pad('   new kimi if we left them):'));
    for (const c of deletes) {
      lines.push(pathInBox(c.shimPath));
    }
    lines.push('');
  }

  if (blockedHarmless.length > 0) {
    lines.push(pad('   Note: we can\'t change these files, but it\'s OK —'));
    lines.push(pad('   they won\'t run instead of the new kimi:'));
    for (const c of blockedHarmless) {
      lines.push(pathInBox(c.shimPath));
    }
    lines.push('');
  }

  if (errors.length > 0) {
    lines.push(pad('   Some changes didn\'t go through:'));
    for (const e of errors) {
      lines.push(
        pathInBox(e.shimPath + '  (' + (e.message ?? e.code ?? 'error') + ')'),
      );
    }
    lines.push('');
  }

  // Footer has three branches based on what actually happened:
  //
  //   1. Preserved somewhere (rename or consolidate): the old CLI is
  //      available as `kimi-legacy`. Standard takeover footer.
  //   2. Only skippedForeignTarget (no rename, no consolidate, no
  //      blockedHarmless): user has a file they made called
  //      `kimi-legacy`, so we couldn't save the old CLI under that
  //      name. Explain the situation honestly.
  //   3. Only blockedHarmless (no rename, no consolidate, no
  //      skippedForeignTarget): we have nothing to celebrate or
  //      apologize for — the "Note: we can't change these files but
  //      it's OK" section above already covers it. Plain footer.
  //
  // If both skippedForeignTarget AND blockedHarmless are present
  // (but no preservation), branch 2 wins — the foreign-target story
  // is the more useful one for the user to know about.
  const preservedSomewhere = renames.length > 0 || consolidates.length > 0;
  if (preservedSomewhere) {
    lines.push(
      pad('   Now typing `kimi` runs the new version. To run the old'),
      pad('   version, type `kimi-legacy` instead. Your settings from'),
      pad('   the old version will be moved over the first time you'),
      pad('   run `kimi`.'),
      '',
      pad('   Note: if you reinstall the old kimi later (e.g. with'),
      pad('   `uv tool`, `pip`, or `pipx`), it will put `kimi` back.'),
      pad('   Run this command again to switch to the new one:'),
      pathInBox(reinstallCmd),
      '',
      pad('   If typing `kimi` still runs the old version, open a new'),
      pad('   terminal window — your current one may have remembered'),
      pad('   the old path.'),
    );
  } else if (skippedForeignTarget.length > 0) {
    lines.push(
      pad('   Now typing `kimi` runs the new version. Your settings'),
      pad('   from the old version will be moved over the first time'),
      pad('   you run `kimi`.'),
      '',
      pad('   We couldn\'t save the old kimi as `kimi-legacy` because'),
      pad('   that name was already taken by a file you\'d created.'),
      pad('   If you need the old kimi back, install it again with'),
      pad('   `uv tool install kimi-cli` (or pipx / pip).'),
      '',
      pad('   If typing `kimi` still runs the old version, open a new'),
      pad('   terminal window — your current one may have remembered'),
      pad('   the old path.'),
    );
  } else {
    lines.push(
      pad('   Now typing `kimi` runs the new version. Your settings'),
      pad('   from the old version will be moved over the first time'),
      pad('   you run `kimi`.'),
      '',
      pad('   If typing `kimi` still runs the old version, open a new'),
      pad('   terminal window — your current one may have remembered'),
      pad('   the old path.'),
    );
  }

  emit(renderBox(lines));
}

/**
 * At least one blocked legacy shim still sits on PATH ahead of where
 * our new shim would land. We refused to touch anything (pre-flight
 * abort), so neither the user's existing setup nor the new install
 * gets a half-migrated state. List each blocking path with the
 * platform-appropriate manual fix.
 */
export function logMigrationBlocked(blocked, actionable, pm) {
  const isWindows = process.platform === 'win32';
  const reinstallCmd = pmGlobalInstallCommand(pm, '@moonshot-ai/kimi-code');

  const lines = [
    warningHeading('Can\'t switch to the new kimi yet'),
    '',
    pad('   There\'s an old kimi on your computer that we can\'t change.'),
    pad('   As long as it\'s there, typing `kimi` will still run the old'),
    pad('   version. Files we can\'t change:'),
  ];

  for (const c of blocked) {
    lines.push(pathInBox(c.shimPath));
  }

  lines.push('', pad('   Please delete them yourself, then install again:'));

  for (const c of blocked) {
    if (isWindows && c.isSystemPath) {
      // Admin PowerShell needed.
      lines.push(pathInBox('# in an elevated PowerShell:'));
      lines.push(pathInBox('Remove-Item ' + quotePowerShellPath(c.shimPath)));
    } else if (c.isSystemPath) {
      lines.push(pathInBox('sudo rm ' + quotePosixPath(c.shimPath)));
    } else if (isWindows) {
      lines.push(pathInBox('Remove-Item ' + quotePowerShellPath(c.shimPath)));
    } else {
      lines.push(pathInBox('rm ' + quotePosixPath(c.shimPath)));
    }
  }

  if (actionable.length > 0) {
    lines.push(
      '',
      pad('   We also found these old kimi files. We could remove them'),
      pad('   ourselves, once the ones above are gone:'),
    );
    for (const c of actionable) {
      lines.push(pathInBox(c.shimPath));
    }
  }

  lines.push(
    '',
    pad('   After deleting them, install again to finish:'),
    pathInBox(reinstallCmd),
    '',
    pad('   Nothing on your computer was changed.'),
  );

  emit(renderBox(lines));
}

/**
 * The reachability check found a `kimi` ahead of our shim on PATH
 * that's neither ours nor a legacy Python CLI — almost certainly a
 * wrapper the user wrote themselves (or installed from somewhere we
 * don't recognize). Deleting blocked legacy shims wouldn't help
 * here: the foreign file would still win resolution. So the
 * remediation is "delete or rename your own file", which only the
 * user can decide.
 */
export function logForeignKimiInTheWay(foreignPath, pm) {
  const reinstallCmd = pmGlobalInstallCommand(pm, '@moonshot-ai/kimi-code');
  emit(
    renderBox([
      warningHeading('Can\'t switch to the new kimi yet'),
      '',
      pad('   There\'s another file called `kimi` on your computer that\'s'),
      pad('   not the new CLI and not the old one — it looks like'),
      pad('   something you set up yourself. As long as it\'s there,'),
      pad('   typing `kimi` will run it instead of the new version.'),
      '',
      pad('   We found it at:'),
      pathInBox(foreignPath),
      '',
      pad('   To use the new kimi, delete or rename that file, then'),
      pad('   install again:'),
      pathInBox(reinstallCmd),
      '',
      pad('   Nothing on your computer was changed.'),
    ]),
  );
}

/**
 * The legacy `kimi` was found, but the directory where the package
 * manager placed the new `kimi` shim is not on the user's PATH.
 * Renaming the legacy shim now would leave the user with NO reachable
 * `kimi` command — the new one would still not be discoverable by
 * their shell. Show them the PATH fix and leave the legacy CLI alone.
 *
 * The PATH-fix hint uses the manager-specific subshell command (one
 * of `npm prefix -g`, `yarn global bin`, `pnpm bin -g`) so it works
 * regardless of which manager the user ran, and renders in the
 * syntax of the user's likely shell:
 *   - POSIX  : `export PATH=...`.
 *   - Windows: `$env:Path = ...` (PowerShell).
 * On Windows, npm places global shims directly under `<prefix>` (no
 * `bin` subdir), and pnpm/yarn already report the bin dir, so we
 * skip the `/bin` suffix the POSIX branch needs for npm.
 */
export function logNewCliNotOnPath(detection, pm) {
  const isWindows = process.platform === 'win32';
  const binCmd = pmGlobalBinCommand(pm);
  const reinstallCmd = pmGlobalInstallCommand(pm, '@moonshot-ai/kimi-code');

  const newPathHint = isWindows
    ? `$env:Path = "$(${binCmd});$env:Path"`
    : pm === 'npm'
      ? `export PATH="$(${binCmd})/bin:$PATH"`
      : `export PATH="$(${binCmd}):$PATH"`;
  const rcLabel = isWindows ? 'PowerShell profile' : 'shell rc';

  emit(
    renderBox([
      warningHeading('New kimi is installed, but your terminal can\'t find it'),
      '',
      pad('   The old kimi is still here:'),
      pathInBox(detection.shimPath),
      '',
      pad('   The new kimi was installed by ' + pm + ', but it landed in a'),
      pad('   folder your terminal doesn\'t search. (Your terminal looks'),
      pad('   for commands in folders listed in your PATH.) If we removed'),
      pad('   the old kimi now, typing `kimi` wouldn\'t find anything.'),
      '',
      pad('   Add the new kimi\'s folder to your PATH (and save the change'),
      pad('   in your ' + rcLabel + ' so it sticks), then install again:'),
      pathInBox(newPathHint),
      pathInBox(reinstallCmd),
      '',
      pad('   The old kimi is still where it was.'),
    ]),
  );
}
