import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const specPattern = /^apps\/desktop\/(?:test\/)?e2e\/(?!fixtures\/)[A-Za-z0-9._/-]+\.spec\.ts$/;
const desktopPrefix = 'apps/desktop/';

const changed = [...new Set(readFileSync(0, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean))];

function finish(mode, specs, reason) {
  console.log(`Desktop e2e mode: ${mode} (${reason})`);
  for (const spec of specs) console.log(`  ${spec}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\nspecs=${specs.join(' ')}\n`);
  }
}

const shared = changed.filter(path => !specPattern.test(path));
if (changed.length === 0) {
  finish('full', [], 'no changed files reported');
} else if (shared.length > 0) {
  const listed = shared.slice(0, 20).map(path => `  ${path}`);
  if (shared.length > listed.length) listed.push(`  ... and ${shared.length - listed.length} more`);
  console.log(`Changed files outside the e2e specs:\n${listed.join('\n')}`);
  finish('full', [], `${shared.length} non-spec file(s) changed`);
} else {
  const deleted = changed.filter(path => !existsSync(path));
  for (const path of deleted) console.log(`Skipping deleted spec ${path}`);
  const specs = changed.filter(path => existsSync(path)).map(path => path.slice(desktopPrefix.length)).sort();
  if (specs.length === 0) finish('none', [], 'only deleted specs changed');
  else finish('specs', specs, `${specs.length} changed spec(s)`);
}
