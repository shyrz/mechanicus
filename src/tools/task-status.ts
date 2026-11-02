import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobStore } from '../utils/background-job-store';
import {
  DIAGNOSTIC_MAX_BYTES,
  diagnosticExcerptOf,
  diagnosticTail,
  fetchChildTranscript,
} from '../utils/child-transcript';
import { getClient } from '../utils/opencode-client';
import { withTimeout } from '../utils/session';
import { getRuntimeSessionStatusSnapshot } from '../utils/session-runtime-status';
import type { TaskActivityTracker } from './task-activity';
import { observationFromSnapshot, summarizeTaskStatus } from './task-policy';

const z = tool.schema;
const ACTIVE_STATES = new Set(['busy', 'running', 'retry']);

export function createTaskStatusTool(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  activityTracker?: TaskActivityTracker;
  now?: () => number;
  statusTimeoutMs?: number;
  readTimeoutMs?: number;
}): Record<'task_status', ToolDefinition> {
  const task_status = tool({
    description:
      'Read the current status of a tracked child task without resuming, prompting, or changing it. Accepts its task ID or parent-scoped alias.',
    args: {
      task_id: z.string().describe('Tracked task ID or parent-scoped alias'),
      diagnostic: z
        .boolean()
        .optional()
        .describe(
          'Read a bounded, non-final excerpt for a tracked error, cancelled, or stopped task.',
        ),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_status requires sessionID');
      const requested = args.task_id.trim();
      if (!requested) throw new Error('task_status requires task_id');
      if (args.diagnostic === true)
        return readTaskDiagnostic(options, parentSessionID, requested);

      const job = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      if (!job) throw new Error(`Unknown task ID or alias: ${requested}`);

      // Bounded live read: a failed, malformed, or timed-out host status
      // response surfaces as explicit uncertainty instead of a confident
      // board-state fallback.
      const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
        timeoutMs: options.statusTimeoutMs,
      });
      const observation = observationFromSnapshot(snapshot, job.taskID);
      const now = options.now?.() ?? Date.now();
      const lastActivityAt =
        options.activityTracker?.lastActivityAt(job.taskID) ??
        job.lastLiveBusyAt ??
        job.runStartedAt;
      const report = summarizeTaskStatus(job, observation, lastActivityAt, now);

      const details = [
        `Task ${job.alias} (${job.taskID})`,
        `state: ${report.state}${report.uncertain ? ' (unconfirmed)' : ''}`,
        `agent: ${job.agent}`,
        `last_activity_at: ${new Date(lastActivityAt).toISOString()}`,
        `idle_for_seconds: ${report.idleSeconds}`,
        `possibly_stuck: ${report.possiblyStuck}`,
      ];
      if (report.uncertain) {
        details.push('status_uncertain: true');
        if (report.lastStatusError) {
          details.push(`last_status_error: ${report.lastStatusError}`);
        }
      }
      if (!report.uncertain && ACTIVE_STATES.has(report.state)) {
        details.push('');
        details.push(
          '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.',
        );
      }
      return details.join('\n');
    },
  });

  return { task_status };
}

const DIAGNOSTIC_TERMINALS = new Set(['error', 'cancelled', 'stopped']);
const DIAGNOSTIC_NEXT =
  'next: treat this as non-final evidence; await or re-delegate, do not mark the task accepted';
const DIAGNOSTIC_EVIDENCE =
  'transcript (session history; not attributed to the current generation)';

/** Bound variable fields and prevent newlines impersonating header lines. */
function diagnosticField(value: string, maxBytes = 512): string {
  const marker = '[... truncated ...] ';
  const tail = diagnosticTail(value, maxBytes).replace(/[\r\n]/g, ' ');
  return tail.length < value.length
    ? marker + diagnosticTail(tail, maxBytes - marker.length)
    : tail;
}

function diagnosticRefusal(taskID: string, state: string): string {
  return [
    `Task ${diagnosticField(taskID)}`,
    `state: ${state}`,
    'message: Diagnostics are only for finished-but-unsuccessful children (error, cancelled, stopped).',
    state === 'completed'
      ? 'next: use task_result to retrieve the final text'
      : 'next: await the completion notice, do not poll task_status',
  ].join('\n');
}

function renderDiagnostic(
  info: {
    taskID: string;
    alias: string;
    state: string;
    generation: number;
    reason: string;
  },
  transcript: unknown,
  unavailable?: string,
): string {
  const header = [
    `Task ${diagnosticField(info.alias)} (${diagnosticField(info.taskID)})`,
    `state: ${info.state}`,
    `generation: ${info.generation}`,
    `terminal_reason: ${diagnosticField(info.reason)}`,
    'partial_output: true (non-final excerpt; not the task result; read-only)',
  ].join('\n');
  const footer = `\nexcerpt_end\ntruncated: messages,chars\nevidence: ${DIAGNOSTIC_EVIDENCE}\n${DIAGNOSTIC_NEXT}`;
  const budget =
    DIAGNOSTIC_MAX_BYTES -
    new TextEncoder().encode(`${header}\nexcerpt_begin\n${footer}`).byteLength;
  const excerpt = unavailable
    ? { unavailable }
    : diagnosticExcerptOf(transcript, { maxBytes: budget });
  if ('unavailable' in excerpt)
    return `${header}\nexcerpt: none (evidence unavailable)\nevidence: unavailable (${diagnosticField(excerpt.unavailable)})\n${DIAGNOSTIC_NEXT}`;
  return `${header}\nexcerpt_begin\n${excerpt.text}\nexcerpt_end\ntruncated: ${excerpt.truncated}\nevidence: ${DIAGNOSTIC_EVIDENCE}\n${DIAGNOSTIC_NEXT}`;
}

/** Read retained failure evidence without consuming or changing board state. */
async function readTaskDiagnostic(
  options: {
    input: PluginInput;
    backgroundJobBoard: BackgroundJobStore;
    readTimeoutMs?: number;
  },
  parentSessionID: string,
  requested: string,
): Promise<string> {
  try {
    const job = options.backgroundJobBoard.resolve(parentSessionID, requested);
    if (!job)
      throw new Error(
        `Unknown task ID or alias: ${diagnosticField(requested)}`,
      );
    const state = job.state === 'reconciled' ? job.terminalState : job.state;
    if (!state || !DIAGNOSTIC_TERMINALS.has(state))
      return diagnosticRefusal(job.taskID, state ?? job.state);
    const generation = job.generation;
    const revision = job.terminalRevision;
    const reason =
      state === 'error'
        ? (job.lastStatusError ??
          job.resultSummary ??
          'no error details available')
        : state === 'cancelled'
          ? (job.resultSummary?.replace(/^cancelled:\s*/i, '') ?? 'cancelled')
          : (job.resultSummary ?? 'stopped before a terminal result');
    let transcript: unknown;
    let unavailable: string | undefined;
    try {
      transcript = await withTimeout(
        fetchChildTranscript(
          getClient(options.input),
          job.taskID,
          options.input.directory,
        ),
        options.readTimeoutMs ?? 5_000,
        'child transcript read timed out',
      );
    } catch (error) {
      unavailable =
        error instanceof Error ? error.message : 'child transcript read failed';
    }
    const latest = options.backgroundJobBoard.get(job.taskID);
    const latestState =
      latest?.state === 'reconciled' ? latest.terminalState : latest?.state;
    if (
      !latest ||
      latest.generation !== generation ||
      latest.terminalRevision !== revision ||
      !latestState ||
      !DIAGNOSTIC_TERMINALS.has(latestState)
    )
      throw new Error(
        `Task ${diagnosticField(job.taskID)} changed generation while its diagnostic was being read`,
      );
    return renderDiagnostic(
      {
        taskID: job.taskID,
        alias: job.alias,
        state,
        generation,
        reason,
      },
      transcript,
      unavailable,
    );
  } catch (error) {
    throw new Error(
      diagnosticField(
        error instanceof Error ? error.message : 'Diagnostic read failed',
        DIAGNOSTIC_MAX_BYTES - 'Error: '.length,
      ),
    );
  }
}
