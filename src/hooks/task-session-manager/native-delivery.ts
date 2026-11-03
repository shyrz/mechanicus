/**
 * Native completion notices carry delivery evidence, not terminal evidence.
 * They may acknowledge an already published terminal run, but cannot publish
 * a new terminal state on their own.
 */
import { isRecord } from '../../utils/guards';
import {
  parseTaskIdFromTaskOutput,
  parseTaskStateFromOutput,
} from '../../utils/task';
import type { MessagePart, MessageWithParts } from '../types';

export type NativeDeliveryState = 'completed' | 'error' | 'cancelled';

const NATIVE_DELIVERY_STATES: ReadonlySet<string> = new Set([
  'completed',
  'error',
  'cancelled',
]);

export type NativeDelivery = {
  taskID: string;
  state: NativeDeliveryState;
};

export function parseNativeDelivery(
  part: MessagePart,
  allowContextHeader = false,
): NativeDelivery | undefined {
  const text = part.text;
  if (
    part.type === 'text' &&
    part.synthetic === true &&
    typeof text === 'string'
  ) {
    const v1 =
      /^<task id="(ses_[A-Za-z0-9_-]+)" state="(completed|error|cancelled)">/.exec(
        text,
      );
    if (v1) return { taskID: v1[1], state: v1[2] as NativeDeliveryState };
  }
  if (typeof text !== 'string' || !/^\s*<subagent\b/i.test(text)) {
    return undefined;
  }
  const taskID = parseTaskIdFromTaskOutput(text);
  const state = parseTaskStateFromOutput(text);
  if (!taskID || !state || !NATIVE_DELIVERY_STATES.has(state)) {
    return undefined;
  }
  const metadata = part.metadata;
  if (
    metadata === undefined &&
    allowContextHeader &&
    /^<subagent sessionID="ses_[A-Za-z0-9_-]+" state="(?:completed|error|cancelled)"(?:>| [^>\r\n]*>)/.test(
      text,
    )
  ) {
    return { taskID, state: state as NativeDeliveryState };
  }
  if (
    !isRecord(metadata) ||
    metadata.source !== 'subagent' ||
    metadata.childID !== taskID ||
    metadata.state !== state
  ) {
    return undefined;
  }
  return { taskID, state: state as NativeDeliveryState };
}

export function messageCreatedAt(
  message: MessageWithParts,
): number | undefined {
  const time = (message.info as { time?: unknown }).time;
  const asMillis = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!isRecord(value)) return undefined;
    return typeof value.epochMilliseconds === 'number' &&
      Number.isFinite(value.epochMilliseconds)
      ? value.epochMilliseconds
      : undefined;
  };
  if (!isRecord(time)) return asMillis(time);
  for (const key of ['created', 'completed'] as const) {
    const value = asMillis(time[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}
