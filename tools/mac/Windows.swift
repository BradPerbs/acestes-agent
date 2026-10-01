// Windows: which there are, which is in front, bringing one forward,
// putting one where it is wanted, and starting an app.
//
// The window server knows every window's id, owner, layer and bounds, front
// to back; the accessibility API knows titles, which are real app windows,
// and which are minimised. A window is listed from the first and named
// from the second.

import Cocoa
import ApplicationServices

struct WindowInfo {
    let id: CGWindowID
    let pid: pid_t
    let layer: Int
    let bounds: CGRect
    let name: String
    let owner: String
    let onScreen: Bool
    let alpha: Double
}

let axTrue: AnyObject = kCFBooleanTrue
let axFalse: AnyObject = kCFBooleanFalse

func cgWindows(_ options: CGWindowListOption, _ relative: CGWindowID = kCGNullWindowID) -> [WindowInfo] {
    guard let list = CGWindowListCopyWindowInfo(options, relative) as? [[String: Any]] else { return [] }
    return list.compactMap { entry in
        guard let id = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { return nil }
        var bounds = CGRect.null
        if let raw = entry[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: raw as CFDictionary) { bounds = rect }
        return WindowInfo(
            id: id,
            pid: pid,
            layer: (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
            bounds: bounds,
            name: entry[kCGWindowName as String] as? String ?? "",
            owner: entry[kCGWindowOwnerName as String] as? String ?? "",
            onScreen: (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
            alpha: (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
        )
    }
}

/// One window by its id, on screen or not (minimised, on another Space).
func info(_ id: CGWindowID) -> WindowInfo? {
    id == 0 ? nil : cgWindows([.optionIncludingWindow], id).first { $0.id == id }
}

func appName(_ pid: pid_t, _ fallback: String = "") -> String {
    NSRunningApplication(processIdentifier: pid)?.localizedName ?? fallback
}

func axWindows(_ pid: pid_t, timeout: Float = 0) -> [AXUIElement] {
    let app = AXUIElementCreateApplication(pid)
    if timeout > 0 { AXUIElementSetMessagingTimeout(app, timeout) }
    return (attribute(app, "AXWindows") as? [AXUIElement]) ?? []
}

/// The accessibility element for a window: by its id, or else by where it is.
func axWindow(_ window: WindowInfo) -> AXUIElement? {
    let candidates = axWindows(window.pid)
    if let match = candidates.first(where: { windowNumber($0) == window.id }) { return match }
    return candidates.first { candidate in
        let place = frame(candidate)
        return !place.isNull && abs(place.minX - window.bounds.minX) < 2 && abs(place.minY - window.bounds.minY) < 2
            && abs(place.width - window.bounds.width) < 2 && abs(place.height - window.bounds.height) < 2
    }
}

/// The window in front: the frontmost app's focused window.
func frontWindow() -> CGWindowID? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let pid = app.processIdentifier
    if let focused = elementOf(attribute(AXUIElementCreateApplication(pid), "AXFocusedWindow")), let id = windowNumber(focused) {
        return id
    }
    return cgWindows([.optionOnScreenOnly, .excludeDesktopElements]).first { $0.pid == pid && $0.layer == 0 }?.id
}

/// Every window a person could switch to, front to back, minimised ones last.
func listedWindows() -> [(window: WindowInfo, title: String, minimized: Bool)] {
    var titles: [CGWindowID: String] = [:]
    var known = Set<CGWindowID>()
    var minimized: [CGWindowID] = []
    let regular = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !protected.contains($0.processIdentifier) }
    for app in regular {
        // An app that has stopped answering costs half a second, not the list.
        for element in axWindows(app.processIdentifier, timeout: 0.5) {
            guard let id = windowNumber(element) else { continue }
            let values = fetch(element, ["AXTitle", "AXMinimized"])
            known.insert(id)
            titles[id] = flat(stringOf(values["AXTitle"]))
            if boolOf(values["AXMinimized"]) == true { minimized.append(id) }
        }
    }
    let regularPids = Set(regular.map { $0.processIdentifier })
    // Without the private lookup nothing is known by id; an app's own
    // windows are taken on trust instead.
    let matched = !known.isEmpty

    var found: [(window: WindowInfo, title: String, minimized: Bool)] = []
    var seen = Set<CGWindowID>()
    for window in cgWindows([.optionOnScreenOnly, .excludeDesktopElements]) {
        guard window.layer == 0, window.alpha > 0, !protected.contains(window.pid),
              window.bounds.width >= 40, window.bounds.height >= 30 else { continue }
        let listed = known.contains(window.id) || !window.name.isEmpty || (!matched && regularPids.contains(window.pid))
        guard listed, !seen.contains(window.id) else { continue }
        seen.insert(window.id)
        let title = titles[window.id].flatMap { $0.isEmpty ? nil : $0 } ?? window.name
        found.append((window, title, false))
    }
    for id in minimized where !seen.contains(id) {
        guard let window = info(id) else { continue }
        seen.insert(id)
        found.append((window, titles[id] ?? window.name, true))
    }
    return found
}

func titleOf(_ window: WindowInfo) -> String {
    if let element = axWindow(window) {
        let title = flat(string(element, "AXTitle"))
        if !title.isEmpty { return title }
    }
    return window.name
}

func describe(_ window: WindowInfo, title known: String? = nil, minimized: Bool? = nil, front: CGWindowID?? = nil) -> Json {
    let inFront: CGWindowID? = front ?? frontWindow()
    let title = known ?? titleOf(window)
    var hidden = minimized ?? !window.onScreen
    if minimized == nil, let element = axWindow(window), let flagged = boolOf(attribute(element, "AXMinimized")) { hidden = flagged }
    return [
        "hwnd": Int(window.id),
        "title": title,
        "process": appName(window.pid, window.owner),
        "pid": Int(window.pid),
        "x": whole(window.bounds.minX),
        "y": whole(window.bounds.minY),
        "width": whole(window.bounds.width),
        "height": whole(window.bounds.height),
        "minimized": hidden,
        "foreground": inFront == window.id,
        "protected": protected.contains(window.pid),
        "elevated": false,
    ]
}

func listWindowsAnswer() -> Json {
    let front = frontWindow()
    return ["windows": listedWindows().map { describe($0.window, title: $0.title, minimized: $0.minimized, front: .some(front)) }]
}

func foregroundAnswer() -> Json {
    guard let id = frontWindow(), let window = info(id) else { return [:] }
    return ["window": describe(window, front: .some(id))]
}

/// The window that would take a click at a point: the topmost one there,
/// leaving out this helper's own markers and Acestes's corner card, which
/// float over everything and let clicks through.
func windowAt(_ point: CGPoint) -> WindowInfo? {
    for window in cgWindows([.optionOnScreenOnly]) {
        if window.pid == selfPid || window.alpha <= 0.01 || window.bounds.isNull { continue }
        if protected.contains(window.pid) && window.layer != 0 { continue }
        if window.layer >= Int(CGWindowLevelForKey(.screenSaverWindow)) { continue }
        if window.bounds.contains(point) { return window }
    }
    return nil
}

func ownerAt(_ point: CGPoint) -> pid_t {
    windowAt(point)?.pid ?? 0
}

/// What is at a point may be touched: not Acestes.
func allowed(_ window: WindowInfo?) throws {
    guard let window = window else { return }
    if protected.contains(window.pid) { throw Stop("protected", "That is on the Acestes window itself, which the agent may not touch.") }
}

func existing(_ id: CGWindowID) throws -> WindowInfo {
    guard let window = info(id) else { throw Stop("gone", "That window is gone. List the windows again.") }
    return window
}

func focus(_ id: CGWindowID) throws -> Json {
    try requireDriving()
    let window = try existing(id)
    try allowed(window)
    bringForward(window)
    return ["window": describe(info(id) ?? window)]
}

/// To the front: the app made frontmost and the window raised in it. The
/// accessibility way works from the background, where asking to be
/// activated is often refused.
func bringForward(_ window: WindowInfo) {
    let element = axWindow(window)
    if let element = element, boolOf(attribute(element, "AXMinimized")) == true {
        _ = setAttribute(element, "AXMinimized", axFalse)
        pause(300)
    }
    if frontWindow() == window.id { return }
    if let app = NSRunningApplication(processIdentifier: window.pid) {
        if #available(macOS 14.0, *) { app.activate() } else { app.activate(options: [.activateIgnoringOtherApps]) }
    }
    _ = setAttribute(AXUIElementCreateApplication(window.pid), "AXFrontmost", axTrue)
    if let element = element {
        _ = setAttribute(element, "AXMain", axTrue)
        AXUIElementPerformAction(element, "AXRaise" as CFString)
    }
    var wait = 0
    while wait < 20 && frontWindow() != window.id {
        pause(25)
        wait += 1
    }
    pause(40)
}

/* ---------------------------------------------------------------- *
 * Displays
 * ---------------------------------------------------------------- */

struct Display {
    let frame: CGRect
    let visible: CGRect
    let scale: CGFloat
    let id: CGDirectDisplayID
}

/// The displays in the top-left, point-based space, the main one first.
func displays() -> [Display] {
    onMain { () -> [Display] in
        let screens = NSScreen.screens
        let height = screens.first?.frame.height ?? 0
        let flip = { (rect: NSRect) in CGRect(x: rect.minX, y: height - rect.maxY, width: rect.width, height: rect.height) }
        return screens.map { screen in
            Display(
                frame: flip(screen.frame),
                visible: flip(screen.visibleFrame),
                scale: screen.backingScaleFactor,
                id: (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
            )
        }
    }
}

/// The display most of a rectangle is on.
func display(for rect: CGRect) -> Display? {
    let all = displays()
    let center = CGPoint(x: rect.midX, y: rect.midY)
    if let holding = all.first(where: { $0.frame.contains(center) }) { return holding }
    return all.max { a, b in
        let one = a.frame.intersection(rect)
        let other = b.frame.intersection(rect)
        return (one.isNull ? 0 : one.width * one.height) < (other.isNull ? 0 : other.width * other.height)
    } ?? all.first
}

/// The window's own display, the main one, or the nth from the left.
func display(for window: WindowInfo, monitor: String) throws -> Display {
    let all = displays()
    if monitor == "primary", let main = all.first { return main }
    if let wanted = Int(monitor) {
        let ordered = all.sorted { $0.frame.minX != $1.frame.minX ? $0.frame.minX < $1.frame.minX : $0.frame.minY < $1.frame.minY }
        if wanted < 1 || wanted > ordered.count {
            throw Stop("bad-request", "There are \(ordered.count) monitors; number them from 1, left to right.")
        }
        return ordered[wanted - 1]
    }
    guard let found = display(for: window.bounds) else { throw Stop("failed", "There is no display to put it on.") }
    return found
}

/// A window moved and sized to part of a display's working area (below the
/// menu bar, beside the Dock): a half, a quarter, the middle, or all of it.
/// Several agents working side by side each get their own part of the
/// screen, so reaching into one never covers another.
func place(_ request: Json) throws -> Json {
    try requireDriving()
    let window = try existing(windowId(request, "hwnd"))
    try allowed(window)

    let slot = text(request, "slot").lowercased()
    let area = try display(for: window, monitor: text(request, "monitor")).visible
    let halfWidth = (area.width / 2).rounded(.down)
    let halfHeight = (area.height / 2).rounded(.down)
    let goal: CGRect
    switch slot {
    case "left": goal = CGRect(x: area.minX, y: area.minY, width: halfWidth, height: area.height)
    case "right": goal = CGRect(x: area.minX + halfWidth, y: area.minY, width: area.width - halfWidth, height: area.height)
    case "top": goal = CGRect(x: area.minX, y: area.minY, width: area.width, height: halfHeight)
    case "bottom": goal = CGRect(x: area.minX, y: area.minY + halfHeight, width: area.width, height: area.height - halfHeight)
    case "top-left": goal = CGRect(x: area.minX, y: area.minY, width: halfWidth, height: halfHeight)
    case "top-right": goal = CGRect(x: area.minX + halfWidth, y: area.minY, width: area.width - halfWidth, height: halfHeight)
    case "bottom-left": goal = CGRect(x: area.minX, y: area.minY + halfHeight, width: halfWidth, height: area.height - halfHeight)
    case "bottom-right": goal = CGRect(x: area.minX + halfWidth, y: area.minY + halfHeight, width: area.width - halfWidth, height: area.height - halfHeight)
    case "center": goal = CGRect(x: area.minX + area.width / 8, y: area.minY + area.height / 10, width: area.width * 3 / 4, height: area.height * 4 / 5)
    case "full", "maximize": goal = area
    default: throw Stop("bad-request", "Unknown place \"\(slot)\".")
    }

    guard let element = axWindow(window) else {
        throw Stop("failed", "That window cannot be moved: its app does not say where its windows are.")
    }
    // A minimised window ignores a new frame, and a full-screen one has a
    // Space of its own; each is brought back first.
    if boolOf(attribute(element, "AXMinimized")) == true {
        _ = setAttribute(element, "AXMinimized", axFalse)
        pause(300)
    }
    if boolOf(attribute(element, "AXFullScreen")) == true {
        _ = setAttribute(element, "AXFullScreen", axFalse)
        pause(900)
    }
    // Position, size, then position again: a window grown past a screen's
    // edge is pushed back by the system, and the second move puts it right.
    withoutEnhanced(window.pid) {
        _ = setAttribute(element, "AXPosition", axValue(goal.origin))
        _ = setAttribute(element, "AXSize", axValue(goal.size))
        _ = setAttribute(element, "AXPosition", axValue(goal.origin))
        pause(150)
    }

    let now = info(window.id) ?? window
    let seen = frame(element)
    return ["window": describe(now), "bounds": box(seen.isNull ? now.bounds : seen)]
}

/* ---------------------------------------------------------------- *
 * Starting an app
 * ---------------------------------------------------------------- */

// What a model used to Windows reaches for, as the Mac's own.
private let aliases: [String: String] = [
    "notepad": "TextEdit", "calc": "Calculator", "explorer": "Finder", "cmd": "Terminal",
    "powershell": "Terminal", "control": "System Settings", "taskmgr": "Activity Monitor",
]

/// Arguments as a shell would split them, quotes kept together.
private func split(_ line: String) -> [String] {
    var parts: [String] = []
    var current = ""
    var quote: Character?
    var started = false
    for letter in line {
        if let open = quote {
            if letter == open { quote = nil } else { current.append(letter) }
        } else if letter == "\"" || letter == "'" {
            quote = letter
            started = true
        } else if letter == " " || letter == "\t" {
            if started || !current.isEmpty { parts.append(current) }
            current = ""
            started = false
        } else {
            current.append(letter)
        }
    }
    if started || !current.isEmpty { parts.append(current) }
    return parts
}

/// The way `open` would: a URL or settings pane, a file or folder, an app by
/// path, bundle id or name.
private func start(_ target: String, _ arguments: String) throws {
    let wanted = aliases[target.lowercased()] ?? target
    let expanded = (wanted as NSString).expandingTildeInPath
    var command: [String]
    if wanted.range(of: "^[A-Za-z][A-Za-z0-9+.-]*:", options: .regularExpression) != nil && !wanted.hasPrefix("/") {
        command = [wanted]
    } else if FileManager.default.fileExists(atPath: expanded) {
        command = expanded.hasSuffix(".app") ? ["-a", expanded] : [expanded]
    } else if wanted.range(of: "^[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+){2,}$", options: .regularExpression) != nil {
        command = ["-b", wanted]
    } else {
        command = ["-a", wanted]
    }
    let extra = split(arguments)
    // Arguments go to an app; a document or a URL takes none.
    if !extra.isEmpty, ["-a", "-b"].contains(command.first ?? "") { command += ["--args"] + extra }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = command
    let errors = Pipe()
    process.standardError = errors
    process.standardOutput = FileHandle.nullDevice
    do {
        try process.run()
    } catch {
        throw Stop("not-found", "Could not open \"\(target)\": \(error.localizedDescription)")
    }
    process.waitUntilExit()
    if process.terminationStatus != 0 {
        let said = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        throw Stop("not-found", "Could not open \"\(target)\": \(flat(said).isEmpty ? "macOS could not find it" : flat(said))")
    }
}

func launch(_ target: String, _ arguments: String) throws -> Json {
    try requireDriving()
    if target.isEmpty { throw Stop("bad-request", "Name the app to open.") }
    // What is on screen already, cheaply, so a new window stands out.
    let onScreen = { cgWindows([.optionOnScreenOnly, .excludeDesktopElements]).filter { $0.layer == 0 && !protected.contains($0.pid) } }
    let before = Set(onScreen().map { $0.id })
    try start(target, arguments)

    let started = Date()
    while Date().timeIntervalSince(started) < 15 {
        pause(250)
        try checkStop()
        guard onScreen().contains(where: { !before.contains($0.id) }) else { continue }
        // A window is often titled a beat after it appears.
        pause(200)
        if let fresh = listedWindows().first(where: { !before.contains($0.window.id) && !$0.minimized }) {
            bringForward(fresh.window)
            return ["window": describe(info(fresh.window.id) ?? fresh.window, title: fresh.title)]
        }
    }
    // A single-instance app raises the window it already had.
    if let id = frontWindow(), let window = info(id), !protected.contains(window.pid) {
        return ["window": describe(window, front: .some(id)), "note": "No new window appeared; this is the one in front now."]
    }
    throw Stop("no-window", "It started, but no window appeared within 15 seconds.")
}
