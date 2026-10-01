// Seeing: pictures of part of the screen.
//
// ScreenCaptureKit on macOS 14 and later, which leaves Acestes and this
// helper's markers out by name; the window server's older call before that,
// where the markers keep themselves out and Acestes hides for the moment.

import Cocoa
import ImageIO
import ScreenCaptureKit

private var askedScreen = false

private func requireScreenRecording() throws {
    if CGPreflightScreenCaptureAccess() { return }
    if !askedScreen {
        askedScreen = true
        _ = CGRequestScreenCaptureAccess()
    }
    throw Stop("permission", "macOS has not given Acestes Screen Recording access, which screenshots need. Ask the user to "
        + "switch on Acestes Agent in System Settings > Privacy & Security > Screen & System Audio Recording, and to reopen "
        + "Acestes if macOS asks. read_screen and read_text work without it.")
}

/// A picture of part of the screen: a window as drawn, the display it is
/// on, or a region, shrunk to what the model is sent (the long edge and the
/// pixel count both capped) and never sharper than the display itself. The
/// answer says where the picture came from and at what scale, pixels per
/// point, so a point in it can be found on the screen again.
func capture(_ request: Json) throws -> Json {
    var region: CGRect
    if let raw = rectList(request, "region") {
        region = CGRect(x: raw[0], y: raw[1], width: raw[2], height: raw[3])
    } else {
        let window = try existing(windowId(request, "hwnd"))
        try allowed(window)
        region = flag(request, "monitor") ? (display(for: window.bounds)?.frame ?? window.bounds) : window.bounds
    }

    // Only what is on a screen can be copied: the display most of it is on.
    guard let screen = display(for: region) else { throw Stop("off-screen", "That is not on any screen.") }
    region = region.intersection(screen.frame)
    if region.isNull || region.width < 4 || region.height < 4 { throw Stop("off-screen", "That is not on any screen.") }
    region = CGRect(x: region.minX.rounded(), y: region.minY.rounded(), width: region.width.rounded(), height: region.height.rounded())

    let jpeg = text(request, "format") == "jpeg"
    let maxLong = CGFloat(max(256, number(request, "maxLong", 1568)))
    let maxPixels = CGFloat(max(65536, number(request, "maxPixels", 1150000)))
    let scale = min(screen.scale, maxLong / max(region.width, region.height), (maxPixels / (region.width * region.height)).squareRoot())
    let width = max(1, Int((region.width * scale).rounded()))
    let height = max(1, Int((region.height * scale).rounded()))

    try requireScreenRecording()
    let shot: CGImage
    if #available(macOS 14.0, *) {
        shot = try modern(region, screen, width, height)
    } else {
        shot = try legacy(region)
    }
    let data = try encode(opaque(shot, width, height), jpeg: jpeg)

    return [
        "data": data.base64EncodedString(),
        "mediaType": jpeg ? "image/jpeg" : "image/png",
        "width": width,
        "height": height,
        "region": box(region),
        "scale": Double(scale),
    ]
}

private func waitOn(_ semaphore: DispatchSemaphore) throws {
    if semaphore.wait(timeout: .now() + 10) == .timedOut {
        throw Stop("failed", "The screen did not answer in time.")
    }
}

@available(macOS 14.0, *)
private func modern(_ region: CGRect, _ screen: Display, _ width: Int, _ height: Int) throws -> CGImage {
    let semaphore = DispatchSemaphore(value: 0)
    var content: SCShareableContent?
    var problem: Error?
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { found, error in
        content = found
        problem = error
        semaphore.signal()
    }
    try waitOn(semaphore)
    guard let shareable = content else {
        throw Stop("failed", "macOS would not say what is on screen: \(problem?.localizedDescription ?? "no reason given").")
    }
    guard let target = shareable.displays.first(where: { $0.displayID == screen.id }) ?? shareable.displays.first else {
        throw Stop("off-screen", "That is not on any screen.")
    }
    // Acestes and this helper's own markers stay out of the picture, whatever
    // they say about being shared.
    let hidden = shareable.windows.filter { window in
        guard let pid = window.owningApplication?.processID else { return false }
        return protected.contains(pid) && !(capturable && pid == selfPid)
    }
    let filter = SCContentFilter(display: target, excludingWindows: hidden)
    let configuration = SCStreamConfiguration()
    configuration.sourceRect = CGRect(x: region.minX - target.frame.minX, y: region.minY - target.frame.minY,
                                      width: region.width, height: region.height)
    configuration.width = width
    configuration.height = height
    configuration.showsCursor = false
    configuration.scalesToFit = true

    var image: CGImage?
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { shot, error in
        image = shot
        problem = error
        semaphore.signal()
    }
    try waitOn(semaphore)
    guard let shot = image else {
        throw Stop("failed", "The screenshot failed: \(problem?.localizedDescription ?? "no reason given").")
    }
    return shot
}

// Gone from the SDKs once ScreenCaptureKit replaced it, still there on the
// systems that need it, so it is looked up at run time.
private typealias CreateImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
private let createImage: CreateImage? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return nil }
    return unsafeBitCast(symbol, to: CreateImage.self)
}()

private func legacy(_ region: CGRect) throws -> CGImage {
    // On screen only, every window, at the display's own resolution.
    guard let call = createImage, let shot = call(region, 1, 0, 1 << 3)?.takeRetainedValue() else {
        throw Stop("failed", "The screenshot failed.")
    }
    return shot
}

/// The picture at the size the model is sent, on an opaque background.
private func opaque(_ image: CGImage, _ width: Int, _ height: Int) -> CGImage {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return image }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage() ?? image
}

private func encode(_ image: CGImage, jpeg: Bool) throws -> Data {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, (jpeg ? "public.jpeg" : "public.png") as CFString, 1, nil) else {
        throw Stop("failed", "The picture could not be encoded.")
    }
    // For a captcha service, which caps what it takes: a grid of photos is
    // several times smaller this way.
    let options = jpeg ? [kCGImageDestinationLossyCompressionQuality: 0.88] as CFDictionary : nil
    CGImageDestinationAddImage(destination, image, options)
    guard CGImageDestinationFinalize(destination) else { throw Stop("failed", "The picture could not be encoded.") }
    return data as Data
}
