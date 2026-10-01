// Small pieces every other file leans on: reading a request, the Stop that
// ends an action on purpose, and reading the accessibility tree without a
// round trip per attribute.

import Cocoa
import ApplicationServices

typealias Json = [String: Any]

/// An action that stopped on purpose, with a code the caller can act on.
struct Stop: Error {
    let code: String
    let message: String

    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

/* ---------------------------------------------------------------- *
 * Reading requests
 * ---------------------------------------------------------------- */

func text(_ request: Json, _ key: String) -> String {
    guard let value = request[key], !(value is NSNull) else { return "" }
    if let string = value as? String { return string }
    if let number = value as? NSNumber { return number.stringValue }
    return "\(value)"
}

func number(_ request: Json, _ key: String, _ fallback: Int) -> Int {
    guard let value = request[key], !(value is NSNull) else { return fallback }
    var raw: Double?
    if let number = value as? NSNumber { raw = number.doubleValue }
    if let string = value as? String { raw = Double(string) }
    guard let found = raw, found.isFinite, abs(found) < 1e12 else { return fallback }
    return Int(found.rounded())
}

/// True only for a real JSON true, as the Windows helper reads it.
func flag(_ request: Json, _ key: String) -> Bool {
    guard let value = request[key] as? NSNumber else { return false }
    return CFGetTypeID(value) == CFBooleanGetTypeID() && value.boolValue
}

/// A window's id: its CGWindowID, which list_windows hands out as `hwnd`.
func windowId(_ request: Json, _ key: String) -> CGWindowID {
    let value = number(request, key, 0)
    return value > 0 && value <= Int(UInt32.max) ? CGWindowID(value) : 0
}

func rectList(_ request: Json, _ key: String) -> [Int]? {
    guard let values = request[key] as? [Any], values.count == 4 else { return nil }
    let numbers = values.compactMap { ($0 as? NSNumber)?.doubleValue }
    guard numbers.count == 4, numbers.allSatisfy({ $0.isFinite }) else { return nil }
    return numbers.map { Int($0.rounded()) }
}

func clip(_ text: String, _ length: Int) -> String {
    text.count <= length ? text : String(text.prefix(length)) + "…"
}

/// One line: what an app says is laid out across lines reads as one name.
func flat(_ text: String) -> String {
    text.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
        .trimmingCharacters(in: .whitespaces)
}

func pause(_ milliseconds: Int) {
    if milliseconds > 0 { usleep(useconds_t(min(milliseconds, 600_000)) * 1000) }
}

/// Integers for the answer, never NaN, which JSON cannot carry.
func whole(_ value: CGFloat) -> Int {
    value.isFinite ? Int(value.rounded()) : 0
}

func box(_ rect: CGRect) -> [Int] {
    rect.isNull ? [0, 0, 0, 0] : [whole(rect.origin.x), whole(rect.origin.y), whole(rect.width), whole(rect.height)]
}

/* ---------------------------------------------------------------- *
 * The accessibility tree
 * ---------------------------------------------------------------- */

/// Everything asked of an element in one round trip, like a UI Automation
/// cache: an app that answers one attribute at a time is a slow read.
func fetch(_ element: AXUIElement, _ names: [String]) -> [String: AnyObject] {
    var raw: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(element, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw) == .success,
          let values = raw as? [AnyObject], values.count == names.count else { return [:] }
    var found: [String: AnyObject] = [:]
    for (index, value) in values.enumerated() {
        if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError { continue }
        found[names[index]] = value
    }
    return found
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func string(_ element: AXUIElement, _ name: String) -> String {
    stringOf(attribute(element, name))
}

func stringOf(_ value: AnyObject?) -> String {
    guard let value = value else { return "" }
    if let string = value as? String { return string }
    if let attributed = value as? NSAttributedString { return attributed.string }
    return ""
}

func boolOf(_ value: AnyObject?) -> Bool? {
    guard let number = value as? NSNumber else { return nil }
    return number.boolValue
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    (attribute(element, "AXChildren") as? [AXUIElement]) ?? []
}

func parent(_ element: AXUIElement) -> AXUIElement? {
    guard let value = attribute(element, "AXParent"), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func elementOf(_ value: AnyObject?) -> AXUIElement? {
    guard let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func pointOf(_ value: AnyObject?) -> CGPoint? {
    guard let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(value as! AXValue, .cgPoint, &point) ? point : nil
}

func sizeOf(_ value: AnyObject?) -> CGSize? {
    guard let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(value as! AXValue, .cgSize, &size) ? size : nil
}

/// Where an element is, in the same top-left, point-based space as the
/// cursor and the window list. Null when the app gives it no place.
func frame(_ element: AXUIElement) -> CGRect {
    let values = fetch(element, ["AXPosition", "AXSize"])
    return frameOf(values)
}

func frameOf(_ values: [String: AnyObject]) -> CGRect {
    guard let origin = pointOf(values["AXPosition"]), let size = sizeOf(values["AXSize"]) else { return .null }
    return CGRect(origin: origin, size: size)
}

func pidOf(_ element: AXUIElement) -> pid_t {
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    return pid
}

func setAttribute(_ element: AXUIElement, _ name: String, _ value: AnyObject) -> Bool {
    AXUIElementSetAttributeValue(element, name as CFString, value) == .success
}

func axValue(_ point: CGPoint) -> AXValue {
    var copy = point
    return AXValueCreate(.cgPoint, &copy)!
}

func axValue(_ size: CGSize) -> AXValue {
    var copy = size
    return AXValueCreate(.cgSize, &copy)!
}

/// The window an AX window element is, by its CGWindowID. The call is
/// private, and the one every window manager on the Mac uses; looked up at
/// run time so a macOS without it falls back to matching by frame.
private typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
private let getWindow: GetWindow? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
    return unsafeBitCast(symbol, to: GetWindow.self)
}()

func windowNumber(_ element: AXUIElement) -> CGWindowID? {
    guard let call = getWindow else { return nil }
    var id: CGWindowID = 0
    return call(element, &id) == .success && id != 0 ? id : nil
}
