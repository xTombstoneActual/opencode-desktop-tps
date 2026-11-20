# opencode-desktop-tps

A small [OpenCode Desktop](https://opencode.ai/docs/) plugin that shows a live
tokens-per-second badge in the session header, so you can see how fast a model
is actually generating.

The pill shows a **live** estimate while the model streams and the **exact**
provider-reported speed once each step finishes. Hover it for peak speed, output
tokens and step count.

```
● 42.7 tok/s        while streaming
● 31.2 tok/s avg    after the step ends
```

The dot is green at ≥ 40 tok/s, amber at ≥ 15, red below that, and grey once the
step has finished. In a narrow window the pill collapses to just the number.

## Requirements

- OpenCode Desktop with the experimental GUI plugin SDK (`@opencode/plugin`
  `2.3.x`). GUI plugins are experimental and may change between releases.
- Node.js 20+ only if you want to build it yourself.

## Install

The bundle in `dist/` is committed, so no build step is needed.

1. Clone the repository somewhere permanent:

   ```bash
   git clone https://github.com/xTombstoneActual/opencode-desktop-tps.git ~/opencode-desktop-tps
   ```

2. Add the directory to your **global** config, `~/.config/opencode/opencode.jsonc`
   (`%USERPROFILE%\.config\opencode\opencode.jsonc` on Windows):

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["/home/you/opencode-desktop-tps"]
   }
   ```

   On Windows use forward slashes:

   ```jsonc
   "plugins": ["C:/Users/you/opencode-desktop-tps"]
   ```

3. OpenCode Desktop reads GUI parts only from the global `opencode.json(c)`.
   Config changes reload the plugin automatically; if the pill does not appear,
   reopen the window and check **Settings → Extensions → Plugins**, where the
   plugin is listed with an on/off switch.

## How it measures

- **Live:** UTF-8 bytes of `session.text.delta` + `session.reasoning.delta`,
  divided by ~4 bytes per token, summed over the last 3 seconds. If deltas stop
  arriving the estimate decays to zero within the window.
- **Exact:** on `session.step.ended`, the provider's
  `tokens.output + tokens.reasoning`, divided by the assistant message's
  `time.firstToken → time.completed` span. It falls back to a local first-token
  clock when the message is not synced yet.

Events come from the desktop app's own background server (`sidecar`) through
`ctx.servers.get("sidecar")?.data.on(...)`, so the badge follows server restarts
and never polls.

## Develop

```bash
npm install
npm run typecheck
npm run build      # writes dist/gui-experimental.cjs
npm run dev        # rebuild on change; each rebuild hot-reloads the GUI
```

The layout follows the OpenCode GUI plugin docs: `src/gui.tsx` is the
`./gui-experimental` entry and `src/tps-tracker.ts` is the rolling-window
tracker.

## Limitations

- Live speed is an estimate, not a count: ~4 bytes per token is close for English
  and code, slightly optimistic for CJK text.
- Exact speed counts `output + reasoning`. Providers report those separately, and
  some include reasoning in `output`, so the figure can differ slightly from
  another client's.
- Only the desktop app's own server is observed. Sessions on remote servers you
  have added do not show a badge.
- The badge appears once tokens start flowing; a step that is still waiting for
  its first token shows nothing.

## License

[MIT](LICENSE)
