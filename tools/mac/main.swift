// The agent's hands on a Mac: the macOS twin of tools/DesktopHelper.cs.
//
// It reads a window's controls from the accessibility API, moves the real
// cursor to one of them along an eased path, and clicks or types there, so
// whoever is supervising sees where it is going. Built by
// scripts/build-desktop-helper.js with the swiftc that comes with the Xcode
// command line tools, against the frameworks inside macOS: no packages.
//
// The same protocol as the Windows helper, so src/main/ai/computer.js drives
// either: one long-lived process, JSON lines. Every request on stdin has an
// `id` and gets one answer on stdout with the same id and `ok`; events that
// nobody asked for (the user taking over, Esc) carry `event` instead.
//
// Where the two differ, it is the Mac's way of doing the same job:
//
//   ids      a window's id (`hwnd` in the protocol) is its CGWindowID
//   points   every x, y and size is in points, top-left of the main display
//            at 0,0: the space the cursor, the window list and the
//            accessibility API share. A screenshot's scale is pixels per
//            point, so on a Retina display it can be above 1.
//   rights   macOS asks the person, once, for Accessibility (to read apps,
//            move the cursor and watch for Esc) and Screen Recording (for
//            screenshots). Both are granted to Acestes, which started this.
//
// Refused whatever it is told: any window of the processes named with
// --protect (Acestes itself, so the agent can never click its own approval
// card). There is no elevation on the Mac to refuse.

import Cocoa
import ApplicationServices

let version = "1"

// On every event we post, so the tap can tell ours from the person's.
let mark: Int64 = 0x41434553

var protected = Set<pid_t>()
var capturable = false
let selfPid = getpid()

for (index, argument) in CommandLine.arguments.enumerated() {
    let next = index + 1 < CommandLine.arguments.count ? CommandLine.arguments[index + 1] : ""
    if argument == "--protect", let pid = pid_t(next) { protected.insert(pid) }
    // For recording a demo or checking the overlays: leaves them in
    // screenshots. Never passed by the app.
    if argument == "--capturable" { capturable = true }
}
protected.insert(selfPid)

/* ---------------------------------------------------------------- *
 * The line protocol
 * ---------------------------------------------------------------- */

private let writeLock = NSLock()

func emit(_ message: Json) {
    var safe = message
    if !JSONSerialization.isValidJSONObject(safe) {
        safe = ["ok": false, "code": "failed", "error": "The helper made an answer it could not write.", "id": message["id"] ?? NSNull()]
    }
    guard var data = try? JSONSerialization.data(withJSONObject: safe, options: [.withoutEscapingSlashes]) else { return }
    data.append(0x0A)
    writeLock.lock()
    defer { writeLock.unlock() }
    try? FileHandle.standardOutput.write(contentsOf: data)
}

func failure(_ code: String, _ message: String) -> Json {
    ["ok": false, "code": code, "error": message]
}

/// The main thread runs the overlays and the event tap; the work waits for it.
func onMain<T>(_ work: () -> T) -> T {
    Thread.isMainThread ? work() : DispatchQueue.main.sync(execute: work)
}

// One request at a time, in order, like the Windows helper's worker.
private let worker = DispatchQueue(label: "acestes.desktop.worker", qos: .userInitiated)

private func readRequests() {
    while let line = readLine(strippingNewline: true) {
        if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
        guard let data = line.data(using: .utf8),
              let request = (try? JSONSerialization.jsonObject(with: data)) as? Json else {
            emit(["event": "error", "error": "Unreadable request."])
            continue
        }
        // Stopping the action in hand cannot wait behind it in the queue.
        if text(request, "cmd") == "cancel" {
            cancelled = true
            continue
        }
        worker.async { work(request) }
    }
    // The app went away. So do we, rather than hold the tap for nobody.
    DispatchQueue.main.async { exit(0) }
}

private func work(_ request: Json) {
    let id = request["id"] ?? NSNull()
    let command = text(request, "cmd")
    cancelled = false
    acting = actions.contains(command)
    openBook(text(request, "owner"))
    var answer: Json
    do {
        answer = try handle(command, request)
        answer["ok"] = true
    } catch let stop as Stop {
        answer = failure(stop.code, stop.message)
    } catch {
        answer = failure("failed", error.localizedDescription)
    }
    acting = false
    closeBook()
    answer["id"] = id
    emit(answer)
}

private func handle(_ command: String, _ request: Json) throws -> Json {
    // Everything but these reads or works other apps, which macOS allows
    // only once the person has said so.
    if !["ping", "forget"].contains(command) && !(command == "drive" && !flag(request, "on")) { try requireTrust() }
    switch command {
    case "ping": return ["version": version, "elevated": false, "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
    case "windows": return listWindowsAnswer()
    case "foreground": return foregroundAnswer()
    case "focus": return try focus(windowId(request, "hwnd"))
    case "launch": return try launch(text(request, "target"), text(request, "args"))
    case "tree": return try tree(request)
    case "text": return try readText(request)
    case "capture": return try capture(request)
    case "captcha": return try captchas(request)
    case "target": return try target(request)
    case "click": return try click(request)
    case "type": return try typeText(request)
    case "keys": return try pressKeys(request)
    case "scroll": return try scroll(request)
    case "drag": return try drag(request)
    case "drive": return try drive(request)
    case "place": return try place(request)
    case "forget": return forget(text(request, "whose"))
    default: throw Stop("unknown", "Unknown command: \(command)")
    }
}

private var askedTrust = false

func requireTrust() throws {
    if AXIsProcessTrusted() { return }
    // The system's own prompt, once, pointing the person at the switch.
    if !askedTrust {
        askedTrust = true
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }
    throw Stop("permission", "macOS has not given Acestes Accessibility access, which reading and working other apps needs. "
        + "Ask the user to switch on Acestes Agent in System Settings > Privacy & Security > Accessibility (in a development "
        + "build, the app that started it), then try again.")
}

/* ---------------------------------------------------------------- *
 * Driving, and the person taking over
 * ---------------------------------------------------------------- */

// Driving: set by the caller for the length of a turn. Paused: the person
// took over, or pressed Esc, and nothing moves until the next turn.
var driving = false
var paused = false
var pauseCode = ""
var cancelled = false
// Set while an action is under way: the only time the person's hand on the
// mouse is a hand fighting the agent's.
var acting = false
var lastX: CGFloat = 0
var lastY: CGFloat = 0

private let actions: Set<String> = ["focus", "launch", "target", "click", "type", "keys", "scroll", "drag", "place"]

private var labelDriving = "The agent is using your computer · Esc to stop"
private var labelPaused = "Paused · you have control"
private var labelStopped = "Stopped"

private var tap: CFMachPort?

private func drive(_ request: Json) throws -> Json {
    if flag(request, "on") {
        if !text(request, "label").isEmpty { labelDriving = text(request, "label") }
        if !text(request, "paused").isEmpty { labelPaused = text(request, "paused") }
        if !text(request, "stopped").isEmpty { labelStopped = text(request, "stopped") }
        let here = cursor()
        lastX = here.x
        lastY = here.y
        paused = false
        pauseCode = ""
        // Without the tap nobody could stop it with Esc, so no tap, no driving.
        let watching = onMain { installTap() }
        if !watching {
            throw Stop("permission", "macOS did not let the helper watch the keyboard and mouse, so Esc could not stop it. "
                + "Ask the user to check Acestes Agent is on in System Settings > Privacy & Security > Accessibility.")
        }
        driving = true
        onMain { overlay.badge(labelDriving, .driving) }
    } else {
        driving = false
        paused = false
        pauseCode = ""
        onMain {
            removeTap()
            overlay.hideAll()
        }
    }
    return [:]
}

private func installTap() -> Bool {
    if tap != nil { return true }
    let kinds: [CGEventType] = [
        .mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown,
        .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel, .keyDown, .keyUp,
    ]
    let mask = kinds.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
    guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                       eventsOfInterest: mask, callback: { _, type, event, _ in tapped(type, event) },
                                       userInfo: nil) else { return false }
    let source = CFMachPortCreateRunLoopSource(nil, port, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: port, enable: true)
    tap = port
    return true
}

private func removeTap() {
    guard let port = tap else { return }
    CGEvent.tapEnable(tap: port, enable: false)
    CFMachPortInvalidate(port)
    tap = nil
}

/// The person's input, by the rule the badge promises. Clicking or typing
/// into Acestes is the person answering the agent (a card, a question, a
/// message), not taking over. Anywhere else it is. Moving the mouse only
/// counts while an action is under way; between actions it is someone
/// reaching for the Acestes window.
private func tapped(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
    let pass = Unmanaged.passUnretained(event)
    // A tap that took too long is switched off by the system; on again.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let port = tap { CGEvent.tapEnable(tap: port, enable: true) }
        return pass
    }
    guard driving, event.getIntegerValueField(.eventSourceUserData) != mark else { return pass }
    switch type {
    case .keyDown, .keyUp:
        if event.getIntegerValueField(.keyboardEventKeycode) == 53 {
            if type == .keyDown { escape() }
            // Swallowed, down and up: nothing on screen gets to see it, so
            // nothing on screen can use it to dismiss a dialog.
            return nil
        }
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        if type == .keyDown && !protected.contains(front) { takeOver("keyboard") }
    case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
        // A hand resting on a mouse drifts a pixel or two; a hand reaching
        // for it does not stop there.
        let at = event.location
        if acting && abs(at.x - lastX) + abs(at.y - lastY) > 8 { takeOver("mouse") }
    default:
        if !protected.contains(ownerAt(event.location)) { takeOver("mouse") }
    }
    return pass
}

private func takeOver(_ by: String) {
    if paused { return }
    paused = true
    pauseCode = "took-over"
    overlay.badge(labelPaused, .paused)
    DispatchQueue.global().async { emit(["event": "took-over", "by": by]) }
}

private func escape() {
    if paused && pauseCode == "escape" { return }
    paused = true
    pauseCode = "escape"
    overlay.badge(labelStopped, .stopped)
    DispatchQueue.global().async { emit(["event": "escape"]) }
}

/// Between every step of every action: has anyone said stop?
func checkStop() throws {
    if paused {
        throw pauseCode == "escape"
            ? Stop("escape", "The user pressed Esc to stop.")
            : Stop("took-over", "The user took control of the mouse or keyboard.")
    }
    if cancelled { throw Stop("cancelled", "Stopped by the app.") }
}

func requireDriving() throws {
    if !driving { throw Stop("not-driving", "Not driving: take the desktop first.") }
    try checkStop()
}

/* ---------------------------------------------------------------- *
 * Each agent's numbers
 *
 * Several conversations can share the desktop, each working in its own
 * window, and one reading its window must not renumber what another is
 * about to click. Every request names its owner, and the worker opens that
 * owner's book before handling it; it handles one request at a time, so
 * swapping the fields is safe.
 * ---------------------------------------------------------------- */

final class Book {
    var elements: [Int: AXUIElement] = [:]
    var roots: [Int: CGWindowID] = [:]
    var counter = 0
}

private var books: [String: Book] = [:]
private var book: Book?
var elements: [Int: AXUIElement] = [:]
var elementRoots: [Int: CGWindowID] = [:]
var counter = 0

private func openBook(_ owner: String) {
    let opened = books[owner] ?? Book()
    books[owner] = opened
    book = opened
    elements = opened.elements
    elementRoots = opened.roots
    counter = opened.counter
}

private func closeBook() {
    guard let open = book else { return }
    open.elements = elements
    open.roots = elementRoots
    open.counter = counter
}

/// A conversation gone: its numbers go with it.
private func forget(_ owner: String) -> Json {
    books.removeValue(forKey: owner)
    return [:]
}

/* ---------------------------------------------------------------- *
 * Start
 * ---------------------------------------------------------------- */

signal(SIGPIPE, SIG_IGN)
let application = NSApplication.shared
// No Dock icon and no menu bar of its own: the helper is never an app the
// person switches to.
application.setActivationPolicy(.accessory)
let overlay = Overlay()
// An app that has stopped answering holds a read for this long, not forever.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 3.0)

Thread { readRequests() }.start()
emit(["event": "ready", "version": version, "elevated": false,
      "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()])
application.run()
