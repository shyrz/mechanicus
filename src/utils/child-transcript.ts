/**
 * Shared child-session transcript evidence extraction and fetch.
 *
 * Two consumers need "what did the child session end with?":
 * - `revived-run-tracker` (revive probes, strict v1 transcript shape)
 * - the quiescent host-outcome settle path in `task-session-manager`
 *   (v2 shim preserves lifecycle metadata; terminality can be confirmed
 *   upstream via `Session.Info.outcome`)
 *
 * Both previously carried their own (and subtly different) extraction
 * logic. This module is the single source of truth for reading a v1-style
 * `{data: [{info, parts}]}` messages response and classifying the
 * trailing assistant turn — and for fetching that transcript:
 * `fetchChildTranscript` binds the client's `session.messages` endpoint
 * (degraded hosts may not expose it) and surfaces `response.error` as a
 * normalized `Error`, replacing the bind/call/unwrap boilerplate that was
 * previously duplicated at every call site. `responseError` and
 * `stringifyError` are the shared response-error extraction and error-text
 * helpers for session-endpoint call sites (revive probes, notification
 * transport, task cancellation).
 */

import type { PluginInput } from '@opencode-ai/plugin';

import { isRecord } from './guards';

interface ChildTranscriptOptions {
  /** Only consider messages after this baseline message id (revive flow). */
  baselineMessageID?: string;
  /** Require `info.time.completed` on the trailing assistant (v1 hosts
   * always provide it once the turn finalizes). Defaults to true; v2
   * shim shapes may pass false when the host outcome gate already
   * confirmed terminal upstream, or when legacy hosts omitted the field. */
  requireCompletionTime?: boolean;
  /** When the ABSOLUTE trailing message is not an assistant, scan
   * backward for the last assistant and classify that message instead.
   * v2 sessions can carry structurally valid non-assistant tails
   * (synthetic/system/skill); the default (false) keeps the strict
   * trailing-message semantics the revive probe relies on. */
  scanBackToLastAssistant?: boolean;
}

export type ChildTerminalEvidence =
  | { kind: 'ready'; text: string }
  | { kind: 'textless' }
  | { kind: 'pending' }
  | { kind: 'error'; errorText: string }
  | { kind: 'no-assistant' }
  | { kind: 'no-new-messages' };

/**
 * Fetch a child session's transcript via `client.session.messages`.
 *
 * Returns the raw response, or `undefined` when the host client does not
 * expose a callable `session.messages` endpoint (degraded hosts) — each
 * call site decides how to degrade. Transport failures propagate to the
 * caller. A `response.error` payload is surfaced as a normalized `Error`
 * whose message is `stringifyError(response.error)`, matching the
 * error-surfacing style previously duplicated at the call sites.
 */
export async function fetchChildTranscript(
  client: PluginInput['client'],
  sessionID: string,
  directory: string,
): Promise<unknown> {
  const session = client.session;
  const messages =
    typeof session?.messages === 'function'
      ? session.messages.bind(session)
      : undefined;
  if (typeof messages !== 'function') return undefined;
  const response = await messages({
    path: { id: sessionID },
    query: { directory },
  });
  const error = responseError(response);
  if (error !== undefined) throw new Error(stringifyError(error));
  return response;
}

/** Extract a non-null `response.error` payload from an SDK-style
 * response; `undefined` when the response carries no error. */
export function responseError(response: unknown): unknown {
  if (!isRecord(response)) return undefined;
  return response.error === undefined || response.error === null
    ? undefined
    : response.error;
}

/** Normalize an unknown error payload to a displayable message string. */
export function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

interface LooseMessage {
  info?: {
    id?: unknown;
    role?: unknown;
    error?: unknown;
    finish?: unknown;
    outcome?: unknown;
    rawFinish?: unknown;
    time?: { completed?: unknown; streamed?: unknown };
  };
  parts?: unknown[];
}

export type TranscriptMessage = LooseMessage;

export const DIAGNOSTIC_MAX_BYTES = 6_144;
const DIAGNOSTIC_MESSAGE_CHARS = 2_000;
const DIAGNOSTIC_ITEM_CHARS = 500;
const DIAGNOSTIC_MESSAGE_PARTS = 100;
const DIAGNOSTIC_MESSAGES = 40;

/** Slice UTF-16 without splitting a surrogate pair at either boundary. */
function diagnosticSlice(text: string, start: number, end?: number): string {
  let sliced = text.slice(start, end);
  if (/^[\uDC00-\uDFFF]/u.test(sliced)) sliced = sliced.slice(1);
  if (/[\uD800-\uDBFF]$/u.test(sliced)) sliced = sliced.slice(0, -1);
  return sliced;
}

/** Read only known error-message fields; never serialize arbitrary error data. */
function diagnosticErrorText(error: unknown) {
  const candidates =
    typeof error === 'string'
      ? [error]
      : isRecord(error)
        ? [isRecord(error.data) ? error.data.message : undefined, error.message]
        : [];
  let truncated = false;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const text = diagnosticSlice(candidate, -480);
    truncated ||= candidate.length > text.length;
    if (text.trim()) return { text, truncated };
  }
  return truncated
    ? { text: '[error details truncated]', truncated: true }
    : undefined;
}

/** UTF-8-safe tail trimming, without allocating a copy of an unbounded string. */
export function diagnosticTail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const tail = diagnosticSlice(text, -maxBytes);
  // Bun's Buffer.byteLength undercounts lone surrogates; encode once instead.
  let bytes = new TextEncoder().encode(tail).byteLength;
  let start = 0;
  let end = tail.length;
  while (bytes > maxBytes) {
    const code = tail.charCodeAt(start++);
    const next = start < end ? tail.charCodeAt(start) : NaN;
    const dropsLow = next >= 0xdc00 && next <= 0xdfff;
    // Each cut also removes a leading low and a trailing high, if present.
    if (code >= 0xd800 && code <= 0xdbff && dropsLow) {
      bytes -= 4;
      start++;
    } else {
      bytes -= code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
      if (dropsLow) {
        bytes -= 3;
        start++;
      }
    }
    const last = tail.charCodeAt(end - 1);
    if (start < end && last >= 0xd800 && last <= 0xdbff) {
      end--;
      bytes -= 3;
    }
  }
  return tail.slice(start, end);
}

/** Select before validation so old malformed entries cannot grow the walk. */
function diagnosticWindow(response: unknown):
  | { unavailable: string }
  | {
      entries: TranscriptMessage[];
      omittedMessages: number;
      partsTruncated: boolean;
    } {
  if (response === undefined)
    return { unavailable: 'transcript source not exposed by host' };
  if (responseError(response) !== undefined)
    return { unavailable: 'transcript read failed' };
  if (!isRecord(response) || !Array.isArray(response.data))
    return { unavailable: 'malformed transcript response' };
  const omittedMessages = Math.max(
    0,
    response.data.length - DIAGNOSTIC_MESSAGES,
  );
  let partsTruncated = false;
  const data = response.data.slice(omittedMessages).map((entry: unknown) => {
    if (!isRecord(entry) || !Array.isArray(entry.parts)) return entry;
    if (entry.parts.length > DIAGNOSTIC_MESSAGE_PARTS) partsTruncated = true;
    return {
      info: entry.info,
      parts: entry.parts.slice(-DIAGNOSTIC_MESSAGE_PARTS),
    };
  });
  const entries: TranscriptMessage[] = [];
  for (const entry of data) {
    if (
      !isRecord(entry) ||
      !isRecord(entry.info) ||
      (entry.parts !== undefined &&
        (!Array.isArray(entry.parts) ||
          entry.parts.some(
            (part) => !isRecord(part) || typeof part.type !== 'string',
          )))
    )
      return { unavailable: 'malformed transcript entries' };
    entries.push(entry);
  }
  return { entries, omittedMessages, partsTruncated };
}

/** Bounded, non-final assistant evidence. Never includes tool inputs or
 * successful tool output. Diagnostic excerpts are not terminal results. */
export function diagnosticExcerptOf(
  response: unknown,
  options: { maxBytes?: number } = {},
):
  | { unavailable: string }
  | { text: string; truncated: string; omittedMessages: number } {
  const window = diagnosticWindow(response);
  if ('unavailable' in window) return { unavailable: window.unavailable };
  const { entries } = window;
  let charsCut = window.partsTruncated;
  const budget = Math.max(
    0,
    Math.min(DIAGNOSTIC_MAX_BYTES, options.maxBytes ?? DIAGNOSTIC_MAX_BYTES),
  );
  const chunks: string[] = [];
  let omittedMessages = window.omittedMessages;
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.info?.role !== 'assistant') continue;
    const pieces: string[] = [];
    let chars = 0;
    const add = (text: string, cap: number) => {
      const room = Math.max(0, DIAGNOSTIC_MESSAGE_CHARS - chars);
      const clipped =
        room > 0 ? diagnosticSlice(text, -Math.min(room, cap)) : '';
      if (text.length > clipped.length) charsCut = true;
      if (clipped) {
        pieces.unshift(clipped);
        chars += clipped.length + 1;
      }
    };
    const detail = diagnosticErrorText(entry.info?.error);
    if (detail) {
      if (detail.truncated) charsCut = true;
      add(`assistant_error: ${detail.text}`, DIAGNOSTIC_ITEM_CHARS);
    }
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      if (chars >= DIAGNOSTIC_MESSAGE_CHARS) {
        charsCut = true;
        break;
      }
      const part = parts[partIndex];
      if (!isRecord(part)) continue;
      if (part.type === 'text' && typeof part.text === 'string')
        add(part.text, DIAGNOSTIC_MESSAGE_CHARS);
      if (part.type === 'tool' && isRecord(part.state)) {
        const status = part.state.status;
        const error = part.state.error;
        if (status === 'error' && typeof error === 'string') {
          if (error.length > 480) charsCut = true;
          add(
            `tool_error: ${diagnosticSlice(error, -480)}`,
            DIAGNOSTIC_ITEM_CHARS,
          );
        }
      }
    }
    const text = diagnosticSlice(pieces.join('\n'), -DIAGNOSTIC_MESSAGE_CHARS);
    chunks.unshift(text);
    bytes += new TextEncoder().encode(text).byteLength + 1;
    if (bytes >= budget) {
      omittedMessages += index;
      charsCut = true;
      break;
    }
  }
  const omitted = omittedMessages
    ? `[... ${omittedMessages} earlier messages omitted ...]\n`
    : '';
  let text = chunks.filter(Boolean).join('\n\n');
  const encoder = new TextEncoder();
  if (encoder.encode(omitted + text).byteLength > budget) charsCut = true;
  const marker = charsCut ? '[... truncated ...]\n' : '';
  text =
    omitted +
    marker +
    diagnosticTail(text, budget - encoder.encode(omitted + marker).byteLength);
  return {
    text: diagnosticTail(text, budget),
    truncated:
      [omittedMessages ? 'messages' : '', charsCut ? 'chars' : '']
        .filter(Boolean)
        .join(',') || 'none',
    omittedMessages,
  };
}

export type TerminalEvidenceVerdict =
  | { verdict: 'completed'; text: string }
  | { verdict: 'error'; text: string }
  | { verdict: 'absent' }
  | { verdict: 'retry'; reason: string };

function verdictFromEvidence(
  evidence: ChildTerminalEvidence,
): TerminalEvidenceVerdict {
  switch (evidence.kind) {
    case 'ready':
      return { verdict: 'completed', text: evidence.text };
    case 'error':
      return { verdict: 'error', text: evidence.errorText };
    case 'pending':
      return { verdict: 'retry', reason: 'pending' };
    case 'textless':
      return { verdict: 'retry', reason: 'textless' };
    default:
      return { verdict: 'retry', reason: 'unrecognized segment shape' };
  }
}

/** A valid absence is not unknown evidence. Never scan through a user prompt
 * or pending assistant placeholder to recover the previous attempt's answer. */
export function classifyTerminalEvidence(
  response: unknown,
  options: {
    baselineMessageID?: string;
    runStartedAt?: number;
    terminalOutcomeConfirmed?: boolean;
  } = {},
): TerminalEvidenceVerdict {
  if (response === undefined)
    return { verdict: 'retry', reason: 'transcript source unavailable' };
  if (responseError(response) !== undefined)
    return { verdict: 'retry', reason: 'transcript read failed' };
  if (!isRecord(response) || !Array.isArray(response.data))
    return { verdict: 'retry', reason: 'malformed transcript response' };
  const all: TranscriptMessage[] = [];
  for (const entry of response.data) {
    if (
      !isRecord(entry) ||
      !isRecord(entry.info) ||
      (!['assistant', 'user', 'system'].includes(String(entry.info.role)) &&
        typeof entry.info.id !== 'string')
    ) {
      return { verdict: 'retry', reason: 'malformed transcript entries' };
    }
    all.push(entry);
    if (
      entry.parts !== undefined &&
      (!Array.isArray(entry.parts) ||
        entry.parts.some(
          (part) => !isRecord(part) || typeof part.type !== 'string',
        ))
    )
      return { verdict: 'retry', reason: 'malformed transcript parts' };
  }
  if (options.baselineMessageID) {
    const baseline = all.findIndex(
      (message) => message.info?.id === options.baselineMessageID,
    );
    if (baseline < 0)
      return { verdict: 'retry', reason: 'baseline message missing' };
    const segment = all.slice(baseline + 1);
    let target = segment.length - 1;
    while (target >= 0) {
      const role = segment[target].info?.role;
      if (typeof role !== 'string' || role === 'assistant' || role === 'user')
        break;
      target -= 1;
    }
    if (target < 0) return { verdict: 'absent' };
    if (segment[target].info?.role === 'user') {
      return segment.some((message) => message.info?.role === 'assistant')
        ? { verdict: 'retry', reason: 'user message after last assistant' }
        : { verdict: 'absent' };
    }
    return verdictFromEvidence(
      classifyAssistantTurnEvidence(
        all,
        baseline + 1 + target,
        baseline,
        !options.terminalOutcomeConfirmed,
      ),
    );
  }
  let target = all.length - 1;
  while (target >= 0 && all[target].info?.role === 'system') target--;
  const trailing = all[target];
  if (!trailing) return { verdict: 'absent' };
  if (trailing.info?.role === 'user') return { verdict: 'absent' };
  if (trailing.info?.role !== 'assistant')
    return {
      verdict: 'retry',
      reason: 'no baseline; cannot attribute a historical assistant turn',
    };
  const completedAt = trailing.info?.time?.completed;
  if (
    options.runStartedAt !== undefined &&
    typeof completedAt === 'number' &&
    completedAt < options.runStartedAt
  )
    return { verdict: 'absent' };
  return verdictFromEvidence(
    classifyAssistantTurnEvidence(
      all,
      target,
      -1,
      !options.terminalOutcomeConfirmed,
    ),
  );
}

/** A v1 closure in migrated history, before the host adds v2 lifecycle data. */
export function classifyMigratedV1Round(
  response: unknown,
): TerminalEvidenceVerdict | undefined {
  if (!isRecord(response) || !Array.isArray(response.data)) return undefined;
  const messages = response.data as TranscriptMessage[];
  // Marker-free v2 history resembles migration; wait for lifecycle evidence
  // rather than guessing that the host has already finished the turn.
  if (
    messages.some(
      (message) =>
        message.info?.rawFinish !== undefined ||
        message.info?.time?.streamed !== undefined ||
        message.info?.outcome !== undefined ||
        message.info?.role === 'idle',
    )
  )
    return undefined;
  const assistant = messages.findLast(
    (message) => message.info?.role === 'assistant',
  );
  if (
    !assistant ||
    !isRecord(assistant.info?.time) ||
    typeof assistant.info.time.completed !== 'number' ||
    (assistant.info?.finish === undefined && assistant.info?.error == null)
  )
    return undefined;
  return classifyTerminalEvidence(response);
}

export function extractChildTerminalEvidence(
  response: unknown,
  options: ChildTranscriptOptions = {},
): ChildTerminalEvidence {
  const data =
    isRecord(response) && Array.isArray(response.data)
      ? (response.data as unknown[])
      : [];
  const messages = data.filter(isRecord) as LooseMessage[];
  if (messages.length === 0) return { kind: 'no-assistant' };

  const baselineIndex = options.baselineMessageID
    ? messages.findIndex((m) => m.info?.id === options.baselineMessageID)
    : -1;
  if (options.baselineMessageID && baselineIndex < 0) {
    return { kind: 'no-new-messages' };
  }
  const lastIndex = messages.length - 1;
  if (baselineIndex >= 0 && lastIndex <= baselineIndex) {
    return { kind: 'no-new-messages' };
  }

  let targetIndex = lastIndex;
  if (
    options.scanBackToLastAssistant &&
    messages[targetIndex].info?.role !== 'assistant'
  ) {
    targetIndex = -1;
    for (let i = lastIndex; i >= 0; i -= 1) {
      if (messages[i].info?.role === 'assistant') {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex < 0) return { kind: 'no-assistant' };
  }

  return classifyAssistantTurnEvidence(
    messages,
    targetIndex,
    baselineIndex,
    options.requireCompletionTime ?? true,
  );
}

/**
 * Single source of truth for classifying ONE assistant turn as the
 * terminal evidence of a run: pending finish states, completion time,
 * segment-wide pending tool calls, terminal error precedence, and
 * usable text. Both the revived-run tracker probe and the stop gate's
 * evidence classifier delegate here so their terminality contracts
 * cannot diverge (a second independent classifier had already dropped
 * the pending-tool rule).
 */
export function classifyAssistantTurnEvidence(
  messages: TranscriptMessage[],
  targetIndex: number,
  baselineIndex: number,
  requireCompletionTime = true,
): ChildTerminalEvidence {
  const last = messages[targetIndex];
  if (last?.info?.role !== 'assistant') return { kind: 'no-assistant' };

  // Terminal error precedence: an assistant turn that carries a
  // terminal error is an error EVEN when a residual `finish` value
  // (e.g. 'tool-calls'/'unknown') survived the failure — the error is
  // the outcome, the finish flag is leftover state.
  if (last.info?.error !== undefined && last.info?.error !== null) {
    return { kind: 'error', errorText: stringifyError(last.info.error) };
  }

  const finish = last.info?.finish;
  if (finish === 'tool-calls' || finish === 'unknown') {
    return { kind: 'pending' };
  }
  if (
    requireCompletionTime &&
    !(isRecord(last.info?.time) && typeof last.info.time.completed === 'number')
  ) {
    return { kind: 'pending' };
  }

  const postBaseline = messages.slice(baselineIndex + 1);
  const hasPendingToolCall = postBaseline.some((message) =>
    (Array.isArray(message.parts) ? message.parts : []).some((part) => {
      if (!isRecord(part) || part.type !== 'tool') return false;
      const status = isRecord(part.state)
        ? typeof part.state.status === 'string'
          ? part.state.status
          : undefined
        : undefined;
      return status !== 'completed' && status !== 'error';
    }),
  );
  if (hasPendingToolCall) return { kind: 'pending' };

  const text = (Array.isArray(last.parts) ? last.parts : [])
    .filter(
      (part) =>
        isRecord(part) &&
        part.type === 'text' &&
        typeof part.text === 'string' &&
        part.text.length > 0,
    )
    .map((part) => (part as { text: string }).text)
    .join('\n\n')
    .trim();
  return text.length > 0 ? { kind: 'ready', text } : { kind: 'textless' };
}
