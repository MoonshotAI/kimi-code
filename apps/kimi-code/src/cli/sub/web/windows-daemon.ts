import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';

const WINDOWS_IPC_KEY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$root = [Environment]::GetFolderPath('LocalApplicationData')
if (-not $root) { throw 'The Windows user profile is unavailable' }
$directory = [IO.Path]::Combine($root, 'KimiCode.SshIpc')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$security = [Security.AccessControl.DirectorySecurity]::new()
$security.SetSecurityDescriptorSddlForm("O:$($sid.Value)D:P(A;OICI;FA;;;$($sid.Value))")
[void][IO.Directory]::CreateDirectory($directory, $security)
if ([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) {
  throw 'The Windows IPC key directory is a reparse point'
}
$acl = [IO.Directory]::GetAccessControl($directory)
$rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sid -or
    $rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or
    $rules[0].AccessControlType -ne 'Allow') {
  throw 'The Windows IPC key directory must be private to the current user'
}
$path = [IO.Path]::Combine($directory, [Console]::In.ReadToEnd() + '.key')
if (-not [IO.File]::Exists($path)) {
  $key = [byte[]]::new(32)
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($key) } finally { $random.Dispose() }
  $temp = [IO.Path]::Combine($directory, [IO.Path]::GetRandomFileName())
  try {
    [IO.File]::WriteAllBytes($temp, $key)
    try { [IO.File]::Move($temp, $path) } catch [IO.IOException] {
      if (-not [IO.File]::Exists($path)) { throw }
    }
  } finally { [IO.File]::Delete($temp) }
}
[Console]::Write([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)))
`;

const WINDOWS_DAEMON_LAUNCH_SCRIPT = `
$ErrorActionPreference = 'Stop'
$command = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$environment = [Environment]::GetEnvironmentVariables()
$environment.Remove('SSH_AUTH_SOCK')
$entries = [string[]] @($environment.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
$startup = New-CimInstance -CimClass (Get-CimClass -ClassName Win32_ProcessStartup) -Property @{CreateFlags=16778240; ShowWindow=0; EnvironmentVariables=$entries} -ClientOnly
$result = Invoke-CimMethod -ClassName Win32_Process -Name Create -Arguments @{CommandLine=$command; CurrentDirectory=[Environment]::CurrentDirectory; ProcessStartupInformation=$startup}
if ($result.ReturnValue -ne 0) { throw "kimi server failed to start with CIM error $($result.ReturnValue)" }
`;

function windowsPowerShell(): string {
  const root = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows';
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(windowsPowerShell(), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ], { timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(stderr.trim() || error.code?.toString() || 'PowerShell failed'));
        return;
      }
      resolve(stdout);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

export async function loadWindowsIpcKey(socketPath: string): Promise<Buffer> {
  const keyId = createHash('sha256').update(socketPath).digest('hex');
  const output = await runPowerShell(WINDOWS_IPC_KEY_SCRIPT, keyId);
  const key = Buffer.from(output, 'base64');
  if (key.length !== 32 || key.toString('base64') !== output) {
    throw new Error('Invalid Windows IPC key');
  }
  return key;
}

export function windowsDaemonCommandLine(argv: readonly string[], logPath: string): string {
  const literal = (value: string) => `'${value.replaceAll(/['‘’]/g, '$&$&')}'`;
  const daemonScript = `$ErrorActionPreference = 'Stop'; & ${argv.map(literal).join(' ')} *> ${literal(logPath)}`;
  const escapedScript = daemonScript.replace(/(\\*)"/g, '$1$1\\"');
  return `"${windowsPowerShell()}" -NoLogo -NoProfile -NonInteractive -Command "${escapedScript}"`;
}

export async function spawnWindowsDaemon(argv: readonly string[], logPath: string): Promise<void> {
  const command = windowsDaemonCommandLine(argv, logPath);
  await runPowerShell(WINDOWS_DAEMON_LAUNCH_SCRIPT, Buffer.from(command, 'utf16le').toString('base64'));
}
