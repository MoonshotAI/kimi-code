/**
 * `tools` domain — Windows Git Bash pre-process fixes for the Bash tool (v2
 * port of `packages/agent-core/src/tools/support/windows-bash-fix.ts`).
 *
 * Before `bash -c` runs on Windows the fixer rewrites Windows-isms the model
 * tends to emit, using the pure `@moonshot-ai/tree-sitter-bash` parser as a
 * shell-aware front end:
 *
 *   1. unquoted Windows backslash paths (`D:\repo\src`, `src\a.py`, `\\server\share\x`,
 *      `~\Desktop`, `.\build\a`) to the forward-slash spellings Git Bash
 *      understands — a blanket quote-aware conversion (reference
 *      `_prepare_bash_cmd`) rewrites every unquoted `\X` pair to `/X` while
 *      quoted text, heredoc data, command names and `\`-escaped metacharacters
 *      stay byte-for-byte;
 *   2. guarded fallback function definitions for commands Git Bash lacks
 *      (`rev`, `tree`, `zip`, `tasklist`, `copy`, ...) prepended to the
 *      command, delegating to the native binary when one exists — the bodies
 *      are byte-for-byte ports of kimi-agent `bash_fix.py` `_FALLBACK_BODIES`
 *      (the embedded perl / PowerShell delegate snippets must stay exact), and
 *      `pip3` / `python3` are additionally guarded against the Microsoft Store
 *      App Execution Alias stubs in `WindowsApps`, which satisfy `command -v`
 *      but print an install prompt instead of running the tool, so those
 *      fallbacks are defined even when `command -v` succeeds and never
 *      delegate to a stub path;
 *   3. the cmd.exe-only `cd /d <path>` form loses its flag;
 *   4. the existing `>nul` → `>/dev/null` redirect rewrite (context-free
 *      regex, applied to the final assembled command);
 *   5. the `MSYSTEM` variable the Git Bash launcher injects is neutralized
 *      (`export MSYSTEM=; ` prefix) so build tools detect the true Windows
 *      MSVC environment instead of defaulting to the mingw platform.
 *
 * Anything other than a `win32` platform passes through byte-for-byte.
 * Commands the parser cannot analyze — budget aborts (`{ ok: false }`) and
 * degraded error trees (`hasError: true`) — are also returned unchanged, so a
 * malformed command reaches Bash with its original syntax error intact.
 *
 * Out of scope (deferred from the reference port): the interactive-shell
 * compatibility prelude (the Bash tool is one-shot `bash -c`), Git Bash install
 * detection and the bash smoke-test probe (the shell path is resolved by the
 * environment probe).
 */

import { existsSync } from 'node:fs';
import { parse, type SyntaxNode } from '@moonshot-ai/tree-sitter-bash';

export interface BashFixResult {
  readonly command: string;
  readonly replacements: readonly string[];
  readonly pathChanges: readonly string[];
  readonly changed: boolean;
}

const FALLBACK_BODIES: Readonly<Record<string, string>> = {
"chdir":  "cd -- \"$@\"",
"cls":  "clear",
"column":  "local __kimix_sep='DEFAULT'; while (( $# )); do case $1 in -t) shift;; -s) __kimix_sep=$2; shift 2;; -s?*) __kimix_sep=${1#-s}; shift;; -*) printf '%s\\n' \"column: unsupported option for perl fallback: $1\" >&2; return 1;; *) break;; esac; done; perl -e 'my $sep = shift @ARGV; $sep = qr/\\s+/ if $sep eq \"DEFAULT\"; my @rows; my @max; while (<>) { chomp; my @c = split $sep; push @rows, \\@c; for my $i (0..$#c) { $max[$i] = length($c[$i]) if !defined $max[$i] || length($c[$i]) > $max[$i]; } } for my $r (@rows) { print join(\"  \", map { sprintf(\"%-*s\", $max[$_]//0, $r->[$_]) } 0..$#$r), \"\\n\"; }' \"$__kimix_sep\" \"$@\"",
"copy":  "if [[ $# -lt 2 ]]; then printf '%s\\n' 'copy: missing source or destination' >&2; return 1; fi; cp -R -- \"$@\"",
"del":  "rm -- \"$@\"",
"erase":  "rm -- \"$@\"",
"fc":  "diff \"$@\"",
"findstr":  "grep \"$@\"",
"gawk":  "awk \"$@\"",
"gcat":  "cat \"$@\"",
"gcomm":  "comm \"$@\"",
"gcp":  "cp \"$@\"",
"gcut":  "cut \"$@\"",
"gdate":  "date \"$@\"",
"gdf":  "df \"$@\"",
"gdu":  "du \"$@\"",
"gegrep":  "egrep \"$@\"",
"gfgrep":  "fgrep \"$@\"",
"gfind":  "find \"$@\"",
"ggrep":  "grep \"$@\"",
"ghead":  "head \"$@\"",
"gjoin":  "join \"$@\"",
"gln":  "ln \"$@\"",
"gls":  "ls \"$@\"",
"gmake":  "make \"$@\"",
"gmkdir":  "mkdir \"$@\"",
"gmv":  "mv \"$@\"",
"gpaste":  "paste \"$@\"",
"greadlink":  "readlink \"$@\"",
"grealpath":  "realpath \"$@\"",
"grm":  "rm \"$@\"",
"grmdir":  "rmdir \"$@\"",
"gsed":  "sed \"$@\"",
"gseq":  "seq \"$@\"",
"gshuf":  "shuf \"$@\"",
"gsort":  "sort \"$@\"",
"gsplit":  "split \"$@\"",
"gstat":  "stat \"$@\"",
"gtail":  "tail \"$@\"",
"gtar":  "tar \"$@\"",
"gtimeout":  "timeout \"$@\"",
"gtr":  "tr \"$@\"",
"guniq":  "uniq \"$@\"",
"gwc":  "wc \"$@\"",
"gxargs":  "xargs \"$@\"",
"killall":  "if [[ $# -eq 0 ]]; then printf '%s\\n' 'killall: missing process name' >&2; return 1; fi; __KIMIX_NAME=$1 powershell.exe -NoProfile -NonInteractive -Command '$procs = Get-Process | Where-Object { $_.Name -eq $env:__KIMIX_NAME }; if ($procs) { $procs | Stop-Process -Force; exit 0 } else { exit 1 }'",
"md":  "mkdir -p -- \"$@\"",
"mklink":  "local __kimix_hard=0 __kimix_link='' __kimix_target=''; while (( $# )); do case $1 in /D|/d|/J|/j) shift;; /H|/h) __kimix_hard=1; shift;; *) if [[ -z $__kimix_link ]]; then __kimix_link=$1; elif [[ -z $__kimix_target ]]; then __kimix_target=$1; else printf '%s\\n' 'mklink: too many arguments' >&2; return 1; fi; shift;; esac; done; if [[ -z $__kimix_link || -z $__kimix_target ]]; then printf '%s\\n' 'mklink: missing link name or target' >&2; return 1; fi; if (( __kimix_hard )); then ln -f -- \"$__kimix_target\" \"$__kimix_link\"; else ln -s -- \"$__kimix_target\" \"$__kimix_link\"; fi",
"move":  "if [[ $# -lt 2 ]]; then printf '%s\\n' 'move: missing source or destination' >&2; return 1; fi; mv -- \"$@\"",
"nc":  "local __kimix_z=0 __kimix_v=0 __kimix_w='' __kimix_host='' __kimix_port=''; while (( $# )); do case $1 in -z) __kimix_z=1; shift;; -v) __kimix_v=1; shift;; -zv|-vz) __kimix_z=1; __kimix_v=1; shift;; -w) __kimix_w=$2; shift 2;; -w?*) __kimix_w=${1#-w}; shift;; -*) printf '%s\\n' \"nc: unsupported option for /dev/tcp fallback: $1\" >&2; return 1;; *) if [[ -z $__kimix_host ]]; then __kimix_host=$1; elif [[ -z $__kimix_port ]]; then __kimix_port=$1; else printf '%s\\n' 'nc: too many arguments' >&2; return 1; fi; shift;; esac; done; if (( ! __kimix_z )); then printf '%s\\n' 'nc: only -z (zero-I/O scan) mode is supported by this fallback' >&2; return 1; fi; if [[ -z $__kimix_host || -z $__kimix_port ]]; then printf '%s\\n' 'nc: missing host or port' >&2; return 1; fi; if [[ -n $__kimix_w ]]; then timeout \"$__kimix_w\" bash -c 'exec 3<>/dev/tcp/$1/$2' _ \"$__kimix_host\" \"$__kimix_port\" 2>/dev/null; else (exec 3<>/dev/tcp/\"$__kimix_host\"/\"$__kimix_port\") 2>/dev/null; fi; local __kimix_rc=$?; (( __kimix_rc != 0 )) && __kimix_rc=1; if (( __kimix_rc == 0 )); then (( __kimix_v )) && printf '%s\\n' \"Connection to $__kimix_host $__kimix_port port [tcp/*] succeeded!\" >&2; else (( __kimix_v )) && printf '%s\\n' \"nc: connect to $__kimix_host port $__kimix_port (tcp) failed\" >&2; fi; return $__kimix_rc",
"netcat":  "local __kimix_z=0 __kimix_v=0 __kimix_w='' __kimix_host='' __kimix_port=''; while (( $# )); do case $1 in -z) __kimix_z=1; shift;; -v) __kimix_v=1; shift;; -zv|-vz) __kimix_z=1; __kimix_v=1; shift;; -w) __kimix_w=$2; shift 2;; -w?*) __kimix_w=${1#-w}; shift;; -*) printf '%s\\n' \"nc: unsupported option for /dev/tcp fallback: $1\" >&2; return 1;; *) if [[ -z $__kimix_host ]]; then __kimix_host=$1; elif [[ -z $__kimix_port ]]; then __kimix_port=$1; else printf '%s\\n' 'nc: too many arguments' >&2; return 1; fi; shift;; esac; done; if (( ! __kimix_z )); then printf '%s\\n' 'nc: only -z (zero-I/O scan) mode is supported by this fallback' >&2; return 1; fi; if [[ -z $__kimix_host || -z $__kimix_port ]]; then printf '%s\\n' 'nc: missing host or port' >&2; return 1; fi; if [[ -n $__kimix_w ]]; then timeout \"$__kimix_w\" bash -c 'exec 3<>/dev/tcp/$1/$2' _ \"$__kimix_host\" \"$__kimix_port\" 2>/dev/null; else (exec 3<>/dev/tcp/\"$__kimix_host\"/\"$__kimix_port\") 2>/dev/null; fi; local __kimix_rc=$?; (( __kimix_rc != 0 )) && __kimix_rc=1; if (( __kimix_rc == 0 )); then (( __kimix_v )) && printf '%s\\n' \"Connection to $__kimix_host $__kimix_port port [tcp/*] succeeded!\" >&2; else (( __kimix_v )) && printf '%s\\n' \"nc: connect to $__kimix_host port $__kimix_port (tcp) failed\" >&2; fi; return $__kimix_rc",
"open":  "start \"$@\"",
"pbcopy":  "clip.exe \"$@\"",
"pbpaste":  "powershell.exe -NoProfile -NonInteractive -Command '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;[Console]::Out.Write((Get-Clipboard -Raw))' \"$@\"",
"pgrep":  "local __kimix_list=0 __kimix_full=0 __kimix_pat=''; while (( $# )); do case $1 in -l) __kimix_list=1; shift;; -f) __kimix_full=1; shift;; -lf|-fl) __kimix_list=1; __kimix_full=1; shift;; --) shift; break;; -*) printf '%s\\n' \"pgrep: unsupported option for Get-Process fallback: $1\" >&2; return 1;; *) __kimix_pat=$1; shift;; esac; done; if [[ -z $__kimix_pat ]]; then printf '%s\\n' 'pgrep: missing pattern' >&2; return 1; fi; if (( __kimix_full )); then __KIMIX_PAT=$__kimix_pat __KIMIX_LIST=$__kimix_list powershell.exe -NoProfile -NonInteractive -Command '$m = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $env:__KIMIX_PAT }; if ($m) { $m | ForEach-Object { if ($env:__KIMIX_LIST -eq \"1\") { \"$($_.ProcessId) $($_.Name)\" } else { $_.ProcessId } }; exit 0 } else { exit 1 }'; else __KIMIX_PAT=$__kimix_pat __KIMIX_LIST=$__kimix_list powershell.exe -NoProfile -NonInteractive -Command '$m = Get-Process | Where-Object { $_.Name -match $env:__KIMIX_PAT }; if ($m) { $m | ForEach-Object { if ($env:__KIMIX_LIST -eq \"1\") { \"$($_.Id) $($_.Name)\" } else { $_.Id } }; exit 0 } else { exit 1 }'; fi",
"pidof":  "if [[ $# -eq 0 ]]; then printf '%s\\n' 'pidof: missing process name' >&2; return 1; fi; __KIMIX_NAME=$1 powershell.exe -NoProfile -NonInteractive -Command '$ids = (Get-Process | Where-Object { $_.Name -eq $env:__KIMIX_NAME }).Id; if ($ids) { $ids -join \" \"; exit 0 } else { exit 1 }'",
"pip3":  "pip \"$@\"",
"pkill":  "local __kimix_full=0 __kimix_pat=''; while (( $# )); do case $1 in -f) __kimix_full=1; shift;; --) shift; break;; -*) printf '%s\\n' \"pkill: unsupported option for Stop-Process fallback: $1\" >&2; return 1;; *) __kimix_pat=$1; shift;; esac; done; if [[ -z $__kimix_pat ]]; then printf '%s\\n' 'pkill: missing pattern' >&2; return 1; fi; if (( __kimix_full )); then __KIMIX_PAT=$__kimix_pat powershell.exe -NoProfile -NonInteractive -Command '$m = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $env:__KIMIX_PAT }; if ($m) { $m | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; exit 0 } else { exit 1 }'; else __KIMIX_PAT=$__kimix_pat powershell.exe -NoProfile -NonInteractive -Command '$m = Get-Process | Where-Object { $_.Name -match $env:__KIMIX_PAT }; if ($m) { $m | Stop-Process -Force; exit 0 } else { exit 1 }'; fi",
"python3":  "python \"$@\"",
"rd":  "rmdir -- \"$@\"",
"ren":  "if [[ $# -ne 2 ]]; then printf '%s\\n' 'ren: exactly two arguments required' >&2; return 1; fi; mv -- \"$1\" \"$2\"",
"rename":  "if [[ $# -ne 2 ]]; then printf '%s\\n' 'rename: exactly two arguments required' >&2; return 1; fi; mv -- \"$1\" \"$2\"",
"rev":  "local __kimix_zero=0; while (( $# )); do case $1 in -0|--zero) __kimix_zero=1; shift;; --) shift; break;; -*) printf '%s\\n' \"rev: unsupported option: $1\" >&2; return 1;; *) break;; esac; done; perl '-Mopen=:std,:encoding(UTF-8)' -e 'my $zero = shift @ARGV; my $failed = 0; sub reverse_fh { my ($fh, $zero) = @_; local $/ = $zero ? qq(\\0) : qq(\\n); while (my $record = <$fh>) { my $ended = $zero ? $record =~ s/\\0\\z// : $record =~ s/\\r?\\n\\z//; print scalar reverse($record); print($zero ? qq(\\0) : qq(\\n)) if $ended } } if (@ARGV) { for my $file (@ARGV) { if (open my $fh, q(<:encoding(UTF-8)), $file) { reverse_fh($fh, $zero); close $fh } else { warn qq(rev: $file: $!\\n); $failed = 1 } } } else { reverse_fh(*STDIN, $zero) } exit $failed' -- \"$__kimix_zero\" \"$@\"",
"say":  "while (( $# )); do case $1 in -*) printf '%s\\n' \"say: unsupported option for SAPI fallback: $1\" >&2; return 1;; *) shift;; esac; done; __KIMIX_SAY_TEXT=$* powershell.exe -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($env:__KIMIX_SAY_TEXT)'",
"systeminfo":  "powershell.exe -NoProfile -NonInteractive -Command 'Get-ComputerInfo | Format-List'",
"taskkill":  "local __kimix_force=0 __kimix_pid='' __kimix_im=''; while (( $# )); do case $1 in /F|/f) __kimix_force=1; shift;; /IM|/im) __kimix_im=$2; shift 2;; /PID|/pid) __kimix_pid=$2; shift 2;; /*) printf '%s\\n' \"taskkill: unsupported option: $1\" >&2; return 1;; *) printf '%s\\n' \"taskkill: unsupported argument: $1\" >&2; return 1;; esac; done; if [[ -n $__kimix_pid ]]; then __KIMIX_FORCE=$__kimix_force __KIMIX_PID=$__kimix_pid powershell.exe -NoProfile -NonInteractive -Command '$force = $env:__KIMIX_FORCE -eq '1'; if ($env:__KIMIX_PID) { Stop-Process -Id $env:__KIMIX_PID -Force:$force; exit 0 } $procs = Get-Process | Where-Object { $_.Name -eq $env:__KIMIX_IM }; if ($procs) { $procs | Stop-Process -Force:$force; exit 0 } else { exit 1 }'; elif [[ -n $__kimix_im ]]; then __KIMIX_FORCE=$__kimix_force __KIMIX_IM=$__kimix_im powershell.exe -NoProfile -NonInteractive -Command '$force = $env:__KIMIX_FORCE -eq '1'; if ($env:__KIMIX_PID) { Stop-Process -Id $env:__KIMIX_PID -Force:$force; exit 0 } $procs = Get-Process | Where-Object { $_.Name -eq $env:__KIMIX_IM }; if ($procs) { $procs | Stop-Process -Force:$force; exit 0 } else { exit 1 }'; else printf '%s\\n' 'taskkill: missing /PID or /IM' >&2; return 1; fi",
"tasklist":  "powershell.exe -NoProfile -NonInteractive -Command 'Get-Process | Select-Object Name, Id, CPU, WorkingSet | Format-Table -AutoSize'",
"traceroute":  "local -a __kimix_args=(); while (( $# )); do case $1 in -n) __kimix_args+=(-d); shift;; -m) __kimix_args+=(-h \"$2\"); shift 2;; -m?*) __kimix_args+=(-h \"${1#-m}\"); shift;; --max-hop=*) __kimix_args+=(-h \"${1#*=}\"); shift;; -w) __kimix_args+=(-w \"$(( $2 * 1000 ))\"); shift 2;; -w?*) __kimix_args+=(-w \"$(( ${1#-w} * 1000 ))\"); shift;; -*) printf '%s\\n' \"traceroute: unsupported option for tracert fallback: $1\" >&2; return 1;; *) __kimix_args+=(\"$1\"); shift;; esac; done; tracert \"${__kimix_args[@]}\"",
"tree":  "local __kimix_depth=0 __kimix_all=0 __kimix_dirs=0 __kimix_noreport=0 __kimix_dir=''; while (( $# )); do case $1 in -L) __kimix_depth=$2; shift 2;; -L?*) __kimix_depth=${1#-L}; shift;; -a) __kimix_all=1; shift;; -d) __kimix_dirs=1; shift;; --noreport) __kimix_noreport=1; shift;; --) shift; break;; -*) printf '%s\\n' \"tree: unsupported option for perl fallback: $1\" >&2; return 1;; *) __kimix_dir=$1; shift;; esac; done; [[ -n $__kimix_dir ]] || __kimix_dir=.; perl -e 'my ($maxdepth,$showall,$dirsonly,$noreport,$top)=@ARGV; print qq($top\\n); my ($ndirs,$nfiles)=(0,0); sub walk { my ($path,$prefix,$depth)=@_; return if $maxdepth && $depth>$maxdepth; opendir(my $dh,$path) or return; my @e = grep { ! /^[.][.]?$/ } readdir($dh); closedir($dh); @e = grep { $showall || ! /^[.]/ } @e; @e = grep { ! $dirsonly || -d qq($path/$_) } @e; @e = sort { lc($a) cmp lc($b) } @e; my $n=@e; my $i=0; for my $e (@e) { $i++; my $last = $i==$n; my $full = qq($path/$e); my $isdir = -d $full; if ($isdir) { $ndirs++ } else { $nfiles++ } print $prefix, ($last ? qq(`-- ) : qq(|-- )), $e, qq(\\n); walk($full, $prefix . ($last ? qq(    ) : qq(|   )), $depth+1) if $isdir && ! -l $full } } walk($top,q(),1); my $dw = $ndirs==1 ? q(directory) : q(directories); my $fw = $nfiles==1 ? q(file) : q(files); print qq(\\n$ndirs $dw, $nfiles $fw\\n) unless $noreport' -- \"$__kimix_depth\" \"$__kimix_all\" \"$__kimix_dirs\" \"$__kimix_noreport\" \"$__kimix_dir\"",
"watch":  "local __kimix_interval=2; while (( $# )); do case $1 in -n) __kimix_interval=$2; shift 2;; -n?*) __kimix_interval=${1#-n}; shift;; -t|-d|--no-title|--color) shift;; --) shift; break;; -*) printf '%s\\n' \"watch: unsupported option: $1\" >&2; return 1;; *) break;; esac; done; if [[ $# -eq 0 ]]; then printf '%s\\n' 'watch: missing command' >&2; return 1; fi; while true; do clear; \"$@\"; sleep \"$__kimix_interval\"; done",
"wget":  "local __kimix_url='' __kimix_out='' __kimix_stdout=0; local -a __kimix_args=(); while (( $# )); do case $1 in -O|--output-document) __kimix_out=$2; shift 2;; -O?*) __kimix_out=${1#-O}; shift;; --output-document=*) __kimix_out=${1#*=}; shift;; -q|--quiet) __kimix_args+=(-s); shift;; -c|--continue) __kimix_args+=(-C -); shift;; --no-check-certificate) __kimix_args+=(-k); shift;; -T|--timeout) __kimix_args+=(--max-time \"$2\"); shift 2;; --timeout=*) __kimix_args+=(--max-time \"${1#*=}\"); shift;; -*) printf '%s\\n' \"wget: unsupported option for curl fallback: $1\" >&2; return 1;; *) __kimix_url=$1; shift;; esac; done; if [[ -z $__kimix_url ]]; then printf '%s\\n' 'wget: missing URL' >&2; return 1; fi; if [[ $__kimix_out == '-' ]]; then __kimix_stdout=1; fi; if [[ -z $__kimix_out && $__kimix_stdout -eq 0 ]]; then __kimix_out=${__kimix_url##*/}; [[ -n $__kimix_out ]] || __kimix_out=index.html; fi; if (( __kimix_stdout )); then curl -fSL \"${__kimix_args[@]}\" -- \"$__kimix_url\"; else curl -fSL \"${__kimix_args[@]}\" -o \"$__kimix_out\" -- \"$__kimix_url\"; fi",
"where":  "which \"$@\"",
"wl-copy":  "while (( $# )); do case $1 in -*) printf '%s\\n' \"wl-copy: unsupported option for clipboard fallback: $1\" >&2; return 1;; *) shift;; esac; done; clip.exe",
"wl-paste":  "while (( $# )); do case $1 in -n|--no-newline) shift;; -*) printf '%s\\n' \"wl-paste: unsupported option for clipboard fallback: $1\" >&2; return 1;; *) shift;; esac; done; powershell.exe -NoProfile -NonInteractive -Command '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;[Console]::Out.Write((Get-Clipboard -Raw))'",
"xclip":  "local __kimix_out=0; while (( $# )); do case $1 in -o|-out) __kimix_out=1; shift;; -i|-in) shift;; -selection|-d|-display) shift 2;; -selection*|-display*) shift;; -*) printf '%s\\n' \"xclip: unsupported option for clipboard fallback: $1\" >&2; return 1;; *) shift;; esac; done; if (( __kimix_out )); then powershell.exe -NoProfile -NonInteractive -Command '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;[Console]::Out.Write((Get-Clipboard -Raw))'; else clip.exe; fi",
"xcopy":  "cp -r -- \"$@\"",
"xdg-open":  "start \"$@\"",
"xsel":  "local __kimix_out=0; while (( $# )); do case $1 in --output) __kimix_out=1; shift;; --input|--clipboard|--primary|--secondary) shift;; --*) printf '%s\\n' \"xsel: unsupported option for clipboard fallback: $1\" >&2; return 1;; -*) case $1 in *o*) __kimix_out=1;; esac; shift;; *) shift;; esac; done; if (( __kimix_out )); then powershell.exe -NoProfile -NonInteractive -Command '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;[Console]::Out.Write((Get-Clipboard -Raw))'; else clip.exe; fi",
"zip":  "local __kimix_archive='' __kimix_level=Optimal __kimix_p='' __kimix_combo='' __kimix_i=0; local -a __kimix_paths=() __kimix_wpaths=() __kimix_split=(); while (( $# )); do if [[ $1 == -[!-]* && ${#1} -gt 2 ]]; then __kimix_combo=${1#-}; __kimix_split=(); shift; for (( __kimix_i=0; __kimix_i<${#__kimix_combo}; __kimix_i++ )); do __kimix_split+=(-${__kimix_combo:__kimix_i:1}); done; set -- \"${__kimix_split[@]}\" \"$@\"; continue; fi; case $1 in -r|-R|--recurse-paths|-q|--quiet) shift;; -0) __kimix_level=NoCompression; shift;; -1) __kimix_level=Fastest; shift;; -[2-9]) shift;; -*) printf '%s\\n' \"zip: unsupported option for Compress-Archive fallback: $1\" >&2; return 1;; *) if [[ -z $__kimix_archive ]]; then __kimix_archive=$1; else __kimix_paths+=(\"$1\"); fi; shift;; esac; done; if [[ -z $__kimix_archive || ${#__kimix_paths[@]} -eq 0 ]]; then printf '%s\\n' 'zip: missing archive name or input paths' >&2; return 1; fi; for __kimix_p in \"${__kimix_paths[@]}\"; do __kimix_wpaths+=(\"$(cygpath -w -- \"$__kimix_p\")\"); done; __kimix_archive=$(cygpath -w -- \"$__kimix_archive\"); __KIMIX_ZIP_LEVEL=$__kimix_level __KIMIX_ZIP_DEST=$__kimix_archive __KIMIX_ZIP_PATHS=$(printf '%s\\n' \"${__kimix_wpaths[@]}\") powershell.exe -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem; $level = [System.IO.Compression.CompressionLevel]$env:__KIMIX_ZIP_LEVEL; $dest = $env:__KIMIX_ZIP_DEST; if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }; $zip = [System.IO.Compression.ZipFile]::Open($dest, [System.IO.Compression.ZipArchiveMode]::Create); foreach ($p in ($env:__KIMIX_ZIP_PATHS -split \"`n\")) { $item = Get-Item -LiteralPath $p; $base = $item.Name; if ($item.PSIsContainer) { $root = $item.FullName; Get-ChildItem -LiteralPath $root -Recurse -Force | ForEach-Object { $rel = $_.FullName.Substring($root.Length).TrimStart(\"\\\") -replace \"\\\\\", \"/\"; if ($_.PSIsContainer) { $zip.CreateEntry($base + \"/\" + $rel + \"/\") | Out-Null } else { [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $base + \"/\" + $rel, $level) | Out-Null } } } else { [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $item.FullName, $base, $level) | Out-Null } }; $zip.Dispose(); if (Test-Path -LiteralPath $dest) { exit 0 } else { exit 1 }'",
};

const STUB_AWARE_FALLBACKS: ReadonlySet<string> = new Set(['pip3', 'python3']);

function nativeDelegate(name: string): string {
  return (
    `local __kimix_native=''; __kimix_native=$(type -P ${name}) || :; ` +
    `if [[ -n $__kimix_native ]]; then "$__kimix_native" "$@"; return; fi; `
  );
}

function fallbackDefinition(name: string): string {
  const body = FALLBACK_BODIES[name];
  let guard: string;
  let delegate: string;
  if (STUB_AWARE_FALLBACKS.has(name)) {
    guard = `if ! command -v ${name} >/dev/null 2>&1 || [[ $(type -P ${name}) == *WindowsApps* ]]; then `;
    delegate =
      `local __kimix_native=''; __kimix_native=$(type -P ${name}) || :; ` +
      `if [[ -n $__kimix_native && $__kimix_native != *WindowsApps* ]]; then "$__kimix_native" "$@"; return; fi; `;
  } else {
    guard = `if ! command -v ${name} >/dev/null 2>&1; then `;
    delegate = nativeDelegate(name);
  }
  return `${guard}${name}() { ${delegate}${body}; }; fi`;
}

const PATH_DRIVE_RE = /^[A-Za-z]:\\.*$/;

const PATH_SEGMENT_RE = /^[A-Za-z0-9_.~\-]+$/;

const PATH_SAFE_CHARS = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./:~@%+=-#,[]*?',
);

const ESCAPED_LITERAL_CHARS = new Set(" \t&;|()<>#'\"$`{}!");

const OPERATOR_CHARS = new Set(';&|()<>\n');

const SKIP_SUBTREE_TYPES: ReadonlySet<string> = new Set([
  'ERROR',
  'heredoc_body',
  'heredoc_content',
  'heredoc_end',
]);

const WORD_SHAPING_TYPES: ReadonlySet<string> = new Set([
  'concatenation',
  'string',
  'raw_string',
  'ansi_c_string',
]);

const WINDOWS_NUL_REDIRECT = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g;

function nulRedirectRewrite(command: string): string {
  return command.replace(WINDOWS_NUL_REDIRECT, '$1/dev/null');
}

const MSYSTEM_NEUTRALIZE_PREFIX = 'export MSYSTEM=; ';

export function gitBashInstallRoot(bashPath: string): string | null {
  if (bashPath.length === 0) return null;
  const normalized = bashPath.replace(/\//g, '\\');
  const driveMatch = /^([A-Za-z]:)\\/.exec(normalized);
  const drive = driveMatch === null ? '' : driveMatch[1]!;
  const tail = driveMatch === null ? normalized : normalized.slice(drive.length);
  const parts = tail.split('\\').filter((part) => part.length > 0 && part !== '.');
  if (parts.length < 3) return null;
  if (parts[parts.length - 1]!.toLowerCase() !== 'bash.exe') return null;
  if (parts[parts.length - 2]!.toLowerCase() !== 'bin') return null;
  const rootParts =
    parts[parts.length - 3]!.toLowerCase() === 'usr'
      ? parts.slice(0, -3)
      : parts.slice(0, -2);
  if (rootParts.length === 0) return null;
  const root = rootParts.join('\\');
  return drive.length > 0 ? `${drive}\\${root}` : root;
}

const GIT_BASH_MARKER_CACHE = new Map<string, boolean>();

export function withMsystemNeutralized(
  command: string,
  bashPath: string,
  platform?: string,
): string {
  const target = platform ?? process.platform;
  if (target !== 'win32') return command;
  const root = gitBashInstallRoot(bashPath);
  if (root === null) return command;
  let gitBash = GIT_BASH_MARKER_CACHE.get(root);
  if (gitBash === undefined) {
    gitBash = existsSync(`${root}\\cmd\\git.exe`);
    GIT_BASH_MARKER_CACHE.set(root, gitBash);
  }
  return gitBash ? MSYSTEM_NEUTRALIZE_PREFIX + command : command;
}

function literalCommandName(raw: string): string | null {
  const value: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '\\') {
      if (i + 1 >= raw.length) return null;
      if (raw[i + 1] === '\n') {
        i += 2;
        continue;
      }
      value.push(raw[i + 1]!);
      i += 2;
      continue;
    }
    if (ch === "'") {
      const close = raw.indexOf("'", i + 1);
      if (close < 0) return null;
      value.push(raw.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < raw.length && raw[i] !== '"') {
        const inner = raw[i]!;
        if (inner === '$' || inner === '`') return null;
        if (inner === '\\' && i + 1 < raw.length) {
          const escaped = raw[i + 1]!;
          if (
            escaped === '$' ||
            escaped === '`' ||
            escaped === '"' ||
            escaped === '\\' ||
            escaped === '\n'
          ) {
            if (escaped !== '\n') value.push(escaped);
            i += 2;
            continue;
          }
        }
        value.push(inner);
        i += 1;
      }
      if (i >= raw.length) return null;
      i += 1;
      continue;
    }
    if (ch === '$' || ch === '`' || ch === '*' || ch === '?' || ch === '[' || ch === '{' || ch === '~') {
      return null;
    }
    value.push(ch);
    i += 1;
  }
  return value.join('');
}

function plausiblePathSegments(raw: string): boolean {
  return raw.split('\\').some((segment) => segment.length >= 2 && /[A-Za-z]/.test(segment[0]!));
}

function decodeUnquotedWord(raw: string): string {
  const value: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '\\' && i + 1 < raw.length) {
      value.push(raw[i + 1]!);
      i += 2;
    } else {
      value.push(ch);
      i += 1;
    }
  }
  return value.join('');
}

function normalizeWindowsPath(raw: string): string {
  const out: string[] = [];
  let i = 0;
  const n = raw.length;
  if (n >= 2 && raw.startsWith('\\\\')) {
    out.push('//');
    i = 2;
  }
  while (i < n) {
    const ch = raw[i]!;
    if (ch === '\\' && i + 1 < n) {
      const nxt = raw[i + 1]!;
      if (nxt === '\\') {
        out.push('/');
      } else if (ESCAPED_LITERAL_CHARS.has(nxt)) {
        out.push(nxt);
      } else {
        out.push('/');
        out.push(nxt);
      }
      i += 2;
    } else if (ch === '\\') {
      out.push('/');
      i += 1;
    } else {
      out.push(ch);
      i += 1;
    }
  }
  return out.join('');
}

function quotePathWord(normalized: string): string {
  if ([...normalized].every((ch) => PATH_SAFE_CHARS.has(ch))) return normalized;
  if (normalized.startsWith('~')) return `~${quotePathWord(normalized.slice(1))}`;
  const escaped = normalized
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
  return `"${escaped}"`;
}

function windowsPathReplacement(raw: string): string | null {
  if (raw.length === 0 || !raw.includes('\\')) return null;
  let backslashes = 0;
  for (const ch of raw) {
    if (ch === '\\') {
      backslashes += 1;
    } else if (ch === "'" || ch === '"' || ch === '`' || ch === '$' || ch === '\n' || ch === '\r') {
      return null;
    }
  }
  const drive = PATH_DRIVE_RE.test(raw);
  const unc = raw.startsWith('\\\\') && raw.length > 2;
  const rootRelative =
    raw.startsWith('\\') && !raw.startsWith('\\\\') && backslashes >= 2 && plausiblePathSegments(raw);
  const homeRelative = raw.startsWith('~\\');
  const dotRelative = raw.startsWith('.\\') || raw.startsWith('..\\');
  let recognized = drive || unc || rootRelative || homeRelative || dotRelative;
  if (!recognized && backslashes >= 2) {
    const decoded = decodeUnquotedWord(raw);
    recognized =
      decoded.length >= 2 &&
      [...decoded].some((ch) => /[A-Za-z0-9]/.test(ch)) &&
      PATH_SEGMENT_RE.test(decoded) &&
      plausiblePathSegments(raw);
  }
  if (!recognized) return null;
  return quotePathWord(normalizeWindowsPath(raw));
}

function insideSkippedSubtree(node: SyntaxNode): boolean {
  let current: SyntaxNode | null = node.parent;
  while (current !== null) {
    if (SKIP_SUBTREE_TYPES.has(current.type)) return true;
    current = current.parent;
  }
  return false;
}

function isCommandNameWord(word: SyntaxNode): boolean {
  let current: SyntaxNode | null = word.parent;
  while (current !== null) {
    if (current.type === 'command_name') return true;
    if (!WORD_SHAPING_TYPES.has(current.type)) return false;
    current = current.parent;
  }
  return false;
}

const BASH_METACHARACTERS = new Set("()|;&<>$\"`'*?[]{}~!#=% \t\n\r");

const DQ_ESCAPED = new Set(['"', '\\', '$', '`']);

const UNQUOTED_SPECIAL_RE = /[\\'"$`]/g;

function findAnsiCEnd(cmd: string, start: number): number {
  let i = start;
  const length = cmd.length;
  while (i < length) {
    const c = cmd[i]!;
    if (c === '\\' && i + 1 < length) {
      i += 2;
    } else if (c === "'") {
      return i + 1;
    } else {
      i += 1;
    }
  }
  return -1;
}

function findBacktickEnd(cmd: string, start: number): number {
  let i = start;
  const length = cmd.length;
  while (i < length) {
    const c = cmd[i]!;
    if (c === '\\' && i + 1 < length) {
      i += 2;
    } else if (c === '`') {
      return i + 1;
    } else {
      i += 1;
    }
  }
  return -1;
}

function findMatchingParen(cmd: string, openPos: number): number {
  let depth = 1;
  let i = openPos + 1;
  const length = cmd.length;
  while (i < length) {
    const c = cmd[i]!;
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) return -1;
      i = end + 1;
    } else if (c === '"') {
      i = findDqEnd(cmd, i + 1);
      if (i === -1) return -1;
    } else if (c === '`') {
      i = findBacktickEnd(cmd, i + 1);
      if (i === -1) return -1;
    } else if (c === '$' && i + 1 < length && cmd[i + 1] === '(') {
      depth += 1;
      i += 2;
    } else if (c === '$' && i + 1 < length && cmd[i + 1] === "'") {
      const end = findAnsiCEnd(cmd, i + 2);
      if (end === -1) return -1;
      i = end;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
      i += 1;
    } else {
      i += 1;
    }
  }
  return -1;
}

function findDqEnd(cmd: string, start: number): number {
  let i = start;
  const length = cmd.length;
  while (i < length) {
    const c = cmd[i]!;
    if (c === '\\' && i + 1 < length && DQ_ESCAPED.has(cmd[i + 1]!)) {
      i += 2;
    } else if (c === '"') {
      return i + 1;
    } else if (c === '$' && i + 1 < length && cmd[i + 1] === '(') {
      const end = findMatchingParen(cmd, i + 1);
      if (end === -1) return -1;
      i = end + 1;
    } else if (c === '$' && i + 1 < length && cmd[i + 1] === "'") {
      const end = findAnsiCEnd(cmd, i + 2);
      if (end === -1) return -1;
      i = end;
    } else if (c === '`') {
      const end = findBacktickEnd(cmd, i + 1);
      if (end === -1) return -1;
      i = end;
    } else {
      i += 1;
    }
  }
  return -1;
}

function searchSpecial(cmd: string, from: number, to: number): number {
  UNQUOTED_SPECIAL_RE.lastIndex = from;
  const m = UNQUOTED_SPECIAL_RE.exec(cmd);
  if (m === null || m.index >= to) return -1;
  return m.index;
}

function processUnquoted(cmd: string): string {
  const result: string[] = [];
  let i = 0;
  const length = cmd.length;
  while (i < length) {
    const nxt = searchSpecial(cmd, i, length);
    if (nxt === -1) {
      result.push(cmd.slice(i));
      break;
    }
    if (nxt > i) {
      result.push(cmd.slice(i, nxt));
      i = nxt;
    }
    if (i >= length) break;
    const char = cmd[i]!;
    if (char === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) {
        result.push(cmd.slice(i));
        break;
      }
      result.push(cmd.slice(i, end + 1));
      i = end + 1;
    } else if (char === '"') {
      const dqEnd = findDqEnd(cmd, i + 1);
      if (dqEnd === -1) {
        result.push(cmd.slice(i));
        break;
      }
      let j = i + 1;
      let chunkStart = i;
      while (j < dqEnd) {
        const nxt2 = searchSpecial(cmd, j, dqEnd);
        if (nxt2 === -1) {
          j = dqEnd;
          break;
        }
        j = nxt2;
        const c = cmd[j]!;
        if (c === '\\' && j + 1 < dqEnd && DQ_ESCAPED.has(cmd[j + 1]!)) {
          j += 2;
        } else if (c === '$' && j + 1 < dqEnd && cmd[j + 1] === '(') {
          const parenEnd = findMatchingParen(cmd, j + 1);
          if (parenEnd === -1 || parenEnd >= dqEnd) {
            j = dqEnd;
            break;
          }
          result.push(cmd.slice(chunkStart, j));
          result.push('$(');
          result.push(processUnquoted(cmd.slice(j + 2, parenEnd)));
          result.push(')');
          j = parenEnd + 1;
          chunkStart = j;
        } else if (c === '$' && j + 1 < dqEnd && cmd[j + 1] === "'") {
          const acEnd = findAnsiCEnd(cmd, j + 2);
          if (acEnd === -1 || acEnd > dqEnd) {
            j = dqEnd;
            break;
          }
          j = acEnd;
        } else if (c === '`') {
          const btEnd = findBacktickEnd(cmd, j + 1);
          if (btEnd === -1 || btEnd > dqEnd) {
            j = dqEnd;
            break;
          }
          result.push(cmd.slice(chunkStart, j));
          result.push('`');
          result.push(processUnquoted(cmd.slice(j + 1, btEnd - 1)));
          result.push('`');
          j = btEnd;
          chunkStart = j;
        } else {
          j += 1;
        }
      }
      result.push(cmd.slice(chunkStart, dqEnd));
      i = dqEnd;
    } else if (char === '$' && i + 1 < length && cmd[i + 1] === "'") {
      const acEnd = findAnsiCEnd(cmd, i + 2);
      if (acEnd === -1) {
        result.push(cmd.slice(i));
        break;
      }
      result.push(cmd.slice(i, acEnd));
      i = acEnd;
    } else if (char === '`') {
      const btEnd = findBacktickEnd(cmd, i + 1);
      if (btEnd === -1) {
        result.push(cmd.slice(i));
        break;
      }
      result.push('`');
      result.push(processUnquoted(cmd.slice(i + 1, btEnd - 1)));
      result.push('`');
      i = btEnd;
    } else if (char === '\\') {
      if (i + 1 < length && BASH_METACHARACTERS.has(cmd[i + 1]!)) {
        result.push('\\');
        result.push(cmd[i + 1]!);
        i += 2;
      } else {
        result.push('/');
        i += 1;
      }
    } else {
      result.push(char);
      i += 1;
    }
  }
  return result.join('');
}

function collectExcludedSpans(root: SyntaxNode): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (
      node.type === 'heredoc_start' ||
      node.type === 'heredoc_body' ||
      node.type === 'heredoc_end' ||
      node.type === 'comment' ||
      node.type === 'command_name'
    ) {
      spans.push([node.startIndex, node.endIndex]);
    }
    for (let i = node.namedChildren.length - 1; i >= 0; i -= 1) {
      stack.push(node.namedChildren[i]!);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

function processUnquotedPreservingSpans(cmd: string, spans: readonly (readonly [number, number])[]): string {
  let out = '';
  let pos = 0;
  for (const [start, end] of spans) {
    if (start > pos) out += processUnquoted(cmd.slice(pos, start));
    out += cmd.slice(start, end);
    pos = end;
  }
  if (pos < cmd.length) out += processUnquoted(cmd.slice(pos));
  return out;
}

function dropCmdCdFlag(
  commandNodes: readonly SyntaxNode[],
  source: string,
  edits: Array<[number, number, string]>,
  pathNotes: string[],
): void {
  for (const command of commandNodes) {
    const nameNode = command.namedChildren.find((child) => child.type === 'command_name');
    if (nameNode === undefined || nameNode.text !== 'cd') continue;
    const firstArg = command.namedChildren.find((child) => child.startIndex >= nameNode.endIndex);
    if (firstArg === undefined) continue;
    const flag = source.slice(firstArg.startIndex, firstArg.endIndex);
    if (flag !== '/d' && flag !== '/D') continue;
    let k = firstArg.endIndex;
    while (k < source.length && (source[k] === ' ' || source[k] === '\t' || source[k] === '\r')) {
      k += 1;
    }
    if (k >= source.length || OPERATOR_CHARS.has(source[k]!) || source[k] === '#') continue;
    edits.push([firstArg.startIndex - 1, firstArg.endIndex, '']);
    pathNotes.push('cd /d');
  }
}

const QUOTE_CHARS_RE = /['"`]/;

const NUL_NEEDED_RE = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/;

const CD_D_FLAG_RE = /\bcd\s+\/?[dD]\b/;

const FALLBACK_NAME_RE = new RegExp(`\\b(?:${Object.keys(FALLBACK_BODIES).join('|')})\\b`);

function needsFullPipeline(command: string): boolean {
  if (command.includes('\\')) return true;
  if (QUOTE_CHARS_RE.test(command)) return true;
  if (CD_D_FLAG_RE.test(command)) return true;
  if (NUL_NEEDED_RE.test(command)) return true;
  return FALLBACK_NAME_RE.test(command);
}

export function fixBashCommand(command: string, platform?: string): BashFixResult {
  const unchanged = (): BashFixResult => ({
    command,
    replacements: [],
    pathChanges: [],
    changed: false,
  });
  const target = platform ?? process.platform;
  if (target !== 'win32' || command.length === 0) return unchanged();
  if (!needsFullPipeline(command)) return unchanged();
  const parsed = parse(command);
  if (!parsed.ok || parsed.hasError) return unchanged();
  const root = parsed.rootNode;
  const converted = processUnquotedPreservingSpans(command, collectExcludedSpans(root));
  const names: string[] = [];
  const seen = new Set<string>();
  const pathNotes: string[] = [];
  const edits: Array<[number, number, string]> = [];
  try {
    const stack: SyntaxNode[] = [root];
    const commandNodes: SyntaxNode[] = [];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === 'command_name') {
        const literal = literalCommandName(node.text);
        if (literal !== null && FALLBACK_BODIES[literal] !== undefined) {
          if (!seen.has(literal)) {
            seen.add(literal);
            names.push(literal);
          }
        } else if (!insideSkippedSubtree(node)) {
          const replacement = windowsPathReplacement(node.text);
          if (replacement !== null) {
            edits.push([node.startIndex, node.endIndex, replacement]);
            pathNotes.push(node.text);
          }
        }
      } else if (
        node.type === 'word' &&
        !isCommandNameWord(node) &&
        !insideSkippedSubtree(node) &&
        node.text.includes('\\')
      ) {
        const replacement = windowsPathReplacement(node.text);
        if (replacement !== null) {
          edits.push([node.startIndex, node.endIndex, replacement]);
          pathNotes.push(node.text);
        } else if (converted.slice(node.startIndex, node.endIndex) !== node.text) {
          pathNotes.push(node.text);
        }
      } else if (node.type === 'command' && !insideSkippedSubtree(node)) {
        commandNodes.push(node);
      }
      for (let i = node.namedChildren.length - 1; i >= 0; i -= 1) {
        stack.push(node.namedChildren[i]!);
      }
    }
    dropCmdCdFlag(commandNodes, converted, edits, pathNotes);
  } catch {
    return unchanged();
  }
  if (converted === command && names.length === 0 && edits.length === 0) {
    return { command: nulRedirectRewrite(command), replacements: [], pathChanges: [], changed: false };
  }
  const definitions = names.map(fallbackDefinition).join('\n');
  let source: string;
  if (edits.length > 0) {
    const sorted = [...edits].sort((a, b) => a[0] - b[0]);
    const pieces: string[] = [];
    let previous = 0;
    for (const [start, end, replacement] of sorted) {
      pieces.push(converted.slice(previous, start), replacement);
      previous = end;
    }
    pieces.push(converted.slice(previous));
    source = pieces.join('');
  } else {
    source = converted;
  }
  const assembled = definitions.length > 0 ? `${definitions}\n${source}` : source;
  return {
    command: nulRedirectRewrite(assembled),
    replacements: names,
    pathChanges: pathNotes,
    changed: names.length > 0 || pathNotes.length > 0,
  };
}
