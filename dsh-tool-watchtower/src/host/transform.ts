/**
 * The transform kernel: pure planning for the post-execute listener. Given a
 * mode and the result's text, decide which path the result takes. No ctx, no
 * framework types — the listener only executes the plan.
 */

export type TransformMode = 'off' | 'redact' | 'annotate' | 'block-secret'

export interface TransformConfig {
  /** Tool names the demo transform may touch (own demo tools; keep user tools out). */
  tools: string[]
  mode: TransformMode
}

/** The marker the demo treats as a secret leak. */
export const SECRET_MARK = 'DSH_SECRET'

const MODES = new Set(['off', 'redact', 'annotate', 'block-secret'])

/** Validate `config.transform` (undefined → off) or fail loudly. */
export function resolveTransform(input: unknown): TransformConfig {
  if (input === undefined) return { tools: [], mode: 'off' }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`dsh-tool-watchtower: config.transform must be a mapping, got ${JSON.stringify(input)}`)
  }
  const raw = input as { tools?: unknown; mode?: unknown }
  if (!Array.isArray(raw.tools) || raw.tools.some(tool => typeof tool !== 'string' || tool.length === 0)) {
    throw new Error('dsh-tool-watchtower: config.transform.tools must be an array of non-empty strings')
  }
  if (typeof raw.mode !== 'string' || !MODES.has(raw.mode)) {
    throw new Error('dsh-tool-watchtower: config.transform.mode must be one of "off" | "redact" | "annotate" | "block-secret"')
  }
  return { tools: [...raw.tools], mode: raw.mode as TransformMode }
}

/** Join the text blocks of one result's content into a single string. */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text
      : ''))
    .join('\n')
}

/** Replace every secret marker in the projected text. */
export function redactText(text: string): string {
  return text.split(SECRET_MARK).join('[redacted]')
}

export type TransformPlan = 'passthrough' | 'redact' | 'block' | 'annotate'

/** The pure decision: what should happen to one settled result. */
export function planTransform(mode: TransformMode, isError: boolean, text: string): TransformPlan {
  if (mode === 'off' || isError) return 'passthrough'
  if (mode === 'redact') return text.includes(SECRET_MARK) ? 'redact' : 'passthrough'
  if (mode === 'block-secret') return text.includes(SECRET_MARK) ? 'block' : 'passthrough'
  return 'annotate'
}
