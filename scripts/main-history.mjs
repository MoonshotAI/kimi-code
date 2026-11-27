export async function lastPassingRun({ get, repo, workflow, events, currentRunId, createdBefore }) {
  const filters = ['branch=main', 'status=success', 'per_page=20'];
  if (events.length === 1) filters.push(`event=${events[0]}`);
  if (createdBefore !== undefined) filters.push(`created=${encodeURIComponent(`<${createdBefore}`)}`);
  const { workflow_runs: runs } = await get(`repos/${repo}/actions/workflows/${workflow}/runs?${filters.join('&')}`);
  const run = runs.find(entry => String(entry.id) !== String(currentRunId) && events.includes(entry.event));
  return run === undefined ? undefined : { sha: run.head_sha, url: run.html_url, event: run.event };
}

export async function commitsBetween({ get, repo, base, head }) {
  const { status, total_commits: total, commits } = await get(`repos/${repo}/compare/${base}...${head}`);
  return {
    status,
    total: total ?? commits.length,
    commits: commits.map(entry => ({ sha: entry.sha, subject: entry.commit.message.split('\n')[0] })),
  };
}
