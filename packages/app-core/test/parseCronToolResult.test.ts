import { describe, expect, it } from 'vitest';
import { parseCronCreateResult, parseCronDeleteResult, parseCronListResult } from '../src/lib/parseCronToolResult';

const CREATE_OUTPUT = [
  'id: 01M2WMAWFESMJYTPHQYR5DRK8D\ncron: 7 * * * *\nhumanSchedule: at minute 7 of every hour\nrecurring: true\nnextFireAt: 2026-09-19T19:08:18.306+08:00',
];

const LIST_OUTPUT = [
  'cron_jobs: 2\nid: job-1\ncron: */5 * * * *\nhumanSchedule: every 5 minutes\nprompt: "check the deploy"\nnextFireAt: 2026-09-19T15:44:00.000+08:00\nrecurring: true\nageDays: 0.01\nstale: false\n---\nid: job-2\ncron: 49 18 19 9 *\nhumanSchedule: at 18:49 on day 19 of September\nprompt: "one shot"\nnextFireAt: null\nrecurring: false\nageDays: 1.50\nstale: false',
];

describe('parseCronCreateResult', () => {
  it('parses the created job fields', () => {
    expect(parseCronCreateResult(CREATE_OUTPUT)).toEqual({
      id: '01M2WMAWFESMJYTPHQYR5DRK8D',
      cron: '7 * * * *',
      humanSchedule: 'at minute 7 of every hour',
      recurring: 'true',
      nextFireAt: '2026-09-19T19:08:18.306+08:00',
    });
  });

  it('returns null for unrelated output', () => {
    expect(parseCronCreateResult(['Deleted cron job abc.'])).toBeNull();
    expect(parseCronCreateResult(undefined)).toBeNull();
  });
});

describe('parseCronListResult', () => {
  it('parses the header and job records', () => {
    const result = parseCronListResult(LIST_OUTPUT);
    expect(result?.count).toBe(2);
    expect(result?.jobs).toHaveLength(2);
    expect(result?.jobs[0]).toMatchObject({ id: 'job-1', cron: '*/5 * * * *', prompt: '"check the deploy"', stale: 'false' });
    expect(result?.jobs[1]).toMatchObject({ id: 'job-2', recurring: 'false', nextFireAt: 'null' });
  });

  it('parses an empty list', () => {
    expect(parseCronListResult(['cron_jobs: 0\nNo cron jobs scheduled.'])).toEqual({ count: 0, jobs: [] });
  });

  it('returns null without the header', () => {
    expect(parseCronListResult(CREATE_OUTPUT)).toBeNull();
  });

  it('returns null when a record is missing a field the contract guarantees', () => {
    expect(parseCronListResult(['cron_jobs: 1\nid: job-1'])).toBeNull();
    expect(parseCronListResult(['cron_jobs: 1\nid: job-1\ncron: 0 * * * *\nprompt: "x"'])).toBeNull();
    expect(parseCronListResult(['cron_jobs: 1\nid: job-1\ncron: 0 * * * *\nrecurring: true'])).toBeNull();
    expect(parseCronListResult(['cron_jobs: 1\ncron: 0 * * * *\nprompt: "x"\nrecurring: true'])).toBeNull();
  });

  it('returns null when the record count does not match the header', () => {
    const [first] = LIST_OUTPUT[0]!.split('\n---\n');
    expect(parseCronListResult([`${first}`])).toBeNull();
    expect(parseCronListResult(['cron_jobs: 0\nid: job-1\ncron: 0 * * * *\nprompt: "x"\nrecurring: true'])).toBeNull();
  });
});

describe('parseCronDeleteResult', () => {
  it('parses the deleted job id', () => {
    expect(parseCronDeleteResult(['Deleted cron job 01M2WMAWFESMJYTPHQYR5DRK8D.'])).toEqual({
      id: '01M2WMAWFESMJYTPHQYR5DRK8D',
    });
  });

  it('returns null for error prose and missing output', () => {
    expect(parseCronDeleteResult(['No cron job with id 01M2WMAWFESMJYTPHQYR5DRK8D.'])).toBeNull();
    expect(parseCronDeleteResult(undefined)).toBeNull();
  });
});
