import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const MOST_CASES = 15;
const LONGEST_NOTE = 120;
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;
const FEISHU_USER_ID = /^[\w-]+$/;

const PLATFORMS = { linux: 'Linux', win32: 'Windows', darwin: 'macOS' };

const EVENTS = { schedule: '定时运行', workflow_dispatch: '手动运行', push: '合并后运行', pull_request: 'PR 上运行' };
const REHEARSAL = '【测试】';
const RUN_ID = /^\d+$/;

const CONCLUSIONS = { failure: '失败', cancelled: '被取消', timed_out: '超时', action_required: '等人批准', neutral: '结果不明' };

const CASE_STATUSES = { failed: '', timedOut: '（超时）', interrupted: '（被中断）' };

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

function caseLine(title, status, note) {
  const said = shortened(note);
  return `· ${title}${CASE_STATUSES[status] ?? `（${status}）`}${said === '' ? '' : `：${said}`}`;
}

function groupedCases(results) {
  const groups = new Map();
  const add = (place, line) => groups.set(place, [...(groups.get(place) ?? []), line]);
  for (const result of results) {
    if (result.unreadable !== undefined) {
      add('读不了的结果文件，这个作业的用例没有列出', `· ${shortened(result.unreadable)}`);
      continue;
    }
    for (const error of result.errors) add(placeOf(result, '用例以外的错误'), `· ${shortened(error)}`);
    for (const failure of result.failures) add(placeOf(result, failure.project), caseLine(failure.title, failure.status, failure.note));
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

function heading(text) {
  return { tag: 'div', text: { tag: 'lark_md', content: `**${text}**` } };
}

function plain(lines) {
  return { tag: 'div', text: { tag: 'plain_text', content: lines.join('\n') } };
}

export function triageUser(value) {
  if (!FEISHU_USER_ID.test(value)) throw new Error('FEISHU_E2E_TRIAGE_USER must be a Feishu open_id or user_id');
  return value;
}

function triageRequest(user, url) {
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `<at id=${triageUser(user)}></at> 看到这条消息后，请立刻打开这次 E2E 运行 [${url}](${url})，分析报错的根因是哪个 PR 引入的，然后 @ 提这个 PR 的人，让对方去修。`,
    },
  };
}

export function failureCard({ run, jobs, results, triage, rehearsal = false }) {
  const { broken, skipped } = jobReport(jobs);
  const groups = groupedCases(results);
  if (broken.length === 0 && groups.length === 0) return undefined;
  const failures = results.reduce((count, result) => count + (result.failures?.length ?? 0), 0);
  const elements = [plain([`${run.head_branch}@${run.head_sha.slice(0, 9)} · ${EVENTS[run.event] ?? run.event}`])];
  if (broken.length > 0) {
    const lines = broken.map(jobLine);
    if (skipped > 0) lines.push(`另有 ${skipped} 个作业被跳过，没有运行`);
    elements.push(heading(`没通过的作业（${broken.length} 个）`), plain(lines));
  }
  if (groups.length > 0) elements.push(heading(failures > 0 ? `没通过的用例（${failures} 条）` : '用例以外的错误'), plain(caseLines(groups)));
  elements.push(
    { tag: 'hr' },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '每个面的报告和失败附件在运行页的 Artifacts 里' }] },
    { tag: 'action', actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看这次运行' }, url: run.html_url }] },
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
  };
}

export function unknownOutcomeCard({ runUrl, reason, triage, rehearsal = false }) {
  const elements = [
    plain(['通知作业没能读到这次运行的结果，不知道有没有作业没通过。', `原因：${shortened(reason)}`]),
    { tag: 'hr' },
    { tag: 'action', actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看这次运行' }, url: runUrl }] },
  ];
  if (triage !== undefined) elements.push(triageRequest(triage, runUrl));
  return { config: { wide_screen_mode: true }, header: { template: 'orange', title: { tag: 'plain_text', content: `${rehearsal ? REHEARSAL : ''}每晚 E2E：没能读到结果` } }, elements };
}

export async function notify({ runId, runUrl, resultsDir, triage, rehearsal = false, github, post }) {
  let card;
  try {
    const run = await github.run(runId);
    const jobs = await github.jobs(runId, run.run_attempt);
    card = failureCard({ run, jobs, results: readResults(resultsDir), triage, rehearsal });
  } catch (error) {
    await post(unknownOutcomeCard({ runUrl, reason: error.message, triage, rehearsal }));
    throw error;
  }
  if (card === undefined) return 'passed';
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
  const outcome = await notify({ runId: settings.GITHUB_RUN_ID, runUrl, resultsDir: settings['--results-dir'], triage, rehearsal, github, post });
  if (outcome === 'passed') console.log(`Every job of run ${settings.GITHUB_RUN_ID} passed; nothing was sent to Feishu.`);
  else console.log(dryRun ? 'Printed the Feishu card above instead of sending it (--dry-run).' : 'Posted the failed jobs and cases to Feishu.');
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
