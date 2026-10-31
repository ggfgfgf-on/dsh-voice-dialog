/**
 * Local types for the harness webserver service.
 *
 * The published plugin depends on the host only through Cordis, and
 * @deepseek-ai/dsh-host-webserver is not a dependency of this package: it is
 * present in the harness checkout, not here. Declaring the small surface this
 * plugin uses keeps `tsc -p tsconfig.json` honest without pulling the whole
 * host into the package's type graph.
 *
 * This file is a global script on purpose: it DECLARES the module (there is
 * nothing to augment). Cordis augmentation lives in cordis-augment.d.ts, which
 * is an external module so it merges instead of shadowing.
 */
declare module '@deepseek-ai/dsh-host-webserver' {
  type IncomingMessage = import('node:http').IncomingMessage
  type ServerResponse = import('node:http').ServerResponse

  /** 'exact' matches the pathname verbatim; 'prefix' matches p and p/<anything>. */
  export type WebRouteKind = 'exact' | 'prefix'

  /** One named route registration; the handler owns the whole response. */
  export interface WebRoute {
    kind: WebRouteKind
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }

  /** The webserver service: route registration returns a disposer. */
  export interface WebServer {
    register(route: WebRoute): () => void
  }
}
