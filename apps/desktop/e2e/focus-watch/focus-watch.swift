import AppKit

let arguments = CommandLine.arguments
guard arguments.count >= 4, let separator = arguments.firstIndex(of: "--"), separator + 1 < arguments.count else {
  FileHandle.standardError.write("usage: focus-watch <log> [--passive] -- <command> [args...]\n".data(using: .utf8)!)
  exit(2)
}
let logPath = arguments[1]
let passive = arguments[..<separator].contains("--passive")
let command = Array(arguments[(separator + 1)...])
let offender = try! NSRegularExpression(pattern: "electron|kimi", options: [.caseInsensitive])
let started = Date()

FileManager.default.createFile(atPath: logPath, contents: nil)
let logHandle = FileHandle(forWritingAtPath: logPath)!

func write(_ line: String) {
  let stamp = String(format: "%9.3f", Date().timeIntervalSince(started))
  logHandle.write("\(stamp) \(line)\n".data(using: .utf8)!)
}

func isOffender(_ text: String) -> Bool {
  offender.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
}

func describe(_ app: NSRunningApplication?) -> String {
  guard let app else { return "none" }
  return "\(app.localizedName ?? "?") [\(app.bundleIdentifier ?? "?")] pid \(app.processIdentifier)"
}

func offenderWindows() -> [(number: Int, text: String)] {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
  var found: [(number: Int, text: String)] = []
  for window in windows where (window[kCGWindowLayer as String] as? Int) == 0 {
    let alpha = window[kCGWindowAlpha as String] as? Double ?? 1
    let name = window[kCGWindowOwnerName as String] as? String ?? "?"
    guard alpha > 0, isOffender(name) else { continue }
    let pid = window[kCGWindowOwnerPID as String] as? Int ?? 0
    let number = window[kCGWindowNumber as String] as? Int ?? 0
    found.append((number, "\(name) pid \(pid) window \(number)"))
  }
  return found
}

let preexisting = Set(offenderWindows().map(\.number))

func visibleOffenders() -> String {
  let found = offenderWindows().filter { !preexisting.contains($0.number) }.map(\.text)
  return found.isEmpty ? "none" : found.joined(separator: "; ")
}

let app = NSApplication.shared
var window: NSWindow?
var neutralReady = false
var violations: [String] = []
var samples = 0
var lastState = ""

func violation(_ text: String) {
  violations.append(text)
  write("VIOLATION \(text)")
}

if !passive {
  app.setActivationPolicy(.regular)
  let neutral = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 480, height: 240), styleMask: [.titled], backing: .buffered, defer: false)
  neutral.title = "focus-watch"
  let field = NSTextField(frame: NSRect(x: 20, y: 100, width: 440, height: 24))
  neutral.contentView?.addSubview(field)
  neutral.makeKeyAndOrderFront(nil)
  neutral.makeFirstResponder(field)
  window = neutral
  app.activate(ignoringOtherApps: true)
}

NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
  let activated = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
  let text = describe(activated)
  write("activated \(text)")
  if isOffender(text) { violation("activated \(text)") }
}

NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { _ in
  guard neutralReady else { return }
  violation("neutral app resigned active; frontmost: \(describe(NSWorkspace.shared.frontmostApplication))")
}

NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: nil, queue: .main) { _ in
  guard neutralReady else { return }
  violation("neutral window resigned key; frontmost: \(describe(NSWorkspace.shared.frontmostApplication))")
}

var child: Process?
var visible = "none"

Thread.detachNewThread {
  while true {
    let offenders = visibleOffenders()
    DispatchQueue.main.async { visible = offenders }
    Thread.sleep(forTimeInterval: 0.02)
  }
}

func finish(_ status: Int32) {
  let seconds = Date().timeIntervalSince(started)
  write(String(format: "summary samples %d over %.1f s (%.1f Hz), violations %d, command exit %d", samples, seconds, Double(samples) / seconds, violations.count, status))
  write(violations.isEmpty ? "result pass" : "result fail")
  exit(status != 0 ? status : violations.isEmpty ? 0 : 1)
}

func launch() {
  write("running \(command.joined(separator: " "))")
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  process.arguments = command
  process.terminationHandler = { finished in
    DispatchQueue.main.async { finish(finished.terminationStatus) }
  }
  do {
    try process.run()
  } catch {
    write("failed to start the command: \(error)")
    exit(2)
  }
  child = process
}

Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { _ in
  samples += 1
  let front = describe(NSWorkspace.shared.frontmostApplication)
  let neutralState = passive ? "passive" : "neutral active \(app.isActive) key \(window?.isKeyWindow ?? false)"
  let state = "frontmost \(front) | visible \(visible) | \(neutralState)"
  if state != lastState {
    write(state)
    lastState = state
    if isOffender(front) { violation("frontmost \(front)") }
    if visible != "none" { violation("visible window \(visible)") }
  }
  if child == nil {
    let active = passive || (app.isActive && window?.isKeyWindow == true)
    if active || Date().timeIntervalSince(started) > 15 {
      neutralReady = active && !passive
      write(active ? "ready" : "ready without an active neutral window")
      launch()
    }
  }
}

app.run()
