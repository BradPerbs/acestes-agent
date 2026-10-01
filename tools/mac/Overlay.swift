// What the person watching sees besides the cursor: an outline on the
// target, a ripple where the click lands, and a badge saying who is driving.
// Borderless panels that never take the focus, let every click through, sit
// on every Space, and stay out of screenshots.

import Cocoa

private let accent = NSColor(srgbRed: 47 / 255, green: 123 / 255, blue: 246 / 255, alpha: 1)

final class Overlay {
    enum Tone { case driving, paused, stopped }

    private let outlineLayer = Layer()
    private let rippleLayer = Layer()
    private let badgeLayer = Layer()
    private var rippleTimer: Timer?
    private var fadeTimer: Timer?
    private var rippleFrame = 0
    private var ripplePoint = CGPoint.zero
    private var fadeStep = 0

    func outline(_ rect: CGRect) {
        fadeTimer?.invalidate()
        let margin: CGFloat = 6
        outlineLayer.show(rect.insetBy(dx: -margin, dy: -margin)) { _ in
            let box = NSRect(x: margin - 3, y: margin - 3, width: rect.width + 6, height: rect.height + 6)
            let path = NSBezierPath(roundedRect: box, xRadius: 6, yRadius: 6)
            accent.withAlphaComponent(34 / 255).setFill()
            path.fill()
            path.lineWidth = 2.5
            accent.withAlphaComponent(235 / 255).setStroke()
            path.stroke()
        }
    }

    func fadeOutline() {
        guard outlineLayer.visible else { return }
        fadeStep = 0
        fadeTimer?.invalidate()
        fadeTimer = repeating(0.03) { [weak self] in self?.fadeFrame() }
    }

    private func fadeFrame() {
        fadeStep += 1
        let alpha = 1 - CGFloat(fadeStep * 40) / 255
        if alpha <= 0 {
            fadeTimer?.invalidate()
            outlineLayer.hide()
            return
        }
        outlineLayer.setAlpha(alpha)
    }

    func ripple(_ point: CGPoint) {
        ripplePoint = point
        rippleFrame = 0
        rippleTimer?.invalidate()
        rippleTimer = repeating(0.022) { [weak self] in self?.rippleStep() }
        rippleStep()
    }

    private func rippleStep() {
        let frames = 14
        if rippleFrame > frames {
            rippleTimer?.invalidate()
            rippleLayer.hide()
            return
        }
        let t = CGFloat(rippleFrame) / CGFloat(frames)
        let size: CGFloat = 64
        let place = CGRect(x: ripplePoint.x - size / 2, y: ripplePoint.y - size / 2, width: size, height: size)
        rippleLayer.show(place) { _ in
            let center = size / 2
            let radius = 5 + 21 * (1 - (1 - t) * (1 - t))
            let ring = NSBezierPath(ovalIn: NSRect(x: center - radius, y: center - radius, width: radius * 2, height: radius * 2))
            ring.lineWidth = 2.5
            accent.withAlphaComponent(230 / 255 * (1 - t)).setStroke()
            ring.stroke()
            if t < 0.4 {
                let dot: CGFloat = 4
                accent.withAlphaComponent(220 / 255 * (1 - t / 0.4)).setFill()
                NSBezierPath(ovalIn: NSRect(x: center - dot, y: center - dot, width: dot * 2, height: dot * 2)).fill()
            }
        }
        rippleFrame += 1
    }

    func badge(_ text: String, _ tone: Tone) {
        guard let screen = NSScreen.screens.first else { return }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
            .foregroundColor: NSColor(srgbRed: 245 / 255, green: 245 / 255, blue: 247 / 255, alpha: 1),
        ]
        let measured = (text as NSString).size(withAttributes: attributes)
        let height: CGFloat = 32
        let dot: CGFloat = 8
        let pad: CGFloat = 14
        let width = ceil(measured.width) + pad * 2 + dot + 8
        // Below the menu bar, in the middle of the main display.
        let visible = screen.visibleFrame
        let top = screen.frame.height - visible.maxY
        let place = CGRect(x: (visible.minX + (visible.width - width) / 2).rounded(), y: top + 10, width: width, height: height)
        let signal: NSColor
        switch tone {
        case .driving: signal = accent
        case .paused: signal = NSColor(srgbRed: 245 / 255, green: 158 / 255, blue: 11 / 255, alpha: 1)
        case .stopped: signal = NSColor(srgbRed: 239 / 255, green: 68 / 255, blue: 68 / 255, alpha: 1)
        }
        badgeLayer.show(place) { _ in
            let pill = NSBezierPath(roundedRect: NSRect(x: 0.5, y: 0.5, width: width - 1, height: height - 1), xRadius: height / 2, yRadius: height / 2)
            NSColor(srgbRed: 22 / 255, green: 22 / 255, blue: 30 / 255, alpha: 238 / 255).setFill()
            pill.fill()
            signal.setFill()
            NSBezierPath(ovalIn: NSRect(x: pad, y: (height - dot) / 2, width: dot, height: dot)).fill()
            (text as NSString).draw(at: NSPoint(x: pad + dot + 8, y: (height - measured.height) / 2), withAttributes: attributes)
        }
    }

    func hideAll() {
        rippleTimer?.invalidate()
        fadeTimer?.invalidate()
        outlineLayer.hide()
        rippleLayer.hide()
        badgeLayer.hide()
    }

    /// A timer that keeps ticking while a menu is being tracked, too.
    private func repeating(_ interval: TimeInterval, _ tick: @escaping () -> Void) -> Timer {
        let timer = Timer(timeInterval: interval, repeats: true) { _ in tick() }
        RunLoop.main.add(timer, forMode: .common)
        return timer
    }
}

/// One click-through, never-activated panel showing one drawing.
final class Layer {
    private let panel: NSPanel
    private let canvas = Canvas()
    private(set) var visible = false

    init() {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 1, height: 1), styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        // Gone from screenshots, there on screen.
        if !capturable { panel.sharingType = .none }
        panel.contentView = canvas
    }

    /// Shown over a rectangle in the top-left, point-based space.
    func show(_ rect: CGRect, _ paint: @escaping (NSRect) -> Void) {
        let height = NSScreen.screens.first?.frame.height ?? 0
        panel.setFrame(NSRect(x: rect.minX, y: height - rect.maxY, width: max(1, rect.width), height: max(1, rect.height)), display: false)
        canvas.paint = paint
        canvas.needsDisplay = true
        panel.alphaValue = 1
        if !visible {
            panel.orderFrontRegardless()
            visible = true
        }
        canvas.displayIfNeeded()
    }

    func setAlpha(_ alpha: CGFloat) {
        panel.alphaValue = alpha
    }

    func hide() {
        guard visible else { return }
        panel.orderOut(nil)
        visible = false
    }
}

private final class Canvas: NSView {
    var paint: ((NSRect) -> Void)?

    // Drawn from the top left, as the rest of the helper counts.
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.set()
        dirtyRect.fill(using: .copy)
        paint?(bounds)
    }
}
