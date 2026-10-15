import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation

enum AudioCaptureError: Error, CustomStringConvertible {
    case createProcessTapFailed(OSStatus)
    case getStreamDescriptionFailed
    case createAggregateDeviceFailed(OSStatus)
    case createDeviceIOProcFailed(OSStatus)
    case startAudioDeviceFailed(OSStatus)
    case noAudioDevices
    case formatFailed

    var description: String {
        switch self {
        case .createProcessTapFailed(let s): return "Could not create the system audio tap (\(s)). Check System Audio Recording Only permission."
        case .getStreamDescriptionFailed: return "Could not read the audio tap format."
        case .createAggregateDeviceFailed(let s): return "Could not create the audio device (\(s))."
        case .createDeviceIOProcFailed(let s): return "Could not create the audio callback (\(s))."
        case .startAudioDeviceFailed(let s): return "Could not start the audio device (\(s))."
        case .noAudioDevices: return "No usable audio input devices found."
        case .formatFailed: return "Could not build the audio format."
        }
    }
}

/// Captures system audio with a Core Audio process tap and the microphone with
/// `AVAudioEngine`, converts both to 16 kHz mono float, and mixes them sample by
/// sample on a serial queue.
///
/// The process tap is deliberate. ScreenCaptureKit also captures system audio,
/// but macOS gates it behind the combined "Screen & System Audio Recording"
/// permission. A process tap is gated behind "System Audio Recording Only", so
/// this tool never asks to see the screen.
///
/// Lifecycle
///   let cap = AudioCapture(captureMic: true)
///   try await cap.start()
///   ...
///   try await cap.stop()
final class AudioCapture: NSObject, @unchecked Sendable {
    let captureMic: Bool
    var onSamples: (([Float]) -> Void)?

    static let outputSampleRate: Double = 16_000
    static let outputChannels: AVAudioChannelCount = 1

    private let tap = SystemAudioTap()
    private let micEngine = AVAudioEngine()
    private var micConverter: AVAudioConverter?
    private var micEnabled = false
    private var targetFormat: AVAudioFormat!

    private let serialQueue = DispatchQueue(label: "transcript.audiocapture.serial")

    private var sysPending: [Float] = []
    private var micPending: [Float] = []

    private var loggedFirstSys = false
    private var loggedFirstMic = false
    private var micSamplesSeen: Int = 0

    private(set) var lastPeak: Float = 0
    /// Highest peak seen since the session began. Used to detect the silent
    /// denial where the tap yields zeros because the permission is missing.
    private(set) var maxPeak: Float = 0

    init(captureMic: Bool = true, onSamples: (([Float]) -> Void)? = nil) {
        self.captureMic = captureMic
        self.onSamples = onSamples
        super.init()
        self.targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Self.outputSampleRate,
            channels: Self.outputChannels,
            interleaved: false
        )
    }

    func start() async throws {
        // System audio first, so a permission failure surfaces before the mic.
        try tap.start { [weak self] samples in
            guard let self else { return }
            self.serialQueue.async { self.appendSys(samples) }
        }

        if captureMic {
            // Start the mic off the main flow. A pending or blocked microphone
            // permission prompt must never hold up system audio transcription.
            Task.detached { [weak self] in
                await self?.startMicIfPermitted()
            }
        } else {
            Paths.log("mic capture disabled")
        }
    }

    /// Ask for microphone access if needed, then start the engine. Any failure
    /// leaves the system audio path running.
    private func startMicIfPermitted() async {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        var granted = status == .authorized
        if status == .notDetermined {
            granted = await AVCaptureDevice.requestAccess(for: .audio)
        }
        guard granted else {
            Paths.log("mic permission not granted, continuing with system audio only")
            return
        }
        do {
            try startMic()
            serialQueue.sync { micEnabled = true }
            Paths.log("mic engine started")
        } catch {
            Paths.log("mic engine failed, continuing with system audio only. \(error)")
        }
    }

    func stop() async throws {
        tap.stop()
        if micEngine.isRunning {
            micEngine.inputNode.removeTap(onBus: 0)
            micEngine.stop()
        }
        serialQueue.sync {
            if micEnabled {
                let n = min(sysPending.count, micPending.count)
                if n > 0 { mixAndEmit(sysHead: n, micHead: n) }
            } else if !sysPending.isEmpty {
                let chunk = sysPending
                sysPending.removeAll(keepingCapacity: false)
                emit(chunk)
            }
            micEnabled = false
        }
    }

    // MARK: - Mic

    private func startMic() throws {
        let input = micEngine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else { throw AudioCaptureError.noAudioDevices }

        guard let convTarget = targetFormat else { throw AudioCaptureError.formatFailed }
        micConverter = AVAudioConverter(from: inputFormat, to: convTarget)

        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            guard let self = self,
                  let conv = self.micConverter,
                  let outBuf = AVAudioPCMBuffer(
                    pcmFormat: convTarget,
                    frameCapacity: AVAudioFrameCount(convTarget.sampleRate)
                  ) else { return }

            var fed = false
            var convError: NSError?
            conv.convert(to: outBuf, error: &convError) { _, status in
                if fed { status.pointee = .noDataNow; return nil }
                fed = true; status.pointee = .haveData
                return buffer
            }
            if convError != nil { return }

            guard let channelData = outBuf.floatChannelData else { return }
            let frameCount = Int(outBuf.frameLength)
            if frameCount == 0 { return }
            let samples = Array(UnsafeBufferPointer(start: channelData[0], count: frameCount))
            self.serialQueue.async { self.appendMic(samples) }
        }

        do { try micEngine.start() }
        catch { throw AudioCaptureError.startAudioDeviceFailed(0) }
    }

    // MARK: - Mixing (runs on serialQueue)

    private func appendSys(_ samples: [Float]) {
        if !loggedFirstSys { Paths.log("first system audio chunk, \(samples.count) samples"); loggedFirstSys = true }
        guard micEnabled else {
            emit(samples)
            return
        }
        sysPending.append(contentsOf: samples)
        drainMixer()
        // Stuck mic guard. If a few seconds of system audio buffer with no mic
        // samples arriving, the mic is dead. Fall back to system only so the
        // transcript keeps flowing.
        let stuckThreshold = Int(Self.outputSampleRate * 3)
        if sysPending.count > stuckThreshold && micSamplesSeen == 0 {
            Paths.log("mic delivered no samples, falling back to system audio only")
            let drained = sysPending
            sysPending.removeAll(keepingCapacity: false)
            micEnabled = false
            emit(drained)
        }
    }

    private func appendMic(_ samples: [Float]) {
        if !loggedFirstMic { Paths.log("first mic chunk, \(samples.count) samples"); loggedFirstMic = true }
        micSamplesSeen += samples.count
        micPending.append(contentsOf: samples)
        drainMixer()
    }

    private func drainMixer() {
        let n = min(sysPending.count, micPending.count)
        if n == 0 { return }
        mixAndEmit(sysHead: n, micHead: n)
    }

    private func mixAndEmit(sysHead: Int, micHead: Int) {
        let n = min(sysHead, micHead, sysPending.count, micPending.count)
        if n == 0 { return }
        var mixed = [Float](repeating: 0, count: n)
        for i in 0..<n {
            // Equal weight sum then soft clip. 0.5 keeps the mix at -6 dB so two
            // loud sources at once do not clip.
            let s = sysPending[i] + micPending[i]
            mixed[i] = max(-1, min(1, s * 0.5))
        }
        sysPending.removeFirst(n)
        micPending.removeFirst(n)
        emit(mixed)
    }

    private func emit(_ mono: [Float]) {
        var peak: Float = 0
        for s in mono { let a = abs(s); if a > peak { peak = a } }
        if peak > lastPeak { lastPeak = peak } else { lastPeak *= 0.92 }
        if peak > maxPeak { maxPeak = peak }
        onSamples?(mono)
    }
}

// MARK: - System audio process tap

/// A Core Audio process tap over the global system mix, wrapped in a private
/// aggregate device with an IO callback. Adapted from the MIT licensed
/// mac-audio-capture project.
final class SystemAudioTap: @unchecked Sendable {
    private var tapID: AudioObjectID = .unknown
    private var aggregateID: AudioObjectID = .unknown
    private var ioProcID: AudioDeviceIOProcID?
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private let target: AVAudioFormat
    private var processing: (([Float]) -> Void)?

    init() {
        target = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: AudioCapture.outputSampleRate,
            channels: AudioCapture.outputChannels,
            interleaved: false
        )!
    }

    func start(_ onSamples: @escaping ([Float]) -> Void) throws {
        processing = onSamples

        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.uuid = UUID()
        description.name = "opencode-transcript system audio"
        description.muteBehavior = .unmuted
        description.isPrivate = true
        description.isExclusive = false

        var newTap = AudioObjectID.unknown
        var err = AudioHardwareCreateProcessTap(description, &newTap)
        guard err == noErr, newTap.isValid else { throw AudioCaptureError.createProcessTapFailed(err) }
        tapID = newTap

        var asbd = try tapID.readTapStreamDescription()
        guard let inputFmt = AVAudioFormat(streamDescription: &asbd) else {
            throw AudioCaptureError.getStreamDescriptionFailed
        }
        inputFormat = inputFmt
        converter = AVAudioConverter(from: inputFmt, to: target)
        Paths.log("system audio tap format \(inputFmt.sampleRate) Hz, \(inputFmt.channelCount) ch")

        let tapConfig: [String: Any] = [
            kAudioSubTapUIDKey as String: description.uuid.uuidString,
            kAudioSubTapDriftCompensationKey as String: true,
        ]
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "opencode-transcript",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceTapListKey: [tapConfig],
            kAudioAggregateDeviceTapAutoStartKey: false,
            kAudioAggregateDeviceIsPrivateKey: true,
        ]

        var newAggregate = AudioObjectID.unknown
        err = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &newAggregate)
        guard err == noErr, newAggregate.isValid else { throw AudioCaptureError.createAggregateDeviceFailed(err) }
        aggregateID = newAggregate

        err = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, nil) { [weak self] _, inInputData, _, _, _ in
            self?.handle(inInputData)
        }
        guard err == noErr else { throw AudioCaptureError.createDeviceIOProcFailed(err) }

        err = AudioDeviceStart(aggregateID, ioProcID)
        guard err == noErr else { throw AudioCaptureError.startAudioDeviceFailed(err) }
        Paths.log("system audio tap running")
    }

    func stop() {
        processing = nil
        if aggregateID.isValid {
            _ = AudioDeviceStop(aggregateID, ioProcID)
            if let ioProcID { _ = AudioDeviceDestroyIOProcID(aggregateID, ioProcID) }
            _ = AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = .unknown
            ioProcID = nil
        }
        if tapID.isValid {
            _ = AudioHardwareDestroyProcessTap(tapID)
            tapID = .unknown
        }
        converter = nil
        inputFormat = nil
    }

    // Runs on the Core Audio IO thread.
    private func handle(_ inputData: UnsafePointer<AudioBufferList>) {
        guard let processing,
              let inputFormat,
              let converter,
              let inputBuffer = AVAudioPCMBuffer(pcmFormat: inputFormat, bufferListNoCopy: inputData, deallocator: nil)
        else { return }

        let ratio = target.sampleRate / inputFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(inputBuffer.frameLength) * ratio) + 1024
        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }

        var fed = false
        var convError: NSError?
        converter.convert(to: outputBuffer, error: &convError) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData
            return inputBuffer
        }
        if convError != nil { return }

        guard let channelData = outputBuffer.floatChannelData else { return }
        let frames = Int(outputBuffer.frameLength)
        if frames == 0 { return }
        let samples = Array(UnsafeBufferPointer(start: channelData[0], count: frames))
        processing(samples)
    }
}

// MARK: - Core Audio helpers

extension AudioObjectID {
    static let unknown = AudioObjectID(kAudioObjectUnknown)
    var isValid: Bool { self != .unknown }

    /// Reads `kAudioTapPropertyFormat` for the tap this object refers to.
    func readTapStreamDescription() throws -> AudioStreamBasicDescription {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var value = AudioStreamBasicDescription()
        let err = AudioObjectGetPropertyData(self, &address, 0, nil, &size, &value)
        guard err == noErr else { throw AudioCaptureError.getStreamDescriptionFailed }
        return value
    }
}
