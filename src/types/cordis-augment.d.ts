/**
 * Cordis declarations this plugin relies on but the installed type bundle does
 * not carry: the webserver service on Context, and four event names the host
 * dispatches today.
 *
 * This file is an external module (it imports), which is what turns
 * `declare module` into a MERGE. Written as a global script it would replace
 * the package's own Context/Events instead, and every unrelated member
 * (ctx.on, ctx.effect, ...) would disappear.
 *
 * Payloads stay `unknown`: the listener narrows them, and that is where the
 * assumptions live. This file must not invent a shape the host might change.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: import('@deepseek-ai/dsh-host-webserver').WebServer
  }

  interface Events {
    /** A session was created; the plugin only reads its header parent. */
    'session/created'(session: unknown): void
    /** A session was disposed; the plugin clears its per-session history. */
    'session/disposed'(session: unknown): void
    /** A subagent run ended; the plugin may read the summary aloud. */
    'subagent/end'(info: unknown): void
    /** Waterfall around tool execution; the plugin only observes the name. */
    'tools/execute'(exec: unknown, next: () => unknown): unknown
  }
}

/** Re-exported so the imports above are used, not erased as unused. */
export type CordisRouteHandlers = (
  req: IncomingMessage,
  res: ServerResponse,
) => void
