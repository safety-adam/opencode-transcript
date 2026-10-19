# opencode-transcript

An OpenCode plugin that transcribes system audio live, shows the transcript as a
horizontal panel above the prompt composer, and exposes the transcript to agents
in the session as a tool.

The panel reads like live subtitles. New lines stick to the bottom, and you can
scroll up through the meeting and back down again.

## How it works

Three parts.

1. `service/native` is a Swift binary. It captures system audio with
   ScreenCaptureKit and the microphone with `AVAudioEngine`, mixes them, and
   transcribes the stream with WhisperKit. It prints one JSON object per line on
   stdout.
2. `service/server.mjs` is a small Node server the plugin owns. It starts the
   binary, reads the JSON stream, keeps the transcript in memory, and serves it
   over localhost. It is a singleton on a port, so every session and terminal
   shares one recording.
3. `src/index.ts` and `src/tui.tsx` are the two plugin halves. The server half
   registers the `live_transcript` tool. The TUI half renders the panel and
   starts and stops the capture.

## Requirements

- macOS 14 or later, Apple silicon recommended. Whisper large-v3 turbo runs
  faster than realtime on an M series GPU.
- Full Xcode for the first native build. The Command Line Tools toolchain lacks
  the macros plugin WhisperKit needs.
- The System Audio Recording Only permission for system audio, and Microphone
  permission for your own voice. See Permissions below.

## Build

Build the native capture binary and bundle it.

```sh
service/native/make-app.sh
```

The first run downloads the Whisper large-v3 turbo model, about 1.5 GB, into
`~/Library/Application Support/opencode-transcript/models`. To reuse a model
cache you already have, set `TRANSCRIPT_MODELS_DIR` to that directory.

Build the TUI half.

```sh
npm install
npm run build
```

## Install

Add the package to both configuration files. The server half loads from
`opencode.json(c)`, the TUI half from `cli.json`.

`~/.config/opencode/opencode.jsonc`

```jsonc
{
  "plugins": [
    { "package": "file:///Users/you/repos/side-projects/opencode-transcript", "options": { "height": 14 } }
  ]
}
```

`~/.config/opencode/cli.json`

```jsonc
{
  "plugins": [
    { "package": "file:///Users/you/repos/side-projects/opencode-transcript", "options": { "height": 14 } }
  ]
}
```

Restart OpenCode.

## Permissions

System audio capture uses a Core Audio process tap, not ScreenCaptureKit. That
matters. ScreenCaptureKit is gated behind the combined "Screen & System Audio
Recording" permission, so it would ask to see your screen. A process tap is
gated behind "System Audio Recording Only", so this tool never asks for the
screen.

macOS 26 shows both sections under Privacy and Security, Screen & System Audio
Recording. The app must be enabled in the lower one, System Audio Recording
Only. To grant it.

1. Run `/listen`. macOS may prompt. Allow it.
2. If no prompt appears, open System Settings, Privacy and Security, Screen and
   System Audio Recording, scroll to System Audio Recording Only, click the plus,
   and add `service/native/Transcript Capture.app` from this repo.
3. Grant Microphone the same way when prompted.
4. Run `/listen` again.

A missing permission does not raise an error. The tap returns silence, and the
transcript would fill with phrases Whisper invents, like a repeated "Thank you".
The plugin watches for this and shows a warning in the panel after a few seconds
of silence, and drops those invented phrases either way.

## Commands

| Command | What it does |
| --- | --- |
| `/listen` | Start transcribing system audio and the microphone, and open the panel |
| `/listen-stop` | Stop transcribing |
| `/transcript` | Show or hide the panel without stopping |

## The agent tool

The server half registers `live_transcript`. An agent in the session can call it
to read the transcript so far, with a timestamp per line. The meeting-companion
skill uses it during a meeting, so a summary can be written from the live
transcript rather than a pasted one.

The tool takes two optional arguments.

- `format`, either `text` for timestamped lines or `json` for segments with
  start and end times.
- `since`, a number of seconds into the recording. Only segments at or after
  that point are returned.

## Session decorations for the sidebar

While recording, the TUI half drops a decoration file so the jump-sidebar plugin
can show which session is recording. This is a general contract any TUI plugin
can use, with no import between plugins.

A plugin writes one file into a shared directory. The sidebar merges every file
and draws a dot before the session title and a label after it.

| Thing | Value |
| --- | --- |
| Directory | `~/.local/share/opencode/sidebar/decorations/` |
| Override | set `OPENCODE_SIDEBAR_DIR` to move the parent directory |
| File | `<plugin-id>.json`, one per contributing plugin |
| Shape | `{ "sessions": { "<sessionID>": { "dot": { "color": "red", "title": "Recording" }, "label": "REC" } } }` |

`color` is any OpenTUI colour, a name such as `red` or a hex string such as
`#22cc88`. `title` is a tooltip. `label` is short text shown after the dot. The
transcript plugin writes `transcript.json` with a red dot and `REC` while a
session is recording, and removes the file on stop.

## Configuration

Options passed to the package.

| Option | Default | What it does |
| --- | --- | --- |
| `height` | `14` | Panel height in rows |
| `port` | `4790` | Service port |
| `dataDir` | `~/.local/share/opencode/transcript` | Where logs and the transcript file are written |

Environment overrides, useful when the plugin is not configured with options.

| Variable | What it does |
| --- | --- |
| `TRANSCRIPT_CAPTURE_BIN` | Path to the native binary |
| `TRANSCRIPT_PORT` | Service port |
| `TRANSCRIPT_DATA_DIR` | Service data directory |
| `TRANSCRIPT_MODELS_DIR` | WhisperKit model cache |
| `TRANSCRIPT_NODE` | Node binary used to run the service |
| `TRANSCRIPT_PROMPT` | Initial prompt to bias recognition toward your vocabulary |

## Recognition quality

The decoder takes an initial prompt that biases it toward words it would
otherwise guess wrong, product names and acronyms especially. Set it from
`TRANSCRIPT_PROMPT`, or put one line in
`~/.local/share/opencode/transcript/prompt.txt`. One line such as this.

```
Meeting transcript. Names and terms include DeepSeek, Gemini Transcribe, Claude, Insights, LLM, API.
```

The model is Whisper large-v3 turbo, which is fast and close to realtime. For
more accuracy at the cost of speed, change `modelName` in
`service/native/Sources/transcript-capture/StreamingASR.swift` to
`openai_whisper-large-v3`, a larger download that runs slower but reads proper
nouns better.

The stream is gated on the room noise floor, so silence never reaches the model,
and Whisper's habitual silence phrases and sound annotations are dropped. Each
pass advances the audio cursor to the exact end of the last committed word, using
Whisper's word timings, so no audio is skipped between segments. The trailing
words stay as grey text in the panel until they commit.

## Files the service writes

| Path | Contents |
| --- | --- |
| `<dataDir>/transcript.md` | The transcript, one timestamped line per segment |
| `<dataDir>/capture.log` | Native binary logs and errors |
| `<dataDir>/server.log` | Service logs |

## Development

See `AGENTS.md`.
