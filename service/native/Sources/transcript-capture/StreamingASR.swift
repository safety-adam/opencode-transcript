import Foundation
import WhisperKit

/// One transcribed chunk emitted by `StreamingASR`. `wallStart` and `wallEnd`
/// are seconds since the session began. `speakerId` is nil in this service,
/// which labels speakers only when a later build adds diarization.
struct LiveSegment: Sendable {
    let text: String
    let wallStart: TimeInterval
    let wallEnd: TimeInterval
    let speakerId: String?
}

enum StreamingASRError: Error, CustomStringConvertible {
    case modelLoadFailed(String)

    var description: String {
        switch self {
        case .modelLoadFailed(let s): return "Could not load Whisper model. \(s)"
        }
    }
}

/// Drives WhisperKit over a growing audio buffer fed by `AudioCapture`. Emits a
/// `LiveSegment` whenever two consecutive transcription passes agree on a
/// stable prefix (LocalAgreement-2). The trailing unstable hypothesis is
/// exposed through `onPendingTail` so the panel can show what Whisper currently
/// thinks the last few seconds say while it firms up.
///
/// Design
///   * `append(_:)` pushes 16 kHz mono float samples from the capture queue.
///   * A background loop runs every `stepSeconds` and transcribes from
///     `committedFrames` up to `maxWindowSeconds` of audio.
///   * The longest common word prefix of two passes is treated as stable and
///     emitted. `committedFrames` advances by the matching word end time.
///   * The loop force commits when the unstable window grows past
///     `forceCommitSeconds` so it never falls behind realtime.
///
/// This is the streaming path from bud, trimmed to the pieces the service uses.
final class StreamingASR: @unchecked Sendable {
    /// Distilled turbo variant of large-v3, about 1.5 GB. Runs faster than
    /// realtime on an M series GPU.
    static let modelName = "openai_whisper-large-v3-v20240930_turbo"

    /// How often to attempt a transcription pass.
    let stepSeconds: Double = 1.5
    /// Max audio seconds per pass. Smaller is faster, with less context.
    let maxWindowSeconds: Double = 10.0
    /// Once the unstable buffer exceeds this, commit something or fall behind.
    let forceCommitSeconds: Double = 8.0

    /// Invoked from a background task whenever a chunk has been committed.
    var onSegment: (@Sendable (LiveSegment) -> Void)?
    /// Invoked whenever the unstable trailing hypothesis updates.
    var onPendingTail: (@Sendable (String) -> Void)?
    /// Invoked once when the model finishes loading.
    var onReady: (@Sendable () -> Void)?

    private var pipe: WhisperKit?
    private let bufferLock = NSLock()
    private var samples: [Float] = []
    private var committedFrames: Int = 0
    /// Frames dropped off the front of `samples` when it is trimmed. Added back
    /// so a segment timestamp is seconds since the session began, never reset.
    private var trimmedFrames: Int = 0
    private var lastHypothesisWords: [String] = []
    /// Slow moving estimate of the room noise, so the silence gate adapts to a
    /// quiet room and a noisy one alike. Updated only on windows judged silent.
    private var noiseFloor: Float = 0.0005
    /// Trailing words already emitted, used to trim the overlap the approximate
    /// frame advance can leave at a commit boundary.
    private var lastEmittedWords: [String] = []

    private var running = false
    private var loopTask: Task<Void, Never>?
    /// Tokenised initial prompt, built once the tokenizer is loaded.
    private var promptTokens: [Int]?

    func start() async throws {
        Paths.log("ASR.start, building compute options with GPU and no ANE")
        // GPU compute is fast. ANE is avoided because it has been the source of
        // E5RT crashes when co-loaded with other CoreML work.
        let compute = ModelComputeOptions(
            melCompute: .cpuAndGPU,
            audioEncoderCompute: .cpuAndGPU,
            textDecoderCompute: .cpuAndGPU,
            prefillCompute: .cpuAndGPU
        )

        let config = WhisperKitConfig(
            model: Self.modelName,
            downloadBase: Paths.modelsDirectory,
            tokenizerFolder: Paths.modelsDirectory,
            computeOptions: compute,
            verbose: false,
            logLevel: .error,
            prewarm: false,
            load: true,
            download: true
        )

        do {
            Paths.log("ASR.start, loading WhisperKit model \(Self.modelName)")
            pipe = try await WhisperKit(config)
            Paths.log("ASR.start, model loaded")
        } catch {
            Paths.log("ASR.start threw. \(error)")
            throw StreamingASRError.modelLoadFailed(error.localizedDescription)
        }
        // Bias the decoder toward domain vocabulary when a prompt is set.
        let prompt = Paths.promptText
        if !prompt.isEmpty, let tokenizer = pipe?.tokenizer {
            let tokens = tokenizer.encode(text: " " + prompt)
                .filter { $0 < tokenizer.specialTokens.specialTokenBegin }
            promptTokens = tokens.isEmpty ? nil : tokens
            Paths.log("initial prompt set, \(tokens.count) tokens")
        }

        running = true
        onReady?()
        loopTask = Task.detached(priority: .userInitiated) { [weak self] in
            await self?.runLoop()
        }
    }

    /// Append captured samples. Called from the capture writer queue.
    func append(_ newSamples: [Float]) {
        bufferLock.lock()
        samples.append(contentsOf: newSamples)
        bufferLock.unlock()
    }

    func stop() async {
        running = false
        loopTask?.cancel()
        loopTask = nil
        await drainTail()
        flushPendingTail()
        pipe = nil
    }

    /// Emit any words still pending after the final pass, so the last thing said
    /// is never left as grey text that never reaches the transcript.
    private func flushPendingTail() {
        guard !lastHypothesisWords.isEmpty else { return }
        let end = TimeInterval(trimmedFrames + committedFrames) / AudioCapture.outputSampleRate
        let start = max(0, end - Double(lastHypothesisWords.count) * 0.4)
        emitCommitted(lastHypothesisWords.joined(separator: " "), wallStart: start, wallEnd: end)
        lastHypothesisWords = []
        onPendingTail?("")
    }

    // MARK: - Loop

    private func snapshotWindow(sampleRate: Double) -> (chunk: [Float], baseFrame: Int)? {
        bufferLock.lock(); defer { bufferLock.unlock() }
        let total = samples.count
        let avail = total - committedFrames
        // Need at least about one second before there is anything worth running.
        if avail < Int(sampleRate) { return nil }
        let cap = Int(sampleRate * maxWindowSeconds)
        let take = min(avail, cap)
        let chunk = Array(samples[committedFrames ..< committedFrames + take])
        return (chunk, trimmedFrames + committedFrames)
    }

    private func advanceCommitted(by frames: Int) {
        bufferLock.lock(); defer { bufferLock.unlock() }
        committedFrames += frames
        // Trim once more than 60 s of dead audio sits behind the cursor. The
        // trimmed count is kept so timestamps stay monotonic.
        if committedFrames > 60 * 16_000 {
            samples.removeFirst(committedFrames)
            trimmedFrames += committedFrames
            committedFrames = 0
        }
    }

    private func runLoop() async {
        let sampleRate = AudioCapture.outputSampleRate
        while running && !Task.isCancelled {
            try? await Task.sleep(nanoseconds: UInt64(stepSeconds * 1_000_000_000))
            await processOnePass(sampleRate: sampleRate, forceCommit: false)
        }
    }

    private func drainTail() async {
        let sampleRate = AudioCapture.outputSampleRate
        await processOnePass(sampleRate: sampleRate, forceCommit: true)
    }

    /// One transcription pass. Take the current window, transcribe it, compare
    /// with the previous hypothesis, commit the stable prefix and update the
    /// pending tail. `forceCommit` flushes whatever is there regardless of
    /// agreement, used on stop.
    private func processOnePass(sampleRate: Double, forceCommit: Bool) async {
        guard let pipe = pipe else { return }
        guard let (chunk, baseFrame) = snapshotWindow(sampleRate: sampleRate) else { return }

        let chunkSeconds = Double(chunk.count) / sampleRate
        if !forceCommit && chunkSeconds < 2.0 { return }

        // Skip near-silent windows. Whisper invents phrases like "Thank you" on
        // silence, which would fill a quiet meeting with junk. The gate is a
        // multiple of the room noise floor, so it tracks a quiet room and a
        // noisy one without ever cutting into speech.
        if !forceCommit {
            // Gate on the loudest 100 ms frame, not the whole window average. A
            // window holding a short utterance inside a lot of silence must not
            // be skipped, and a window average would skip it.
            let frameLength = max(1, Int(sampleRate * 0.1))
            var maxFrameRms: Float = 0
            var sumSquares: Float = 0
            var index = 0
            while index < chunk.count {
                let end = min(index + frameLength, chunk.count)
                var frameSquares: Float = 0
                for j in index..<end { let s = chunk[j]; frameSquares += s * s }
                sumSquares += frameSquares
                let frameRms = (frameSquares / Float(end - index)).squareRoot()
                if frameRms > maxFrameRms { maxFrameRms = frameRms }
                index = end
            }
            let meanRms = (sumSquares / Float(chunk.count)).squareRoot()
            let gate = max(noiseFloor * 3, 0.0005)
            if maxFrameRms < gate {
                // Silence. Flush any words still pending from the previous
                // window before moving past this audio, otherwise the quiet tail
                // of a sentence is lost. Timing is approximate, the word count
                // gives a rough span.
                if !lastHypothesisWords.isEmpty {
                    let end = TimeInterval(trimmedFrames + committedFrames) / sampleRate
                    let start = max(0, end - Double(lastHypothesisWords.count) * 0.4)
                    emitCommitted(lastHypothesisWords.joined(separator: " "), wallStart: start, wallEnd: end)
                    lastHypothesisWords = []
                    onPendingTail?("")
                }
                noiseFloor = 0.9 * noiseFloor + 0.1 * meanRms
                advanceCommitted(by: chunk.count)
                return
            }
        }

        let results: [TranscriptionResult]
        do {
            var options = DecodingOptions()
            // Real word timings, so the cursor advances to the end of the last
            // committed word instead of a guessed fraction of the window.
            options.wordTimestamps = true
            if let promptTokens { options.promptTokens = promptTokens }
            results = try await pipe.transcribe(audioArray: chunk, decodeOptions: options)
        } catch {
            Paths.log("transcribe error. \(error)")
            return
        }

        // Words with their start and end times inside the chunk, in order.
        var newWords: [String] = []
        var wordStarts: [Float] = []
        var wordEnds: [Float] = []
        for segment in results.flatMap({ $0.segments }) {
            for word in segment.words ?? [] {
                let cleaned = word.word.trimmingCharacters(in: .whitespacesAndNewlines)
                if cleaned.isEmpty { continue }
                newWords.append(cleaned)
                wordStarts.append(word.start)
                wordEnds.append(word.end)
            }
        }
        let haveTimings = wordEnds.count == newWords.count && !newWords.isEmpty
        if newWords.isEmpty {
            // Timings missing, fall back to the plain text.
            let fullText = results.map { $0.text }.joined(separator: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            newWords = fullText.split(whereSeparator: { $0.isWhitespace }).map { String($0) }
        }

        if newWords.isEmpty {
            if chunkSeconds >= forceCommitSeconds || forceCommit {
                flushPendingTail()
                advanceCommitted(by: chunk.count)
                onPendingTail?("")
            }
            return
        }

        // A silence hallucination must never overwrite a real pending tail. On
        // the quiet after speech Whisper returns "Thank you" and similar, which
        // would otherwise replace the last real words before they are committed,
        // losing them from the transcript.
        if !lastHypothesisWords.isEmpty && isSilencePhrase(newWords.joined(separator: " ")) {
            flushPendingTail()
            advanceCommitted(by: chunk.count)
            return
        }

        let stableCount = longestCommonPrefix(lastHypothesisWords, newWords)

        var commitCount = stableCount
        if forceCommit { commitCount = newWords.count }
        // If the window is full and the passes still disagree, force commit
        // everything but the last quarter so the loop does not fall behind.
        if !forceCommit && chunkSeconds >= forceCommitSeconds && stableCount == 0 {
            commitCount = max(0, Int(Double(newWords.count) * 0.75))
        }

        if commitCount > 0 {
            let committedText = newWords[0..<commitCount].joined(separator: " ")
            // Cut at the end of the last committed word. Exact when timings are
            // present, otherwise the old word fraction as a fallback.
            let cutSeconds: Double
            let startSeconds: Double
            if haveTimings {
                cutSeconds = Double(wordEnds[commitCount - 1])
                startSeconds = Double(wordStarts[0])
            } else {
                cutSeconds = chunkSeconds * Double(commitCount) / Double(newWords.count)
                startSeconds = 0
            }
            let cutFrames = min(chunk.count, max(1, Int(cutSeconds * sampleRate)))
            let wallStart = TimeInterval(baseFrame) / sampleRate + startSeconds
            let wallEnd = TimeInterval(baseFrame) / sampleRate + cutSeconds
            emitCommitted(committedText, wallStart: wallStart, wallEnd: wallEnd)
            advanceCommitted(by: cutFrames)
            lastHypothesisWords = Array(newWords[commitCount...])
        } else {
            lastHypothesisWords = newWords
        }

        onPendingTail?(lastHypothesisWords.joined(separator: " "))
    }

    /// Longest common prefix of two word arrays, compared on a normalised form
    /// of each word (lower cased, punctuation stripped).
    private func longestCommonPrefix(_ a: [String], _ b: [String]) -> Int {
        let n = min(a.count, b.count)
        var i = 0
        while i < n && norm(a[i]) == norm(b[i]) { i += 1 }
        return i
    }

    /// Emit a committed chunk. Trims any leading words that repeat the tail of
    /// the last emitted chunk, then drops a chunk made only of Whisper's silence
    /// phrases. Keeps a short tail of emitted words for the overlap check.
    private func emitCommitted(_ text: String, wallStart: TimeInterval, wallEnd: TimeInterval) {
        var words = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        if words.isEmpty { return }

        let maxK = min(lastEmittedWords.count, words.count)
        if maxK > 0 {
            for k in stride(from: maxK, through: 1, by: -1) {
                let tail = lastEmittedWords.suffix(k).map(norm)
                let head = words.prefix(k).map(norm)
                if tail == head {
                    words.removeFirst(k)
                    break
                }
            }
        }
        guard !words.isEmpty else { return }

        let trimmed = words.joined(separator: " ")
        if isSilencePhrase(trimmed) || isNoiseAnnotation(trimmed) { return }

        lastEmittedWords.append(contentsOf: words)
        if lastEmittedWords.count > 40 {
            lastEmittedWords.removeFirst(lastEmittedWords.count - 40)
        }
        onSegment?(LiveSegment(text: trimmed, wallStart: wallStart, wallEnd: wallEnd, speakerId: nil))
    }

    /// Words that make up Whisper's silence hallucinations. A segment made
    /// entirely from these is dropped.
    private let silenceWords: Set<String> = [
        "thank", "thanks", "you", "please", "subscribe", "watching", "bye",
        "love", "i", "for", "thankyou", "thankyouverymuch",
    ]

    /// True for a sound annotation Whisper writes for non speech, such as
    /// `*clicks*`, `[BLANK_AUDIO]` or `(upbeat music)`. The whole segment is
    /// wrapped in one pair of brackets or asterisks.
    private func isNoiseAnnotation(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.count >= 2, let first = t.first, let last = t.last else { return false }
        return (first == "[" && last == "]") || (first == "(" && last == ")") || (first == "*" && last == "*")
    }

    private func isSilencePhrase(_ text: String) -> Bool {
        let words = text.lowercased()
            .split(whereSeparator: { !$0.isLetter })
            .map(String.init)
            .filter { !$0.isEmpty }
        guard !words.isEmpty else { return true }
        return words.allSatisfy { silenceWords.contains($0) }
    }

    private func norm(_ s: String) -> String {
        let lower = s.lowercased()
        return lower.unicodeScalars
            .filter { CharacterSet.alphanumerics.contains($0) }
            .reduce(into: "") { $0.append(Character($1)) }
    }
}
