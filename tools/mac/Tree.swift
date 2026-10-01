// Seeing: a window's accessibility tree, as the numbered elements the agent
// acts on, in the same shape and with the same role names as the Windows
// helper's UI Automation reads, so the agent reads both alike.

import Cocoa
import ApplicationServices

let maxVisited = 2500
let maxChildren = 80
let maxDepth = 40

private let interactive: Set<String> = [
    "button", "check box", "combo box", "edit", "link", "list item", "menu item",
    "radio button", "slider", "spinner", "tab item", "tree item", "data item", "document", "calendar",
]

private let containers: Set<String> = [
    "window", "pane", "group", "tab", "list", "tree", "table", "tool bar", "menu bar", "menu", "status bar",
]

// Chrome of the chrome: never what anyone means to click.
private let skipped: Set<String> = ["scroll bar", "thumb", "column"]

// Read in one round trip per element, children included.
private let fields = [
    "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXEnabled", "AXFocused", "AXPosition",
    "AXSize", "AXSelected", "AXExpanded", "AXDisclosing", "AXPlaceholderValue", "AXChildren",
]

/// What one element is, from one fetch.
struct Seen {
    let values: [String: AnyObject]
    let axRole: String
    let subrole: String
    let role: String
    let name: String
    let frame: CGRect
    let kids: [AXUIElement]
    var password: Bool { subrole == "AXSecureTextField" }
}

func see(_ element: AXUIElement, parentRole: String = "", extra: [String] = []) -> Seen {
    let values = fetch(element, fields + extra)
    let axRole = stringOf(values["AXRole"])
    let subrole = stringOf(values["AXSubrole"])
    let role = roleName(axRole, subrole, parentRole)
    return Seen(values: values, axRole: axRole, subrole: subrole, role: role, name: nameOf(values, role: role),
                frame: frameOf(values), kids: (values["AXChildren"] as? [AXUIElement]) ?? [])
}

/// The Mac's roles in the words the Windows helper uses for the same things.
func roleName(_ role: String, _ subrole: String, _ parentRole: String) -> String {
    switch role {
    case "AXButton", "AXMenuButton", "AXDisclosureTriangle", "AXColorWell": return "button"
    case "AXPopUpButton", "AXComboBox": return "combo box"
    case "AXCheckBox": return "check box"
    case "AXRadioButton": return parentRole == "AXTabGroup" ? "tab item" : "radio button"
    case "AXTextField", "AXTextArea", "AXSearchField", "AXDateField", "AXTimeField": return "edit"
    case "AXStaticText": return "text"
    case "AXHeading": return "heading"
    case "AXLink": return "link"
    case "AXImage": return "image"
    case "AXGroup", "AXRadioGroup", "AXCheckBoxGroup": return "group"
    case "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXDrawer": return "pane"
    case "AXList": return "list"
    case "AXOutline", "AXBrowser": return "tree"
    case "AXTable", "AXGrid": return "table"
    case "AXRow": return parentRole == "AXOutline" ? "tree item" : parentRole == "AXList" ? "list item" : "data item"
    case "AXCell": return "data item"
    case "AXColumn": return "column"
    case "AXScrollBar": return "scroll bar"
    case "AXValueIndicator", "AXSplitter", "AXGrowArea", "AXRuler", "AXRulerMarker", "AXMatte", "AXHandle": return "thumb"
    case "AXSlider": return "slider"
    case "AXIncrementor", "AXStepper": return "spinner"
    case "AXTabGroup": return "tab"
    case "AXToolbar": return "tool bar"
    case "AXMenuBar": return "menu bar"
    case "AXMenuBarItem", "AXMenuItem": return "menu item"
    case "AXMenu": return "menu"
    case "AXWebArea": return "document"
    case "AXWindow", "AXSheet", "AXPopover": return "window"
    case "AXProgressIndicator", "AXBusyIndicator", "AXLevelIndicator", "AXRelevanceIndicator": return "progress bar"
    case "AXHelpTag": return "tool tip"
    case "AXApplication": return "application"
    default: return "element"
    }
}

/// What a person would call it: its title, its description, the words of a
/// piece of text, or a field's placeholder.
func nameOf(_ values: [String: AnyObject], role: String) -> String {
    let title = flat(stringOf(values["AXTitle"]))
    if !title.isEmpty { return title }
    if role == "text" || role == "heading" {
        let words = flat(stringOf(values["AXValue"]))
        if !words.isEmpty { return words }
    }
    let description = flat(stringOf(values["AXDescription"]))
    if !description.isEmpty { return description }
    if role == "edit" || role == "combo box" { return flat(stringOf(values["AXPlaceholderValue"])) }
    return ""
}

/* ---------------------------------------------------------------- *
 * Waking an app's accessibility
 * ---------------------------------------------------------------- */

// Chromium and Firefox build their accessibility tree only once an
// assistive app says it is there; Electron apps answer to a flag of their own.
private let browsers: Set<String> = [
    "com.google.Chrome", "com.google.Chrome.canary", "com.microsoft.edgemac", "com.brave.Browser",
    "company.thebrowser.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "org.chromium.Chromium",
    "org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition",
]
private var woken = Set<pid_t>()
private(set) var enhanced = Set<pid_t>()

func wake(_ pid: pid_t) {
    if woken.contains(pid) { return }
    woken.insert(pid)
    let app = AXUIElementCreateApplication(pid)
    var changed = setAttribute(app, "AXManualAccessibility", axTrue)
    if let id = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier, browsers.contains(id) {
        if setAttribute(app, "AXEnhancedUserInterface", axTrue) {
            enhanced.insert(pid)
            changed = true
        }
    }
    // The tree is built a moment after it is asked for.
    if changed { pause(400) }
}

/// The enhanced interface animates every move a window makes, which turns
/// arranging windows into a slow slide; it is off for the length of one.
func withoutEnhanced(_ pid: pid_t, _ work: () -> Void) {
    guard enhanced.contains(pid) else { return work() }
    let app = AXUIElementCreateApplication(pid)
    _ = setAttribute(app, "AXEnhancedUserInterface", axFalse)
    work()
    _ = setAttribute(app, "AXEnhancedUserInterface", axTrue)
}

/* ---------------------------------------------------------------- *
 * The tree
 * ---------------------------------------------------------------- */

final class WalkState {
    var limit = 500
    var visited = 0
    var truncated = false
    var offscreen = false
    var register = true
    var find: String?
    var findRole = ""
    var found: Json?
    var nodes: [Json] = []
}

private struct Root {
    let element: AXUIElement
    let window: CGWindowID
    let menuBar: Bool
    // What of it can be seen: the window, for the window itself. A menu or
    // the menu bar sits outside it, and is taken as all on screen.
    var view = CGRect.null
}

func tree(_ request: Json) throws -> Json {
    let limit = max(20, min(1500, number(request, "maxNodes", 500)))
    var roots: [Root] = []
    var wanted = windowId(request, "hwnd")
    let under = number(request, "under", 0)

    if under > 0 {
        let start = try lookup(under)
        wanted = elementRoots[under] ?? 0
        roots.append(Root(element: start, window: wanted, menuBar: false, view: info(wanted)?.bounds ?? .null))
    } else {
        let window = try existing(wanted)
        if protected.contains(window.pid) { throw Stop("protected", "That is the Acestes window itself, which the agent may not read.") }
        wake(window.pid)
        guard let element = axWindow(window) else {
            throw Stop("gone", "That window cannot be read: its app does not describe its windows. Take a screenshot instead.")
        }
        roots = rootsFor(window, element)
    }
    guard let window = info(wanted) else { throw Stop("gone", "That window is gone. List the windows again.") }

    // What is scrolled away is counted, not listed: most of a long page is
    // off screen, and listing it made every read several times the size of
    // what the person can see. A minimised window is all off screen, so
    // there it is listed after all.
    let state = WalkState()
    state.limit = limit
    state.offscreen = flag(request, "offscreen") || !window.onScreen

    // Looking for something is a walk that numbers nothing, so the numbers
    // the agent holds stay good while it waits.
    let sought = text(request, "find")
    if !sought.isEmpty {
        state.register = false
        state.find = sought
        state.findRole = text(request, "role").lowercased()
        state.offscreen = true
        for root in roots where !state.truncated {
            _ = walk(root.element, root: root.window, depth: 0, shown: 0, state: state, above: "", view: root.view, parentRole: "", menuBar: root.menuBar)
        }
        var search: Json = ["window": describe(window)]
        if let found = state.found { search["found"] = found }
        return search
    }

    elements = [:]
    elementRoots = [:]
    counter = 0
    for root in roots where !state.truncated {
        _ = walk(root.element, root: root.window, depth: 0, shown: 0, state: state, above: "", view: root.view, parentRole: "", menuBar: root.menuBar)
    }
    return ["window": describe(window), "nodes": state.nodes, "truncated": state.truncated]
}

/// The window, whatever the same app has open over it (a dialog, a
/// palette, a menu), and its menu bar, where much of a Mac app lives.
private func rootsFor(_ window: WindowInfo, _ element: AXUIElement) -> [Root] {
    var roots = [Root(element: element, window: window.id, menuBar: false, view: window.bounds)]
    let app = AXUIElementCreateApplication(window.pid)
    for other in axWindows(window.pid) where !CFEqual(other, element) {
        let values = fetch(other, ["AXSubrole", "AXMinimized", "AXPosition", "AXSize"])
        let kind = stringOf(values["AXSubrole"])
        guard ["AXDialog", "AXSystemDialog", "AXFloatingWindow", "AXSystemFloatingWindow"].contains(kind),
              boolOf(values["AXMinimized"]) != true, frameOf(values).intersects(window.bounds) else { continue }
        roots.append(Root(element: other, window: windowNumber(other) ?? window.id, menuBar: false))
    }
    let top = fetch(app, ["AXChildren", "AXMenuBar"])
    for child in (top["AXChildren"] as? [AXUIElement]) ?? [] where string(child, "AXRole") == "AXMenu" {
        roots.append(Root(element: child, window: window.id, menuBar: false))
    }
    if let bar = elementOf(top["AXMenuBar"]) { roots.append(Root(element: bar, window: window.id, menuBar: true)) }
    return roots
}

/// One element and what it holds. True when it was left out for being
/// scrolled away, so the one holding it can count it.
private func walk(_ element: AXUIElement, root: CGWindowID, depth: Int, shown: Int, state: WalkState, above: String,
                  view: CGRect, parentRole: String, menuBar: Bool) -> Bool {
    if state.truncated { return false }
    state.visited += 1
    if state.visited > maxVisited || state.nodes.count >= state.limit {
        state.truncated = true
        return false
    }

    let seen = see(element, parentRole: parentRole)
    let role = seen.role
    if skipped.contains(role) { return false }
    let name = seen.name
    let off = depth > 0 && isOff(seen.frame, view)
    if off && !state.offscreen { return true }

    if let wanted = state.find {
        let value = seen.password ? "" : flat(stringOf(seen.values["AXValue"]))
        let named = name.range(of: wanted, options: .caseInsensitive) != nil || value.range(of: wanted, options: .caseInsensitive) != nil
        if named && (state.findRole.isEmpty || state.findRole == role) {
            state.found = ["r": role, "n": clip(name.isEmpty ? value : name, 120)]
            state.truncated = true
            return false
        }
    }

    // A label inside a link or a button mostly repeats its name.
    let keep = interactive.contains(role)
        || (containers.contains(role) && (!name.isEmpty || depth == 0))
        || ((role == "text" || role == "heading" || role == "image") && !name.isEmpty && above.range(of: name, options: .caseInsensitive) == nil)

    var childShown = shown
    var index = -1
    if keep && state.register {
        counter += 1
        elements[counter] = element
        elementRoots[counter] = root
        index = state.nodes.count
        state.nodes.append(node(element, seen, id: counter, depth: shown, offscreen: off))
        childShown = shown + 1
    }
    if depth >= maxDepth { return false }

    // A closed menu still lists everything in it; only an open one is walked.
    if menuBar && seen.axRole == "AXMenuBarItem" && boolOf(seen.values["AXSelected"]) != true { return false }

    // A scroll area is a window onto what it holds: what falls outside it
    // is scrolled away.
    var inner = view
    if seen.axRole == "AXScrollArea" && !seen.frame.isNull && !seen.frame.isEmpty {
        let visible = view.intersection(seen.frame)
        inner = visible.isNull ? seen.frame : visible
    }

    let kids = seen.kids
    let count = min(kids.count, maxChildren)
    var hidden = 0
    let passDown = keep && !name.isEmpty ? name : above
    for child in kids.prefix(count) where !state.truncated {
        if walk(child, root: root, depth: depth + 1, shown: childShown, state: state, above: passDown, view: inner,
                parentRole: seen.axRole, menuBar: menuBar) { hidden += 1 }
    }
    if hidden > 0 && !state.truncated && state.register { state.nodes.append(["d": childShown, "offscreen": hidden]) }
    if kids.count > count && !state.truncated && state.register { state.nodes.append(["d": childShown, "more": kids.count - count]) }

    // A button or a link with no name of its own is called what it says:
    // the first piece of text inside it, which then need not be listed twice.
    if index >= 0 && name.isEmpty && ["button", "link", "menu item", "list item", "tab item", "data item", "tree item", "check box", "radio button"].contains(role) {
        if let first = (index + 1..<state.nodes.count).first(where: { state.nodes[$0]["r"] as? String == "text" }),
           let words = state.nodes[first]["n"] as? String {
            state.nodes[index]["n"] = words
            let leaf = first + 1 >= state.nodes.count || ((state.nodes[first + 1]["d"] as? Int) ?? 0) <= ((state.nodes[first]["d"] as? Int) ?? 0)
            if leaf && state.nodes[first]["s"] == nil { state.nodes.remove(at: first) }
        }
    }
    return false
}

/// Wholly outside what can be seen. Something with no place of its own is
/// given the benefit of the doubt.
private func isOff(_ rect: CGRect, _ view: CGRect) -> Bool {
    if rect.isNull || view.isNull || rect.width < 1 || rect.height < 1 { return false }
    return !rect.intersects(view)
}

private func node(_ element: AXUIElement, _ seen: Seen, id: Int, depth: Int, offscreen: Bool) -> Json {
    var node: Json = ["id": id, "d": depth, "r": seen.role]
    if !seen.name.isEmpty { node["n"] = clip(seen.name, 120) }
    let raw = seen.values["AXValue"]

    // The start of a long value, and how long it is: a page or a document is
    // read whole with the text command, not in every tree.
    if !seen.password && seen.role != "link" && seen.role != "check box" && seen.role != "radio button" && seen.role != "tab item"
        && seen.role != "text" && seen.role != "heading" {
        var value = flat(stringOf(raw))
        if value.isEmpty, let number = raw as? NSNumber, ["slider", "spinner", "progress bar"].contains(seen.role) { value = number.stringValue }
        if !value.isEmpty && value != seen.name {
            node["v"] = clip(value, 150)
            if value.count > 150 { node["len"] = value.count }
        }
    }

    var states: [String] = []
    if boolOf(seen.values["AXEnabled"]) == false { states.append("disabled") }
    if boolOf(seen.values["AXFocused"]) == true { states.append("focused") }
    if offscreen { states.append("offscreen") }
    if seen.password { states.append("password") }
    if let number = raw as? NSNumber {
        if seen.role == "check box" {
            states.append(number.intValue == 1 ? "checked" : number.intValue == 0 ? "unchecked" : "mixed")
        } else if seen.axRole == "AXDisclosureTriangle" {
            states.append(number.intValue == 1 ? "expanded" : "collapsed")
        } else if (seen.role == "radio button" || seen.role == "tab item") && number.intValue == 1 {
            states.append("selected")
        }
    }
    if let expanded = boolOf(seen.values["AXExpanded"]) { states.append(expanded ? "expanded" : "collapsed") }
    else if seen.role == "tree item", let open = boolOf(seen.values["AXDisclosing"]) { states.append(open ? "expanded" : "collapsed") }
    if boolOf(seen.values["AXSelected"]) == true && !states.contains("selected") { states.append("selected") }
    if seen.role == "edit" && !seen.password {
        var settable = DarwinBoolean(false)
        if AXUIElementIsAttributeSettable(element, "AXValue" as CFString, &settable) == .success && !settable.boolValue {
            states.append("read-only")
        }
    }
    if !states.isEmpty { node["s"] = states.joined(separator: ", ") }
    return node
}

func lookup(_ id: Int) throws -> AXUIElement {
    guard let element = elements[id] else {
        throw Stop("unknown-element", "There is no element \(id) in the last read. Read the screen again.")
    }
    return element
}

/// Still there: an element whose window closed answers nothing.
func alive(_ element: AXUIElement) throws {
    var value: AnyObject?
    if AXUIElementCopyAttributeValue(element, "AXRole" as CFString, &value) == .invalidUIElement {
        throw Stop("gone", "That element is gone. Read the screen again.")
    }
}

/* ---------------------------------------------------------------- *
 * The whole text
 * ---------------------------------------------------------------- */

let maxText = 400000

/// The whole text of an element, or of a window: what a page, an email or a
/// document says, in one answer. A field's value when it has one, and
/// otherwise every named thing in reading order. Never a password field.
func readText(_ request: Json) throws -> Json {
    let id = number(request, "element", 0)
    let element: AXUIElement
    if id > 0 {
        element = try lookup(id)
        try alive(element)
    } else {
        let window = try existing(windowId(request, "hwnd"))
        if protected.contains(window.pid) { throw Stop("protected", "That is the Acestes window itself, which the agent may not read.") }
        wake(window.pid)
        guard let found = axWindow(window) else { throw Stop("gone", "That window cannot be read.") }
        element = found
    }
    let seen = see(element)
    if seen.password { throw Stop("password", "That is a password field. Its text is not read.") }

    var words = ""
    if seen.role == "edit" || seen.role == "combo box" { words = stringOf(seen.values["AXValue"]) }
    if words.isEmpty, let count = (attribute(element, "AXNumberOfCharacters") as? NSNumber)?.intValue, count > 0 {
        var range = CFRange(location: 0, length: min(count, maxText))
        if let span = AXValueCreate(.cfRange, &range) {
            var value: AnyObject?
            if AXUIElementCopyParameterizedAttributeValue(element, "AXStringForRange" as CFString, span, &value) == .success {
                words = stringOf(value)
            }
        }
    }
    if words.isEmpty { words = flatten(element) }
    return ["text": words, "length": words.utf16.count]
}

/// Every named thing inside, in reading order, one per line, repeats dropped.
private func flatten(_ root: AXUIElement) -> String {
    var lines: [String] = []
    var last = ""
    var total = 0
    var visited = 0
    func visit(_ element: AXUIElement, _ parentRole: String, _ depth: Int) {
        visited += 1
        if visited > 8000 || total > maxText || depth > 60 { return }
        let seen = see(element, parentRole: parentRole)
        if seen.password || skipped.contains(seen.role) { return }
        let value = seen.role != "link" && seen.role != "text" && seen.role != "heading" ? flat(stringOf(seen.values["AXValue"])) : ""
        let line = !value.isEmpty && value != seen.name ? (seen.name.isEmpty ? value : "\(seen.name): \(value)") : seen.name
        if !line.isEmpty && line != last && seen.role != "window" {
            lines.append(line)
            last = line
            total += line.count + 1
        }
        // A field's own words are its value; its insides repeat them.
        if seen.role == "edit" && !value.isEmpty { return }
        for child in seen.kids { visit(child, seen.axRole, depth + 1) }
    }
    visit(root, "", 0)
    return lines.joined(separator: "\n")
}

/* ---------------------------------------------------------------- *
 * Captchas
 * ---------------------------------------------------------------- */

/// The captcha widgets in a window, found by the address of the frame each
/// lives in, which reads the same in every language where the words on it
/// do not. Each comes with its checkbox and that box's state, and a
/// challenge with its buttons and what it asks. Everything reported is
/// numbered on from the last read, so the agent can act on it and the
/// numbers it already holds stay good. Also any image named as a captcha,
/// for the kind that is a picture of letters beside a field.
func captchas(_ request: Json) throws -> Json {
    let window = try existing(windowId(request, "hwnd"))
    if protected.contains(window.pid) { throw Stop("protected", "That is the Acestes window itself, which the agent may not read.") }
    wake(window.pid)
    guard let root = axWindow(window) else { throw Stop("gone", "That window cannot be read.") }
    let area = window.bounds
    var widgets: [Json] = []
    var images: [Json] = []
    var visited = 0
    let word = try? NSRegularExpression(pattern: "\\bcaptcha\\b", options: .caseInsensitive)

    func visit(_ element: AXUIElement, _ parentRole: String, _ depth: Int) {
        visited += 1
        if visited > 6000 || depth > 60 || widgets.count >= 8 { return }
        let seen = see(element, parentRole: parentRole, extra: ["AXURL"])
        if seen.role == "image" {
            // The word on its own: "captcha", "CAPTCHA image", but not a
            // solver's logo ("2Captcha") on a page about them.
            let range = NSRange(seen.name.startIndex..., in: seen.name)
            if images.count < 5, word?.firstMatch(in: seen.name, range: range) != nil {
                images.append(["id": register(element, window.id), "name": clip(seen.name, 80), "rect": box(seen.frame),
                               "visible": shown(seen.frame, area)])
            }
            return
        }
        // A link's address is where it goes, not a frame.
        if seen.role != "link", let address = urlOf(seen.values["AXURL"]), address.lowercased().hasPrefix("http"),
           let kind = captchaKind(address) {
            var widget: Json = ["kind": kind.0, "part": kind.1, "url": clip(address, 300), "id": register(element, window.id),
                                "rect": box(seen.frame), "visible": shown(seen.frame, area)]
            inside(element, window.id, area, &widget)
            widgets.append(widget)
            return
        }
        for child in seen.kids { visit(child, seen.axRole, depth + 1) }
    }
    visit(root, "", 0)
    return ["window": describe(window), "widgets": widgets, "images": images]
}

private func urlOf(_ value: AnyObject?) -> String? {
    if let url = value as? URL { return url.absoluteString }
    if let text = value as? String { return text }
    return nil
}

/// Which captcha a frame's address belongs to, and which part of it.
private func captchaKind(_ url: String) -> (String, String)? {
    let address = url.lowercased()
    if address.contains("/recaptcha/api2/anchor") || address.contains("/recaptcha/enterprise/anchor") { return ("recaptcha", "checkbox") }
    if address.contains("/recaptcha/api2/bframe") || address.contains("/recaptcha/enterprise/bframe") { return ("recaptcha", "challenge") }
    if address.contains("hcaptcha.com") && address.contains("frame=checkbox") { return ("hcaptcha", "checkbox") }
    if address.contains("hcaptcha.com") && address.contains("frame=challenge") { return ("hcaptcha", "challenge") }
    if address.contains("challenges.cloudflare.com") { return ("turnstile", "checkbox") }
    if address.contains("arkoselabs.com") || address.contains("funcaptcha.com") { return ("arkose", "challenge") }
    return nil
}

/// What a captcha frame holds: its checkbox, its named buttons, and the words it shows.
private func inside(_ frameElement: AXUIElement, _ window: CGWindowID, _ area: CGRect, _ widget: inout Json) {
    var buttons: [Json] = []
    var words = ""
    var last = ""
    var seenCount = 0
    var checkbox: Json?
    func visit(_ element: AXUIElement, _ parentRole: String, _ depth: Int) {
        seenCount += 1
        if seenCount > 400 || depth > 40 { return }
        let seen = see(element, parentRole: parentRole, extra: ["AXDOMIdentifier", "AXDOMClassList"])
        if seen.role == "check box" {
            if checkbox == nil {
                let value = (seen.values["AXValue"] as? NSNumber)?.intValue
                checkbox = ["id": register(element, window), "name": clip(seen.name, 80), "rect": box(seen.frame),
                            "state": value == 1 ? "checked" : value == 0 ? "unchecked" : value == 2 ? "mixed" : "",
                            "visible": shown(seen.frame, area)]
            }
            return
        }
        if seen.role == "button" && buttons.count < 30 {
            let automationId = stringOf(seen.values["AXDOMIdentifier"])
            let className = ((seen.values["AXDOMClassList"] as? [String]) ?? []).joined(separator: " ")
            // An image tile is a button with no name: the solver finds those
            // by looking, so only the named ones are worth listing.
            if !seen.name.isEmpty || !automationId.isEmpty {
                var button: Json = ["id": register(element, window), "name": clip(seen.name, 80), "rect": box(seen.frame),
                                    "enabled": boolOf(seen.values["AXEnabled"]) ?? true, "visible": shown(seen.frame, area)]
                if !automationId.isEmpty { button["aid"] = automationId }
                if !className.isEmpty { button["cls"] = clip(className, 120) }
                buttons.append(button)
            }
            return
        }
        if seen.role == "text" && !seen.name.isEmpty && seen.name != last && words.count < 600 {
            if !words.isEmpty { words += " " }
            words += seen.name
            last = seen.name
        }
        for child in seen.kids { visit(child, seen.axRole, depth + 1) }
    }
    for child in children(frameElement) { visit(child, "AXWebArea", 1) }
    if let box = checkbox { widget["checkbox"] = box }
    widget["buttons"] = buttons
    widget["text"] = clip(words, 600)
}

private func register(_ element: AXUIElement, _ root: CGWindowID) -> Int {
    counter += 1
    elements[counter] = element
    elementRoots[counter] = root
    return counter
}

/// On screen for real: not collapsed to nothing, and inside the window
/// rather than parked far outside it.
private func shown(_ rect: CGRect, _ area: CGRect) -> Bool {
    if rect.isNull || rect.width < 8 || rect.height < 8 { return false }
    return rect.intersects(area)
}

/* ---------------------------------------------------------------- *
 * Aiming
 * ---------------------------------------------------------------- */

private let systemWide = AXUIElementCreateSystemWide()

func at(_ point: CGPoint) -> AXUIElement? {
    var element: AXUIElement?
    return AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &element) == .success ? element : nil
}

/// Where an element is to be clicked, checked: its window brought to the
/// front, scrolled into view if it has to be, and a hit test at the point
/// confirming that the click would land on it and not on something
/// covering it. Or a point given outright, with its window.
func target(_ request: Json) throws -> Json {
    try requireDriving()
    var answer: Json = [:]
    let id = number(request, "element", 0)
    var point: CGPoint
    var home: WindowInfo?

    if id > 0 {
        let element = try lookup(id)
        let root = elementRoots[id] ?? 0
        if let window = info(root) {
            try allowed(window)
            home = window
            if frontWindow() != root { bringForward(window) }
        }
        if protected.contains(pidOf(element)) { throw Stop("protected", "That is on the Acestes window itself, which the agent may not touch.") }
        try checkStop()
        try alive(element)

        var bounds = frame(element)
        let visible = home.map { $0.bounds } ?? .null
        if !bounds.isNull && !visible.isNull && !visible.contains(CGPoint(x: bounds.midX, y: bounds.midY)) {
            AXUIElementPerformAction(element, "AXScrollToVisible" as CFString)
            pause(200)
            bounds = frame(element)
        }
        if bounds.isNull || bounds.width < 1 || bounds.height < 1 {
            throw Stop("no-place", "Element \(id) has no place on screen: it is hidden, collapsed or scrolled away.")
        }
        point = CGPoint(x: bounds.midX.rounded(), y: bounds.midY.rounded())

        if let hit = at(point), !related(hit, element), !passesThrough(hit, point) {
            // The middle can be where a label inside sits over another
            // element; a point nearer the start is the next best guess.
            let inset = CGPoint(x: (bounds.minX + min(12, bounds.width / 4)).rounded(), y: point.y)
            if let other = at(inset), related(other, element) || passesThrough(other, inset) {
                point = inset
            } else {
                throw Stop("covered", "Element \(id) is covered by \(summary(hit)). Close or move that first, or read the screen again.")
            }
        }
        answer["rect"] = box(bounds)
        // What is being aimed at, by name, for the card in the corner.
        answer["label"] = summary(element)
    } else {
        let x = number(request, "x", Int.min)
        let y = number(request, "y", Int.min)
        if x == Int.min || y == Int.min { throw Stop("bad-request", "Give an element id, or x and y.") }
        point = CGPoint(x: x, y: y)
        // A point in a screenshot of a window: that window to the front
        // first, so the point lands on what the screenshot showed, and where
        // the window is now, so the caller can tell if it moved.
        let owner = windowId(request, "hwnd")
        if owner != 0 {
            guard let window = info(owner) else { throw Stop("gone", "The window in the screenshot is gone. Take another.") }
            try allowed(window)
            home = window
            if frontWindow() != owner { bringForward(window) }
            try checkStop()
            answer["frame"] = box((info(owner) ?? window).bounds)
        }
    }

    let landing = windowAt(point)
    try allowed(landing)
    answer["x"] = whole(point.x)
    answer["y"] = whole(point.y)
    // The app being worked, for the user's say-so: the menu bar and the
    // Dock are drawn by the system, but a click there is a click for the app.
    if let window = landing, NSRunningApplication(processIdentifier: window.pid)?.activationPolicy == .regular {
        answer["window"] = describe(window)
    } else if let window = home ?? frontWindow().flatMap({ info($0) }) {
        answer["window"] = describe(window)
    }
    return answer
}

/// A hit on Acestes's own corner card, which clicks go straight through: it
/// covers nothing. What actually takes the click is the window beneath.
private func passesThrough(_ hit: AXUIElement, _ point: CGPoint) -> Bool {
    protected.contains(pidOf(hit)) && !protected.contains(ownerAt(point))
}

/// The same element, or one inside the other: a label in a button is still the button.
private func related(_ hit: AXUIElement, _ target: AXUIElement) -> Bool {
    if CFEqual(hit, target) { return true }
    var step: AXUIElement? = hit
    for _ in 0..<15 {
        guard let current = step, let up = parent(current) else { break }
        if CFEqual(up, target) { return true }
        step = up
    }
    // A hit on one of the target's own containers is a hit on the target: a
    // browser's hit test can stop at the element holding a frame (a
    // captcha's iframe) rather than go into it. Only up to the page itself,
    // though: a document, pane or window that answered could be hiding
    // whatever really sits on top.
    step = target
    for level in 0..<10 {
        guard let current = step, let up = parent(current) else { break }
        let role = string(up, "AXRole")
        if level >= 3 && ["AXWebArea", "AXScrollArea", "AXWindow", "AXSplitGroup"].contains(role) { break }
        if CFEqual(up, hit) { return true }
        step = up
    }
    return false
}

func summary(_ element: AXUIElement) -> String {
    var step: AXUIElement? = element
    for _ in 0..<4 {
        guard let current = step else { break }
        let seen = see(current)
        if !seen.name.isEmpty { return "\(seen.role) \"\(clip(seen.name, 80))\"" }
        step = parent(current)
    }
    return "something without a name"
}
