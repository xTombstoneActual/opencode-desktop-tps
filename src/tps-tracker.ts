/**
 * Rolling-window tokens-per-second tracking for streaming assistant output.
 *
 * During a stream, tokens are estimated from UTF-8 bytes (~4 bytes per token)
 * over the last few seconds. When a step ends, the estimate is replaced by the
 * provider-reported token count divided by the generation time (first token to
 * step end), which is the exact figure the badge settles on.
 */

export interface SessionTpsMetrics {
  /** A step is producing tokens right now. */
  streaming: boolean
  /** Rolling estimate over the live window, in tokens per second. */
  liveTps: number
  /** Exact provider-reported figure for the last finished step. */
  finalTps: number | null
  /** Highest live or final figure seen in this session. */
  peakTps: number
  /** Tokens in the last finished step, or the live estimate while streaming. */
  tokens: number
  /** Provider-reported output tokens summed over every finished step. */
  totalTokens: number
  /** Finished steps seen by this plugin. */
  steps: number
}

interface Sample {
  time: number
  tokens: number
}

interface InternalState {
  streaming: boolean
  /** When the current step's first token arrived. */
  startedAt: number
  samples: Sample[]
  estimatedTokens: number
  exactTokens: number | null
  liveTps: number
  finalTps: number | null
  peakTps: number
  totalTokens: number
  steps: number
  /** Assistant message of the last counted step, so replays are not counted twice. */
  lastEventID: string | null
}

const WINDOW_MS = 3000
const MIN_WINDOW_SEC = 0.25
const BYTES_PER_TOKEN = 4
const encoder = new TextEncoder()

export class TpsTracker {
  private sessions = new Map<string, InternalState>()

  private getOrCreate(sessionId: string): InternalState {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = {
        streaming: false,
        startedAt: 0,
        samples: [],
        estimatedTokens: 0,
        exactTokens: null,
        liveTps: 0,
        finalTps: null,
        peakTps: 0,
        totalTokens: 0,
        steps: 0,
        lastEventID: null,
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  /** Reset the per-step accumulators without dropping the last average. */
  beginStep(sessionId: string): SessionTpsMetrics {
    const state = this.getOrCreate(sessionId)
    state.streaming = false
    state.startedAt = 0
    state.samples = []
    state.estimatedTokens = 0
    state.exactTokens = null
    state.liveTps = 0
    return this.snapshot(state)
  }

  /** The current step produced its first token: start the clock. */
  onFirstToken(sessionId: string, now = Date.now()): SessionTpsMetrics {
    const state = this.getOrCreate(sessionId)
    this.start(state, now)
    return this.snapshot(state)
  }

  onDelta(sessionId: string, text: string, now = Date.now()): SessionTpsMetrics {
    const state = this.getOrCreate(sessionId)
    this.start(state, now)

    const deltaTokens = encoder.encode(text).length / BYTES_PER_TOKEN
    if (deltaTokens > 0) {
      state.estimatedTokens += deltaTokens
      state.samples.push({ time: now, tokens: deltaTokens })
    }

    return this.recompute(state, now)
  }

  /**
   * A step finished. `outputTokens` is the provider count (output + reasoning)
   * and `elapsedMs` the measured first-token to completion time, when known.
   */
  onStepEnded(
    sessionId: string,
    outputTokens?: number,
    now = Date.now(),
    elapsedMs?: number,
    eventID?: string,
  ): SessionTpsMetrics | null {
    const state = this.sessions.get(sessionId)
    if (!state) return null

    // A replayed or duplicated event only
    // refreshes the snapshot: it is the same step.
    if (eventID && state.lastEventID === eventID) {
      return this.snapshot(state)
    }
    if (eventID) state.lastEventID = eventID

    const measuredSec =
      elapsedMs !== undefined && elapsedMs > 0
        ? elapsedMs / 1000
        : (now - state.startedAt) / 1000

    const totalTokens =
      typeof outputTokens === "number" && outputTokens > 0
        ? Math.round(outputTokens)
        : Math.round(state.estimatedTokens)

    state.streaming = false
    state.exactTokens = totalTokens
    state.totalTokens += totalTokens
    state.steps += 1

    const final = totalTokens > 0 ? totalTokens / Math.max(measuredSec, MIN_WINDOW_SEC) : state.liveTps
    state.finalTps = final
    state.liveTps = final
    if (final > state.peakTps) state.peakTps = final

    return this.snapshot(state)
  }

  /** Stop streaming without an exact count (interrupted, failed, or idle). */
  settle(sessionId: string, now = Date.now()): SessionTpsMetrics | null {
    const state = this.sessions.get(sessionId)
    if (!state || !state.streaming) return null

    const elapsedSec = (now - state.startedAt) / 1000
    const estimate = Math.round(state.estimatedTokens)
    const final =
      estimate > 0 ? estimate / Math.max(elapsedSec, MIN_WINDOW_SEC) : state.liveTps

    state.streaming = false
    state.exactTokens = estimate > 0 ? estimate : null
    state.finalTps = final
    state.liveTps = final
    if (final > state.peakTps) state.peakTps = final

    return this.snapshot(state)
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** Recompute every streaming session, so a paused stream decays to zero. */
  tick(now = Date.now()): Map<string, SessionTpsMetrics> {
    const updated = new Map<string, SessionTpsMetrics>()
    for (const [id, state] of this.sessions) {
      if (!state.streaming) continue
      updated.set(id, this.recompute(state, now))
    }
    return updated
  }

  get(sessionId: string): SessionTpsMetrics | undefined {
    const state = this.sessions.get(sessionId)
    return state ? this.snapshot(state) : undefined
  }

  private start(state: InternalState, now: number): void {
    if (state.streaming) return
    state.streaming = true
    state.startedAt = now
    state.samples = []
    state.estimatedTokens = 0
    state.exactTokens = null
    state.liveTps = 0
  }

  private recompute(state: InternalState, now: number): SessionTpsMetrics {
    const cutoff = now - WINDOW_MS
    while (state.samples.length > 0 && state.samples[0].time < cutoff) {
      state.samples.shift()
    }

    // A rate needs a little time to mean anything: a single chunk in the first
    // few milliseconds would read as an enormous spike and poison the peak.
    const elapsedSec = (now - state.startedAt) / 1000
    if (elapsedSec < MIN_WINDOW_SEC) {
      state.liveTps = 0
      return this.snapshot(state)
    }

    const windowStart = Math.max(state.startedAt, cutoff)
    const windowTokens = state.samples.reduce((sum, sample) => sum + sample.tokens, 0)
    const windowSec = Math.max((now - windowStart) / 1000, MIN_WINDOW_SEC)

    state.liveTps = windowTokens > 0 ? windowTokens / windowSec : 0
    if (state.liveTps > state.peakTps) {
      state.peakTps = state.liveTps
    }

    return this.snapshot(state)
  }

  private snapshot(state: InternalState): SessionTpsMetrics {
    return {
      streaming: state.streaming,
      liveTps: state.liveTps,
      finalTps: state.finalTps,
      peakTps: state.peakTps,
      tokens: state.exactTokens ?? Math.round(state.estimatedTokens),
      totalTokens: state.totalTokens,
      steps: state.steps,
    }
  }
}
