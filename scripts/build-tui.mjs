// Builds the Solid TUI entry to plain JavaScript.
//
// Why this exists:
//   OpenCode only runs its Solid JSX transform on `.tsx` files that live OUTSIDE
//   `node_modules`. A plugin installed from npm or a git URL is unpacked under
//   `node_modules`, so a raw `.tsx` TUI entry falls back to Bun's default JSX
//   transform and emits `import ... from "react"`, which is not installed.
//
//   Shipping a precompiled `dist/tui.js` avoids the on the fly transform. The
//   output imports the runtime primitives from `@opentui/solid` (plus
//   `@opencode/plugin/tui` and `solid-js`), all of which OpenCode bridges at
//   runtime, so it works from `node_modules` and from a local path alike.
//
// Regenerate after editing `src/tui.tsx`:
//   npm run build

import { transformFileAsync } from "@babel/core"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const targets = [{ input: "src/tui.tsx", output: "dist/tui.js" }]

for (const { input, output } of targets) {
  const result = await transformFileAsync(resolve(root, input), {
    configFile: false,
    babelrc: false,
    cwd: root,
    presets: [
      ["@babel/preset-typescript", { isTSX: true, allExtensions: true }],
      // `universal` emits runtime primitive imports instead of the automatic
      // `@opentui/solid/jsx-runtime` import, matching OpenCode's own transform.
      ["babel-preset-solid", { generate: "universal", moduleName: "@opentui/solid" }],
    ],
  })

  if (!result?.code) throw new Error(`Babel produced no output for ${input}`)

  const out = resolve(root, output)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, result.code + "\n")
  console.log(`${input} -> ${output}`)
}
