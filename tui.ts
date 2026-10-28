import { Plugin } from "@opencode/plugin/tui"
import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import os from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { jsx } from "@opentui/solid/jsx-runtime"

/**
 * prompt-suggest
 *
 * Ghost-text suggestion of the next prompt, shown above the composer.
 *
 * The suggestion comes from one stateless `generate.text` call over a
 * priority-selected transcript: no new session, no tools, nothing written to
 * session history, so the conversation is never polluted.
 *
 * Elements are built with the `jsx` factory rather than JSX syntax on purpose.
 * A plugin loaded from `node_modules` or an explicit path does not get the
 * host's JSX transform, so JSX syntax would be compiled against
 * `react/jsx-runtime` and fail to resolve. Importing the OpenTUI runtime
 * directly keeps this file loadable from every location.
 */

const ID = "prompt-suggest"
const PLUGIN_FILE = fileURLToPath(import.meta.url)

const INSTRUCTIONS = [
  "You predict what a developer will type next into their coding agent.",
  "Read the conversation so far and output ONLY the single most likely next user message, written the way they would type it.",
  "Rules:",
  "- Exactly one line, under 120 characters.",
  "- Imperative voice describing the concrete next step.",
  "- No quotes, backticks, bullet, label, or explanation.",
  "- Never describe what the assistant did. Never ask a question the assistant already answered.",
  "- If the work looks finished and nothing useful remains, output exactly: NONE",
].join("\n")

/**
 * Priority tiers. Lower is more important, and a tier that cannot fit its
 * content blocks every tier below it, so trimming can never evict a user
 * message or a turn's closing message in favour of reasoning or tool chatter.
 */
const Tier = {
  /** User messages, system messages, and the closing message of every turn. */
  Essential: 0,
  /** Assistant text from intermediate steps inside a turn. */
  Narration: 1,
  /** One-line tool call summaries (never raw input or output). */
  ToolCall: 2,
  /** Model reasoning. Off unless explicitly enabled. */
  Reasoning: 3,
} as const

interface Segment {
  index: number
  tier: number
  /** Tie-break inside a tier: user/system before closing messages. */
  sub: number
  text: string
}

interface SuggestState {
  text: string
  sessionID: string
  busy: boolean
  error: string
}

const DEFAULTS = {
  auto: true,
  autoDelayMs: 900,
  maxMessages: 40,
  maxContextChars: 20_000,
  maxSegmentChars: 4000,
  includeToolCalls: true,
  includeReasoning: false,
  timeoutMs: 20_000,
  debug: false,
}

function clean(raw: string): string {
  let text = (raw ?? "").trim()
  text = text.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "").trim()
  text = text.split("\n")[0].trim()
  text = text.replace(/^[-*>]\s+/, "").trim()
  text = text.replace(/^["'“”`]+/, "").replace(/["'“”`]+$/, "").trim()
  text = text.replace(/\s+/g, " ")
  if (text.length > 200) text = text.slice(0, 200).trim()
  return text
}

function clamp(text: string, limit: number): string {
  const collapsed = text.trim().replace(/\n{3,}/g, "\n\n")
  if (collapsed.length <= limit) return collapsed
  return `${collapsed.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

/**
 * The stateless generation endpoint moved from `/api/experimental/generate`
 * to `/api/experimental/generate/text` in OpenCode 2.2. When a newer client
 * talks to an older server, the new path answers 404 with no content type, and
 * the client's error decoder reports that as `UnsupportedContentType` instead
 * of a useful status. `session.generate` has been served by every 2.1+ server,
 * so it is the compatibility fallback for that version skew.
 */
function responseText(response: unknown): string {
  if (!response || typeof response !== "object") return ""
  const value = response as { text?: unknown; data?: { text?: unknown } }
  if (typeof value.text === "string") return value.text
  if (typeof value.data?.text === "string") return value.data.text
  return ""
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isProtocolError(message: string): boolean {
  return /UnsupportedContentType|MalformedResponse|UnexpectedStatus:?\s*404|404 Not Found|HTTP 404/i.test(message)
}

function isTimeout(message: string): boolean {
  return /abort|timed? ?out/i.test(message)
}

function isTransient(message: string): boolean {
  return /did not finish activating|Transport|ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|network error|service unavailable/i.test(
    message,
  )
}

/** Keeps the one-line error slot readable instead of showing internal tags. */
function describe(message: string): string {
  if (/UnsupportedContentType/.test(message)) return "server/client version mismatch — update OpenCode"
  if (/UnexpectedStatus|MalformedResponse/.test(message)) return "server returned an unexpected response"
  if (/did not finish activating/i.test(message)) return "plugins are still starting"
  if (/Transport|ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|network error/i.test(message)) {
    return "cannot reach the OpenCode server"
  }
  if (isTimeout(message)) return "timed out"
  return message.length > 80 ? `${message.slice(0, 79)}…` : message
}

function readConfig(): Record<string, unknown> {
  const home = process.env.XDG_CONFIG_HOME || join(os.homedir(), ".config")
  for (const path of [join(home, "opencode", `${ID}.json`), join(dirname(PLUGIN_FILE), "config.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
    } catch {
      // Missing or malformed: fall through to the next source.
    }
  }
  return {}
}

export default Plugin.define({
  id: ID,
  setup(context) {
    const options: Record<string, any> = { ...DEFAULTS, ...readConfig(), ...(context.options ?? {}) }
    const auto = options.auto !== false
    const autoDelayMs = Math.max(0, Number(options.autoDelayMs ?? DEFAULTS.autoDelayMs))
    const maxMessages = Math.max(2, Number(options.maxMessages ?? DEFAULTS.maxMessages))
    const maxContextChars = Math.max(200, Number(options.maxContextChars ?? DEFAULTS.maxContextChars))
    const maxSegmentChars = Math.max(200, Number(options.maxSegmentChars ?? DEFAULTS.maxSegmentChars))
    const includeToolCalls = options.includeToolCalls !== false
    const includeReasoning = options.includeReasoning === true
    const timeoutMs = Math.max(2000, Number(options.timeoutMs ?? DEFAULTS.timeoutMs))

    // Theme tokens are host-owned; fall back rather than assume a key exists.
    const theme = context.theme as {
      text?: { base?: string; muted?: string; dim?: string; faint?: string }
    }
    const strong = theme.text?.base ?? "#ffffff"
    const faint = theme.text?.muted ?? theme.text?.dim ?? theme.text?.faint ?? "#7a7a7a"

    const [state, setState] = context.storage.memory<SuggestState>("suggest", {
      initial: { text: "", sessionID: "", busy: false, error: "" },
    })

    // Monotonic run id: a newer request invalidates every older one.
    let run = 0

    function debugLog(message: string) {
      if (!options.debug) return
      try {
        appendFileSync(join(os.tmpdir(), `${ID}-debug.log`), `${message}\n`)
      } catch {
        // Debug logging must never break suggestions.
      }
    }

    const activeSession = (): string | undefined => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    type ModelRef = { providerID: string; id: string; variant?: string }

    const modelRef = (): ModelRef | undefined => {
      const override = options.model as { providerID?: string; id?: string; variant?: string } | undefined
      if (override?.providerID && override?.id) {
        return {
          providerID: override.providerID,
          id: override.id,
          ...(override.variant ? { variant: override.variant } : {}),
        }
      }
      const selected = context.ui.model.current() as
        | { providerID: string; modelID: string; variant?: string }
        | undefined
      if (!selected) return undefined
      return {
        providerID: selected.providerID,
        id: selected.modelID,
        ...(selected.variant ? { variant: selected.variant } : {}),
      }
    }

    type GenerateCall = (
      input: { prompt: string; model?: ModelRef },
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>
    type SessionGenerateCall = (
      input: { sessionID: string; prompt: string },
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>

    // Remember which endpoint worked so version skew costs one probe, not one
    // failed request per turn.
    let generateRoute: "generate.text" | "session.generate" | undefined

    class RouteUnavailableError extends Error {
      constructor(message: string) {
        super(message)
        this.name = "RouteUnavailableError"
      }
    }

    /**
     * Tries the stateless `generate.text` endpoint, then falls back to the
     * older `session.generate` endpoint that every 2.1+ server serves. A 2.2
     * client talking to a 2.1 server gets a content-type-less 404 from the
     * newer path, which surfaces as `UnsupportedContentType`; retrying through
     * the session endpoint keeps suggestions working instead of showing that
     * tag. The session endpoint already includes the conversation, so only the
     * instructions are sent there, never the transcript a second time.
     */
    async function generate(
      sessionID: string,
      history: string,
      signal: AbortSignal,
    ): Promise<{ text: string; route: "generate.text" | "session.generate" }> {
      const client = context.client as unknown as {
        generate?: { text?: GenerateCall }
        session?: { generate?: SessionGenerateCall }
      }

      const text: GenerateCall | undefined = client.generate?.text
      const scoped: SessionGenerateCall | undefined = client.session?.generate

      const stateless = async () => {
        if (typeof text !== "function") throw new RouteUnavailableError("generate.text is not available")
        const model = modelRef()
        const response = await text.call(
          client.generate,
          { prompt: `${INSTRUCTIONS}\n\n<conversation>\n${history}\n</conversation>`, ...(model ? { model } : {}) },
          { signal },
        )
        return { text: responseText(response), route: "generate.text" as const }
      }

      const scopedCall = async () => {
        if (typeof scoped !== "function") throw new RouteUnavailableError("session.generate is not available")
        const response = await scoped.call(client.session, { sessionID, prompt: INSTRUCTIONS }, { signal })
        return { text: responseText(response), route: "session.generate" as const }
      }

      const primary = generateRoute === "session.generate" ? scopedCall : stateless
      const secondary = generateRoute === "session.generate" ? stateless : scopedCall

      try {
        const result = await primary()
        generateRoute = result.route
        return result
      } catch (error) {
        if (signal.aborted) throw error
        const message = messageOf(error)
        if (!(error instanceof RouteUnavailableError) && !isProtocolError(message)) throw error
        debugLog(`falling back to the other generate endpoint after: ${message}`)
        const result = await secondary()
        generateRoute = result.route
        return result
      }
    }

    /**
     * Collects transcript segments tagged with a priority tier. Tool output and
     * reasoning are never inlined: tool calls contribute a single status line
     * and reasoning is only included when explicitly enabled.
     */
    function collect(sessionID: string): Segment[] {
      const messages = (context.data.session.message.list(sessionID) ?? []).slice(-maxMessages)
      if (messages.length === 0) return []

      // The closing message of each turn is the one right before the next user
      // message (and the last one in the session). Those get top priority.
      const closing = new Set<number>()
      let pending: number | null = null
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index]
        if (message.type === "user") {
          if (pending !== null) closing.add(pending)
          pending = null
          continue
        }
        if (message.type === "assistant") pending = index
      }
      if (pending !== null) closing.add(pending)

      const segments: Segment[] = []

      messages.forEach((message, index) => {
        if (message.type === "user") {
          const text = clamp(message.text ?? "", maxSegmentChars)
          if (text && !text.startsWith("/")) {
            segments.push({ index, tier: Tier.Essential, sub: 0, text: `USER: ${text}` })
          }
          return
        }

        if (message.type === "system") {
          const text = clamp((message as { text?: string }).text ?? "", maxSegmentChars)
          if (text) segments.push({ index, tier: Tier.Essential, sub: 0, text: `SYSTEM: ${text}` })
          return
        }

        if (message.type !== "assistant") return

        const tier = closing.has(index) ? Tier.Essential : Tier.Narration
        const text = clamp(
          message.content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
          maxSegmentChars,
        )
        if (text) {
          segments.push({
            index,
            tier,
            sub: tier === Tier.Essential ? 1 : 0,
            text: `ASSISTANT: ${text}`,
          })
        }

        if (includeToolCalls) {
          for (const part of message.content) {
            if (part.type !== "tool") continue
            const failed = part.state && "status" in part.state && part.state.status === "error"
            segments.push({
              index,
              tier: Tier.ToolCall,
              sub: 0,
              text: `TOOL: ${part.name}${failed ? " (failed)" : ""}`,
            })
          }
        }

        if (includeReasoning) {
          for (const part of message.content) {
            if (part.type !== "reasoning") continue
            const reasoning = clamp(part.text ?? "", Math.min(600, maxSegmentChars))
            if (reasoning) {
              segments.push({ index, tier: Tier.Reasoning, sub: 0, text: `REASONING: ${reasoning}` })
            }
          }
        }
      })

      return segments
    }

    /**
     * Fills the character budget tier by tier, newest first, then restores
     * chronological order. A tier that cannot fit its content blocks every
     * lower tier, so tool calls and reasoning can never occupy space that
     * would have held a user message or a turn's closing message.
     */
    function select(segments: Segment[], budget: number): Segment[] {
      const chosen: Segment[] = []
      let used = 0
      let blocked = false
      const tiers = [...new Set(segments.map((segment) => segment.tier))].sort((a, b) => a - b)

      for (const tier of tiers) {
        if (blocked) break
        const inTier = segments
          .filter((segment) => segment.tier === tier)
          .sort((a, b) => a.sub - b.sub || b.index - a.index)
        for (const segment of inTier) {
          const cost = segment.text.length + 2
          if (used + cost > budget) {
            blocked = true
            continue
          }
          chosen.push(segment)
          used += cost
        }
      }

      // If even the essentials overflow, keep the newest message anyway.
      if (chosen.length === 0 && segments.length > 0) {
        const newest = [...segments].sort((a, b) => b.index - a.index)[0]
        chosen.push({ ...newest, text: clamp(newest.text, budget) })
      }

      return chosen.sort((a, b) => a.index - b.index)
    }

    async function transcript(sessionID: string): Promise<{ history: string; stats: string }> {
      try {
        await context.data.session.message.sync(sessionID)
      } catch (error) {
        debugLog(`sync failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      const chosen = select(collect(sessionID), maxContextChars)
      const counts = chosen.reduce<Record<number, number>>((acc, segment) => {
        acc[segment.tier] = (acc[segment.tier] ?? 0) + 1
        return acc
      }, {})
      const stats = `budget=${maxContextChars} essential=${counts[0] ?? 0} narration=${counts[1] ?? 0} tools=${counts[2] ?? 0} reasoning=${counts[3] ?? 0} chars=${chosen.reduce((sum, s) => sum + s.text.length, 0)}`
      return { history: chosen.map((segment) => segment.text).join("\n\n"), stats }
    }

    async function suggest(sessionID: string | undefined, attempt = 0): Promise<void> {
      debugLog(`--- entry attempt=${attempt} session=${sessionID} ---`)
      if (!sessionID) return
      // Subagent sessions produce noise, not useful next prompts.
      try {
        if (context.data.session.root(sessionID) !== sessionID) return
      } catch {
        // Session not registered yet: keep going.
      }

      const current = ++run
      setState((draft) => {
        draft.busy = true
        draft.error = ""
        draft.sessionID = sessionID
      })

      try {
        const { history, stats } = await transcript(sessionID)
        if (current !== run) return
        if (!history) {
          debugLog(`empty history (${stats})`)
          setState((draft) => {
            draft.busy = false
            draft.text = ""
          })
          return
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        let text = ""
        let via = ""
        try {
          const result = await generate(sessionID, history, controller.signal)
          text = result.text
          via = result.route
        } finally {
          clearTimeout(timer)
        }

        if (current !== run) return
        const cleaned = clean(text)
        debugLog(`${stats} via=${via}\n--- raw ---\n${text}\n--- cleaned ---\n${cleaned}`)
        setState((draft) => {
          draft.busy = false
          draft.text = cleaned === "NONE" ? "" : cleaned
        })
      } catch (error) {
        if (current !== run) return
        const message = messageOf(error)
        // A transient failure (startup activation or a server restart) is
        // worth retrying; a timeout is not.
        if (!isTimeout(message) && isTransient(message) && attempt < 2) {
          debugLog(`retrying after: ${message}`)
          setTimeout(() => {
            if (run === current && activeSession() === sessionID) void suggest(sessionID, attempt + 1)
          }, 700 + attempt * 800)
          return
        }
        debugLog(`error: ${message}`)
        setState((draft) => {
          draft.busy = false
          draft.text = ""
          // Timeouts are expected on slow models and would only flicker. The
          // rest get a short, readable description instead of a client tag.
          draft.error = isTimeout(message) ? "" : describe(message)
        })
      }
    }

    function clear() {
      run++
      setState((draft) => {
        draft.text = ""
        draft.busy = false
        draft.error = ""
      })
    }

    // Ghost text above the composer.
    context.ui.slot({
      append: "session.composer.top",
      render: (input) => {
        const mine = state.sessionID === input.sessionID
        const busy = mine && state.busy
        const text = mine ? state.text : ""
        const error = mine ? state.error : ""
        if (!busy && !text && !error) return jsx("box", {})

        const hints = [
          ...context.keymap.shortcuts(`${ID}.accept`).map((key) => `${key} accept`),
          ...context.keymap.shortcuts(`${ID}.refresh`).map((key) => `${key} refresh`),
          ...context.keymap.shortcuts(`${ID}.copy`).map((key) => `${key} copy`),
        ].join("  ")

        const line = busy ? "suggesting next prompt…" : error ? `suggest: ${error}` : `next ↳ ${text}`
        return jsx("box", {
          flexDirection: "column",
          children: [
            jsx("text", { fg: busy || error ? faint : strong, children: line }),
            hints ? jsx("text", { fg: faint, children: `   ${hints}` }) : null,
          ],
        })
      },
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: `${ID}.refresh`,
          title: "Suggest next prompt",
          description: "Generate a suggestion for the next message",
          group: "Prompt Suggest",
          bind: "<leader>p",
          palette: true,
          slash: { name: "suggest" },
          run: () => {
            const sessionID = activeSession()
            if (!sessionID) {
              context.ui.toast.show({ message: "Open a session first", variant: "warning" })
              return
            }
            void suggest(sessionID)
          },
        },
        {
          id: `${ID}.accept`,
          title: "Accept suggested prompt",
          description: "Send the suggested message",
          group: "Prompt Suggest",
          bind: "<leader>f",
          run: async () => {
            const sessionID = activeSession()
            const text = state.text
            if (!sessionID || !text) return
            clear()
            try {
              await context.client.session.prompt({ sessionID, text })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              context.ui.toast.show({ message: `Could not send: ${message}`, variant: "error" })
            }
          },
        },
        {
          id: `${ID}.copy`,
          title: "Copy suggested prompt",
          description: "Put the suggestion on the clipboard",
          group: "Prompt Suggest",
          bind: "<leader>v",
          run: () => {
            const text = state.text
            if (!text) return
            try {
              execFileSync("pbcopy", { input: text })
              context.ui.toast.show({ message: "Suggestion copied", variant: "success", duration: 1500 })
            } catch {
              context.ui.toast.show({ message: text, variant: "info", duration: 8000 })
            }
          },
        },
      ],
      bindings: [`${ID}.refresh`, `${ID}.accept`, `${ID}.copy`],
    }))

    const stops: Array<() => void> = []

    if (auto) {
      // A finished turn is the natural moment to guess what comes next.
      stops.push(
        context.data.on("session.execution.succeeded", (event) => {
          const sessionID = event.data.sessionID
          setTimeout(() => {
            // Only suggest for the session the user is looking at; a finished
            // background tab would spend tokens on a suggestion nobody sees.
            if (activeSession() !== sessionID) return
            try {
              if (context.data.session.status(sessionID) === "running") return
            } catch {
              // Unknown session: fall through and try anyway.
            }
            void suggest(sessionID)
          }, autoDelayMs)
        }),
      )

      // A new turn means the old guess is stale.
      stops.push(
        context.data.on("session.execution.started", (event) => {
          if (state.sessionID === event.data.sessionID) clear()
        }),
      )
    }

    return () => {
      for (const stop of stops) stop()
    }
  },
})
