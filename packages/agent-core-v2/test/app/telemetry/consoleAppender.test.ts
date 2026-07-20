import { describe, expect, it } from 'vitest';

import { ConsoleAppender } from '#/app/telemetry/consoleAppender';

describe('ConsoleAppender', () => {
  it('logs event name and properties with the default prefix', () => {
    const lines: string[] = [];
    const appender = new ConsoleAppender({ log: (message) => lines.push(message) });
    appender.track('tool.call', { name: 'bash', count: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[telemetry] tool.call');
    expect(lines[0]).toContain('"name":"bash"');
    expect(lines[0]).toContain('"count":1');
  });

  it('uses a custom prefix', () => {
    const lines: string[] = [];
    const appender = new ConsoleAppender({ prefix: '[dbg]', log: (message) => lines.push(message) });
    appender.track('evt');
    expect(lines[0]).toBe('[dbg] evt');
  });

  it('omits the payload when properties is undefined', () => {
    const lines: string[] = [];
    const appender = new ConsoleAppender({ log: (message) => lines.push(message) });
    appender.track('evt');
    expect(lines[0]).toBe('[telemetry] evt');
  });

  it('pretty-prints properties when requested', () => {
    const lines: string[] = [];
    const appender = new ConsoleAppender({ pretty: true, log: (message) => lines.push(message) });
    appender.track('evt', { a: 1 });
    expect(lines[0]).toContain('\n');
  });
});
