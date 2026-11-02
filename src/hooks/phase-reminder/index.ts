/**
 * Rebuild a phase reminder on every eligible primary-agent user message.
 *
 * Eligibility comes from each message's agent, so switching agents cannot
 * remove reminders from historical turns. Keep the per-message behavior to
 * reconstruct reminders previously added by post-file-tool-nudge as well.
 */
import { isPrimaryAgentName, PHASE_REMINDER } from '../../config/constants';
import { isInternalInitiatorPart } from '../../utils';
import {
  appendTaggedSyntheticPart,
  isTaggedPart,
} from '../cache-safe-injection';
import {
  findLatestUserMessage,
  isUserMessageWithParts,
  type MessagePart,
} from '../types';

export { PHASE_REMINDER };

export const PHASE_REMINDER_METADATA_KEY = 'mechanicus.phaseReminder';

export function hasPhaseReminder(part: MessagePart): boolean {
  return isTaggedPart(part, PHASE_REMINDER_METADATA_KEY);
}

/**
 * Creates the experimental.chat.messages.transform hook for phase reminder injection.
 * This hook runs right before sending to API, so it doesn't affect UI display.
 * Only injects for the orchestrator agent.
 */
export function createPhaseReminderHook() {
  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
    ): Promise<void> => {
      const messages = Array.isArray(output.messages) ? output.messages : [];

      const lastUserMessage = findLatestUserMessage(messages);
      if (!lastUserMessage) {
        return;
      }

      const { sessionID } = lastUserMessage.info;
      if (!sessionID) {
        return;
      }

      // post-file-tool-nudge must run first so its tagged part deduplicates.
      // Append reminder as a new, separate message part instead of mutating
      // the user-authored text. This prevents the reminder from leaking into
      // the UI display and chat history (issue #448).
      for (const message of messages) {
        if (
          !isUserMessageWithParts(message) ||
          !isPrimaryAgentName(message.info.agent) ||
          message.info.sessionID !== sessionID
        ) {
          continue;
        }

        const textPart = message.parts.find(
          (part) => part.type === 'text' && part.text !== undefined,
        );
        if (
          !textPart ||
          isInternalInitiatorPart(textPart) ||
          message.parts.some(hasPhaseReminder)
        ) {
          continue;
        }

        appendTaggedSyntheticPart(message, {
          text: PHASE_REMINDER,
          metadataKey: PHASE_REMINDER_METADATA_KEY,
        });
      }
    },
  };
}
