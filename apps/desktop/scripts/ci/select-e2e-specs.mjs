import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const LABEL = 'desktop-e2e';

const specPattern = /^apps\/desktop\/(?:test\/)?e2e\/(?!fixtures\/)[A-Za-z0-9._/-]+\.spec\.ts$/;
const journeyPattern = /^(?:apps\/desktop\/(?:test\/)?e2e\/|packages\/testkit\/|apps\/desktop\/scripts\/ci\/select-e2e-specs\.mjs$|\.github\/workflows\/desktop-e2e\.yml$)/;
const desktopPrefix = 'apps/desktop/';

export function selectJourneys({ pullRequest, labelled, changed, exists = existsSync }) {
  if (!pullRequest) return { mode: 'full', specs: [], reason: 'not a pull request' };
  if (labelled) return { mode: 'full', specs: [], reason: `the pull request has the ${LABEL} label` };
  const journeyFiles = [...new Set(changed)].filter(path => journeyPattern.test(path));
  if (journeyFiles.length === 0) {
    return { mode: 'none', specs: [], reason: `the pull request does not change the journeys; add the ${LABEL} label to run them` };
  }
  const shared = journeyFiles.filter(path => !specPattern.test(path));
  if (shared.length > 0) return { mode: 'full', specs: [], reason: `${shared.length} shared journey file(s) changed`, shared };
  const specs = journeyFiles.filter(path => exists(path)).map(path => path.slice(desktopPrefix.length)).sort();
  if (specs.length === 0) return { mode: 'none', specs: [], reason: 'only deleted specs changed' };
  return { mode: 'specs', specs, reason: `${specs.length} changed spec(s)` };
}

function main() {
  const { values } = parseArgs({
    options: {
      'pull-request': { type: 'boolean', default: false },
      labelled: { type: 'boolean', default: false },
    },
  });
  const pullRequest = values['pull-request'];
  const changed = pullRequest ? readFileSync(0, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];
  const selection = selectJourneys({ pullRequest, labelled: values.labelled, changed });
  if (selection.shared !== undefined) {
    const listed = selection.shared.slice(0, 20).map(path => `  ${path}`);
    if (selection.shared.length > listed.length) listed.push(`  ... and ${selection.shared.length - listed.length} more`);
    console.log(`Changed journey files outside the specs:\n${listed.join('\n')}`);
  }
  console.log(`Desktop e2e mode: ${selection.mode} (${selection.reason})`);
  for (const spec of selection.specs) console.log(`  ${spec}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${selection.mode}\nspecs=${selection.specs.join(' ')}\n`);
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
