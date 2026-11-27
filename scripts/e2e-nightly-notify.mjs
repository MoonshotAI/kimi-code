import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { commitsBetween, lastPassingRun } from './main-history.mjs';

const MOST_CASES = 15;
const MOST_COMMITS = 20;
const LONGEST_NOTE = 120;
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;
const TRIAGE_NAME = /^[\p{L}\p{N}_.-]+$/u;

const PLATFORMS = { linux: 'Linux', win32: 'Windows', darwin: 'macOS' };

const EVENTS = { schedule: '定时运行', workflow_dispatch: '手动运行', push: '合并后运行', pull_request: 'PR 上运行' };
const REHEARSAL = '【测试】';
const RUN_ID = /^\d+$/;

const CONCLUSIONS = { failure: '失败', cancelled: '被取消', timed_out: '超时', action_required: '等人批准', neutral: '结果不明' };

const CASE_STATUSES = { failed: '', timedOut: '（超时）', interrupted: '（被中断）' };

const VERDICTS = ['每次都复现', '时有时无', '复跑都通过', '没有复跑'];
const PLATFORMS_NOT_ON_PUSH = [
  ['Windows', /windows/i],
  ['macOS', /macos/i],
];
const PULL_REQUEST = /^(.*?)\s*\(#(\d+)\)$/;

function settled(conclusion) {
  return conclusion === 'success' || conclusion === 'skipped';
}

function brokenStep(job) {
  return (job.steps ?? []).find(step => step.conclusion !== null && !settled(step.conclusion))?.name;
}

export function jobReport(jobs) {
  const finished = jobs.filter(job => job.status === 'completed');
  const broken = finished.filter(job => !settled(job.conclusion)).map(job => ({ name: job.name, conclusion: job.conclusion, step: brokenStep(job) }));
  return { broken, skipped: finished.filter(job => job.conclusion === 'skipped').length };
}

export function readResults(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => join(entry.parentPath, entry.name))
    .toSorted()
    .map(path => resultsIn(path, relative(dir, path)));
}

function resultsIn(path, name) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { unreadable: `${name}：${error.message}` };
  }
  const shaped = typeof parsed?.platform === 'string' && Array.isArray(parsed.errors) && Array.isArray(parsed.failures) && (parsed.shard === null || typeof parsed.shard?.total === 'number');
  return shaped ? parsed : { unreadable: `${name}：不是 run-summary 写出的结果格式` };
}

function placeOf(result, label) {
  const shard = result.shard === null ? '' : `（第 ${result.shard.current}/${result.shard.total} 片）`;
  return `${PLATFORMS[result.platform] ?? result.platform} · ${label}${shard}`;
}

function shortened(text) {
  const line = text.replaceAll(/\s+/g, ' ').trim();
  return line.length > LONGEST_NOTE ? `${line.slice(0, LONGEST_NOTE)}…` : line;
}

function rerunTag(rerun, policy) {
  if (rerun === undefined) return policy === undefined ? '没有复跑' : `没有复跑：一个作业只复跑前 ${policy.most} 条`;
  if (rerun.error !== undefined) return '复跑出错';
  const done = rerun.failed + rerun.passed;
  if (done === 0) return '复跑没跑完';
  return `复现 ${rerun.failed}/${done}${rerun.unfinished > 0 ? `，另 ${rerun.unfinished} 次没跑完` : ''}`;
}

function verdict(rerun) {
  if (rerun === undefined || rerun.error !== undefined || rerun.failed + rerun.passed === 0) return '没有复跑';
  if (rerun.passed === 0) return '每次都复现';
  return rerun.failed === 0 ? '复跑都通过' : '时有时无';
}

function verdictLine(failures) {
  const counts = failures.map(failure => verdict(failure.rerun));
  const parts = VERDICTS.map(name => [name, counts.filter(count => count === name).length]).filter(([, count]) => count > 0);
  return `同一提交上复跑的结果（只用来判断能不能稳定复现，作业照样算失败）：${parts.map(([name, count]) => `${name} ${count} 条`).join('，')}`;
}

function caseLine({ title, status, note, rerun }, policy) {
  const said = shortened(note);
  return `· [${rerunTag(rerun, policy)}] ${title}${CASE_STATUSES[status] ?? `（${status}）`}${said === '' ? '' : `：${said}`}`;
}

function groupedCases(results) {
  const groups = new Map();
  const add = (place, line) => groups.set(place, [...(groups.get(place) ?? []), line]);
  for (const result of results) {
    if (result.unreadable !== undefined) {
      add('结果文件没读全，有些用例没有列出', `· ${shortened(result.unreadable)}`);
      continue;
    }
    for (const error of result.errors) add(placeOf(result, '用例以外的错误'), `· ${shortened(error)}`);
    for (const failure of result.failures) add(placeOf(result, failure.project), caseLine(failure, result.rerun));
  }
  return [...groups].toSorted(([left], [right]) => left.localeCompare(right));
}

function caseLines(groups) {
  const lines = [];
  let listed = 0;
  let left = 0;
  for (const [place, cases] of groups) {
    const room = Math.max(0, MOST_CASES - listed);
    if (room > 0) lines.push(place, ...cases.slice(0, room));
    listed += Math.min(room, cases.length);
    left += Math.max(0, cases.length - room);
  }
  if (left > 0) lines.push(`……另有 ${left} 条没列出，完整的结果在运行页的摘要里`);
  return lines;
}

function jobLine({ name, conclusion, step }) {
  return `· ${name}：${CONCLUSIONS[conclusion] ?? conclusion}${step === undefined ? '' : `，在「${step}」这一步`}`;
}

function beijingDate(timestamp) {
  return new Date(Date.parse(timestamp) + BEIJING_OFFSET).toISOString().slice(0, 10);
}

function lark(text) {
  return { tag: 'div', text: { tag: 'lark_md', content: text } };
}

function heading(text) {
  return lark(`**${text}**`);
}

function plain(lines) {
  return { tag: 'div', text: { tag: 'plain_text', content: lines.join('\n') } };
}

function button(text, url, type = 'default') {
  return { tag: 'button', type, text: { tag: 'plain_text', content: text }, url };
}

function commitLine({ sha, subject }) {
  const pull = PULL_REQUEST.exec(subject);
  return pull === null ? `· ${sha.slice(0, 9)} ${shortened(subject)}` : `· #${pull[2]} ${shortened(pull[1])}`;
}

function runLink(base) {
  return `[${EVENTS[base.event] ?? base.event} · ${base.sha.slice(0, 9)}](${base.url})`;
}

function candidateSection(run, candidates) {
  const title = '上次全绿以来的提交';
  if (candidates.error !== undefined) return { elements: [heading(title), plain([`没能读到候选提交：${shortened(candidates.error)}`])] };
  const { notOnPush, base } = candidates;
  if (base === undefined) return { elements: [heading(title), plain([`main 上找不到更早的全绿${notOnPush.length > 0 ? '每晚运行' : '运行'}，列不出候选提交`])] };
  if (candidates.status === 'identical') return { elements: [heading(title), lark(`上次全绿的${runLink(base)}测的就是这个提交，之后没有新提交。`)] };
  if (candidates.status === 'behind' || candidates.status === 'diverged') return { elements: [heading(title), lark(`上次全绿的${runLink(base)}不在这个提交之前，列不出候选提交。`)] };
  const lines = candidates.commits.slice(0, MOST_COMMITS).map(commitLine);
  if (candidates.total > lines.length) lines.push(`……另有 ${candidates.total - lines.length} 个提交，完整的列表点「查看这些提交」`);
  const platforms = notOnPush.join('、');
  const since = `从上次全绿的${runLink(base)}算起${notOnPush.length > 0 ? `。有 ${platforms} 作业没通过，合并后运行不跑 ${platforms}，所以只看每晚运行` : ''}`;
  return {
    elements: [heading(`${title}（${candidates.total} 个）`), lark(since), plain(lines)],
    compare: `${run.repository.html_url}/compare/${base.sha}...${run.head_sha}`,
  };
}

export function triageUser(value) {
  if (!TRIAGE_NAME.test(value)) throw new Error("FEISHU_E2E_TRIAGE_USER must be the name to write after @, made of letters, digits, '.', '_' or '-'");
  return value;
}

function triageRequest(user, url) {
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `@${triageUser(user)} 看到这条消息后，请立刻打开这次 E2E 运行 [${url}](${url})，分析报错的根因是哪个 PR 引入的，然后 @ 提这个 PR 的人，让对方去修。`,
    },
  };
}

function somethingFailed(jobs, results) {
  return jobReport(jobs).broken.length > 0 || groupedCases(results).length > 0;
}

export function failureCard({ run, jobs, results, triage, rehearsal = false, candidates }) {
  if (!somethingFailed(jobs, results)) return undefined;
  const { broken, skipped } = jobReport(jobs);
  const groups = groupedCases(results);
  const failures = results.flatMap(result => result.failures ?? []);
  const elements = [plain([`${run.head_branch}@${run.head_sha.slice(0, 9)} · ${EVENTS[run.event] ?? run.event}`])];
  if (broken.length > 0) {
    const lines = broken.map(jobLine);
    if (skipped > 0) lines.push(`另有 ${skipped} 个作业被跳过，没有运行`);
    elements.push(heading(`没通过的作业（${broken.length} 个）`), plain(lines));
  }
  if (groups.length > 0) {
    const lines = caseLines(groups);
    const reran = failures.length > 0 && results.some(result => result.rerun !== undefined);
    elements.push(heading(failures.length > 0 ? `没通过的用例（${failures.length} 条）` : '用例以外的错误'), plain(reran ? [verdictLine(failures), ...lines] : lines));
  }
  const range = candidates === undefined ? undefined : candidateSection(run, candidates);
  if (range !== undefined) elements.push(...range.elements);
  elements.push(
    { tag: 'hr' },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '每个面的报告和失败附件在运行页的 Artifacts 里' }] },
    { tag: 'action', actions: [button('查看这次运行', run.html_url, 'primary'), ...(range?.compare === undefined ? [] : [button('查看这些提交', range.compare)])] },
  );
  if (triage !== undefined) elements.push(triageRequest(triage, run.html_url));
  return {
    config: { wide_screen_mode: true },
    header: { template: 'red', title: { tag: 'plain_text', content: `${rehearsal ? REHEARSAL : ''}每晚 E2E 没通过 · ${beijingDate(run.run_started_at ?? run.created_at)}` } },
    elements,
  };
}

export function signature(timestamp, secret) {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

export async function send({ webhook, secret, card, now = Date.now, fetchImpl = fetch }) {
  const timestamp = String(Math.floor(now() / 1000));
  const response = await fetchImpl(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp, sign: signature(timestamp, secret), msg_type: 'interactive', card }),
  });
  const text = await response.text();
  let reply;
  try {
    reply = JSON.parse(text);
  } catch {
    reply = undefined;
  }
  const code = reply?.code ?? reply?.StatusCode;
  if (!response.ok || code !== 0) throw new Error(`Feishu did not accept the message: HTTP ${response.status}, ${text.slice(0, 300)}`);
}

export function githubClient({ token, repo, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  async function get(path) {
    const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
    const response = await fetchImpl(`${apiUrl}/${path}`, { headers });
    if (!response.ok) throw new Error(`GET ${path} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response.json();
  }
  return {
    run: runId => get(`repos/${repo}/actions/runs/${runId}`),
    jobs: async (runId, attempt) => (await get(`repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`)).jobs,
    lastPassingRun: options => lastPassingRun({ get, repo, ...options }),
    commitsBetween: (base, head) => commitsBetween({ get, repo, base, head }),
  };
}

export function unknownOutcomeCard({ runUrl, reason, triage, rehearsal = false }) {
  const elements = [
    plain(['通知作业没能读到这次运行的结果，不知道有没有作业没通过。', `原因：${shortened(reason)}`]),
    { tag: 'hr' },
    { tag: 'action', actions: [button('查看这次运行', runUrl, 'primary')] },
  ];
  if (triage !== undefined) elements.push(triageRequest(triage, runUrl));
  return { config: { wide_screen_mode: true }, header: { template: 'orange', title: { tag: 'plain_text', content: `${rehearsal ? REHEARSAL : ''}每晚 E2E：没能读到结果` } }, elements };
}

function failedPlatformsNotOnPush(jobs) {
  const failed = jobs.filter(job => job.status === 'completed' && !settled(job.conclusion));
  return PLATFORMS_NOT_ON_PUSH.filter(([, label]) => failed.some(job => (job.labels ?? []).some(name => label.test(name)))).map(([platform]) => platform);
}

async function candidatesFor(github, run, jobs) {
  const notOnPush = failedPlatformsNotOnPush(jobs);
  try {
    const base = await github.lastPassingRun({ workflow: run.workflow_id, events: notOnPush.length > 0 ? ['schedule'] : ['push', 'schedule'], currentRunId: run.id, createdBefore: run.created_at });
    return base === undefined ? { notOnPush } : { notOnPush, base, ...(await github.commitsBetween(base.sha, run.head_sha)) };
  } catch (error) {
    return { notOnPush, error: error.message };
  }
}

export async function notify({ runId, runUrl, resultsDir, resultsDownloadFailed = false, triage, rehearsal = false, github, post }) {
  let card;
  try {
    const run = await github.run(runId);
    const jobs = await github.jobs(runId, run.run_attempt);
    const results = [...readResults(resultsDir), ...(resultsDownloadFailed ? [{ unreadable: '下载 e2e-results-* artifact 失败' }] : [])];
    if (!somethingFailed(jobs, results)) return 'passed';
    card = failureCard({ run, jobs, results, triage, rehearsal, candidates: await candidatesFor(github, run, jobs) });
  } catch (error) {
    await post(unknownOutcomeCard({ runUrl, reason: error.message, triage, rehearsal }));
    throw error;
  }
  await post(card);
  return 'posted';
}

async function main() {
  const { values } = parseArgs({
    options: {
      'results-dir': { type: 'string' },
      'run-id': { type: 'string' },
      repo: { type: 'string' },
      rehearsal: { type: 'boolean', default: false },
      'results-download-failed': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const dryRun = values['dry-run'];
  const settings = {
    '--results-dir': values['results-dir'],
    GITHUB_RUN_ID: values['run-id'] ?? process.env.GITHUB_RUN_ID,
    GITHUB_REPOSITORY: values.repo ?? process.env.GITHUB_REPOSITORY,
    GH_TOKEN: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    ...(dryRun
      ? {}
      : {
          FEISHU_E2E_WEBHOOK: process.env.FEISHU_E2E_WEBHOOK,
          FEISHU_E2E_SECRET: process.env.FEISHU_E2E_SECRET,
          FEISHU_E2E_TRIAGE_USER: process.env.FEISHU_E2E_TRIAGE_USER,
        }),
  };
  const missing = Object.entries(settings)
    .filter(([, value]) => value === undefined || value === '')
    .map(([name]) => name);
  if (missing.length > 0) throw new Error(`Missing ${missing.join(', ')}; the Feishu webhook, its signing secret and the user to mention are repository secrets`);
  if (!RUN_ID.test(settings.GITHUB_RUN_ID)) throw new Error(`The run ID must be a number, got ${JSON.stringify(settings.GITHUB_RUN_ID)}`);
  if (!dryRun && !settings.FEISHU_E2E_WEBHOOK.startsWith('https://')) throw new Error('FEISHU_E2E_WEBHOOK must be an https:// address');
  const triageValue = settings.FEISHU_E2E_TRIAGE_USER ?? process.env.FEISHU_E2E_TRIAGE_USER;
  const triage = triageValue === undefined || triageValue === '' ? undefined : triageUser(triageValue);
  const github = githubClient({ token: settings.GH_TOKEN, repo: settings.GITHUB_REPOSITORY, apiUrl: process.env.GITHUB_API_URL });
  const post = dryRun
    ? async card => console.log(JSON.stringify(card, null, 2))
    : card => send({ webhook: settings.FEISHU_E2E_WEBHOOK, secret: settings.FEISHU_E2E_SECRET, card });
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${settings.GITHUB_REPOSITORY}/actions/runs/${settings.GITHUB_RUN_ID}`;
  const rehearsal = values.rehearsal;
  const resultsDownloadFailed = values['results-download-failed'];
  const outcome = await notify({ runId: settings.GITHUB_RUN_ID, runUrl, resultsDir: settings['--results-dir'], resultsDownloadFailed, triage, rehearsal, github, post });
  if (outcome === 'passed') console.log(`Every job of run ${settings.GITHUB_RUN_ID} passed; nothing was sent to Feishu.`);
  else console.log(dryRun ? 'Printed the Feishu card above instead of sending it (--dry-run).' : 'Posted the failed jobs and cases to Feishu.');
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
