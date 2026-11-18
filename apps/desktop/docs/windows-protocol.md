# Windows protocol registration

Stable NSIS installers register `kimi-code://` before the first application launch.
The command quotes both the executable path and URL argument. Uninstall removes
the association only if it still points at that installation. All-user installs
also update the installing user's association so an older per-user entry does
not mask the machine entry.

Canary and Preview installers omit these hooks, and their applications skip
runtime registration. Stable application startup retains its registration repair.

The native regression test compiles the production hooks into small NSIS
executables and exercises installation, relocation and uninstall against a unique
temporary HKCU protocol key. It does not launch the application or modify the
real `kimi-code` association. It requires Windows and an NSIS compiler:

```powershell
$env:KIMI_NSIS_PATH = 'C:\path\to\NSIS\Bin\makensis.exe'
pnpm --filter kimi-code-app test tests/main/app/protocol-registration.test.ts tests/main/app/deep-link.test.ts
```

Without `KIMI_NSIS_PATH`, the native lifecycle test is skipped; configuration and
runtime channel tests still run. The native fixture covers per-user installation;
elevated all-user installation requires separate manual verification.
