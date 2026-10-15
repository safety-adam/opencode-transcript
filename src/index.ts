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
          "the live transcript panel. Returns the transcript so far, with a timestamp per line. " +
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
          if (!data.running && (data.segments || []).length === 0) {
            return { content: "Nothing is being recorded and no transcript is held. Start it with /listen." }
          }

          const since = typeof args.since === "number" ? args.since : 0
          const segments = (data.segments || []).filter((seg: any) => Number(seg.start ?? 0) >= since)

          if (args.format === "json") {
            return {
              content: JSON.stringify(
                { state: data.state, running: data.running, elapsed: data.elapsed, segments },
                null,
                2,
              ),
            }
          }

          if (segments.length === 0) {
            return { content: data.running ? "Recording, but nothing has been transcribed yet." : "No transcript segments." }
          }

          const lines = segments.map((seg: any) => {
            const s = Math.max(0, Math.floor(Number(seg.start ?? 0)))
            const stamp = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
            return seg.speaker ? `[${stamp}] ${seg.speaker}: ${seg.text}` : `[${stamp}] ${seg.text}`
          })
          const header = data.running ? "Live transcript so far." : "Transcript from the last recording."
          const warning = data.warning ? `\n\nNote. ${data.warning}` : ""
          return { content: `${header}\n\n${lines.join("\n")}${warning}` }
        },
      } as any)
    })
  },
})
