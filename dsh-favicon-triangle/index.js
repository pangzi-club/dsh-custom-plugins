/**
 * DSH Web plugin: serve a triangle as the browser tab icon.
 *
 * The shipped Web shell declares `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`
 * and the install manifest points at the same path, while
 * `@deepseek-ai/dsh-host-frontend-static` serves that file from the SPA dist
 * through the webserver's fallback seat. Claiming the exact path therefore
 * replaces both the tab icon and the installed-app icon, with no change to the
 * shipped frontend build.
 */

/** The one path this plugin claims. */
const FAVICON_PATH = '/favicon.svg'

/** Triangle mark: black on a light tab strip, white under a dark color scheme. */
const TRIANGLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 50 50" fill="none">
  <style>
    @media (prefers-color-scheme: dark) {
      path { fill: #fff; }
    }
  </style>
  <path id="path" fill="#000" d="M25 5.5 L46.5 42.5 L3.5 42.5 Z" />
</svg>
`

/**
 * Answer one favicon request. The handler owns the complete response, so it
 * rejects methods with no representation and revalidates on every load — a
 * browser that cached the previous icon must not keep it without asking.
 * @param req - Node request.
 * @param res - Node response.
 */
function serveFavicon(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  const body = Buffer.from(TRIANGLE_SVG, 'utf8')
  res.writeHead(200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-cache, must-revalidate',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

export const name = 'favicon-triangle'

/** The webserver service owns the route table this plugin claims a path in. */
export const inject = ['webServer']

/**
 * Claim `/favicon.svg` for as long as this plugin stays loaded; the registered
 * effect removes the route when the plugin unloads.
 * @param ctx - Host context carrying the webserver service.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: FAVICON_PATH, handler: serveFavicon }),
    'favicon-triangle: GET /favicon.svg',
  )
}
