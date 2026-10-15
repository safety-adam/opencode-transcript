import Foundation

// Filesystem layout for the capture binary.
//
// Everything the service writes that is not the JSON stream on stdout lives
// under one data directory, so an install is easy to find and easy to remove.
//
// Environment overrides, both optional:
//   TRANSCRIPT_DATA_DIR     where models and logs live
//   TRANSCRIPT_MODELS_DIR   where WhisperKit reads and downloads models
enum Paths {
    /// Root data directory. Defaults to Application Support so the model cache
    /// survives a reinstall of the plugin.
    static let dataDirectory: URL = {
        let env = ProcessInfo.processInfo.environment["TRANSCRIPT_DATA_DIR"]
        let base: URL
        if let env, !env.isEmpty {
            base = URL(fileURLWithPath: env)
        } else {
            let support = FileManager.default
                .urls(for: .applicationSupportDirectory, in: .userDomainMask)
                .first ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
            base = support.appendingPathComponent("opencode-transcript", isDirectory: true)
        }
        return ensure(base)
    }()

    /// WhisperKit model cache. Point this at another install's cache to avoid a
    /// fresh model download, for example a bud install, by setting
    /// TRANSCRIPT_MODELS_DIR to that cache directory.
    static let modelsDirectory: URL = {
        let env = ProcessInfo.processInfo.environment["TRANSCRIPT_MODELS_DIR"]
        if let env, !env.isEmpty { return ensure(URL(fileURLWithPath: env)) }
        return ensure(dataDirectory.appendingPathComponent("models", isDirectory: true))
    }()

    /// Initial prompt for the decoder, used to bias recognition toward domain
    /// words and product names. Read from `TRANSCRIPT_PROMPT`, or from
    /// `prompt.txt` in the data directory, one line is enough. Empty means no
    /// prompt.
    static var promptText: String {
        if let env = ProcessInfo.processInfo.environment["TRANSCRIPT_PROMPT"], !env.isEmpty {
            return env.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let file = dataDirectory.appendingPathComponent("prompt.txt")
        let text = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Diagnostics. Written to stderr, which the Node service redirects to
    /// capture.log next to the transcript. stdout is reserved for JSON lines.
    static func log(_ message: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        FileHandle.standardError.write(Data("[\(stamp)] \(message)\n".utf8))
    }

    @discardableResult
    private static func ensure(_ url: URL) -> URL {
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
