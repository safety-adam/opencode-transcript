# AGENTS.md

Guidance for agents and contributors working on this plugin.

## What this package is

An OpenCode plugin with three parts that ship together.

| Path | Part | Loaded by |
| --- | --- | --- |
| `service/native` | Swift capture and speech to text binary | the Node service |
| `service/server.mjs` | Node HTTP service that owns the binary and holds the transcript | the plugin |
| `src/index.ts` | Server half, registers the `live_transcript` tool | the OpenCode server |
| `src/tui.tsx` | TUI half, renders the transcript panel | the OpenCode terminal client |

`src/tui.tsx` contains JSX and must be compiled before it is published. The
compiled artifact, `dist/tui.js`, is committed and is what `exports["./tui"]`
points at.

## Critical constraint, `.tsx` under `node_modules`

OpenCode only runs its Solid JSX transform on `.tsx` files **outside**
`node_modules`. A plugin installed from npm or a git URL is unpacked under
`node_modules`, so a raw `.tsx` TUI entry is handed to Bun's default JSX
transform, which emits `import ... from "react"`, a package that is not
installed.

- Never set `exports["./tui"]` to `./src/tui.tsx`.
- `exports["./tui"]` must be `./dist/tui.js`.
- After editing `src/tui.tsx`, run `npm run build` and commit the updated
  `dist/tui.js`.

## Build

```sh
npm install
npm run build                 # src/tui.tsx -> dist/tui.js
service/native/make-app.sh    # builds and bundles the native binary
```

The native build needs the full Xcode toolchain. `make-app.sh` sets
`DEVELOPER_DIR` to a known Xcode install when one is present.

## Shared service code

`service/ensure.mjs` is imported by both `src/index.ts` and `src/tui.tsx`. It
holds config resolution, the health probe, and the start, stop and fetch
helpers. Keep it free of TypeScript types and framework imports so the compiled
TUI half can load it.

## Testing locally

1. Build the native binary and the TUI half.
2. Wire the package into `opencode.json(c)` and `cli.json` as the README shows.
3. Run the TUI against a private server so a running instance is undisturbed.

   ```sh
   opencode --standalone --print-logs --log-level debug
   ```

4. Run `/listen`. Grant System Audio Recording Only and Microphone when
   prompted, then run `/listen` again. See the README for the manual path when
   no prompt appears.

To trigger the audio permission prompt on its own, launch the bundle through
LaunchServices so it becomes the responsible process.

```sh
open "service/native/Transcript Capture.app" --args --request-permission
```

The service can also be exercised on its own, without OpenCode.

```sh
node service/server.mjs &
curl -s localhost:4790/health
curl -s -X POST localhost:4790/start
curl -s localhost:4790/transcript
curl -s -X POST localhost:4790/stop
```

## References

- Plugins, <https://opencode.ai/v2/docs/build/plugins>
- CLI and TUI plugins, <https://opencode.ai/v2/docs/build/plugins/cli>
- Slots and session panels, <https://opencode.ai/v2/docs/build/plugins/cli>
