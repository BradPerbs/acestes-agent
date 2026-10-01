// Moving, clicking, typing: real events posted where the hardware's go, so
// the cursor the person watches is the one doing the work. Every event
// carries the mark, which is how the tap tells them from the person's.

import Cocoa
import Carbon

private let source = CGEventSource(stateID: .hidSystemState)
private var held: CGMouseButton?

func cursor() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
}

private func post(_ event: CGEvent?) {
    guard let event = event else { return }
    event.setIntegerValueField(.eventSourceUserData, value: mark)
    event.post(tap: .cghidEventTap)
}

/// All the displays together: a point past their edge is brought back in.
private func desktop() -> CGRect {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    return ids.prefix(Int(count)).reduce(CGRect.null) { $0.union(CGDisplayBounds($1)) }
}

private func moveTo(_ x: CGFloat, _ y: CGFloat, within bounds: CGRect) {
    var point = CGPoint(x: x.rounded(), y: y.rounded())
    if !bounds.isNull {
        point.x = min(max(point.x, bounds.minX), bounds.maxX - 1)
        point.y = min(max(point.y, bounds.minY), bounds.maxY - 1)
    }
    // With a button down the system wants a drag, not a move, or nothing
    // under the cursor sees the button held.
    let kind: CGEventType
    switch held {
    case .some(.left): kind = .leftMouseDragged
    case .some(.right): kind = .rightMouseDragged
    case .some: kind = .otherMouseDragged
    case .none: kind = .mouseMoved
    }
    post(CGEvent(mouseEventSource: source, mouseType: kind, mouseCursorPosition: point, mouseButton: held ?? .left))
    lastX = point.x
    lastY = point.y
}

private func press(_ button: CGMouseButton, down: Bool, at point: CGPoint, clicks: Int, flags: CGEventFlags) {
    let kind: CGEventType
    switch button {
    case .left: kind = down ? .leftMouseDown : .leftMouseUp
    case .right: kind = down ? .rightMouseDown : .rightMouseUp
    default: kind = down ? .otherMouseDown : .otherMouseUp
    }
    let event = CGEvent(mouseEventSource: source, mouseType: kind, mouseCursorPosition: point, mouseButton: button)
    // A double click is the second press saying it is the second.
    event?.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
    event?.flags = flags
    post(event)
    held = down ? button : nil
}

/// The real cursor, eased in and out along a shallow bow, so it reads as a
/// hand reaching rather than a ruler. Longer trips take a little longer,
/// within reason. Checked for a stop at every step.
func glide(_ x: CGFloat, _ y: CGFloat, _ duration: Int) throws {
    let bounds = desktop()
    let from = cursor()
    let dx = x - from.x
    let dy = y - from.y
    let distance = (dx * dx + dy * dy).squareRoot()
    if distance < 3 || duration <= 0 {
        moveTo(x, y, within: bounds)
        return
    }

    let scale = max(0.45, min(1.35, (distance / 700).squareRoot()))
    let total = Double(duration) * Double(scale)
    let frames = max(4, Int(total) / 10)
    let normalX = -dy / distance
    let normalY = dx / distance
    let bow = min(40, distance * 0.08) * ((Int(x) + Int(y)) & 1 == 0 ? 1 : -1)

    let started = Date()
    for frame in 1...frames {
        try checkStop()
        let t = CGFloat(frame) / CGFloat(frames)
        let eased = t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
        let arc = sin(.pi * t) * bow
        moveTo(from.x + dx * eased + normalX * arc, from.y + dy * eased + normalY * arc, within: bounds)
        pause(Int(total * Double(t) - Date().timeIntervalSince(started) * 1000))
    }
    moveTo(x, y, within: bounds)
}

private func chance() -> CGFloat { CGFloat.random(in: 0..<1) }

/// The cursor as a hand moves it, for the widgets that judge a person by how
/// the pointer arrives (a captcha's checkbox): a curve that differs every
/// time, quick off the mark and slow to settle, a slight tremor on the way,
/// and on a longer reach a small overshoot put right. Checked for a stop at
/// every step, like glide.
func reach(_ x: CGFloat, _ y: CGFloat, _ duration: Int, correcting: Bool = false) throws {
    let bounds = desktop()
    let from = cursor()
    let dx = x - from.x
    let dy = y - from.y
    let distance = (dx * dx + dy * dy).squareRoot()
    if distance < 2 || duration <= 0 {
        moveTo(x, y, within: bounds)
        return
    }

    var aimX = x
    var aimY = y
    let overshoot = !correcting && distance > 180 && chance() < 0.55
    if overshoot {
        let past = 3 + chance() * min(14, distance * 0.025)
        aimX = (x + dx / distance * past + (chance() - 0.5) * 4).rounded()
        aimY = (y + dy / distance * past + (chance() - 0.5) * 4).rounded()
    }
    let ax = aimX - from.x
    let ay = aimY - from.y
    let normalX = -dy / distance
    let normalY = dx / distance
    let spread = min(90, distance * (0.08 + chance() * 0.17))
    let side: CGFloat = chance() < 0.5 ? -1 : 1
    let f1 = 0.2 + chance() * 0.2
    let f2 = 0.6 + chance() * 0.2
    let b1 = spread * side * (0.5 + chance() * 0.5)
    let b2 = spread * side * (chance() - 0.3) * 0.8
    let c1x = from.x + ax * f1 + normalX * b1
    let c1y = from.y + ay * f1 + normalY * b1
    let c2x = from.x + ax * f2 + normalX * b2
    let c2y = from.y + ay * f2 + normalY * b2

    let scale = max(0.5, min(1.4, (distance / 650).squareRoot()))
    var total = Double(duration) * Double(scale) * Double(0.85 + chance() * 0.35)
    if correcting { total = max(60, total / 3) }
    let frames = max(6, Int(total) / 9)

    let started = Date()
    for frame in 1...frames {
        try checkStop()
        let t = CGFloat(frame) / CGFloat(frames)
        let u = pow(t, 0.8)
        let s = u * u * u * (10 - 15 * u + 6 * u * u)
        let r = 1 - s
        var px = r * r * r * from.x + 3 * r * r * s * c1x + 3 * r * s * s * c2x + s * s * s * aimX
        var py = r * r * r * from.y + 3 * r * r * s * c1y + 3 * r * s * s * c2y + s * s * s * aimY
        let shake = frame < frames ? r * 0.9 : 0
        px += (chance() - 0.5) * 2 * shake
        py += (chance() - 0.5) * 2 * shake
        moveTo(px, py, within: bounds)
        pause(Int(total * Double(t) - Date().timeIntervalSince(started) * 1000))
    }
    moveTo(aimX, aimY, within: bounds)
    if overshoot {
        pause(40 + Int.random(in: 0..<90))
        try reach(x, y, duration, correcting: true)
    }
}

func click(_ request: Json) throws -> Json {
    try requireDriving()
    let point = CGPoint(x: number(request, "x", 0), y: number(request, "y", 0))
    let button = text(request, "button")
    let count = max(1, min(3, number(request, "count", 1)))
    let duration = number(request, "glide", 300)
    let modifiers = try combo(text(request, "modifiers"), modifiersOnly: true)
    let natural = flag(request, "natural")

    showOutline(request)
    if natural {
        try reach(point.x, point.y, duration)
        // A hand arrives, then presses.
        pause(60 + Int.random(in: 0..<160))
    } else {
        try glide(point.x, point.y, duration)
    }
    try checkStop()
    try allowed(windowAt(point))

    let which: CGMouseButton = button == "right" ? .right : button == "middle" ? .center : .left
    do {
        let flags = hold(modifiers)
        defer { letGo(modifiers) }
        for index in 0..<count {
            press(which, down: true, at: point, clicks: index + 1, flags: flags)
            pause(natural ? 55 + Int.random(in: 0..<75) : 25)
            press(which, down: false, at: point, clicks: index + 1, flags: flags)
            if index < count - 1 { pause(70) }
        }
    }

    DispatchQueue.main.async {
        overlay.ripple(point)
        overlay.fadeOutline()
    }
    pause(number(request, "settle", 120))
    return after(point)
}

func scroll(_ request: Json) throws -> Json {
    try requireDriving()
    let point = CGPoint(x: number(request, "x", 0), y: number(request, "y", 0))
    let direction = text(request, "direction")
    let amount = max(1, min(30, number(request, "amount", 3)))

    showOutline(request)
    try glide(point.x, point.y, number(request, "glide", 300))
    try allowed(windowAt(point))
    // A notch of a Windows wheel, about three lines. Positive is towards
    // the top or the left of what is scrolled.
    let notch: Int32 = 100
    let vertical: Int32 = direction == "up" ? notch : direction == "down" ? -notch : 0
    let sideways: Int32 = direction == "left" ? notch : direction == "right" ? -notch : 0
    for _ in 0..<amount {
        try checkStop()
        post(CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: vertical, wheel2: sideways, wheel3: 0))
        pause(40)
    }
    DispatchQueue.main.async { overlay.fadeOutline() }
    pause(100)
    return after(point)
}

func drag(_ request: Json) throws -> Json {
    try requireDriving()
    let from = CGPoint(x: number(request, "x", 0), y: number(request, "y", 0))
    let to = CGPoint(x: number(request, "toX", 0), y: number(request, "toY", 0))
    let duration = number(request, "glide", 300)

    try glide(from.x, from.y, duration)
    try allowed(windowAt(from))
    press(.left, down: true, at: from, clicks: 1, flags: [])
    do {
        // Never left holding the button, whatever stopped the move.
        defer { press(.left, down: false, at: cursor(), clicks: 1, flags: []) }
        pause(50)
        // Slower with the button down: a drag is the move people watch.
        try glide(to.x, to.y, duration * 2)
        try allowed(windowAt(to))
        pause(50)
    }
    DispatchQueue.main.async { overlay.ripple(to) }
    pause(100)
    return after(to)
}

private func frontApp() -> pid_t {
    NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
}

/// Keys go to whatever has the focus, which must not be Acestes.
private func frontAllowed() throws {
    if protected.contains(frontApp()) { throw Stop("protected", "That is on the Acestes window itself, which the agent may not touch.") }
    if let id = frontWindow() { try allowed(info(id)) }
}

func typeText(_ request: Json) throws -> Json {
    try requireDriving()
    let words = text(request, "text")
    let perSecond = max(5, min(400, number(request, "cps", 30)))
    let gap = 1000.0 / Double(perSecond)
    try frontAllowed()
    let app = frontApp()
    let window = frontWindow()
    let total = words.utf16.count

    var done = 0
    for (index, letter) in words.enumerated() {
        try checkStop()
        // Typing into whatever took the focus meanwhile is worse than stopping.
        if frontApp() != app || (index % 8 == 0 && frontWindow() != window) {
            throw Stop("focus-moved", "The window in front changed while typing, after \(done) of \(total) characters.")
        }
        if letter == "\r" {
        } else if letter == "\n" || letter == "\r\n" {
            tap(36)
        } else if letter == "\t" {
            tap(48)
        } else {
            unicode(letter)
        }
        done += String(letter).utf16.count
        // The same average pace, never the same gap twice: a metronome reads
        // as a machine, a rhythm as someone typing.
        pause(max(1, Int(gap * Double.random(in: 0.55..<1.45))))
    }
    var answer: Json = ["typed": total]
    if let id = frontWindow(), let front = info(id) { answer["window"] = describe(front, front: .some(id)) }
    return answer
}

/// Any character, whatever the keyboard layout: the event says what it
/// types rather than which key.
private func unicode(_ letter: Character) {
    let units = Array(String(letter).utf16)
    for down in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        units.withUnsafeBufferPointer { buffer in
            event?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
        }
        event?.flags = []
        post(event)
    }
}

private func keyEvent(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) {
    let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
    event?.flags = flags
    post(event)
}

private func tap(_ code: CGKeyCode) {
    keyEvent(code, down: true, flags: [])
    pause(15)
    keyEvent(code, down: false, flags: [])
}

func pressKeys(_ request: Json) throws -> Json {
    try requireDriving()
    try frontAllowed()
    let keys = try combo(text(request, "keys"), modifiersOnly: false)
    if keys.isEmpty { throw Stop("bad-request", "Name the keys, like \"cmd+s\" or \"enter\".") }
    let times = max(1, min(50, number(request, "repeat", 1)))
    for _ in 0..<times {
        try checkStop()
        var flags: CGEventFlags = []
        for key in keys {
            flags.formUnion(key.flag)
            keyEvent(key.code, down: true, flags: flags.union(key.extra))
        }
        pause(20)
        for key in keys.reversed() {
            flags.subtract(key.flag)
            keyEvent(key.code, down: false, flags: key.modifier ? flags : flags.union(key.flag).union(key.extra))
        }
        pause(40)
    }
    pause(80)
    var answer: Json = [:]
    if let id = frontWindow(), let front = info(id) { answer["window"] = describe(front, front: .some(id)) }
    return answer
}

/// Modifier keys pressed for a click, so an app that asks what is held hears it too.
private func hold(_ modifiers: [Key]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for key in modifiers {
        flags.formUnion(key.flag)
        keyEvent(key.code, down: true, flags: flags)
    }
    return flags
}

private func letGo(_ modifiers: [Key]) {
    var flags = modifiers.reduce(CGEventFlags()) { $0.union($1.flag) }
    for key in modifiers.reversed() {
        flags.subtract(key.flag)
        keyEvent(key.code, down: false, flags: flags)
    }
}

/// What the cursor is on now, and which window is in front: how the agent knows the click landed.
private func after(_ point: CGPoint) -> Json {
    var answer: Json = [:]
    if let under = at(point) { answer["under"] = summary(under) }
    if let id = frontWindow(), let front = info(id) { answer["window"] = describe(front, front: .some(id)) }
    return answer
}

private func showOutline(_ request: Json) {
    guard let rect = rectList(request, "rect") else { return }
    let area = CGRect(x: rect[0], y: rect[1], width: rect[2], height: rect[3])
    DispatchQueue.main.async { overlay.outline(area) }
}

/* ---------------------------------------------------------------- *
 * Keys by name
 * ---------------------------------------------------------------- */

struct Key {
    let code: CGKeyCode
    var flag: CGEventFlags = []
    // What the hardware sends with it: arrows are on the keypad, and the
    // keys above them on the function layer.
    var extra: CGEventFlags = []
    var modifier: Bool { !flag.isEmpty }
}

private let fnLayer: CGEventFlags = .maskSecondaryFn
private let arrows: CGEventFlags = [.maskSecondaryFn, .maskNumericPad]

private let named: [String: Key] = [
    "ctrl": Key(code: 59, flag: .maskControl), "control": Key(code: 59, flag: .maskControl),
    "shift": Key(code: 56, flag: .maskShift),
    "alt": Key(code: 58, flag: .maskAlternate), "option": Key(code: 58, flag: .maskAlternate), "opt": Key(code: 58, flag: .maskAlternate),
    "cmd": Key(code: 55, flag: .maskCommand), "command": Key(code: 55, flag: .maskCommand), "meta": Key(code: 55, flag: .maskCommand),
    "super": Key(code: 55, flag: .maskCommand), "win": Key(code: 55, flag: .maskCommand), "windows": Key(code: 55, flag: .maskCommand),
    "fn": Key(code: 63, flag: .maskSecondaryFn),
    "enter": Key(code: 36), "return": Key(code: 36), "tab": Key(code: 48), "esc": Key(code: 53), "escape": Key(code: 53),
    "space": Key(code: 49), "backspace": Key(code: 51),
    "delete": Key(code: 117, extra: fnLayer), "del": Key(code: 117, extra: fnLayer), "forwarddelete": Key(code: 117, extra: fnLayer),
    "insert": Key(code: 114, extra: fnLayer), "help": Key(code: 114, extra: fnLayer),
    "home": Key(code: 115, extra: fnLayer), "end": Key(code: 119, extra: fnLayer),
    "pageup": Key(code: 116, extra: fnLayer), "pgup": Key(code: 116, extra: fnLayer),
    "pagedown": Key(code: 121, extra: fnLayer), "pgdn": Key(code: 121, extra: fnLayer),
    "up": Key(code: 126, extra: arrows), "down": Key(code: 125, extra: arrows),
    "left": Key(code: 123, extra: arrows), "right": Key(code: 124, extra: arrows),
    "capslock": Key(code: 57), "plus": Key(code: 24), "minus": Key(code: 27),
]

private let functionKeys: [CGKeyCode] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90]

// What a Windows habit asks for that a Mac keyboard does not have.
private let missing: [String: String] = [
    "printscreen": "There is no Print Screen key on a Mac: take a screenshot with the screenshot tool instead.",
    "menu": "There is no menu key on a Mac: right-click instead.",
    "apps": "There is no menu key on a Mac: right-click instead.",
]

/// "cmd+shift+s" as keys, modifiers first as written.
func combo(_ line: String, modifiersOnly: Bool) throws -> [Key] {
    var keys: [Key] = []
    for raw in line.lowercased().split(separator: "+", omittingEmptySubsequences: true) {
        let part = raw.trimmingCharacters(in: .whitespaces)
        if part.isEmpty { continue }
        if let key = named[part] {
            if modifiersOnly && !key.modifier { throw Stop("bad-request", "Unknown key \"\(part)\".") }
            keys.append(key)
            continue
        }
        if let note = missing[part] { throw Stop("bad-request", note) }
        if part.count > 1, part.first == "f", let number = Int(part.dropFirst()), number >= 1, number <= functionKeys.count {
            keys.append(Key(code: functionKeys[number - 1], extra: fnLayer))
            continue
        }
        if part.count == 1 && !modifiersOnly {
            guard let found = layout[part] else {
                throw Stop("bad-request", "There is no key for \"\(part)\" on this keyboard layout.")
            }
            if found.1.contains(.maskShift) { keys.append(named["shift"]!) }
            if found.1.contains(.maskAlternate) { keys.append(named["alt"]!) }
            keys.append(Key(code: found.0))
            continue
        }
        throw Stop("bad-request", "Unknown key \"\(part)\".")
    }
    return keys
}

/// Which key types each character on the keyboard layout in use, and with
/// which of shift and option: cmd+z is the key marked Z, wherever it is.
/// Asked of the main thread, where the input source calls must be made.
private let layout: [String: (CGKeyCode, CGEventFlags)] = onMain { readLayout() }

private func readLayout() -> [String: (CGKeyCode, CGEventFlags)] {
    var map: [String: (CGKeyCode, CGEventFlags)] = [:]
    let current = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue()
    let source = current.flatMap { TISGetInputSourceProperty($0, kTISPropertyUnicodeKeyLayoutData) != nil ? $0 : nil }
        ?? TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue()
    if let source = source, let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) {
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        data.withUnsafeBytes { bytes in
            guard let keyboard = bytes.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
            // Shift and option as UCKeyTranslate counts them: Carbon's masks, shifted down a byte.
            let states: [(UInt32, CGEventFlags)] = [(0, []), (2, .maskShift), (8, .maskAlternate), (10, [.maskShift, .maskAlternate])]
            for (state, flags) in states {
                for code in 0..<128 {
                    var dead: UInt32 = 0
                    var length = 0
                    var chars = [UniChar](repeating: 0, count: 4)
                    let status = UCKeyTranslate(keyboard, UInt16(code), UInt16(kUCKeyActionDown), state, UInt32(LMGetKbdType()),
                                                OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, 4, &length, &chars)
                    guard status == noErr, length > 0 else { continue }
                    let typed = String(utf16CodeUnits: chars, count: length).lowercased()
                    if map[typed] == nil { map[typed] = (CGKeyCode(code), flags) }
                }
            }
        }
    }
    // The US layout, for anything the layout in use did not say.
    let us: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
        "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
        "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
        "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
    ]
    for (letter, code) in us where map[letter] == nil { map[letter] = (code, []) }
    return map
}
