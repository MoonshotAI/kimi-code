import { describe, expect, it } from 'vitest';

import { isNotifyUserTool, parseNotifyUserArgs } from '../src/lib/notifyUser';

describe('isNotifyUserTool', () => {
  it('matches the NotifyUser tool name only', () => {
    expect(isNotifyUserTool('NotifyUser')).toBe(true);
    expect(isNotifyUserTool('notifyuser')).toBe(true);
    expect(isNotifyUserTool('Agent')).toBe(false);
    expect(isNotifyUserTool('AskUserQuestion')).toBe(false);
  });
});

describe('parseNotifyUserArgs', () => {
  it('reads the title and the message', () => {
    expect(
      parseNotifyUserArgs(JSON.stringify({ title: '  Root cause found ', message: ' Two refreshes reuse one token. ' })),
    ).toEqual({ title: 'Root cause found', message: 'Two refreshes reuse one token.' });
  });

  it('derives a title from the first line of an update posted without one', () => {
    expect(
      parseNotifyUserArgs(
        JSON.stringify({ message: '\n**Login module is clean.**\n\nThe bug must be in session expiry.' }),
      ),
    ).toEqual({ title: 'Login module is clean.', message: 'The bug must be in session expiry.' });
    expect(parseNotifyUserArgs(JSON.stringify({ message: '- Checked the parser' }))).toEqual({
      title: 'Checked the parser',
      message: '- Checked the parser',
    });
  });

  it('returns an empty update for arguments that are still streaming or malformed', () => {
    expect(parseNotifyUserArgs('{"title": "Root ca')).toEqual({ title: '', message: '' });
    expect(parseNotifyUserArgs('[]')).toEqual({ title: '', message: '' });
    expect(parseNotifyUserArgs('null')).toEqual({ title: '', message: '' });
    expect(parseNotifyUserArgs('{}')).toEqual({ title: '', message: '' });
    expect(parseNotifyUserArgs(JSON.stringify({ title: 42, message: '   ' }))).toEqual({
      title: '',
      message: '',
    });
  });
});
