import { effect as _$effect } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createSignal } from "solid-js";
import { ensureServer, fetchTranscript, resolveConfig, startListening, stopListening, writeSessionDecorations } from "../service/ensure.mjs";

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

const SPIN = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const BUSY = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function pick(...values) {
  for (const v of values) if (v !== undefined && v !== null) return v;
  return undefined;
}
function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`;
  return `${b} B`;
}
function meter(peak, width) {
  // Speech peaks sit near 0.02 of full scale, so a linear bar barely moves. Map
  // -60 dB to 0 dB onto the bar instead.
  const p = Math.max(peak || 0, 0);
  const db = 20 * Math.log10(p + 1e-7);
  const level = Math.max(0, Math.min(1, (db + 60) / 60));
  const filled = Math.round(level * width);
  let out = "";
  for (let i = 0; i < width; i++) {
    out += i < filled ? SPIN[Math.min(SPIN.length - 1, 1 + Math.floor(level * (SPIN.length - 1)))] : "·";
  }
  return out;
}
function Panel(props) {
  const theme = props.context.theme;
  const base = pick(theme.text?.base, theme.text, "white");
  const muted = pick(theme.text?.muted, theme.text?.base, "gray");
  const red = pick(theme.hue?.red?.[200], theme.text?.feedback?.error?.base, "red");
  const green = pick(theme.hue?.green?.[200], theme.text?.feedback?.success?.base, "green");
  const yellow = pick(theme.text?.feedback?.warning?.base, "yellow");
  const accent = pick(theme.hue?.accent?.[200], theme.hue?.cyan?.[200], theme.text?.feedback?.info?.base, "cyan");
  const bg = pick(theme.background?.element, theme.background?.raised?.base);
  const border = pick(theme.border?.base, muted);
  const loading = () => props.status().loading;
  const running = () => props.status().running;
  const failed = () => Boolean(props.status().error);
  const dotColor = () => failed() ? red : loading() ? yellow : running() ? red : muted;
  const label = () => failed() ? "ERROR" : loading() ? "LOADING" : running() ? "LIVE" : "TRANSCRIPT";
  const spinner = () => BUSY[props.frame() % BUSY.length];
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("box"),
      _el$3 = _$createElement("text"),
      _el$5 = _$createElement("text"),
      _el$0 = _$createElement("box"),
      _el$11 = _$createElement("text"),
      _el$13 = _$createElement("text"),
      _el$15 = _$createElement("scrollbox");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$13);
    _$insertNode(_el$, _el$15);
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "backgroundColor", bg);
    _$setProp(_el$, "paddingLeft", 1);
    _$setProp(_el$, "paddingRight", 1);
    _$setProp(_el$, "flexShrink", 0);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$5);
    _$insertNode(_el$2, _el$0);
    _$insertNode(_el$2, _el$11);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "gap", 1);
    _$setProp(_el$2, "flexShrink", 0);
    _$setProp(_el$2, "alignItems", "center");
    _$insertNode(_el$3, _$createTextNode(`●`));
    _$setProp(_el$3, "flexShrink", 0);
    _$setProp(_el$5, "fg", base);
    _$setProp(_el$5, "attributes", 1);
    _$setProp(_el$5, "flexShrink", 0);
    _$insert(_el$5, label);
    _$insert(_el$2, _$createComponent(Show, {
      get when() {
        return loading();
      },
      get children() {
        return [(() => {
          var _el$6 = _$createElement("text");
          _$setProp(_el$6, "fg", yellow);
          _$setProp(_el$6, "flexShrink", 0);
          _$insert(_el$6, spinner);
          return _el$6;
        })(), (() => {
          var _el$7 = _$createElement("text");
          _$setProp(_el$7, "fg", muted);
          _$setProp(_el$7, "flexShrink", 0);
          _$insert(_el$7, () => `model ${formatBytes(props.status().modelsBytes)}`);
          return _el$7;
        })()];
      }
    }), _el$0);
    _$insert(_el$2, _$createComponent(Show, {
      get when() {
        return !loading();
      },
      get children() {
        return [(() => {
          var _el$8 = _$createElement("text");
          _$setProp(_el$8, "fg", muted);
          _$setProp(_el$8, "flexShrink", 0);
          _$insert(_el$8, () => clock(props.status().elapsed));
          return _el$8;
        })(), (() => {
          var _el$9 = _$createElement("text");
          _$setProp(_el$9, "fg", accent);
          _$setProp(_el$9, "flexShrink", 0);
          _$insert(_el$9, () => meter(props.status().peak, 8));
          return _el$9;
        })()];
      }
    }), _el$0);
    _$setProp(_el$0, "flexGrow", 1);
    _$setProp(_el$0, "minWidth", 0);
    _$insert(_el$2, _$createComponent(Show, {
      get when() {
        return running() || loading();
      },
      get children() {
        var _el$1 = _$createElement("text");
        _$insertNode(_el$1, _$createTextNode(`■ stop`));
        _$setProp(_el$1, "fg", muted);
        _$setProp(_el$1, "flexShrink", 0);
        _$setProp(_el$1, "onMouseUp", () => props.onStop());
        return _el$1;
      }
    }), _el$11);
    _$insertNode(_el$11, _$createTextNode(`▾ hide`));
    _$setProp(_el$11, "fg", muted);
    _$setProp(_el$11, "flexShrink", 0);
    _$setProp(_el$11, "onMouseUp", () => props.onHide());
    _$insertNode(_el$13, _$createTextNode(`────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────`));
    _$setProp(_el$13, "fg", border);
    _$setProp(_el$13, "flexShrink", 0);
    _$setProp(_el$15, "flexGrow", 1);
    _$setProp(_el$15, "minHeight", 0);
    _$setProp(_el$15, "width", "100%");
    _$setProp(_el$15, "stickyScroll", true);
    _$setProp(_el$15, "stickyStart", "bottom");
    _$setProp(_el$15, "verticalScrollbarOptions", {
      visible: true
    });
    _$insert(_el$15, _$createComponent(Show, {
      get when() {
        return props.status().error;
      },
      get children() {
        var _el$16 = _$createElement("text");
        _$setProp(_el$16, "fg", red);
        _$insert(_el$16, () => props.status().error);
        return _el$16;
      }
    }), null);
    _$insert(_el$15, _$createComponent(Show, {
      get when() {
        return props.status().warning;
      },
      get children() {
        var _el$17 = _$createElement("text");
        _$setProp(_el$17, "fg", yellow);
        _$insert(_el$17, () => props.status().warning);
        return _el$17;
      }
    }), null);
    _$insert(_el$15, _$createComponent(Show, {
      get when() {
        return loading();
      },
      get children() {
        var _el$18 = _$createElement("text");
        _$setProp(_el$18, "fg", muted);
        _$insert(_el$18, () => `Loading the Whisper model, ${formatBytes(props.status().modelsBytes)} of about 1.5 GB. This happens once. Transcription starts automatically when it is ready.`);
        return _el$18;
      }
    }), null);
    _$insert(_el$15, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!(!loading() && props.segments().length === 0))() && !props.tail();
      },
      get children() {
        var _el$19 = _$createElement("text");
        _$setProp(_el$19, "fg", muted);
        _$insert(_el$19, () => running() ? "Listening. Waiting for speech." : "No transcript yet. Run /listen to start.");
        return _el$19;
      }
    }), null);
    _$insert(_el$15, _$createComponent(For, {
      get each() {
        return props.segments();
      },
      children: seg => (() => {
        var _el$24 = _$createElement("box"),
          _el$25 = _$createElement("text"),
          _el$26 = _$createElement("text"),
          _el$27 = _$createElement("text");
        _$insertNode(_el$24, _el$25);
        _$insertNode(_el$24, _el$26);
        _$insertNode(_el$24, _el$27);
        _$setProp(_el$24, "flexDirection", "row");
        _$setProp(_el$24, "gap", 1);
        _$setProp(_el$25, "fg", muted);
        _$setProp(_el$25, "flexShrink", 0);
        _$insert(_el$25, () => clock(seg.start));
        _$setProp(_el$26, "fg", green);
        _$setProp(_el$26, "flexShrink", 0);
        _$setProp(_el$26, "wrapMode", "none");
        _$insert(_el$26, (() => {
          var _c$ = _$memo(() => !!seg.speaker);
          return () => _c$() ? `${seg.speaker} ` : "";
        })());
        _$setProp(_el$27, "fg", base);
        _$setProp(_el$27, "flexGrow", 1);
        _$setProp(_el$27, "minWidth", 0);
        _$setProp(_el$27, "wrapMode", "word");
        _$insert(_el$27, () => seg.text);
        return _el$24;
      })()
    }), null);
    _$insert(_el$15, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!!loading())() && props.tail();
      },
      get children() {
        var _el$20 = _$createElement("box"),
          _el$21 = _$createElement("text"),
          _el$23 = _$createElement("text");
        _$insertNode(_el$20, _el$21);
        _$insertNode(_el$20, _el$23);
        _$setProp(_el$20, "flexDirection", "row");
        _$setProp(_el$20, "gap", 1);
        _$insertNode(_el$21, _$createTextNode(`  ...`));
        _$setProp(_el$21, "fg", muted);
        _$setProp(_el$21, "flexShrink", 0);
        _$setProp(_el$23, "fg", muted);
        _$setProp(_el$23, "flexGrow", 1);
        _$setProp(_el$23, "minWidth", 0);
        _$setProp(_el$23, "wrapMode", "word");
        _$insert(_el$23, () => props.tail());
        return _el$20;
      }
    }), null);
    _$effect(_p$ => {
      var _v$ = props.height,
        _v$2 = dotColor();
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "height", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$;
  })();
}
export default Plugin.define({
  id: "transcript.tui",
  setup(context) {
    const config = resolveConfig(context.options || {});
    const height = Number(context.options?.height) || 14;

    // The session that owns the panel. Set by /listen, cleared by /listen-stop,
    // and persisted so it survives a plugin reload.
    const [activeSessionID, setActiveSessionID] = createSignal(null);
    const [hidden, setHidden] = createSignal(false);
    let persist = () => {};
    try {
      const [store, update] = context.storage.store("transcript.ui", {
        initial: {
          sessionID: null,
          hidden: false
        }
      });
      const read = () => (typeof store === "function" ? store() : store) ?? {};
      setActiveSessionID(read().sessionID ?? null);
      setHidden(read().hidden === true);
      persist = patch => update(draft => Object.assign(draft, patch));
    } catch {
      // Storage unavailable, the panel still works for this process.
    }

    // Tell the sidebar which session is recording, through the shared
    // decorations file contract. No import between the plugins.
    const publishDecoration = sid => {
      void writeSessionDecorations("transcript", sid ? {
        [sid]: {
          dot: {
            color: "red",
            title: "Recording"
          },
          label: "REC"
        }
      } : {});
    };
    const ownSession = sid => {
      setActiveSessionID(sid);
      persist({
        sessionID: sid
      });
      publishDecoration(sid);
    };
    const setHiddenBoth = value => {
      setHidden(value);
      persist({
        hidden: value
      });
    };
    const [status, setStatus] = createSignal({
      state: "idle",
      running: false,
      loading: false,
      elapsed: 0,
      peak: 0,
      modelsBytes: 0,
      error: null,
      warning: null
    });
    const [segments, setSegments] = createSignal([]);
    const [tail, setTail] = createSignal("");
    const [frame, setFrame] = createSignal(0);
    let inflight = false;
    const refresh = async () => {
      if (inflight) return;
      inflight = true;
      try {
        const data = await fetchTranscript(config);
        setStatus({
          state: data?.state ?? "unreachable",
          running: Boolean(data?.running),
          loading: Boolean(data?.loading) || data?.state === "loading",
          elapsed: Number(data?.elapsed || 0),
          peak: Number(data?.peak || 0),
          modelsBytes: Number(data?.modelsBytes || 0),
          error: data?.error ?? null,
          warning: data?.warning ?? null
        });
        setSegments(Array.isArray(data?.segments) ? data.segments : []);
        setTail(typeof data?.tail === "string" ? data.tail : "");
      } finally {
        inflight = false;
      }
    };
    const poll = setInterval(() => {
      if (activeSessionID() || status().running || status().loading) void refresh();
    }, 700);

    // Animate the loading spinner only while loading.
    const anim = setInterval(() => {
      if (status().loading) setFrame(f => (f + 1) % BUSY.length);
    }, 90);
    void (async () => {
      await ensureServer(config);
      await refresh();
      // Keep the shared indicator honest after a reload.
      const running = status().running || status().loading;
      publishDecoration(running ? activeSessionID() : null);
    })();
    const toast = (message, variant = "info") => {
      try {
        context.ui.toast.show({
          message,
          variant
        });
      } catch {
        // Toast is best effort.
      }
    };
    const currentSessionID = () => {
      try {
        const route = context.ui.router.current?.();
        return route?.type === "session" ? route.sessionID : undefined;
      } catch {
        return undefined;
      }
    };
    const listen = async () => {
      const sid = currentSessionID();
      if (!sid) {
        toast("Open a session first", "warning");
        return;
      }
      ownSession(sid);
      setHiddenBoth(false);
      const res = await startListening(config, {
        mic: true
      });
      if (!res?.ok) toast(res?.error || "Could not start listening", "error");else toast("Listening to system audio and mic", "success");
      void refresh();
    };
    const stop = async () => {
      await stopListening(config);
      ownSession(null);
      void refresh();
    };
    context.ui.slot({
      append: "session.composer.top",
      render: input => _$createComponent(Show, {
        get when() {
          return _$memo(() => !!(input?.sessionID && activeSessionID() === input.sessionID))() && !hidden();
        },
        get children() {
          return _$createComponent(Panel, {
            context: context,
            status: status,
            segments: segments,
            tail: tail,
            frame: frame,
            height: height,
            onStop: () => void stop(),
            onHide: () => setHiddenBoth(true)
          });
        }
      })
    });
    context.ui.slot({
      append: "app",
      render: () => {
        try {
          context.keymap?.layer?.(() => ({
            mode: "global",
            priority: 10,
            commands: [{
              id: "transcript.listen",
              title: "Transcript: start listening",
              group: "Transcript",
              palette: true,
              slash: {
                name: "listen"
              },
              run: () => void listen()
            }, {
              id: "transcript.stop",
              title: "Transcript: stop listening",
              group: "Transcript",
              palette: true,
              slash: {
                name: "listen-stop"
              },
              run: () => void stop()
            }, {
              id: "transcript.toggle",
              title: "Transcript: show or hide the panel",
              group: "Transcript",
              palette: true,
              slash: {
                name: "transcript"
              },
              run: () => setHiddenBoth(!hidden())
            }],
            bindings: ["transcript.listen", "transcript.stop", "transcript.toggle"]
          }));
        } catch {
          // Keymap unavailable, the panel still works from the stored state.
        }
        return null;
      }
    });
    return () => {
      clearInterval(poll);
      clearInterval(anim);
    };
  }
});
