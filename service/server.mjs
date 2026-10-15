// Transcript service. A localhost HTTP server that owns the native capture
// binary and holds the running transcript.
//
// It is a singleton on its port. The plugin starts it on demand, and every
// plugin instance, session and terminal shares the one recording.
//
// Endpoints
//   GET  /health      liveness probe, used to detect an already running server
//   POST /start       spawn the capture binary and begin transcribing
//   POST /stop        stop the capture binary and keep the transcript
//   GET  /status      current state, elapsed time and input level
//   GET  /transcript  the transcript as structured segments and plain text
//   GET  /events      Server Sent Events stream of state and segment updates

import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { appendFile, mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { openSync } from "node:fs"
import path from "node:path"

const PORT = Number(process.env.TRANSCRIPT_PORT || 4790)
const DATA_DIR = String(process.env.TRANSCRIPT_DATA_DIR || path.join(process.env.HOME || ".", ".local", "share", "opencode", "transcript"))
const BINARY = String(process.env.TRANSCRIPT_CAPTURE_BIN || "transcript-capture")

const state = {
  state: "idle", // idle | loading | running | stopping | error
  error: null,
  warning: null,
  startedAt: null,
  endedAt: null,
  peak: 0,
  mic: true,
  segments: [],
  tail: "",
}

let child = null
let logHandle = null
let stdoutBuffer = ""
const clients = new Set()

function broadcast(type, data = {}) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) {
    try {
      res.write(payload)
    } catch {
      clients.delete(res)
    }
  }
}

function stamp(seconds) {
  const s = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
}

function transcriptText() {
  return state.segments
    .map((seg) => (seg.speaker ? `[${stamp(seg.start)}] ${seg.speaker}: ${seg.text}` : `[${stamp(seg.start)}] ${seg.text}`))
    .join("\n")
}

// Total bytes under a directory. Used to show model download progress while
// the capture binary is loading.
async function dirSize(dir) {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await dirSize(full)
    } else {
      try {
        total += (await stat(full)).size
      } catch {
        // A file that vanished mid walk, ignore it.
      }
    }
  }
  return total
}

async function transcriptFile() {
  return path.join(DATA_DIR, "transcript.md")
}

async function writeHeader() {
  const file = await transcriptFile()
  const started = state.startedAt ? new Date(state.startedAt).toISOString() : new Date().toISOString()
  await writeFile(file, `# Live transcript\n\nStarted ${started}\n\n`, "utf8")
}

async function appendLine(line) {
  try {
    await appendFile(await transcriptFile(), line + "\n", "utf8")
  } catch {
    // The transcript stays in memory even if the file write fails.
  }
}

function handleEvent(msg) {
  switch (msg.type) {
    case "phase": {
      // The capture binary is warming up, most likely loading or downloading
      // the Whisper model. Report it as loading, not recording.
      if (msg.phase === "loading-model") {
        state.state = "loading"
        broadcast("state", { state: state.state })
      }
      break
    }
    case "ready": {
      state.state = "running"
      state.error = null
      state.startedAt = state.startedAt ?? Date.now()
      void writeHeader()
      broadcast("state", { state: state.state, startedAt: state.startedAt })
      break
    }
    case "segment": {
      const seg = {
        text: String(msg.text ?? ""),
        start: Number(msg.start ?? 0),
        end: Number(msg.end ?? msg.start ?? 0),
        speaker: msg.speaker ?? null,
      }
      state.segments.push(seg)
      state.tail = ""
      const line = seg.speaker ? `[${stamp(seg.start)}] ${seg.speaker}: ${seg.text}` : `[${stamp(seg.start)}] ${seg.text}`
      void appendLine(line)
      broadcast("segment", { segment: seg, index: state.segments.length - 1 })
      break
    }
    case "tail": {
      state.tail = String(msg.text ?? "")
      broadcast("tail", { text: state.tail })
      break
    }
    case "level": {
      state.peak = Number(msg.peak ?? 0)
      broadcast("level", { peak: state.peak })
      break
    }
    case "warning": {
      state.warning = String(msg.message ?? "")
      broadcast("warning", { message: state.warning })
      break
    }
    case "error": {
      state.state = "error"
      state.error = String(msg.message ?? "unknown error")
      broadcast("state", { state: state.state, error: state.error })
      break
    }
    case "done": {
      broadcast("state", { state: state.state })
      break
    }
    default:
      break
  }
}

function onStdout(chunk) {
  stdoutBuffer += chunk
  let nl = stdoutBuffer.indexOf("\n")
  while (nl !== -1) {
    const line = stdoutBuffer.slice(0, nl).trim()
    stdoutBuffer = stdoutBuffer.slice(nl + 1)
    if (line) {
      try {
        handleEvent(JSON.parse(line))
      } catch {
        // Ignore a non JSON line so one bad line never kills the stream.
      }
    }
    nl = stdoutBuffer.indexOf("\n")
  }
}

async function start(mic) {
  if (state.state === "running" || state.state === "loading") {
    return { ok: true, already: true, state: state.state }
  }
  state.state = "loading"
  state.error = null
  state.warning = null
  state.startedAt = Date.now()
  state.endedAt = null
  state.mic = mic !== false
  state.tail = ""
  // A new recording starts a fresh transcript. Stop keeps the last one.
  state.segments = []
  broadcast("state", { state: state.state })

  try {
    await mkdir(DATA_DIR, { recursive: true })
    logHandle = openSync(path.join(DATA_DIR, "capture.log"), "a")
  } catch {
    logHandle = "ignore"
  }

  const args = state.mic ? [] : ["--no-mic"]
  try {
    // stdin is a control pipe, stdout carries the JSON stream, stderr goes to
    // the log file.
    child = spawn(BINARY, args, { stdio: ["pipe", "pipe", logHandle] })
  } catch (err) {
    state.state = "error"
    state.error = `could not start capture binary at ${BINARY}. ${err?.message || err}`
    broadcast("state", { state: state.state, error: state.error })
    return { ok: false, error: state.error }
  }

  stdoutBuffer = ""
  child.stdout?.on("data", (buf) => onStdout(String(buf)))
  child.on("error", (err) => {
    state.state = "error"
    state.error = `capture binary error. ${err?.message || err}`
    broadcast("state", { state: state.state, error: state.error })
  })
  child.on("exit", (code) => {
    child = null
    if (state.state === "stopping" || state.state === "running" || state.state === "loading") {
      state.state = state.error ? "error" : "idle"
    }
    state.endedAt = Date.now()
    broadcast("state", { state: state.state, endedAt: state.endedAt })
  })

  return { ok: true, state: state.state }
}

async function stop() {
  if (!child) {
    if (state.state !== "idle" && state.state !== "error") state.state = "idle"
    return { ok: true, state: state.state }
  }
  state.state = "stopping"
  broadcast("state", { state: state.state })
  const proc = child
  const done = new Promise((resolve) => proc.once("exit", resolve))
  try {
    proc.stdin?.write("stop\n")
  } catch {
    // Fall back to a signal below.
  }
  // Escalate if the process does not drain and exit on its own.
  const term = setTimeout(() => {
    try {
      proc.kill("SIGTERM")
    } catch {
      // Already gone.
    }
  }, 1500)
  const kill = setTimeout(() => {
    try {
      proc.kill("SIGKILL")
    } catch {
      // Already gone.
    }
  }, 5000)
  await done
  clearTimeout(term)
  clearTimeout(kill)
  child = null
  state.state = "idle"
  state.endedAt = Date.now()
  broadcast("state", { state: state.state, endedAt: state.endedAt })
  return { ok: true, state: state.state }
}

function json(res, code, body) {
  const data = JSON.stringify(body)
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(data) })
  res.end(data)
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`)

  if (url.pathname === "/health") {
    return json(res, 200, { service: "opencode-transcript", state: state.state })
  }

  if (url.pathname === "/start" && req.method === "POST") {
    const body = await readBody(req)
    const result = await start(body.mic !== false)
    return json(res, result.ok ? 200 : 500, result)
  }

  if (url.pathname === "/stop" && req.method === "POST") {
    return json(res, 200, await stop())
  }

  if (url.pathname === "/status") {
    const elapsed = state.startedAt ? ((state.endedAt || Date.now()) - state.startedAt) / 1000 : 0
    const modelsBytes = state.state === "loading" ? await dirSize(path.join(DATA_DIR, "models")) : 0
    return json(res, 200, {
      state: state.state,
      running: state.state === "running",
      loading: state.state === "loading",
      error: state.error,
      warning: state.warning,
      elapsed,
      peak: state.peak,
      mic: state.mic,
      modelsBytes,
      segmentCount: state.segments.length,
    })
  }

  if (url.pathname === "/transcript") {
    const format = url.searchParams.get("format") || "json"
    if (format === "text") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      return res.end(transcriptText())
    }
    return json(res, 200, {
      state: state.state,
      running: state.state === "running",
      loading: state.state === "loading",
      startedAt: state.startedAt,
      elapsed: state.startedAt ? ((state.endedAt || Date.now()) - state.startedAt) / 1000 : 0,
      peak: state.peak,
      tail: state.tail,
      segments: state.segments,
      text: transcriptText(),
    })
  }

  if (url.pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    res.write(`event: state\ndata: ${JSON.stringify({ state: state.state })}\n\n`)
    clients.add(res)
    const keepAlive = setInterval(() => {
      try {
        res.write(": keep-alive\n\n")
      } catch {
        clearInterval(keepAlive)
        clients.delete(res)
      }
    }, 15000)
    req.on("close", () => {
      clearInterval(keepAlive)
      clients.delete(res)
    })
    return
  }

  return json(res, 404, { error: "not found" })
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`opencode-transcript service listening on ${PORT}`)
})

function shutdown() {
  try {
    if (child) child.kill("SIGTERM")
  } catch {
    // Nothing to do.
  }
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
