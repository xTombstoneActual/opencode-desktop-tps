import { Show, createSignal, onCleanup } from "solid-js"
import { createKeyed, Plugin, Slot } from "@opencode/plugin/gui"
import { TpsTracker, type SessionTpsMetrics } from "./tps-tracker"

const FAST_TPS = 40
const OK_TPS = 15

export default Plugin.define({
  i18n: {
    en: {
      "tps.title": "Generation speed",
      "tps.peak": "Peak",
      "tps.output": "Output",
      "tps.steps": "Steps",
      "tps.live": "live",
      "tps.average": "average",
    },
  },
  setup(ctx) {
    const tracker = new TpsTracker()
    const [metrics, setMetrics] = createSignal<Record<string, SessionTpsMetrics>>({})

    const publish = (sessionID: string, next: SessionTpsMetrics | null) => {
      if (!next) return
      setMetrics((previous) => ({ ...previous, [sessionID]: next }))
    }

    // The desktop app's own server, which runs this plugin, is `sidecar`.
    const server = () => {
      const sidecar = ctx.servers.get("sidecar")
      if (sidecar) return sidecar
      const builtin = ctx.servers.list().find((id) => ctx.servers.get(id)?.builtin)
      return builtin ? ctx.servers.get(builtin) : undefined
    }

    createKeyed(server, (ref) => {
      const data = ref.data

      onCleanup(
        data.on("session.step.started", (event) => {
          publish(event.data.sessionID, tracker.beginStep(event.data.sessionID))
        }),
      )

      onCleanup(
        data.on("session.step.first-token", (event) => {
          publish(event.data.sessionID, tracker.onFirstToken(event.data.sessionID))
        }),
      )

      onCleanup(
        data.on("session.text.delta", (event) => {
          publish(event.data.sessionID, tracker.onDelta(event.data.sessionID, event.data.delta))
        }),
      )

      onCleanup(
        data.on("session.reasoning.delta", (event) => {
          publish(event.data.sessionID, tracker.onDelta(event.data.sessionID, event.data.delta))
        }),
      )

      onCleanup(
        data.on("session.step.ended", (event) => {
          const { sessionID, assistantMessageID, tokens } = event.data

          // Prefer the message's own timestamps: they cover the generation even
          // when this plugin only started watching after the first token.
          let elapsedMs: number | undefined
          const message = data.session.message.get(sessionID, assistantMessageID)
          if (message?.type === "assistant") {
            const first = message.time.firstToken ?? message.time.created
            const done = message.time.completed ?? message.time.streamed
            if (first !== undefined && done !== undefined && done >= first) {
              elapsedMs = done - first
            }
          }

          const output = (tokens.output ?? 0) + (tokens.reasoning ?? 0)
          publish(
            sessionID,
            tracker.onStepEnded(
              sessionID,
              output > 0 ? output : undefined,
              Date.now(),
              elapsedMs,
              event.id,
            ),
          )
        }),
      )

      // A step that failed, an interrupted run, or an idle session settles the
      // badge on the last measured speed instead of leaving it live.
      for (const type of [
        "session.step.failed",
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted",
        "session.idle",
      ] as const) {
        onCleanup(
          data.on(type, (event) => {
            publish(event.data.sessionID, tracker.settle(event.data.sessionID))
          }),
        )
      }

      onCleanup(
        data.on("session.deleted", (event) => {
          const sessionID = event.data.sessionID
          tracker.forget(sessionID)
          setMetrics((previous) => {
            if (!(sessionID in previous)) return previous
            const next = { ...previous }
            delete next[sessionID]
            return next
          })
        }),
      )
    })

    // Decay the rolling window smoothly when generation pauses mid-step.
    const timer = setInterval(() => {
      const updates = tracker.tick()
      if (updates.size === 0) return
      setMetrics((previous) => {
        const next = { ...previous }
        for (const [id, value] of updates) next[id] = value
        return next
      })
    }, 250)

    const Badge = (props: { sessionID: string; compact: boolean }) => {
      const current = () => metrics()[props.sessionID]

      const displayed = () => {
        const value = current()
        if (!value) return undefined
        return value.streaming ? value.liveTps : (value.finalTps ?? undefined)
      }

      const color = () => {
        const tps = displayed() ?? 0
        if (tps >= FAST_TPS) return "#22c55e"
        if (tps >= OK_TPS) return "#eab308"
        return "#ef4444"
      }

      const shown = () => displayed() ?? 0

      const label = () => {
        const value = current()
        if (!value) return ""
        if (value.streaming) return ctx.t("tps.live")
        return ctx.t("tps.average")
      }

      const tooltip = () => {
        const value = current()
        if (!value) return ctx.t("tps.title")
        return [
          `${ctx.t("tps.title")}: ${label()}`,
          `${ctx.t("tps.peak")}: ${value.peakTps.toFixed(1)} tok/s`,
          `${ctx.t("tps.output")}: ${value.tokens} tok`,
          `${ctx.t("tps.steps")}: ${value.steps}`,
        ].join(" · ")
      }

      return (
        <Show when={displayed() !== undefined}>
          <div
              role="status"
              aria-label={tooltip()}
              title={tooltip()}
              style={{
                display: "inline-flex",
                "align-items": "center",
                gap: "6px",
                height: "22px",
                padding: "0 8px",
                "border-radius": "999px",
                border: "1px solid rgba(127, 127, 127, 0.16)",
                background: "rgba(127, 127, 127, 0.12)",
                color: "inherit",
                "font-size": "11px",
                "line-height": "1",
                "font-variant-numeric": "tabular-nums",
                "font-family": ctx.appearance.font("mono"),
                "white-space": "nowrap",
                "user-select": "none",
              }}
            >
              <span
                style={{
                  width: "6px",
                  height: "6px",
                  "border-radius": "50%",
                  "flex-shrink": "0",
                  background: current()?.streaming ? color() : "#94a3b8",
                }}
              />
              <span>
                {props.compact
                  ? shown().toFixed(0)
                  : `${shown().toFixed(1)} tok/s${current()?.streaming ? "" : " avg"}`}
              </span>
          </div>
        </Show>
      )
    }

    ctx.add(Slot, {
      at: "session.header",
      order: 20,
      render: (input) => <Badge sessionID={input.session.id} compact={input.compact} />,
    })

    return () => clearInterval(timer)
  },
})
