import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-fixture';
import { getClient } from '../../utils/opencode-client';
import { createTaskSessionManagerHook } from './index';

const PARENT = 'ses_parent';
const CHILD = 'ses_child';

function createHook(board: BackgroundJobBoard, hostFlavor?: string) {
  void getClient;
  return createTaskSessionManagerHook(
    {
      client: { session: {} },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      backgroundJobBoard: board,
      hostFlavor,
      maxSessionsPerAgent: 2,
      maxRetainedSnapshots: 4,
      shouldManageSession: () => true,
    },
  );
}

function launch(board: BackgroundJobBoard, now = 500) {
  return board.registerLaunch({
    taskID: CHILD,
    parentSessionID: PARENT,
    agent: 'explorer',
    now,
  });
}

function complete(board: BackgroundJobBoard, now = 1_000) {
  board.updateStatus({
    taskID: CHILD,
    state: 'completed',
    resultSummary: 'done',
    now,
  });
}

function delivery(options?: {
  text?: string;
  metadata?: Record<string, unknown>;
  synthetic?: boolean;
  parentSessionID?: string;
  time?: unknown;
}) {
  return {
    messages: [
      {
        info: {
          id: 'delivery-1',
          role: 'user',
          sessionID: options?.parentSessionID ?? PARENT,
          ...(options?.time === undefined
            ? {}
            : { time: { created: options.time } }),
        },
        parts: [
          {
            type: 'text',
            text:
              options?.text ??
              '<subagent sessionID="ses_child" state="completed" description="work">\ndone\n</subagent>',
            ...(options?.metadata ? { metadata: options.metadata } : {}),
            ...(options?.synthetic ? { synthetic: true } : {}),
          },
        ],
      },
    ],
  };
}

async function observe(
  hook: ReturnType<typeof createTaskSessionManagerHook>,
  messages: { messages: unknown[] },
) {
  await hook['experimental.chat.messages.transform']({}, messages as never);
  await hook.injectBackgroundJobBoard({}, messages as never);
}

describe('native completion deliveries', () => {
  test('retires a current v2 delivery once, without retiring a later run', async () => {
    const board = new BackgroundJobBoard();
    launch(board);
    complete(board);
    const hook = createHook(board, 'v2');
    const request = delivery({ time: 1_100 });

    await observe(hook, request);
    expect(board.get(CHILD)).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });

    launch(board, 2_000);
    complete(board, 2_500);
    await observe(hook, request);
    expect(board.get(CHILD)).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
  });

  test('recognizes a synthetic v1 task delivery', async () => {
    const board = new BackgroundJobBoard();
    launch(board);
    complete(board);
    const hook = createHook(board);
    const text = '<task id="ses_child" state="completed">\ndone\n</task>';
    await observe(hook, delivery({ time: 1_100, text }));
    expect(board.get(CHILD)?.state).toBe('completed');

    await observe(hook, delivery({ time: 1_100, text, synthetic: true }));
    expect(board.get(CHILD)?.state).toBe('reconciled');
  });

  test('does not retire running, stale, mismatched, or untimed records', async () => {
    const cases = [
      { running: true, time: 1_100 },
      { running: false, time: 400 },
      {
        running: false,
        time: 1_100,
        text: '<subagent sessionID="ses_child" state="error">bad</subagent>',
      },
      { running: false, time: undefined },
    ];
    for (const entry of cases) {
      const board = new BackgroundJobBoard();
      launch(board);
      if (!entry.running) complete(board);
      await observe(
        createHook(board, 'v2'),
        delivery({ time: entry.time, text: entry.text }),
      );
      expect(board.get(CHILD)?.terminalUnreconciled).toBe(!entry.running);
      expect(board.get(CHILD)?.state).toBe(
        entry.running ? 'running' : 'completed',
      );
    }
  });

  test('requires the owning parent and matching native metadata', async () => {
    const board = new BackgroundJobBoard();
    launch(board);
    complete(board);
    await observe(
      createHook(board, 'v2'),
      delivery({ time: 1_100, parentSessionID: 'ses_other' }),
    );
    expect(board.get(CHILD)?.terminalUnreconciled).toBe(true);

    await observe(
      createHook(board),
      delivery({
        time: 1_100,
        metadata: {
          source: 'subagent',
          childID: 'ses_other',
          state: 'completed',
        },
      }),
    );
    expect(board.get(CHILD)?.terminalUnreconciled).toBe(true);
  });

  test('accepts v2 cancelled deliveries for interrupted terminal records', async () => {
    for (const state of ['error', 'stopped'] as const) {
      const board = new BackgroundJobBoard();
      launch(board);
      if (state === 'error') {
        board.updateStatus({ taskID: CHILD, state, now: 1_000 });
      } else {
        board.markStopped(CHILD, 'interrupted', 1_000, undefined, 1_000);
      }
      await observe(
        createHook(board, 'v2'),
        delivery({
          time: 1_100,
          text: '<subagent sessionID="ses_child" state="cancelled">interrupted</subagent>',
        }),
      );
      expect(board.get(CHILD)?.terminalUnreconciled).toBe(false);
    }
  });
});
