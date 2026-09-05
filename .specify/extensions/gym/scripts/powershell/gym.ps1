# GYM runner dispatcher (PowerShell). Locates Node and routes to the right script.
#   gym.ps1 init | run | warmup | gate | drop [args]
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "GYM requires Node.js on PATH. Install Node >= 18 and retry."
  exit 1
}

if ($args.Count -gt 0 -and $args[0] -eq 'drop') {
  $rest = $args[1..($args.Count - 1)]
  & node (Join-Path $ScriptDir '..\drop.mjs') @rest
} elseif ($args.Count -gt 0 -and ($args[0] -eq 'init' -or $args[0] -eq 'run' -or $args[0] -eq 'warmup' -or $args[0] -eq 'gate')) {
  & node (Join-Path $ScriptDir '..\gym-runner.mjs') @args
} else {
  Write-Error "Usage: gym.ps1 [init|run|warmup|gate|drop]"
  exit 1
}
