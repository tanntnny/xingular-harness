import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// One request per process. This helper deliberately has no discovery or input operations.
struct Request: Decodable {
  let operation: String
  let approved: Bool
  let windowID: UInt32
  let processID: Int32
  let processLaunchTime: Double
}

struct Failure: Error {
  let code: String
  let message: String
}

func refuse(_ code: String, _ message: String) -> Failure {
  Failure(code: code, message: message)
}

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
        let line = String(data: data, encoding: .utf8) else { exit(2) }
  print(line)
}

func processMatches(_ request: Request) -> Bool {
  guard let app = NSRunningApplication(processIdentifier: request.processID),
        !app.isTerminated, let launch = app.launchDate else { return false }
  return launch.timeIntervalSince1970 == request.processLaunchTime
}

@available(macOS 14.2, *)
func findWindow(_ request: Request) async throws -> SCWindow {
  guard processMatches(request) else { throw refuse("target_changed", "Process identity is unavailable or changed.") }
  let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
  let matches = content.windows.filter {
    $0.windowID == request.windowID && $0.owningApplication?.processID == request.processID && $0.isOnScreen
  }
  guard matches.count == 1, let window = matches.first, processMatches(request) else {
    throw refuse("target_changed", "Approved window is unavailable or changed.")
  }
  return window
}

// Candidate capture path, intentionally unreachable until the identity and isolation gaps in
// README.md are resolved. Pre/post checks cannot prove window-ID continuity during capture.
@available(macOS 14.2, *)
func captureCandidate(_ request: Request) async throws -> [String: Any] {
  guard CGPreflightScreenCaptureAccess() else { throw refuse("permission_denied", "Screen recording permission is not available.") }
  let window = try await findWindow(request)
  let filter = SCContentFilter(desktopIndependentWindow: window)
  let rect = filter.contentRect
  let scale = CGFloat(filter.pointPixelScale)
  let width = ceil(rect.width * scale)
  let height = ceil(rect.height * scale)
  guard width.isFinite, height.isFinite, width >= 1, height >= 1,
        width <= 8192, height <= 8192, width * height <= 32_000_000 else {
    throw refuse("invalid_size", "Window dimensions are unavailable or too large.")
  }
  let config = SCStreamConfiguration()
  config.width = Int(width)
  config.height = Int(height)
  config.showsCursor = false
  config.ignoreShadowsSingleWindow = true
  config.includeChildWindows = false
  let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
  _ = try await findWindow(request)
  guard image.width == Int(width), image.height == Int(height) else {
    throw refuse("invalid_image", "Capture dimensions changed.")
  }
  let data = NSMutableData()
  guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
    throw refuse("encoding_failed", "Could not encode image.")
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else { throw refuse("encoding_failed", "Could not encode image.") }
  return ["ok": true, "mimeType": "image/png", "width": image.width, "height": image.height,
          "data": (data as Data).base64EncodedString()]
}

@main
struct Main {
  static func main() async {
    do {
      guard let line = readLine(), line.utf8.count <= 4096,
            let data = line.data(using: .utf8),
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            Set(object.keys) == Set(["operation", "approved", "windowID", "processID", "processLaunchTime"]) else {
        throw refuse("invalid_request", "Expected one bounded JSON request with exactly the documented fields.")
      }
      let request: Request
      do { request = try JSONDecoder().decode(Request.self, from: data) }
      catch { throw refuse("invalid_request", "Invalid request fields.") }
      guard request.operation == "capture", request.approved, request.windowID > 0,
            request.processID > 0, request.processLaunchTime.isFinite, request.processLaunchTime > 0 else {
        throw refuse("invalid_request", "Capture requires an explicit approval and valid target identity.")
      }
      // Fail closed: neither matching numeric IDs nor pre/post checks establish that the same
      // approved window survived throughout capture. Do not query or capture the user's screen.
      throw refuse("isolation_unverified", "Capture is disabled: continuous approved-window identity and pixel isolation are not verified.")
    } catch let failure as Failure {
      emit(["ok": false, "code": failure.code, "message": failure.message])
    } catch {
      emit(["ok": false, "code": "internal_error", "message": "The request could not be processed."])
    }
  }
}
