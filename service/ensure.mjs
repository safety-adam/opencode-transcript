// Shared bootstrap for the transcript service. Both plugin halves import this.
//
// The service is a small Node HTTP server (`server.mjs`) that owns the native
// capture binary and keeps the running transcript in memory. It is a singleton
// on a localhost port, so any number of plugin instances, sessions or terminals
// share one recording.
//
// Nothing here imports a TypeScript type or a framework, so the same file loads
// from the server half (`src/index.ts`) and the compiled TUI half
// (`dist/tui.js`).

import { execFileSync, spawn } from "node:child_process"
import { openSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const DEFAULT_PORT = 4790

export function resolveConfig(options = {}) {
  const port = Number(options.port || process.env.TRANSCRIPT_PORT || DEFAULT_PORT)
  const dataDir = String(
    options.dataDir ||
      process.env.TRANSCRIPT_DATA_DIR ||
      path.join(os.homedir(), ".local", "share", "opencode", "transcript"),
  )
  return { port, dataDir, binary: resolveBinary(options) }
}

export function serverURL(port) {
  return `http://127.0.0.1:${port}`
}

// Locate the native capture binary. Order of precedence:
//   1. An explicit option or TRANSCRIPT_CAPTURE_BIN.
//   2. The bundled app built by service/native/make-app.sh (needed so macOS
//      attributes the Screen Recording permission to a stable bundle).
//   3. A bare `swift build` output next to the sources.
//   4. `transcript-capture` on PATH.
function resolveBinary(options = {}) {
  const explicit = options.binary || process.env.TRANSCRIPT_CAPTURE_BIN
  if (explicit) return explicit
  const app = path.join(HERE, "native", "Transcript Capture.app", "Contents", "MacOS", "transcript-capture")
  if (existsSync(app)) return app
  const built = path.join(HERE, "native", ".build", "release", "transcript-capture")
  if (existsSync(built)) return built
  return "transcript-capture"
}

export async function isHealthy(port) {
  try {
    const res = await fetch(serverURL(port) + "/health", { signal: AbortSignal.timeout(800) })
    if (!res.ok) return false
    const body = await res.json()
    return body?.service === "opencode-transcript"
  } catch {
    return false
  }
}

// OpenCode runs on its own binary, so process.execPath is not a JavaScript
// runtime. Find a real node to run the server.
function findNode() {
  const candidates = [
    process.env.TRANSCRIPT_NODE,
    "node",
    path.join(os.homedir(), ".local", "share", "mise", "shims", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 3000 })
      return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return "node"
}

// Start the service if it is not already up. Returns true once healthy. The
// server is a singleton on its port, so a second start exits quietly.
export async function ensureServer(config) {
  const { port, dataDir, binary } = config
  if (await isHealthy(port)) return true

  try {
    await mkdir(dataDir, { recursive: true })
  } catch {
    // The server also creates it.
  }

  let out = "ignore"
  try {
    out = openSync(path.join(dataDir, "server.log"), "a")
  } catch {
    // Fall back to discarding output.
  }

  try {
    const child = spawn(findNode(), [path.join(HERE, "server.mjs")], {
      detached: true,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        TRANSCRIPT_PORT: String(port),
        TRANSCRIPT_DATA_DIR: dataDir,
        TRANSCRIPT_CAPTURE_BIN: binary,
      },
    })
    child.unref()
  } catch {
    return false
  }

  for (let i = 0; i < 25; i++) {
    await new Promise((resolve) => setTimeout(resolve, 160))
    if (await isHealthy(port)) return true
  }
  return false
}

export async function startListening(config, { mic = true } = {}) {
  if (!(await ensureServer(config))) return { ok: false, error: "service did not start" }
  try {
    const res = await fetch(serverURL(config.port) + "/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mic }),
    })
    return await res.json()
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

export async function stopListening(config) {
  try {
    const res = await fetch(serverURL(config.port) + "/stop", { method: "POST" })
    return await res.json()
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

// Sidebar decorations. Any TUI plugin can annotate session rows in the
// jump-sidebar plugin by dropping one JSON file per plugin into a shared
// directory. There is no import between plugins, only this file contract.
//
//   directory  ~/.local/share/opencode/sidebar/decorations/
//              override the parent with OPENCODE_SIDEBAR_DIR
//   file       <plugin-id>.json, one per contributing plugin
//   shape      { "sessions": { "<sessionID>": {
//                  "dot":   { "color": "red", "title": "Recording" },
//                  "label": "REC"
//              } } }
//
// The sidebar merges every file. A dot is drawn before the title, and a label
// after the dot. Colour is any OpenTUI colour, a name or a hex string.
export function sidebarDecorationsDir() {
  const base =
    process.env.OPENCODE_SIDEBAR_DIR ||
    path.join(os.homedir(), ".local", "share", "opencode", "sidebar")
  return path.join(base, "decorations")
}

export async function writeSessionDecorations(pluginID, sessions) {
  const dir = sidebarDecorationsDir()
  const file = path.join(dir, `${pluginID}.json`)
  try {
    if (sessions && Object.keys(sessions).length > 0) {
      await mkdir(dir, { recursive: true })
      await writeFile(file, JSON.stringify({ sessions }), "utf8")
    } else {
      await rm(file, { force: true })
    }
  } catch {
    // Best effort, the indicator is not critical.
  }
}

export async function fetchStatus(config) {
  try {
    const res = await fetch(serverURL(config.port) + "/status", { signal: AbortSignal.timeout(1500) })
    return await res.json()
  } catch {
    return { state: "unreachable", running: false }
  }
}

export async function fetchTranscript(config) {
  try {
    const res = await fetch(serverURL(config.port) + "/transcript", { signal: AbortSignal.timeout(2000) })
    return await res.json()
  } catch {
    return { state: "unreachable", running: false, segments: [], text: "" }
  }
}
