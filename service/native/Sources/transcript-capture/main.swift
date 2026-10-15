import Foundation

// transcript-capture
//
// Captures system audio and the microphone, transcribes it with WhisperKit, and
// prints one JSON object per line on stdout. The Node service in
// ../../server.mjs owns this process, reads the stream and turns it into the
// transcript the plugin shows.
//
// Output lines
//   {"type":"ready"}
//   {"type":"segment","text":"...","start":1.2,"end":3.4}
//   {"type":"tail","text":"..."}
//   {"type":"level","peak":0.42}
//   {"type":"error","message":"..."}
//   {"type":"done"}
//
// Stop by writing "stop" on stdin, or by sending SIGTERM or SIGINT. The service
// always drains the last few seconds of audio before it exits.

// MARK: - JSON output

private let emitLock = NSLock()

private func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    emitLock.lock()
    defer { emitLock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

// MARK: - Session

final class Session: @unchecked Sendable {
    private let captureMic: Bool
    private let asr = StreamingASR()
    private var capture: AudioCapture?
    private var levelTimer: DispatchSourceTimer?
    private let stopSemaphore = DispatchSemaphore(value: 0)
    private var startedAt: Date?
    private var warnedSilent = false

    init(captureMic: Bool) {
        self.captureMic = captureMic
    }

    func start() async throws {
        let asr = self.asr
        asr.onSegment = { seg in
            emit(["type": "segment", "text": seg.text, "start": seg.wallStart, "end": seg.wallEnd])
        }
        asr.onPendingTail = { tail in
            emit(["type": "tail", "text": tail])
        }

        Paths.log("session start, captureMic=\(captureMic)")
        // Tell the service the model is loading, so the panel can show progress
        // instead of pretending to record. The first run downloads about 1.5 GB.
        emit(["type": "phase", "phase": "loading-model"])
        try await asr.start()

        let capture = AudioCapture(captureMic: captureMic) { samples in
            asr.append(samples)
        }
        self.capture = capture
        try await capture.start()
        startedAt = Date()

        startLevelTimer()
        emit(["type": "ready"])
        Paths.log("session ready")
    }

    private func startLevelTimer() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
        timer.setEventHandler { [weak self] in
            guard let self, let capture = self.capture else { return }
            emit(["type": "level", "peak": Double(capture.lastPeak)])
            // The tap returns silence, not an error, when System Audio Recording
            // Only permission is missing. Say so once rather than let Whisper
            // hallucinate on the silence.
            if !self.warnedSilent,
               let startedAt = self.startedAt,
               Date().timeIntervalSince(startedAt) > 8,
               capture.maxPeak == 0 {
                self.warnedSilent = true
                Paths.log("warning, no audio detected after 8s")
                emit(["type": "warning", "message": "No audio has arrived. If a meeting is playing, grant System Audio Recording Only permission to Transcript Capture in System Settings, then restart the capture."])
            }
        }
        timer.resume()
        levelTimer = timer
    }

    func requestStop() {
        stopSemaphore.signal()
    }

    func waitForStop() {
        stopSemaphore.wait()
    }

    func finish() async {
        levelTimer?.cancel()
        levelTimer = nil
        if let capture {
            try? await capture.stop()
        }
        await asr.stop()
        emit(["type": "done"])
        Paths.log("session done")
    }
}

// MARK: - Entry

let arguments = CommandLine.arguments

// Permission probe. Creates the system audio tap briefly so macOS shows the
// System Audio Recording Only prompt, then exits. Launch it through `open` so
// LaunchServices makes this bundle the responsible process for the prompt.
if arguments.contains("--request-permission") {
    Paths.log("permission probe, creating system audio tap")
    let probe = SystemAudioTap()
    do {
        try probe.start { _ in }
        Paths.log("permission probe, tap running")
        emit(["type": "ready"])
    } catch {
        Paths.log("permission probe failed. \(error)")
        emit(["type": "error", "message": "\(error)"])
    }
    try? await Task.sleep(nanoseconds: 4_000_000_000)
    probe.stop()
    exit(0)
}

let captureMic = !arguments.contains("--no-mic")
let session = Session(captureMic: captureMic)

// Signals. Ignore the default disposition, then handle them on a background
// queue so the main thread is free to block on the stop semaphore. The sources
// are held in this array for the life of the process, because a source that
// goes out of scope is cancelled.
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let signalQueue = DispatchQueue(label: "transcript.signals")
let signalSources: [DispatchSourceSignal] = [SIGTERM, SIGINT].map { sig in
    let source = DispatchSource.makeSignalSource(signal: sig, queue: signalQueue)
    source.setEventHandler { session.requestStop() }
    source.resume()
    return source
}
_ = signalSources

// stdin. A "stop" line ends the session. If stdin closes, the parent has gone,
// so stop as well rather than record forever.
DispatchQueue.global().async {
    while let line = readLine(strippingNewline: true) {
        if line.trimmingCharacters(in: .whitespaces).lowercased() == "stop" {
            break
        }
    }
    session.requestStop()
}

do {
    try await session.start()
} catch {
    emit(["type": "error", "message": "\(error)"])
    Paths.log("startup failed. \(error)")
    exit(1)
}

session.waitForStop()
await session.finish()
exit(0)
