import { writeFileSync } from 'node:fs';

import { pmGlobalInstallCommand, pmGlobalBinCommand } from './reach.mjs';

const BOX_WIDTH = 80;
const BOX_INNER = BOX_WIDTH - 2;
const BOX_PAD_LEFT = 2;

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

const TERMINAL_DEVICE = process.platform === 'win32' ? 'CON' : '/dev/tty';

export function notify(line) {
  const text = line + '\n';
  try {
    writeFileSync(TERMINAL_DEVICE, text);
    return;
  } catch {}
  process.stdout.write(stripAnsi(text));
}

function quotePosixPath(path) {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

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
  const lead = ' '.repeat(BOX_PAD_LEFT + 5);
  return lead + color(C_CYAN, path);
}

function successHeading(text) {
  return pad(color(C_BOLD_GREEN, '✓  ' + text));
}

function warningHeading(text) {
  return pad(color(C_BOLD_YELLOW, '!  ' + text));
}

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

export function logMigrationIncomplete(input, pm) {
  const { outcomes, verify } = input;
  const { renames, consolidates, skippedForeignTarget, deletes, errors } = outcomes;
  const isWindows = process.platform === 'win32';
  const reinstallCmd = pmGlobalInstallCommand(pm, '@moonshot-ai/kimi-code');

  const lines = [warningHeading('Couldn\'t finish switching to the new kimi'), ''];

  if (verify.kind === 'blocked-legacy') {
    lines.push(
      pad('   Typing `kimi` still runs the old version. This file is in'),
      pad('   the way and we couldn\'t change it:'),
      pathInBox(verify.shim),
      '',
    );
  } else if (verify.kind === 'foreign') {
    lines.push(
      pad('   Typing `kimi` runs a file we don\'t recognize (not the new'),
      pad('   CLI, not the old one). It\'s still in the way:'),
      pathInBox(verify.path),
      '',
    );
  } else {
    lines.push(
      pad('   Typing `kimi` currently finds nothing at all — the old'),
      pad('   shim was removed but the new one isn\'t reachable yet.'),
      '',
    );
  }

  const changed = [
    ...renames.map((c) => c.shimPath + '  ->  ' + c.target),
    ...consolidates.map((c) => c.shimPath + '  (removed; kimi-legacy kept)'),
    ...skippedForeignTarget.map((c) => c.shimPath + '  (removed)'),
    ...deletes.map((c) => c.shimPath + '  (removed)'),
  ];
  if (changed.length > 0) {
    lines.push(pad('   Changes already made:'));
    for (const line of changed) lines.push(pathInBox(line));
    lines.push('');
  }

  if (errors.length > 0) {
    lines.push(pad('   Changes that didn\'t go through:'));
    for (const e of errors) {
      lines.push(pathInBox(e.shimPath + '  (' + (e.message ?? e.code ?? 'error') + ')'));
    }
    lines.push('');
  }

  if (verify.kind === 'blocked-legacy') {
    const c = verify;
    lines.push(pad('   Delete it yourself, then install again:'));
    if (isWindows) {
      lines.push(pathInBox('Remove-Item ' + quotePowerShellPath(c.shim)));
    } else {
      lines.push(pathInBox('rm ' + quotePosixPath(c.shim)));
      lines.push(pad('   (use sudo if it\'s in a system directory)'));
    }
    lines.push(pathInBox(reinstallCmd), '');
  } else if (verify.kind === 'foreign') {
    lines.push(
      pad('   Delete or rename that file, then install again:'),
      pathInBox(reinstallCmd),
      '',
    );
  } else {
    lines.push(
      pad('   Open a new terminal and check `which kimi`. If it finds'),
      pad('   nothing, reinstall to restore a working shim:'),
      pathInBox(reinstallCmd),
      '',
    );
  }

  if (renames.length > 0 || consolidates.length > 0) {
    lines.push(
      pad('   The old version is still available as `kimi-legacy`.'),
    );
  }

  emit(renderBox(lines));
}

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
