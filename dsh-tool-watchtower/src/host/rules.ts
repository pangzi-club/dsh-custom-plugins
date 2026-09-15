/**
 * The watchtower's gate rules: a plugin-row `config.rules` list evaluated
 * first-match-wins against one tool name. Pure parsing + evaluation, no ctx,
 * so the tests can drive both directly.
 */

/** One configured rule: `tool` is an exact wire name or the `'*'` wildcard. */
export interface GateRule {
  tool: string
  decision: 'allow' | 'deny' | 'ask'
  reason?: string
}

/** The decisions the pre-execute waterfall understands (upstream shape). */
export type Verdict =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

const DECISIONS = new Set(['allow', 'deny', 'ask'])

/**
 * Validate `config.rules` (undefined → no rules) or fail loudly with the
 * offending path in the message.
 */
export function resolveRules(input: unknown): GateRule[] {
  if (input === undefined) return []
  if (!Array.isArray(input)) {
    throw new Error(`dsh-tool-watchtower: config.rules must be an array, got ${JSON.stringify(input)}`)
  }
  return input.map((entry, index) => {
    const at = `config.rules[${index}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`dsh-tool-watchtower: ${at} must be a mapping, got ${JSON.stringify(entry)}`)
    }
    const rule = entry as Record<string, unknown>
    if (typeof rule.tool !== 'string' || rule.tool.trim().length === 0) {
      throw new Error(`dsh-tool-watchtower: ${at}.tool must be a non-empty string`)
    }
    if (typeof rule.decision !== 'string' || !DECISIONS.has(rule.decision)) {
      throw new Error(
        `dsh-tool-watchtower: ${at}.decision must be one of "allow" | "deny" | "ask", got ${JSON.stringify(rule.decision)}`,
      )
    }
    if (rule.reason !== undefined && (typeof rule.reason !== 'string' || rule.reason.trim().length === 0)) {
      throw new Error(`dsh-tool-watchtower: ${at}.reason must be a non-empty string when present`)
    }
    return {
      tool: rule.tool,
      decision: rule.decision as GateRule['decision'],
      ...(typeof rule.reason === 'string' ? { reason: rule.reason } : {}),
    }
  })
}

/** Evaluate the rules against one tool call: first match wins, default allow. */
export function decide(rules: readonly GateRule[], toolName: string): Verdict {
  for (const rule of rules) {
    if (rule.tool !== '*' && rule.tool !== toolName) continue
    if (rule.decision === 'deny') {
      return { kind: 'deny', reason: rule.reason ?? `dsh-tool-watchtower: tool "${toolName}" is denied by rule` }
    }
    if (rule.decision === 'ask') {
      return { kind: 'ask', ...(rule.reason === undefined ? {} : { reason: rule.reason }) }
    }
    return { kind: 'allow' }
  }
  return { kind: 'allow' }
}
