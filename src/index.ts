import { Plugin } from "@opencode/plugin"
import { ensureServer, fetchTranscript, resolveConfig } from "../service/ensure.mjs"

// Server half of opencode-transcript.
//
// It makes sure the transcript service is up and registers the `live_transcript`
// tool, so an agent working in a session can read the transcript that the
// panel is showing. The TUI half renders the panel and starts and stops the
// capture.
//
// The service itself is shared across sessions and terminals. See
// service/server.mjs.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// "19 Oct 2026 10:30" in the machine's local time.
function wallClock(ms: number): string {
  const d = new Date(ms)
  const day = String(d.getDate()).padStart(2, "0")
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  return `${day} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${hh}:${mm}`
}

// "10:30".
function clockOnly(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

// "3 minutes ago".
function timeAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? "" : "s"} ago`
}

// "3 minutes in", "1h 5m in".
function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s} seconds`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m} minutes`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h} hours`
}

export default Plugin.define({
  id: "transcript",
  async setup(ctx: any) {
    const config = resolveConfig(ctx.options || {})

    // Bring the service up in the background so the first tool call is fast.
    void ensureServer(config).catch(() => {})

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "live_transcript",
        description:
          "Read the live transcript of system audio and microphone that opencode-transcript is recording. " +
          "Call this when the user asks what was said, wants a meeting summarised as it happens, or refers to " +
          "the live transcript panel. Returns the transcript so far, with a timestamp per line, and states when the " +
          "recording ran and how long ago it ended, so a stale transcript is not mistaken for a live one. " +
          "If nothing is being recorded, it says so and the user can start it with /listen.",
        input: {
          type: "object",
          properties: {
            format: {
              type: "string",
              enum: ["text", "json"],
              description: "text returns timestamped lines. json returns segments with start and end times.",
            },
            since: {
              type: "number",
              description: "Only return segments that started at or after this many seconds into the recording.",
            },
          },
          additionalProperties: false,
        },
        async execute(input: any) {
          const args = input || {}
          const data: any = await fetchTranscript(config)

          if (!data || data.state === "unreachable") {
            return { content: "The transcript service is not running. Start it with /listen." }
          }
          if (data.loading) {
            return {
              content:
                "The transcript service is starting. The Whisper model is loading, so nothing has been transcribed yet. Try again in a moment.",
            }
          }
          const since = typeof args.since === "number" ? args.since : 0
          const segments = (data.segments || []).filter((seg: any) => Number(seg.start ?? 0) >= since)
          const startedAt = Number(data.startedAt || 0)
          const elapsed = Number(data.elapsed || 0)
          const endedAt = startedAt ? startedAt + elapsed * 1000 : 0

          // Name the recording's wall clock time and how long ago it ended, so
          // a consumer can tell a live transcript from a stale one. A stale
          // transcript is still returned, so the user can ask what was just said
          // after stopping.
          let header: string
          if (data.running) {
            header = startedAt
              ? `RECORDING. Started ${wallClock(startedAt)}, ${duration(elapsed)} in.`
              : "RECORDING."
          } else if (startedAt) {
            header = `NOT RECORDING. Last recording, ${wallClock(startedAt)} to ${clockOnly(endedAt)}, ended ${timeAgo(endedAt)}.`
          } else {
            header = "NOT RECORDING. No recording has run."
          }

          if (args.format === "json") {
            return {
              content: JSON.stringify(
                {
                  state: data.state,
                  running: data.running,
                  startedAt: startedAt || null,
                  endedAt: !data.running && startedAt ? endedAt : null,
                  elapsed,
                  segments,
                },
                null,
                2,
              ),
            }
          }

          if (segments.length === 0) {
            const body = data.running ? "Nothing has been transcribed yet." : "No transcript segments."
            return { content: `${header}\n\n${body}` }
          }

          const lines = segments.map((seg: any) => {
            const s = Math.max(0, Math.floor(Number(seg.start ?? 0)))
            const stamp = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
            return seg.speaker ? `[${stamp}] ${seg.speaker}: ${seg.text}` : `[${stamp}] ${seg.text}`
          })
          const warning = data.warning ? `\n\nNote. ${data.warning}` : ""
          return { content: `${header}\n\n${lines.join("\n")}${warning}` }
        },
      } as any)
    })
  },
})
