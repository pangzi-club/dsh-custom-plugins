/**
 * Activity fold for the watchtower: a per-session ring buffer fed by the
 * `tools/result` and `agent/assistant-stream` observers, plus the pure totals
 * fold the ping body (and, later, the live panel) serve.
 *
 * Pure data + pure functions: no I/O, no clock. Where an event carries no
 * timestamp of its own (start/end frames, tool outcomes), the caller hands in
 * `Date.now()`.
 */
/** Defensive number read: non-finite or missing counts as zero. */
function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
/** Pull the usage payload out of a chunk value, if it is one. */
function usageOf(chunk) {
    if (typeof chunk !== 'object' || chunk === null)
        return undefined;
    const usage = chunk.usage;
    if (typeof usage !== 'object' || usage === null)
        return undefined;
    const raw = usage;
    if (typeof raw.inputTokens !== 'number' || typeof raw.outputTokens !== 'number')
        return undefined;
    return {
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        ...(typeof raw.cacheReadTokens === 'number' ? { cacheReadTokens: raw.cacheReadTokens } : {}),
        ...(typeof raw.cacheWriteTokens === 'number' ? { cacheWriteTokens: raw.cacheWriteTokens } : {}),
    };
}
/** Pure fold: totals over a record list, in list order. */
export function foldTotals(records) {
    const totals = {
        tools: 0,
        toolErrors: 0,
        modelAttempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
    };
    for (const record of records) {
        if (record.kind === 'tool') {
            totals.tools += 1;
            if (record.isError)
                totals.toolErrors += 1;
            continue;
        }
        totals.modelAttempts += 1;
        const usage = record.usage;
        if (usage === undefined)
            continue;
        totals.inputTokens += usage.inputTokens;
        totals.outputTokens += usage.outputTokens;
        totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
        totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    }
    return totals;
}
/**
 * One session's ring buffer. New records land at the front; the oldest drop
 * past `limit`. In-flight attempts live in `attempts` until their end frame
 * arrives, so usage and outcome land on the record pushed at start.
 */
export class ActivityLog {
    limit;
    records = [];
    attempts = new Map();
    constructor(limit) {
        this.limit = limit;
    }
    recordTool(time, callId, name, isError, code) {
        const record = {
            kind: 'tool',
            time,
            callId,
            name,
            isError,
            ...(code === undefined ? {} : { code }),
        };
        this.push(record);
    }
    /** Fold one assistant-stream frame; `fallbackTime` covers clock-free frames. */
    recordFrame(frame, fallbackTime) {
        const attemptId = String(frame.attemptId ?? '');
        if (frame.type === 'start') {
            const record = {
                kind: 'model',
                time: fallbackTime,
                attemptId,
                turn: num(frame.turn),
                step: num(frame.step),
            };
            this.attempts.set(attemptId, record);
            this.push(record);
            return;
        }
        const record = this.attempts.get(attemptId);
        if (record === undefined)
            return;
        if (frame.type === 'chunk') {
            // Usage rides its own chunk type, always before finish when present.
            const usage = usageOf(frame.chunk);
            if (usage !== undefined)
                record.usage = usage;
            return;
        }
        if (frame.type === 'end') {
            record.endedAt = fallbackTime;
            record.outcome = frame.outcome?.kind === 'committed' ? 'committed' : 'abandoned';
            // Done collecting: drop the in-flight entry so a reused id cannot alias.
            this.attempts.delete(attemptId);
        }
    }
    snapshot() {
        return { records: [...this.records], totals: foldTotals(this.records) };
    }
    push(record) {
        this.records.unshift(record);
        if (this.records.length > this.limit)
            this.records.length = this.limit;
    }
}
