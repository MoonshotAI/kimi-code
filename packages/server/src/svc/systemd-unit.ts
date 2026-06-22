

const FORBIDDEN = /[\r\n]/;

function assertNoLineBreaks(value: string, label: string): void {
  if (FORBIDDEN.test(value)) {
    throw new Error(`${label} cannot contain CR or LF characters.`);
  }
}


function systemdEscapeArg(value: string): string {
  assertNoLineBreaks(value, 'Systemd unit values');
  if (!/[\s"\\]/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface BuildSystemdUnitInput {
  description?: string;
  programArguments: readonly string[];
  workingDirectory?: string;

  environment?: Readonly<Record<string, string>>;
}


export function buildSystemdUnit(input: BuildSystemdUnitInput): string {
  const execStart = input.programArguments.map(systemdEscapeArg).join(' ');
  const description = (input.description ?? 'Kimi Code local server').trim();
  assertNoLineBreaks(description, 'Systemd Description');

  const workingDirLine = input.workingDirectory
    ? `WorkingDirectory=${systemdEscapeArg(input.workingDirectory)}`
    : null;

  const envLines = input.environment
    ? Object.entries(input.environment).map(([k, v]) => {
        assertNoLineBreaks(k, 'Systemd environment variable names');
        assertNoLineBreaks(v, 'Systemd environment variable values');
        return `Environment=${systemdEscapeArg(`${k}=${v}`)}`;
      })
    : [];

  const lines = [
    '[Unit]',
    `Description=${description}`,
    'After=network-online.target',
    'Wants=network-online.target',
    'StartLimitBurst=5',
    'StartLimitIntervalSec=60',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execStart}`,
    'Restart=always',
    'RestartSec=5',
    'TimeoutStopSec=30',
    'TimeoutStartSec=30',
    'KillMode=control-group',
    workingDirLine,
    ...envLines,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return lines.filter((line): line is string => line !== null).join('\n');
}

export function parseSystemctlShow(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of output.split(/\r?\n/)) {
    const idx = rawLine.indexOf('=');
    if (idx === -1) continue;
    const key = rawLine.slice(0, idx).trim();
    const value = rawLine.slice(idx + 1);
    if (key.length > 0) {
      result[key] = value;
    }
  }
  return result;
}
