import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createSignal, onCleanup } from "solid-js"
import {
  ensureServer,
  fetchTranscript,
  resolveConfig,
  startListening,
  stopListening,
  writeSessionDecorations,
} from "../service/ensure.mjs"

// TUI half of opencode-transcript.
//
// Renders the live transcript as a horizontal panel above the prompt composer.
// The panel sticks to the bottom as new lines arrive, so it reads like live
// subtitles, and you can scroll up to read back through the meeting. Scrolling
// away pauses the stick, and scrolling back to the bottom resumes it.
//
// The panel belongs to one session, the session that ran /listen. Other
// sessions do not show it, even though the recording itself is shared.
//
// Commands
//   /listen         start transcribing system audio and mic, and open the panel
//   /listen-stop    stop transcribing
//   /transcript     show or hide the panel without stopping

const SPIN = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
const BUSY = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function pick(...values: any[]): any {
  for (const v of values) if (v !== undefined && v !== null) return v
  return undefined
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0))
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
}

function formatBytes(bytes: number): string {
  const b = Number(bytes) || 0
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`
  return `${b} B`
}

function meter(peak: number, width: number): string {
  // Speech peaks sit near 0.02 of full scale, so a linear bar barely moves. Map
  // -60 dB to 0 dB onto the bar instead.
  const p = Math.max(peak || 0, 0)
  const db = 20 * Math.log10(p + 1e-7)
  const level = Math.max(0, Math.min(1, (db + 60) / 60))
  const filled = Math.round(level * width)
  let out = ""
  for (let i = 0; i < width; i++) {
    out += i < filled ? SPIN[Math.min(SPIN.length - 1, 1 + Math.floor(level * (SPIN.length - 1)))] : "·"
  }
  return out
}

type Segment = { text: string; start: number; end: number; speaker?: string | null }
type Status = {
  state: string
  running: boolean
  loading: boolean
  elapsed: number
  peak: number
  modelsBytes: number
  error?: string | null
  warning?: string | null
}

function Panel(props: {
  context: any
  status: () => Status
  segments: () => Segment[]
  tail: () => string
  frame: () => number
  height: number
  onStop: () => void
  onHide: () => void
}) {
  const theme = props.context.theme
  const base = pick(theme.text?.base, theme.text, "white")
  const muted = pick(theme.text?.muted, theme.text?.base, "gray")
  const red = pick(theme.hue?.red?.[200], theme.text?.feedback?.error?.base, "red")
  const green = pick(theme.hue?.green?.[200], theme.text?.feedback?.success?.base, "green")
  const yellow = pick(theme.text?.feedback?.warning?.base, "yellow")
  const accent = pick(theme.hue?.accent?.[200], theme.hue?.cyan?.[200], theme.text?.feedback?.info?.base, "cyan")
  const bg = pick(theme.background?.element, theme.background?.raised?.base)
  const border = pick(theme.border?.base, muted)

  const loading = () => props.status().loading
  const running = () => props.status().running
  const failed = () => Boolean(props.status().error)

  const dotColor = () => (failed() ? red : loading() ? yellow : running() ? red : muted)
  const label = () => (failed() ? "ERROR" : loading() ? "LOADING" : running() ? "LIVE" : "TRANSCRIPT")
  const spinner = () => BUSY[props.frame() % BUSY.length]

  return (
    <box flexDirection="column" height={props.height} backgroundColor={bg} paddingLeft={1} paddingRight={1} flexShrink={0}>
      <box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
        <text fg={dotColor()} flexShrink={0}>
          {"●"}
        </text>
        <text fg={base} attributes={1} flexShrink={0}>
          {label()}
        </text>
        <Show when={loading()}>
          <text fg={yellow} flexShrink={0}>
            {spinner()}
          </text>
          <text fg={muted} flexShrink={0}>
            {`model ${formatBytes(props.status().modelsBytes)}`}
          </text>
        </Show>
        <Show when={!loading()}>
          <text fg={muted} flexShrink={0}>
            {clock(props.status().elapsed)}
          </text>
          <text fg={accent} flexShrink={0}>
            {meter(props.status().peak, 8)}
          </text>
        </Show>
        <box flexGrow={1} minWidth={0} />
        <Show when={running() || loading()}>
          <text fg={muted} flexShrink={0} onMouseUp={() => props.onStop()}>
            {"■ stop"}
          </text>
        </Show>
        <text fg={muted} flexShrink={0} onMouseUp={() => props.onHide()}>
          {"▾ hide"}
        </text>
      </box>

      <text fg={border} flexShrink={0}>
        {"─".repeat(200)}
      </text>

      <scrollbox flexGrow={1} minHeight={0} width="100%" stickyScroll stickyStart="bottom" verticalScrollbarOptions={{ visible: true }}>
        <Show when={props.status().error}>
          <text fg={red}>{props.status().error}</text>
        </Show>
        <Show when={props.status().warning}>
          <text fg={yellow}>{props.status().warning}</text>
        </Show>
        <Show when={loading()}>
          <text fg={muted}>
            {`Loading the Whisper model, ${formatBytes(props.status().modelsBytes)} of about 1.5 GB. This happens once. Transcription starts automatically when it is ready.`}
          </text>
        </Show>
        <Show when={!loading() && props.segments().length === 0 && !props.tail()}>
          <text fg={muted}>
            {running() ? "Listening. Waiting for speech." : "No transcript yet. Run /listen to start."}
          </text>
        </Show>
        <For each={props.segments()}>
          {(seg: Segment) => (
            <box flexDirection="row" gap={1}>
              <text fg={muted} flexShrink={0}>
                {clock(seg.start)}
              </text>
              <text fg={green} flexShrink={0} wrapMode="none">
                {seg.speaker ? `${seg.speaker} ` : ""}
              </text>
              <text fg={base} flexGrow={1} minWidth={0} wrapMode="word">
                {seg.text}
              </text>
            </box>
          )}
        </For>
        <Show when={!loading() && props.tail()}>
          <box flexDirection="row" gap={1}>
            <text fg={muted} flexShrink={0}>
              {"  ..."}
            </text>
            <text fg={muted} flexGrow={1} minWidth={0} wrapMode="word">
              {props.tail()}
            </text>
          </box>
        </Show>
      </scrollbox>
    </box>
  )
}

export default Plugin.define({
  id: "transcript.tui",
  setup(context: any) {
    const config = resolveConfig(context.options || {})
    const height = Number(context.options?.height) || 14

    // The session that owns the panel. Set by /listen, cleared by /listen-stop,
    // and persisted so it survives a plugin reload.
    const [activeSessionID, setActiveSessionID] = createSignal<string | null>(null)
    const [hidden, setHidden] = createSignal(false)

    let persist: (patch: Record<string, any>) => void = () => {}
    try {
      const [store, update] = context.storage.store("transcript.ui", { initial: { sessionID: null, hidden: false } })
      const read = () => (typeof store === "function" ? store() : store) ?? {}
      setActiveSessionID(read().sessionID ?? null)
      setHidden(read().hidden === true)
      persist = (patch) => update((draft: any) => Object.assign(draft, patch))
    } catch {
      // Storage unavailable, the panel still works for this process.
    }

    // Tell the sidebar which session is recording, through the shared
    // decorations file contract. No import between the plugins.
    const publishDecoration = (sid: string | null) => {
      void writeSessionDecorations(
        "transcript",
        sid ? { [sid]: { dot: { color: "red", title: "Recording" }, label: "REC" } } : {},
      )
    }

    const ownSession = (sid: string | null) => {
      setActiveSessionID(sid)
      persist({ sessionID: sid })
      publishDecoration(sid)
    }
    const setHiddenBoth = (value: boolean) => {
      setHidden(value)
      persist({ hidden: value })
    }

    const [status, setStatus] = createSignal<Status>({
      state: "idle",
      running: false,
      loading: false,
      elapsed: 0,
      peak: 0,
      modelsBytes: 0,
      error: null,
      warning: null,
    })
    const [segments, setSegments] = createSignal<Segment[]>([])
    const [tail, setTail] = createSignal("")
    const [frame, setFrame] = createSignal(0)

    let inflight = false
    const refresh = async () => {
      if (inflight) return
      inflight = true
      try {
        const data: any = await fetchTranscript(config)
        setStatus({
          state: data?.state ?? "unreachable",
          running: Boolean(data?.running),
          loading: Boolean(data?.loading) || data?.state === "loading",
          elapsed: Number(data?.elapsed || 0),
          peak: Number(data?.peak || 0),
          modelsBytes: Number(data?.modelsBytes || 0),
          error: data?.error ?? null,
          warning: data?.warning ?? null,
        })
        setSegments(Array.isArray(data?.segments) ? data.segments : [])
        setTail(typeof data?.tail === "string" ? data.tail : "")
      } finally {
        inflight = false
      }
    }

    const poll = setInterval(() => {
      if (activeSessionID() || status().running || status().loading) void refresh()
    }, 700)

    // Animate the loading spinner only while loading.
    const anim = setInterval(() => {
      if (status().loading) setFrame((f) => (f + 1) % BUSY.length)
    }, 90)

    void (async () => {
      await ensureServer(config)
      await refresh()
      // Keep the shared indicator honest after a reload.
      const running = status().running || status().loading
      publishDecoration(running ? activeSessionID() : null)
    })()

    const toast = (message: string, variant: string = "info") => {
      try {
        context.ui.toast.show({ message, variant })
      } catch {
        // Toast is best effort.
      }
    }

    const currentSessionID = (): string | undefined => {
      try {
        const route = context.ui.router.current?.()
        return route?.type === "session" ? route.sessionID : undefined
      } catch {
        return undefined
      }
    }

    const listen = async () => {
      const sid = currentSessionID()
      if (!sid) {
        toast("Open a session first", "warning")
        return
      }
      ownSession(sid)
      setHiddenBoth(false)
      const res: any = await startListening(config, { mic: true })
      if (!res?.ok) toast(res?.error || "Could not start listening", "error")
      else toast("Listening to system audio and mic", "success")
      void refresh()
    }

    const stop = async () => {
      await stopListening(config)
      ownSession(null)
      void refresh()
    }

    context.ui.slot({
      append: "session.composer.top",
      render: (input: any) => (
        <Show when={input?.sessionID && activeSessionID() === input.sessionID && !hidden()}>
          <Panel
            context={context}
            status={status}
            segments={segments}
            tail={tail}
            frame={frame}
            height={height}
            onStop={() => void stop()}
            onHide={() => setHiddenBoth(true)}
          />
        </Show>
      ),
    })

    context.ui.slot({
      append: "app",
      render: () => {
        try {
          context.keymap?.layer?.(() => ({
            mode: "global",
            priority: 10,
            commands: [
              {
                id: "transcript.listen",
                title: "Transcript: start listening",
                group: "Transcript",
                palette: true,
                slash: { name: "listen" },
                run: () => void listen(),
              },
              {
                id: "transcript.stop",
                title: "Transcript: stop listening",
                group: "Transcript",
                palette: true,
                slash: { name: "listen-stop" },
                run: () => void stop(),
              },
              {
                id: "transcript.toggle",
                title: "Transcript: show or hide the panel",
                group: "Transcript",
                palette: true,
                slash: { name: "transcript" },
                run: () => setHiddenBoth(!hidden()),
              },
            ],
            bindings: ["transcript.listen", "transcript.stop", "transcript.toggle"],
          }))
        } catch {
          // Keymap unavailable, the panel still works from the stored state.
        }
        return null
      },
    })

    return () => {
      clearInterval(poll)
      clearInterval(anim)
    }
  },
})
