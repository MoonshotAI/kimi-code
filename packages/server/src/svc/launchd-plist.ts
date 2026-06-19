



export const LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS = 10;
export const LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS = 20;

export const LAUNCH_AGENT_UMASK_DECIMAL = 0o077;
export const LAUNCH_AGENT_PROCESS_TYPE = 'Interactive';
export const LAUNCH_AGENT_STDIN_PATH = '/dev/null';

export interface BuildLaunchAgentPlistInput {
  label: string;

  comment?: string;

  programArguments: readonly string[];

  workingDirectory?: string;

  stdoutPath: string;

  stderrPath: string;

  environment?: Readonly<Record<string, string>>;
}

const plistEscape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

function renderEnvDict(env?: Readonly<Record<string, string>>): string {
  if (!env) return '';
  const entries = Object.entries(env);
  if (entries.length === 0) return '';
  const inner = entries
    .map(
      ([k, v]) =>
        `\n      <key>${plistEscape(k)}</key>\n      <string>${plistEscape(v)}</string>`,
    )
    .join('');
  return `\n    <key>EnvironmentVariables</key>\n    <dict>${inner}\n    </dict>`;
}


export function buildLaunchAgentPlist(input: BuildLaunchAgentPlistInput): string {
  const argsXml = input.programArguments
    .map((arg) => `\n      <string>${plistEscape(arg)}</string>`)
    .join('');
  const workingDirXml = input.workingDirectory
    ? `\n    <key>WorkingDirectory</key>\n    <string>${plistEscape(input.workingDirectory)}</string>`
    : '';
  const commentXml = input.comment?.trim()
    ? `\n    <key>Comment</key>\n    <string>${plistEscape(input.comment.trim())}</string>`
    : '';
  const envXml = renderEnvDict(input.environment);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${plistEscape(input.label)}</string>${commentXml}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ExitTimeOut</key>
    <integer>${LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS}</integer>
    <key>ProcessType</key>
    <string>${LAUNCH_AGENT_PROCESS_TYPE}</string>
    <key>ThrottleInterval</key>
    <integer>${LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS}</integer>
    <key>Umask</key>
    <integer>${LAUNCH_AGENT_UMASK_DECIMAL}</integer>
    <key>ProgramArguments</key>
    <array>${argsXml}
    </array>${workingDirXml}
    <key>StandardInPath</key>
    <string>${plistEscape(LAUNCH_AGENT_STDIN_PATH)}</string>
    <key>StandardOutPath</key>
    <string>${plistEscape(input.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${plistEscape(input.stderrPath)}</string>${envXml}
  </dict>
</plist>
`;
}
