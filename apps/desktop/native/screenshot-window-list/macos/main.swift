import AppKit
import CoreGraphics
import Foundation

let excludedWindows = Set(CommandLine.arguments.dropFirst().compactMap(UInt32.init))
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
let dockPids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").map(\.processIdentifier))
var windows: [[String: Any]] = []

for item in raw {
  guard
    let number = item[kCGWindowNumber as String] as? NSNumber,
    let layer = item[kCGWindowLayer as String] as? NSNumber,
    let alpha = item[kCGWindowAlpha as String] as? NSNumber,
    let bounds = item[kCGWindowBounds as String] as? [String: Any],
    let x = bounds["X"] as? NSNumber,
    let y = bounds["Y"] as? NSNumber,
    let width = bounds["Width"] as? NSNumber,
    let height = bounds["Height"] as? NSNumber
  else { continue }
  if let pid = item[kCGWindowOwnerPID as String] as? NSNumber, dockPids.contains(pid.int32Value) { continue }
  if excludedWindows.contains(number.uint32Value) || layer.intValue < 0 || layer.int32Value >= CGWindowLevelForKey(.cursorWindow) || alpha.doubleValue <= 0 || width.doubleValue < 8 || height.doubleValue < 8 {
    continue
  }
  windows.append([
    "id": number.stringValue,
    "x": x.doubleValue,
    "y": y.doubleValue,
    "width": width.doubleValue,
    "height": height.doubleValue,
  ])
}

let payload: [String: Any] = ["units": "points", "windows": windows]
let data = try JSONSerialization.data(withJSONObject: payload)
FileHandle.standardOutput.write(data)
