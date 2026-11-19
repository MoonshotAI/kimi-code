import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

// Only schedule runs use this guard. A same-repository release/* version PR
// blocks nightly only when its package diff or release plan changes kimi-code-app.
// Missing, malformed or contradictory evidence fails the job and therefore the build.
const DESKTOP_PACKAGE = 'apps/desktop/package.json';
const RELEASE_PLAN = '.changeset/release-plan.json';
const repo = process.env.GITHUB_REPOSITORY;

function gh(args, stage, parseJson = true) {
  let stdout;
  try {
    stdout = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`${stage}: ${detail}`);
  }
  if (!parseJson) return stdout;
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${stage}: invalid JSON: ${error.message}`);
  }
}

function api(endpoint, stage, args = []) {
  return gh(['api', `repos/${repo}/${endpoint}`, ...args], stage);
}

function content(path, ref, stage) {
  const endpoint = `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  return gh(['api', endpoint, '-H', 'Accept: application/vnd.github.raw+json'], stage, false);
}

function jsonContent(path, ref, stage) {
  const text = content(path, ref, stage);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${stage}: ${path} at ${ref} is invalid JSON: ${error.message}`);
  }
}

function paged(endpoint, stage) {
  const pages = api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100`, stage, ['--paginate', '--slurp']);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`${stage}: unexpected paginated response`);
  }
  return pages.flat();
}

function isDesktopVersionPr(pr) {
  return pr.base?.ref?.startsWith('release/')
    && pr.head?.ref === `changeset-release/${pr.base.ref}`
    && pr.base?.repo?.full_name === repo
    && pr.head?.repo?.full_name === repo;
}

function packageVersionChange(pr) {
  const stage = `PR #${pr.number} Desktop package`;
  const before = jsonContent(DESKTOP_PACKAGE, pr.base.sha, stage);
  const after = jsonContent(DESKTOP_PACKAGE, pr.head.sha, stage);
  if (before.name !== 'kimi-code-app' || after.name !== 'kimi-code-app'
    || typeof before.version !== 'string' || typeof after.version !== 'string'
    || before.version.length === 0 || after.version.length === 0) {
    throw new Error(`${stage}: expected readable kimi-code-app versions`);
  }
  return { changed: before.version !== after.version, before: before.version, after: after.version };
}

function releasePlanChange(pr) {
  const stage = `PR #${pr.number} release plan`;
  const plan = jsonContent(RELEASE_PLAN, pr.head.sha, stage);
  if (plan.branch !== pr.base.ref || !Array.isArray(plan.packages)) {
    throw new Error(`${stage}: branch or packages does not match ${pr.base.ref}`);
  }
  const desktop = plan.packages.filter((pkg) => pkg?.name === 'kimi-code-app');
  if (desktop.length > 1) throw new Error(`${stage}: duplicate kimi-code-app entries`);
  if (desktop.length === 1 && (desktop[0].path !== 'apps/desktop'
    || typeof desktop[0].version !== 'string' || desktop[0].version.length === 0)) {
    throw new Error(`${stage}: invalid kimi-code-app entry`);
  }
  return { changed: desktop.length === 1, version: desktop[0]?.version };
}

function desktopVersionEvidence(pr, files) {
  const paths = new Set(files.map((file) => file.filename));
  const packageResult = paths.has(DESKTOP_PACKAGE) ? packageVersionChange(pr) : undefined;
  const planResult = paths.has(RELEASE_PLAN) ? releasePlanChange(pr) : undefined;
  if (packageResult && planResult && (packageResult.changed !== planResult.changed
    || (packageResult.changed && packageResult.after !== planResult.version))) {
    throw new Error(`PR #${pr.number}: Desktop package and release plan disagree`);
  }
  const evidence = [
    packageResult ? `package:${packageResult.before}->${packageResult.after}` : undefined,
    planResult?.changed ? `release-plan:${planResult.version}` : undefined,
  ].filter(Boolean);
  return {
    number: pr.number,
    base: pr.base.ref,
    desktopVersionChange: Boolean(packageResult?.changed || planResult?.changed),
    evidence,
  };
}

function writeOutput(skip) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `skip=${skip}\n`);
  console.log(`nightly skip: ${skip}`);
}

try {
  if (process.env.GITHUB_EVENT_NAME !== 'schedule') {
    writeOutput(false);
  } else {
    if (!/^[^/]+\/[^/]+$/.test(repo ?? '')) throw new Error('GITHUB_REPOSITORY must be owner/repo');
    const prs = paged('pulls?state=open', 'list open PRs').filter(isDesktopVersionPr);
    const results = [];
    for (const pr of prs) {
      const files = paged(`pulls/${pr.number}/files`, `PR #${pr.number} files`);
      const result = desktopVersionEvidence(pr, files);
      results.push(result);
      console.log(JSON.stringify(result));
    }
    const blocking = results.filter((result) => result.desktopVersionChange);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
        '### Desktop nightly version PR guard',
        ...(results.length === 0 ? ['No open release/* version PRs.']
          : results.map((result) => `- #${result.number}: ${result.desktopVersionChange ? '**Desktop version change; skip nightly**' : 'no Desktop version change; allow nightly'}${result.evidence.length > 0 ? ` (${result.evidence.join(', ')})` : ''}`)),
        '',
      ].join('\n'));
    }
    writeOutput(blocking.length > 0);
  }
} catch (error) {
  console.error(`::error::Desktop nightly guard failed closed: ${error.message}`);
  writeOutput(true);
  process.exitCode = 1;
}
