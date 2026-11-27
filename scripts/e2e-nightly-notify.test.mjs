import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { failureCard, githubClient, jobReport, notify, readResults, send, signature, triageUser, unknownOutcomeCard } from './e2e-nightly-notify.mjs';

const run = {
  id: 42,
  workflow_id: 427,
  head_branch: 'main',
  head_sha: 'd5263af02c0ffee0123456789abcdef012345678',
  event: 'schedule',
  html_url: 'https://github.com/example/repo/actions/runs/42',
  created_at: '2026-11-26T20:07:29Z',
  run_started_at: '2026-11-26T20:07:31Z',
  run_attempt: 2,
  repository: { html_url: 'https://github.com/example/repo' },
};

function job(name, conclusion, steps = [], labels = ['ubuntu-latest']) {
  return { name, status: 'completed', conclusion, labels, steps: steps.map(([stepName, stepConclusion]) => ({ name: stepName, conclusion: stepConclusion })) };
}

const noHistory = {
  lastPassingRun: async () => undefined,
  commitsBetween: async () => {
    throw new Error('no base run, so no commits to compare');
  },
};

const notifyJob = { name: 'Notify Feishu about nightly failures', status: 'in_progress', conclusion: null, steps: [] };

const greenJobs = [job('Decide whether E2E runs', 'success'), job('Build (optional)', 'success'), job('TUI (optional)', 'success'), notifyJob];

function results(platform, shard, failures, errors = []) {
  return { platform, shard, status: failures.length + errors.length === 0 ? 'passed' : 'failed', errors, failures };
}

function failure(project, title, status = 'failed', note = 'expect(received).toBe(expected)') {
  return { project, file: 'scenarios/conversation/example.spec.ts', title, status, note };
}

function texts(card) {
  return card.elements.map(element => element.text?.content ?? element.elements?.[0]?.content ?? element.actions?.[0]?.url ?? element.tag);
}

await test('signs the timestamp and secret the way Feishu checks them, matching an openssl HMAC of an empty message', () => {
  assert.equal(signature('1700000000', 'test-secret'), 'mbm4Y4oluIPQ00qlBIhX8vAZ0EKv3nw0LuTb91jPL84=');
});

await test('lists finished jobs that did not pass with the step they stopped in, and ignores the running notify job', () => {
  const report = jobReport([
    job('Build (optional)', 'success'),
    job('Web (optional, 2/2)', 'failure', [['Set up job', 'success'], ['Run the scenarios and driver self-tests on the Web interface', 'failure'], ['Post Run actions/checkout@v6', 'success']]),
    job('Windows desktop (optional, 1/2)', 'cancelled', [['Set up job', 'success'], ['Run the scenarios and driver self-tests on Windows', 'cancelled']]),
    job('Windows acp (optional)', 'skipped'),
    notifyJob,
  ]);
  assert.deepEqual(report, {
    broken: [
      { name: 'Web (optional, 2/2)', conclusion: 'failure', step: 'Run the scenarios and driver self-tests on the Web interface' },
      { name: 'Windows desktop (optional, 1/2)', conclusion: 'cancelled', step: 'Run the scenarios and driver self-tests on Windows' },
    ],
    skipped: 1,
  });
});

await test('sends nothing when every job passed and no case failed', () => {
  assert.equal(failureCard({ run, jobs: greenJobs, results: [results('linux', null, []), results('win32', { current: 1, total: 2 }, [])] }), undefined);
});

await test('reports a failed build and the jobs it left unrun, even without any results file', () => {
  const jobs = [job('Decide whether E2E runs', 'success'), job('Build (optional)', 'failure', [['Run pnpm run build', 'failure']]), job('TUI (optional)', 'skipped'), job('ACP (optional)', 'skipped'), notifyJob];
  const card = failureCard({ run, jobs, results: [] });
  assert.equal(card.header.template, 'red');
  assert.equal(card.header.title.content, '每晚 E2E 没通过 · 2026-11-27');
  assert.deepEqual(texts(card), [
    'main@d5263af02 · 定时运行',
    '**没通过的作业（1 个）**',
    '· Build (optional)：失败，在「Run pnpm run build」这一步\n另有 2 个作业被跳过，没有运行',
    'hr',
    '每个面的报告和失败附件在运行页的 Artifacts 里',
    'https://github.com/example/repo/actions/runs/42',
  ]);
});

await test('groups failed cases by platform, project and shard, and marks cases that timed out or were interrupted', () => {
  const jobs = [job('Web (optional, 2/2)', 'failure', [['Run the scenarios', 'failure']]), job('Windows tui (optional)', 'failure', [['Run the scenarios', 'failure']]), notifyJob];
  const card = failureCard({
    run: { ...run, event: 'workflow_dispatch' },
    jobs,
    results: [
      results('win32', null, [failure('TUI', 'keeps the draft after a restart', 'timedOut', 'Test timeout of 30000ms exceeded.')]),
      results('linux', { current: 2, total: 2 }, [failure('Web', 'runs a shell command once after approval'), failure('Web', 'answers a question', 'interrupted', '')]),
      results('linux', null, []),
    ],
  });
  assert.deepEqual(texts(card).slice(0, 5), [
    'main@d5263af02 · 手动运行',
    '**没通过的作业（2 个）**',
    '· Web (optional, 2/2)：失败，在「Run the scenarios」这一步\n· Windows tui (optional)：失败，在「Run the scenarios」这一步',
    '**没通过的用例（3 条）**',
    [
      'Linux · Web（第 2/2 片）',
      '· [没有复跑] runs a shell command once after approval：expect(received).toBe(expected)',
      '· [没有复跑] answers a question（被中断）',
      'Windows · TUI',
      '· [没有复跑] keeps the draft after a restart（超时）：Test timeout of 30000ms exceeded.',
    ].join('\n'),
  ]);
});

await test('keeps the card small: lists at most fifteen cases, counts the rest, and shortens long notes', () => {
  const many = Array.from({ length: 18 }, (_, index) => failure('Desktop', `case ${String(index + 1).padStart(2, '0')}`, 'failed', 'x'.repeat(300)));
  const card = failureCard({ run, jobs: [job('Desktop (optional, 1/2)', 'failure'), notifyJob], results: [results('linux', { current: 1, total: 2 }, many)] });
  const lines = texts(card)[4].split('\n');
  assert.equal(lines.length, 1 + 15 + 1);
  assert.equal(lines[1], `· [没有复跑] case 01：${'x'.repeat(120)}…`);
  assert.equal(lines.at(-1), '……另有 3 条没列出，完整的结果在运行页的摘要里');
  assert.equal(texts(card)[3], '**没通过的用例（18 条）**');
});

await test('reports errors that belong to no case, such as a scenario file that does not load', () => {
  const card = failureCard({ run, jobs: [job('ACP (optional)', 'failure'), notifyJob], results: [results('linux', null, [], ['SyntaxError: Unexpected token in scenarios/broken.spec.ts'])] });
  assert.deepEqual(texts(card).slice(3, 5), ['**用例以外的错误**', 'Linux · 用例以外的错误\n· SyntaxError: Unexpected token in scenarios/broken.spec.ts']);
});

await test('ends the card with the triage name after a plain @ and asks them to find the PR behind the failure', () => {
  const card = failureCard({ run, jobs: [job('Build (optional)', 'failure'), notifyJob], results: [], triage: 'triage-bot' });
  const last = card.elements.at(-1);
  assert.equal(last.text.tag, 'lark_md');
  assert.equal(
    last.text.content,
    '@triage-bot 看到这条消息后，请立刻打开这次 E2E 运行 [https://github.com/example/repo/actions/runs/42](https://github.com/example/repo/actions/runs/42)，分析报错的根因是哪个 PR 引入的，然后 @ 提这个 PR 的人，让对方去修。',
  );
  assert.equal(failureCard({ run, jobs: [job('Build (optional)', 'failure'), notifyJob], results: [] }).elements.at(-1).tag, 'action');
});

await test('accepts a plain name and refuses anything that could turn into markup in the card', () => {
  assert.equal(triageUser('triage-bot'), 'triage-bot');
  assert.equal(triageUser('值班同学'), '值班同学');
  assert.equal(triageUser('bot.v2_on-call'), 'bot.v2_on-call');
  for (const value of ['', '@triage-bot', '<at id=all></at>', '**all**', '[x](https://example.com)', 'two words']) {
    assert.throws(() => triageUser(value), /FEISHU_E2E_TRIAGE_USER must be the name to write after @/);
  }
  assert.throws(() => failureCard({ run, jobs: [job('Build (optional)', 'failure')], results: [], triage: 'x <at' }), /FEISHU_E2E_TRIAGE_USER/);
});

await test('reads every results file under the download folder, one folder per artifact or none at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-nightly-notify-'));
  try {
    mkdirSync(join(dir, 'e2e-results-tui'));
    mkdirSync(join(dir, 'e2e-results-web-2'));
    writeFileSync(join(dir, 'e2e-results-tui', 'e2e-results.json'), JSON.stringify(results('linux', null, [])));
    writeFileSync(join(dir, 'e2e-results-web-2', 'e2e-results.json'), JSON.stringify(results('linux', { current: 2, total: 2 }, [failure('Web', 'a')])));
    writeFileSync(join(dir, 'e2e-results-web-2', 'notes.txt'), 'not a results file');
    assert.deepEqual(
      readResults(dir).map(entry => entry.failures.length),
      [0, 1],
    );
    assert.deepEqual(readResults(join(dir, 'missing')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('reads the file straight from the download folder when only one artifact matched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-nightly-notify-'));
  try {
    writeFileSync(join(dir, 'e2e-results.json'), JSON.stringify(results('win32', null, [failure('ACP', 'a')])));
    assert.deepEqual(readResults(dir), [results('win32', null, [failure('ACP', 'a')])]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('lists a results file it cannot read or that has another shape instead of silently dropping its cases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-nightly-notify-'));
  try {
    mkdirSync(join(dir, 'e2e-results-acp'));
    mkdirSync(join(dir, 'e2e-results-tui'));
    writeFileSync(join(dir, 'e2e-results-acp', 'e2e-results.json'), '{"platform": "linux", "fail');
    writeFileSync(join(dir, 'e2e-results-tui', 'e2e-results.json'), JSON.stringify({ platform: 'linux', shard: null, errors: [], failedCases: [] }));
    const read = readResults(dir);
    assert.equal(read.length, 2);
    assert.match(read[0].unreadable, /^e2e-results-acp[\\/]e2e-results\.json：/);
    assert.match(read[1].unreadable, /^e2e-results-tui[\\/]e2e-results\.json：不是 run-summary 写出的结果格式$/);
    const card = failureCard({ run, jobs: greenJobs, results: read });
    assert.equal(texts(card)[1], '**用例以外的错误**');
    assert.match(texts(card)[2], /^结果文件没读全，有些用例没有列出\n· e2e-results-acp/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function replying(status, body, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
}

await test('posts a signed interactive card to the webhook and accepts both reply formats Feishu uses', async () => {
  const card = { header: {}, elements: [] };
  for (const reply of [{ code: 0, msg: 'success', data: {} }, { StatusCode: 0, StatusMessage: 'success' }]) {
    const calls = [];
    await send({ webhook: 'https://open.feishu.example/hook/abc', secret: 'test-secret', card, now: () => 1700000000999, fetchImpl: replying(200, reply, calls) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://open.feishu.example/hook/abc');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { timestamp: '1700000000', sign: 'mbm4Y4oluIPQ00qlBIhX8vAZ0EKv3nw0LuTb91jPL84=', msg_type: 'interactive', card });
  }
});

await test('fails loudly when Feishu refuses the message, without echoing the webhook address', async () => {
  const webhook = 'https://open.feishu.example/hook/private-token';
  const refusals = [replying(200, { code: 19021, msg: 'sign match fail or timestamp is not within one hour from current time' }, []), replying(400, 'bad request', []), replying(200, 'not json', [])];
  for (const fetchImpl of refusals) {
    await assert.rejects(send({ webhook, secret: 'test-secret', card: {}, fetchImpl }), error => {
      assert.match(error.message, /^Feishu did not accept the message: HTTP \d+/);
      assert.doesNotMatch(error.message, /private-token/);
      return true;
    });
  }
});

await test('reads the run and the jobs of this attempt from the GitHub API', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: init.headers.Authorization });
    return new Response(JSON.stringify(url.endsWith('/jobs?per_page=100') ? { jobs: greenJobs } : run), { status: 200 });
  };
  const github = githubClient({ token: 'YOUR_TOKEN', repo: 'example/repo', apiUrl: 'https://api.example.test', fetchImpl });
  assert.deepEqual(await github.run('42'), run);
  assert.deepEqual(await github.jobs('42', '2'), greenJobs);
  assert.deepEqual(calls, [
    { url: 'https://api.example.test/repos/example/repo/actions/runs/42', authorization: 'Bearer YOUR_TOKEN' },
    { url: 'https://api.example.test/repos/example/repo/actions/runs/42/attempts/2/jobs?per_page=100', authorization: 'Bearer YOUR_TOKEN' },
  ]);
  const failing = githubClient({ token: 'YOUR_TOKEN', repo: 'example/repo', fetchImpl: async () => new Response('Not Found', { status: 404 }) });
  await assert.rejects(failing.run('42'), /GET repos\/example\/repo\/actions\/runs\/42 failed with HTTP 404: Not Found/);
});

await test('posts only when something failed, reading the jobs of the run\'s latest attempt', async () => {
  const posted = [];
  const post = async card => posted.push(card);
  const missing = join(tmpdir(), 'e2e-nightly-notify-missing-folder');
  const asked = [];
  const green = {
    lastPassingRun: async () => {
      throw new Error('a passing run needs no candidate commits');
    },
    run: async () => run,
    jobs: async (runId, attempt) => {
      asked.push([runId, attempt]);
      return greenJobs;
    },
  };
  assert.equal(await notify({ runId: '42', resultsDir: missing, github: green, post }), 'passed');
  assert.equal(posted.length, 0);
  assert.deepEqual(asked, [['42', 2]]);
  const red = { ...noHistory, run: async () => run, jobs: async () => [job('Build (optional)', 'failure'), notifyJob] };
  assert.equal(await notify({ runId: '42', resultsDir: missing, triage: 'triage-bot', github: red, post }), 'posted');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].header.title.content, '每晚 E2E 没通过 · 2026-11-27');
  assert.match(posted[0].elements.at(-1).text.content, /^@triage-bot /);
});

await test('still posts a card, then fails, when it cannot read the run from GitHub', async () => {
  const posted = [];
  const runUrl = 'https://github.com/example/repo/actions/runs/42';
  const down = { run: async () => run, jobs: async () => Promise.reject(new Error('GET repos/example/repo/actions/runs/42/attempts/1/jobs failed with HTTP 502: Bad Gateway')) };
  await assert.rejects(
    notify({ runId: '42', runUrl, resultsDir: join(tmpdir(), 'e2e-nightly-notify-missing-folder'), triage: 'triage-bot', github: down, post: async card => posted.push(card) }),
    /HTTP 502/,
  );
  assert.deepEqual(posted, [unknownOutcomeCard({ runUrl, reason: 'GET repos/example/repo/actions/runs/42/attempts/1/jobs failed with HTTP 502: Bad Gateway', triage: 'triage-bot' })]);
  assert.equal(posted[0].header.title.content, '每晚 E2E：没能读到结果');
  assert.deepEqual(texts(posted[0]).slice(0, 1), ['通知作业没能读到这次运行的结果，不知道有没有作业没通过。\n原因：GET repos/example/repo/actions/runs/42/attempts/1/jobs failed with HTTP 502: Bad Gateway']);
  assert.equal(texts(posted[0]).at(-2), runUrl);
  assert.match(posted[0].elements.at(-1).text.content, /^@triage-bot /);
});

await test('marks a test card about an earlier run so nobody takes it for tonight\'s failure', async () => {
  const posted = [];
  const red = { ...noHistory, run: async () => ({ ...run, event: 'push' }), jobs: async () => [job('Desktop (optional, 2/2)', 'failure'), notifyJob] };
  const missing = join(tmpdir(), 'e2e-nightly-notify-missing-folder');
  await notify({ runId: '42', resultsDir: missing, triage: 'triage-bot', rehearsal: true, github: red, post: async card => posted.push(card) });
  assert.equal(posted[0].header.title.content, '【测试】每晚 E2E 没通过 · 2026-11-27');
  assert.equal(texts(posted[0])[0], 'main@d5263af02 · 合并后运行');
  assert.match(posted[0].elements.at(-1).text.content, /^@triage-bot 看到这条消息后/);
  assert.equal(unknownOutcomeCard({ runUrl: run.html_url, reason: 'x', rehearsal: true }).header.title.content, '【测试】每晚 E2E：没能读到结果');
  assert.equal(failureCard({ run, jobs: [job('Build (optional)', 'failure')], results: [] }).header.title.content, '每晚 E2E 没通过 · 2026-11-27');
});

await test('still lists the failed jobs, and says the cases are missing, when downloading the results failed', async () => {
  const posted = [];
  const red = { ...noHistory, run: async () => run, jobs: async () => [job('Web (optional, 1/2)', 'failure', [['Run the scenarios', 'failure']]), notifyJob] };
  const missing = join(tmpdir(), 'e2e-nightly-notify-missing-folder');
  assert.equal(await notify({ runId: '42', resultsDir: missing, resultsDownloadFailed: true, github: red, post: async card => posted.push(card) }), 'posted');
  assert.deepEqual(texts(posted[0]).slice(1, 5), [
    '**没通过的作业（1 个）**',
    '· Web (optional, 1/2)：失败，在「Run the scenarios」这一步',
    '**用例以外的错误**',
    '结果文件没读全，有些用例没有列出\n· 下载 e2e-results-* artifact 失败',
  ]);
});

function rerunResults(platform, failures, policy = { repeats: 5, most: 3 }) {
  return { ...results(platform, null, failures), ...(policy === undefined ? {} : { rerun: policy }) };
}

function rerunOf(failed, passed, unfinished = 0, error) {
  return { failed, passed, unfinished, ...(error === undefined ? {} : { error }) };
}

await test('tags each failed case with how often its reruns on the same commit reproduced it, and sums the reruns up first', () => {
  const card = failureCard({
    run,
    jobs: [job('ACP (optional)', 'failure'), job('Windows acp (optional)', 'failure', [], ['windows-latest']), notifyJob],
    results: [
      rerunResults('linux', [
        { ...failure('ACP', 'fails every time', 'failed', 'x'), rerun: rerunOf(5, 0) },
        { ...failure('ACP', 'fails now and then', 'timedOut', 'y'), rerun: rerunOf(2, 3) },
        { ...failure('ACP', 'passes on every rerun', 'failed', ''), rerun: rerunOf(0, 5) },
        failure('ACP', 'comes after the first three', 'failed', 'z'),
      ]),
      rerunResults('win32', [
        { ...failure('ACP', 'ran out of time', 'failed', ''), rerun: rerunOf(1, 1, 3) },
        { ...failure('ACP', 'never finished a rerun', 'failed', ''), rerun: rerunOf(0, 0, 5) },
        { ...failure('ACP', 'could not be rerun', 'failed', ''), rerun: rerunOf(0, 0, 5, 'Playwright did not select the case') },
      ]),
      results('darwin', null, [failure('ACP', 'from a job that did not rerun', 'failed', '')]),
    ],
  });
  assert.equal(texts(card)[3], '**没通过的用例（8 条）**');
  assert.deepEqual(texts(card)[4].split('\n'), [
    '同一提交上复跑的结果（只用来判断能不能稳定复现，作业照样算失败）：每次都复现 1 条，时有时无 2 条，复跑都通过 1 条，没有复跑 4 条',
    'Linux · ACP',
    '· [复现 5/5] fails every time：x',
    '· [复现 2/5] fails now and then（超时）：y',
    '· [复现 0/5] passes on every rerun',
    '· [没有复跑：一个作业只复跑前 3 条] comes after the first three：z',
    'macOS · ACP',
    '· [没有复跑] from a job that did not rerun',
    'Windows · ACP',
    '· [复现 1/2，另 3 次没跑完] ran out of time',
    '· [复跑没跑完] never finished a rerun',
    '· [复跑出错] could not be rerun',
  ]);
});

function commit(index, subject = `fix: change number ${index} (#${5600 + index})`) {
  return { sha: `${String(index).padStart(2, '0')}${'c'.repeat(38)}`, subject };
}

const base = { sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', url: 'https://github.com/example/repo/actions/runs/40', event: 'push' };

function sectionOf(card) {
  const start = texts(card).findIndex(text => text.startsWith('**上次全绿以来的提交'));
  return texts(card).slice(start, texts(card).indexOf('hr'));
}

await test('lists the commits since the last run on main that passed, with their pull request numbers, and links to the whole range', () => {
  const commits = [commit(1), commit(2, 'chore: pushed straight to main'), commit(3, `feat: ${'y'.repeat(200)} (#5700)`), ...Array.from({ length: 22 }, (_, index) => commit(index + 4))];
  const card = failureCard({ run, jobs: [job('TUI (optional)', 'failure'), notifyJob], results: [], candidates: { windows: false, base, status: 'ahead', total: 25, commits } });
  const [title, since, list] = sectionOf(card);
  assert.equal(title, '**上次全绿以来的提交（25 个）**');
  assert.equal(since, '从上次全绿的[合并后运行 · a1b2c3d4e](https://github.com/example/repo/actions/runs/40)算起');
  const lines = list.split('\n');
  assert.equal(lines.length, 21);
  assert.deepEqual(lines.slice(0, 4), ['· #5601 fix: change number 1', `· 02ccccccc chore: pushed straight to main`, `· #5700 feat: ${'y'.repeat(114)}…`, '· #5604 fix: change number 4']);
  assert.equal(lines.at(-2), '· #5620 fix: change number 20');
  assert.equal(lines.at(-1), '……另有 5 个提交，完整的列表点「查看这些提交」');
  assert.deepEqual(card.elements.find(element => element.tag === 'action').actions.map(action => [action.text.content, action.url]), [
    ['查看这次运行', run.html_url],
    ['查看这些提交', `https://github.com/example/repo/compare/${base.sha}...${run.head_sha}`],
  ]);
});

await test('says when the range starts at the last nightly run because a Windows job failed, and lists a short range whole', () => {
  const card = failureCard({
    run,
    jobs: [job('Windows tui (optional)', 'failure', [], ['windows-latest']), notifyJob],
    results: [],
    candidates: { windows: true, base: { ...base, event: 'schedule' }, status: 'ahead', total: 2, commits: [commit(1), commit(2)] },
  });
  assert.deepEqual(sectionOf(card), [
    '**上次全绿以来的提交（2 个）**',
    '从上次全绿的[定时运行 · a1b2c3d4e](https://github.com/example/repo/actions/runs/40)算起。有 Windows 作业没通过，合并后运行不跑 Windows，所以只看每晚运行',
    '· #5601 fix: change number 1\n· #5602 fix: change number 2',
  ]);
});

await test('says so instead of listing commits when there is no range to show', () => {
  const jobs = [job('TUI (optional)', 'failure'), notifyJob];
  const section = candidates => sectionOf(failureCard({ run, jobs, results: [], candidates }));
  assert.deepEqual(section({ windows: false, base, status: 'identical', total: 0, commits: [] }), [
    '**上次全绿以来的提交**',
    '上次全绿的[合并后运行 · a1b2c3d4e](https://github.com/example/repo/actions/runs/40)测的就是这个提交，之后没有新提交。',
  ]);
  for (const status of ['behind', 'diverged']) {
    assert.deepEqual(section({ windows: false, base, status, total: 3, commits: [] }), [
      '**上次全绿以来的提交**',
      '上次全绿的[合并后运行 · a1b2c3d4e](https://github.com/example/repo/actions/runs/40)不在这个提交之前，列不出候选提交。',
    ]);
  }
  assert.deepEqual(section({ windows: false }), ['**上次全绿以来的提交**', 'main 上找不到更早的全绿运行，列不出候选提交']);
  assert.deepEqual(section({ windows: true }), ['**上次全绿以来的提交**', 'main 上找不到更早的全绿每晚运行，列不出候选提交']);
  assert.deepEqual(section({ windows: false, error: 'GET repos/example/repo/compare/a...b failed with HTTP 404: Not Found' }), [
    '**上次全绿以来的提交**',
    '没能读到候选提交：GET repos/example/repo/compare/a...b failed with HTTP 404: Not Found',
  ]);
  const card = failureCard({ run, jobs, results: [], candidates: { windows: false, base, status: 'identical', total: 0, commits: [] } });
  assert.equal(card.elements.find(element => element.tag === 'action').actions.length, 1);
});

await test('asks for the last passing push or nightly run before this one, or only nightly runs when a Windows job failed, and the commits since', async () => {
  for (const [jobs, events] of [
    [[job('Desktop (optional, 1/2)', 'failure'), job('Windows web (optional, 1/2)', 'success', [], ['windows-latest']), notifyJob], ['push', 'schedule']],
    [[job('Desktop (optional, 1/2)', 'success'), job('Windows web (optional, 1/2)', 'cancelled', [], ['windows-latest']), notifyJob], ['schedule']],
  ]) {
    const asked = [];
    const posted = [];
    const github = {
      run: async () => run,
      jobs: async () => jobs,
      lastPassingRun: async options => {
        asked.push(['last-pass', options]);
        return base;
      },
      commitsBetween: async (from, to) => {
        asked.push(['commits', from, to]);
        return { status: 'ahead', total: 1, commits: [commit(1)] };
      },
    };
    assert.equal(await notify({ runId: '42', resultsDir: join(tmpdir(), 'e2e-nightly-notify-missing-folder'), github, post: async card => posted.push(card) }), 'posted');
    assert.deepEqual(asked, [
      ['last-pass', { workflow: 427, events, currentRunId: 42, createdBefore: '2026-11-26T20:07:29Z' }],
      ['commits', base.sha, run.head_sha],
    ]);
    assert.ok(texts(posted[0]).includes('**上次全绿以来的提交（1 个）**'));
  }
});

await test('still posts the failures when the candidate commits cannot be read, and says why', async () => {
  const posted = [];
  const github = {
    run: async () => run,
    jobs: async () => [job('ACP (optional)', 'failure'), notifyJob],
    lastPassingRun: async () => {
      throw new Error('GET repos/example/repo/actions/workflows/427/runs failed with HTTP 502: Bad Gateway');
    },
  };
  assert.equal(await notify({ runId: '42', resultsDir: join(tmpdir(), 'e2e-nightly-notify-missing-folder'), github, post: async card => posted.push(card) }), 'posted');
  assert.equal(posted[0].header.title.content, '每晚 E2E 没通过 · 2026-11-27');
  assert.deepEqual(sectionOf(posted[0]), ['**上次全绿以来的提交**', '没能读到候选提交：GET repos/example/repo/actions/workflows/427/runs failed with HTTP 502: Bad Gateway']);
});

await test('reads the last passing run and the commits since it through the same GitHub client', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const body = url.includes('/compare/')
      ? { status: 'ahead', total_commits: 1, commits: [{ sha: 'c1', commit: { message: 'fix: one (#1)\n\nbody' } }] }
      : { workflow_runs: [{ id: 41, event: 'schedule', head_sha: 'aaa', html_url: 'run-41' }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const github = githubClient({ token: 'YOUR_TOKEN', repo: 'example/repo', apiUrl: 'https://api.example.test', fetchImpl });
  assert.deepEqual(await github.lastPassingRun({ workflow: 427, events: ['schedule'], currentRunId: 42, createdBefore: '2026-11-26T20:07:29Z' }), { sha: 'aaa', url: 'run-41', event: 'schedule' });
  assert.deepEqual(await github.commitsBetween('aaa', 'bbb'), { status: 'ahead', total: 1, commits: [{ sha: 'c1', subject: 'fix: one (#1)' }] });
  assert.deepEqual(calls, [
    `https://api.example.test/repos/example/repo/actions/workflows/427/runs?branch=main&status=success&per_page=20&event=schedule&created=${encodeURIComponent('<2026-11-26T20:07:29Z')}`,
    'https://api.example.test/repos/example/repo/compare/aaa...bbb',
  ]);
});
