import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import * as mainHistory from '../../../../scripts/main-history.mjs';

export const TITLE = 'Desktop E2E journeys are failing on main';
export const WORKFLOW = 'desktop-e2e.yml';

const BOT = 'github-actions[bot]';
const SHARD_JOB = /^Desktop E2E shard /;
const MAX_LISTED = 30;
const ANSI = /\u001b\[[0-9;]*m/g;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z /;

export function failedJourneys(log) {
  const journeys = [];
  let collecting = false;
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.replace(ANSI, '').replace(TIMESTAMP, '').replace(/\s+$/, '');
    const header = /^ {2}\d+ (failed|interrupted|flaky)$/.exec(line);
    if (header !== null) {
      collecting = header[1] !== 'flaky';
      continue;
    }
    if (collecting && /^ {4}\S/.test(line)) {
      journeys.push(line.trim().replace(/[\s─]+$/u, ''));
      continue;
    }
    collecting = false;
  }
  return journeys;
}

export function nextStep(result, issue) {
  if (result === 'success') return issue === undefined ? 'none' : 'close';
  if (result === 'failure') return issue === undefined ? 'open' : 'comment';
  return 'none';
}

function listed(items, render) {
  const lines = items.slice(0, MAX_LISTED).map(render);
  if (items.length > MAX_LISTED) lines.push(`- …and ${items.length - MAX_LISTED} more`);
  return lines;
}

export function failureReport({ run, sha, journeys, lastPass, commits }) {
  const lines = [`Run: ${run}`, `Commit: ${sha}`, ''];
  if (journeys.length > 0) lines.push('Failing journeys:', ...listed(journeys, journey => `- \`${journey}\``));
  else lines.push('The shards did not print any failing journey. Open the run to see which step failed.');
  lines.push('');
  if (lastPass === undefined) {
    lines.push('No earlier run of this workflow passed on main, so there is no range of commits to compare.');
  } else {
    lines.push(`Commits since the last passing run (${lastPass.url}, ${lastPass.sha.slice(0, 9)}):`);
    lines.push(...listed(commits, commit => `- ${commit.sha.slice(0, 9)} ${commit.subject}`));
  }
  return lines.join('\n');
}

export function openingBody(report) {
  return [
    'The Desktop E2E journeys failed on main.',
    '',
    report,
    '',
    'The Desktop E2E workflow opened this issue and comments on it while main keeps failing. It closes the issue when a later run on main passes.',
  ].join('\n');
}

export function recoveryComment({ run, sha }) {
  return `The Desktop E2E journeys pass on main again: ${run} (commit ${sha.slice(0, 9)}). Closing this issue.`;
}

export async function report({ result, run, sha, runId, attempt, client }) {
  const issue = await client.findOpenIssue(TITLE);
  const step = nextStep(result, issue);
  if (step === 'none') return { step };
  if (step === 'close') {
    await client.comment(issue.number, recoveryComment({ run, sha }));
    await client.close(issue.number);
    return { step, issue: issue.number };
  }
  const journeys = [...new Set((await client.failedShardLogs(runId, attempt)).flatMap(failedJourneys))];
  const lastPass = await client.lastPassingRun(runId);
  const commits = lastPass === undefined ? [] : await client.commitsBetween(lastPass.sha, sha);
  const text = failureReport({ run, sha, journeys, lastPass, commits });
  if (step === 'open') return { step, issue: await client.openIssue(TITLE, openingBody(text)) };
  await client.comment(issue.number, `Still failing.\n\n${text}`);
  return { step, issue: issue.number };
}

export function githubClient({ token, repo, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  async function request(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetchImpl(`${apiUrl}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error(`${method} ${path} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response;
  }
  async function json(path) {
    return (await request(path)).json();
  }
  return {
    async findOpenIssue(title) {
      const issues = await (await request(`repos/${repo}/issues?state=open&creator=${encodeURIComponent(BOT)}&per_page=100`)).json();
      return issues.find(issue => issue.title === title && issue.pull_request === undefined);
    },
    async failedShardLogs(runId, attempt) {
      const { jobs } = await (await request(`repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`)).json();
      const failed = jobs.filter(job => SHARD_JOB.test(job.name) && job.conclusion === 'failure');
      return Promise.all(failed.map(async job => (await request(`repos/${repo}/actions/jobs/${job.id}/logs`)).text()));
    },
    lastPassingRun(currentRunId) {
      return mainHistory.lastPassingRun({ get: json, repo, workflow: WORKFLOW, events: ['push', 'schedule'], currentRunId });
    },
    async commitsBetween(base, head) {
      return (await mainHistory.commitsBetween({ get: json, repo, base, head })).commits;
    },
    async openIssue(title, body) {
      return (await (await request(`repos/${repo}/issues`, { method: 'POST', body: { title, body } })).json()).number;
    },
    async comment(number, body) {
      await request(`repos/${repo}/issues/${number}/comments`, { method: 'POST', body: { body } });
    },
    async close(number) {
      await request(`repos/${repo}/issues/${number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
    },
  };
}

function printingWrites(client) {
  return {
    ...client,
    async openIssue(title, body) {
      console.log(`Would open "${title}":\n\n${body}`);
      return 0;
    },
    async comment(number, body) {
      console.log(`Would comment on #${number}:\n\n${body}`);
    },
    async close(number) {
      console.log(`Would close #${number}`);
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      result: { type: 'string' },
      'run-id': { type: 'string' },
      'run-attempt': { type: 'string' },
      sha: { type: 'string' },
      repo: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const settings = {
    result: values.result,
    runId: values['run-id'] ?? process.env.GITHUB_RUN_ID,
    attempt: values['run-attempt'] ?? process.env.GITHUB_RUN_ATTEMPT ?? '1',
    sha: values.sha ?? process.env.GITHUB_SHA,
    repo: values.repo ?? process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  };
  const missing = Object.entries(settings).filter(([, value]) => value === undefined || value === '').map(([name]) => name);
  if (missing.length > 0) throw new Error(`Missing ${missing.join(', ')}; pass them as options or run inside GitHub Actions with GH_TOKEN set`);
  const run = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${settings.repo}/actions/runs/${settings.runId}`;
  const client = githubClient({ token: settings.token, repo: settings.repo, apiUrl: process.env.GITHUB_API_URL });
  const outcome = await report({ ...settings, run, client: values['dry-run'] ? printingWrites(client) : client });
  console.log(`Desktop E2E on main: ${settings.result}; tracking issue step: ${outcome.step}${outcome.issue === undefined ? '' : ` (#${outcome.issue})`}`);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
