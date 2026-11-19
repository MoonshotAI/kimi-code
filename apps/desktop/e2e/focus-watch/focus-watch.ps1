param(
  [Parameter(Mandatory = $true)][string]$Log,
  [Parameter(Mandatory = $true)][string]$Command
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public static class FocusWatch {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string className, string title);
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint period);
  delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr param);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr hwnd, out uint key, out byte alpha, out uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

  static readonly Regex Offender = new Regex("electron|kimi", RegexOptions.IgnoreCase);
  static readonly Dictionary<uint, string> Names = new Dictionary<uint, string>();

  static string NameOf(uint pid) {
    string name;
    if (Names.TryGetValue(pid, out name)) return name;
    try { name = Process.GetProcessById((int)pid).ProcessName; } catch { name = "?"; }
    Names[pid] = name;
    return name;
  }

  static string VisibleOffenders() {
    var left = GetSystemMetrics(76);
    var top = GetSystemMetrics(77);
    var right = left + GetSystemMetrics(78);
    var bottom = top + GetSystemMetrics(79);
    var found = new List<string>();
    EnumWindows((hwnd, param) => {
      if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
      int cloaked;
      if (DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      Rect rect;
      if (!GetWindowRect(hwnd, out rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top) return true;
      if (rect.Right <= left || rect.Bottom <= top || rect.Left >= right || rect.Top >= bottom) return true;
      uint key, flags;
      byte alpha;
      if ((GetWindowLong(hwnd, -20) & 0x80000) != 0 && GetLayeredWindowAttributes(hwnd, out key, out alpha, out flags) && (flags & 2) != 0 && alpha == 0) return true;
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      var name = NameOf(pid);
      if (Offender.IsMatch(name)) found.Add(string.Format("{0} pid {1} hwnd 0x{2:X} [{3},{4},{5},{6}]", name, pid, hwnd.ToInt64(), rect.Left, rect.Top, rect.Right, rect.Bottom));
      return true;
    }, IntPtr.Zero);
    return found.Count == 0 ? "none" : string.Join("; ", found);
  }

  public static void Activate(IntPtr hwnd) {
    ShowWindow(hwnd, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(hwnd);
  }

  public static int Run(string log, Process child, string consoleTitle) {
    timeBeginPeriod(1);
    Thread.CurrentThread.Priority = ThreadPriority.Highest;
    var watch = Stopwatch.StartNew();
    var violations = 0;
    var samples = 0;
    var last = "";
    using (var writer = new StreamWriter(log, false) { AutoFlush = true }) {
      Action<string> write = line => writer.WriteLine(string.Format("{0,9:F3} {1}", watch.Elapsed.TotalSeconds, line));
      write("running in console pid " + child.Id);
      var console = IntPtr.Zero;
      while (!child.HasExited) {
        samples++;
        if (console == IntPtr.Zero) {
          console = FindWindow(null, consoleTitle);
          if (console != IntPtr.Zero) {
            Activate(console);
            write(string.Format("console window 0x{0:X} activated", console.ToInt64()));
          }
        }
        var hwnd = GetForegroundWindow();
        uint pid = 0;
        if (hwnd != IntPtr.Zero) GetWindowThreadProcessId(hwnd, out pid);
        var name = hwnd == IntPtr.Zero ? "none" : NameOf(pid);
        var title = new StringBuilder(256);
        if (hwnd != IntPtr.Zero) GetWindowText(hwnd, title, title.Capacity);
        var foreground = string.Format("foreground {0} pid {1} hwnd 0x{2:X} \"{3}\"", name, pid, hwnd.ToInt64(), title);
        var visible = VisibleOffenders();
        var state = foreground + " | visible " + visible;
        if (state != last) {
          write(state);
          last = state;
          if (Offender.IsMatch(name)) { violations++; write("VIOLATION " + foreground); }
          if (visible != "none") { violations++; write("VIOLATION visible window " + visible); }
        }
        Thread.Sleep(10);
      }
      var seconds = watch.Elapsed.TotalSeconds;
      child.WaitForExit();
      var status = child.ExitCode;
      write(string.Format("summary samples {0} over {1:F1} s ({2:F1} Hz), violations {3}, command exit {4}", samples, seconds, samples / seconds, violations, status));
      write(violations == 0 ? "result pass" : "result fail");
      return status != 0 ? status : violations == 0 ? 0 : 1;
    }
  }
}
'@

$output = "$Log.out"
$title = "focus-watch-$PID"
$script = "$Log.ps1"
Set-Content -LiteralPath $script -Value @"
`$Host.UI.RawUI.WindowTitle = '$title'
Set-Location -LiteralPath '$((Get-Location).Path)'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
`$OutputEncoding = [System.Text.Encoding]::UTF8
$Command *>&1 | Tee-Object -FilePath '$output'
exit `$LASTEXITCODE
"@
$console = Start-Process pwsh -ArgumentList @('-NoProfile', '-File', $script) -PassThru
$null = $console.Handle
$status = [FocusWatch]::Run($Log, $console, $title)
if (Test-Path -LiteralPath $output) { Get-Content -LiteralPath $output }
Get-Content -LiteralPath $Log
exit $status
