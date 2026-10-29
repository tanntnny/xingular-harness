import AppKit
import Foundation
import ScreenCaptureKit

// Experimental selection stage only. No capture or window enumeration is performed.
@available(macOS 15.2, *)
final class PickerHelper: NSObject, SCContentSharingPickerObserver {
  private let picker = SCContentSharingPicker.shared
  private var pending = false
  private var revoked = false
  private var selection: SCContentFilter?

  func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else { exit(2) }
    FileHandle.standardOutput.write(Data((text + "\n").utf8))
  }

  func command(_ data: Data) {
    guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          Set(object.keys) == ["operation"], let operation = object["operation"] as? String else {
      emit(["ok": false, "code": "invalid_request"]); return
    }
    switch operation {
    case "select":
      guard !pending else { emit(["ok": false, "code": "busy"]); return }
      selection = nil
      revoked = false
      pending = true
      var config = SCContentSharingPickerConfiguration()
      config.allowedPickerModes = [.singleWindow]
      config.allowsChangingSelectedContent = false
      picker.defaultConfiguration = config
      picker.add(self)
      picker.isActive = true
      emit(["ok": true, "event": "select_pending"])
      picker.present(using: .window)
    case "revoke":
      selection = nil
      revoked = true
      emit(["ok": true, "event": "revoked"])
    case "capture":
      // The parent cannot atomically revoke an in-flight OS screenshot, and the SDK does not
      // document identity continuity across window destruction. Never request pixels here.
      emit(["ok": false, "code": "isolation_unverified"])
    case "close":
      selection = nil
      picker.isActive = false
      picker.remove(self)
      emit(["ok": true, "event": "closed"])
      exit(0)
    default:
      emit(["ok": false, "code": "invalid_request"])
    }
  }

  private func finish(_ event: String) {
    pending = false
    picker.isActive = false
    picker.remove(self)
    emit(["ok": event == "selected", "event": event])
  }

  func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
    DispatchQueue.main.async {
      guard self.pending else { return }
      self.selection = nil
      self.finish(self.revoked ? "discarded" : "cancelled")
    }
  }

  func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
    DispatchQueue.main.async {
      guard self.pending else { return }
      guard !self.revoked, stream == nil, filter.style == .window,
            filter.includedWindows.count == 1, filter.includedDisplays.isEmpty,
            filter.includedApplications.isEmpty else {
        self.selection = nil
        self.finish(self.revoked ? "discarded" : "invalid_selection")
        return
      }
      self.selection = filter
      self.finish("selected")
    }
  }

  func contentSharingPickerStartDidFailWithError(_ error: Error) {
    DispatchQueue.main.async {
      guard self.pending else { return }
      self.selection = nil
      self.finish(self.revoked ? "discarded" : "picker_failed")
    }
  }
}

@main
struct Main {
  static func main() {
    guard #available(macOS 15.2, *) else {
      FileHandle.standardOutput.write(Data("{\"code\":\"unsupported_os\",\"ok\":false}\n".utf8))
      return
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let helper = PickerHelper()
    DispatchQueue.global(qos: .userInitiated).async {
      var line = Data()
      var oversized = false
      while true {
        let byte = FileHandle.standardInput.readData(ofLength: 1)
        if byte.isEmpty { DispatchQueue.main.async { exit(0) }; return }
        if byte[0] == 10 {
          let request = line
          let tooLarge = oversized
          line.removeAll(keepingCapacity: true)
          oversized = false
          DispatchQueue.main.async {
            if tooLarge { helper.emit(["ok": false, "code": "invalid_request"]) }
            else { helper.command(request) }
          }
        } else if line.count < 4096 {
          line.append(byte)
        } else {
          oversized = true
        }
      }
    }
    app.run()
  }
}
