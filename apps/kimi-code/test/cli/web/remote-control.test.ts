import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatRemoteControlOutput,
  formatRemoteControlStatus,
} from '#/cli/sub/web/remote-control';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Remote Control output', () => {
  const outputOptions = {
    url: 'https://example.test/devices/example-device/?rc=1&from=kimi_code_cli',
    localOrigin: 'http://127.0.0.1:1234',
    localServerToken: 'example-token',
    deviceName: 'example-device',
    qrCode: 'QR\n',
    pngPath: '/tmp/example-qr.png',
  };

  it('shows the full URL as the clickable link text alongside the setup contract', () => {
    vi.stubEnv('FORCE_HYPERLINK', '1');
    const output = formatRemoteControlOutput(outputOptions);
    const url = outputOptions.url;
    expect(output).toContain('Use Kimi Code on this machine');
    expect(output).toContain('1.');
    expect(output).toContain('2.');
    expect(output).toContain('3.');
    expect(output).toContain(`\u001B]8;;${url}`);
    const plain = output
      .replaceAll(/\u001B\]8;;.*?\u0007/g, '')
      .replaceAll(/\u001B\[[0-9;]*m/g, '');
    expect(plain).toContain(`open ${url}`);
    expect(plain).not.toContain('exampl…');
    expect(plain).toContain('http://127.0.0.1:1234/#token=example-token');
    expect(output).toContain('#token=example-token');
    expect(output).toContain('Connected to example.test');
    expect(output).toContain('This device:');
    expect(output).not.toContain('Manage devices');
    expect(output).toContain('PNG:');
    expect(output).toContain('\n    QR');
    expect(output).toContain('grants control of this machine');
    expect(output).toContain('docs');
    expect(output).toContain('feedback');
    expect(output).toContain('Logs: off');
    expect(output).not.toContain('stream-1');
  });

  it('prints the full URL as plain text when the terminal cannot render hyperlinks', () => {
    vi.stubEnv('FORCE_HYPERLINK', '0');
    const output = formatRemoteControlOutput(outputOptions);
    expect(output).toContain(`open ${outputOptions.url}`);
    expect(output).toContain('#token=example-token');
    expect(output).not.toContain('exampl…vice');
    expect(output).not.toContain('Manage devices');
  });

  it('formats relay and device lifecycle states', () => {
    expect(formatRemoteControlStatus('relay_connected').toLowerCase()).toContain('connected');
    expect(formatRemoteControlStatus('relay_disconnected')).toContain('disconnected');
    expect(formatRemoteControlStatus('device_connected').toLowerCase()).toContain('connected');
    expect(formatRemoteControlStatus('device_disconnected')).toContain('disconnected');
  });
});
