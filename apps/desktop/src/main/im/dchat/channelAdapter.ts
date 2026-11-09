import { captureImContext } from '../../../shared/imMessageSource';
import { getCurrentDbClientSnapshot } from '../../localDb/client/current';
import { captureImAccountGeneration, isImAccountGenerationCurrent } from '../accountBoundary';
import { getMaker } from '../../maker-host';
import type { DchatIM } from '@cindy/im';
import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import { channelForceConfirmToolCall } from '../shared/channelToolPolicy';
import { DCHAT_GROUP_WINDOW } from './groupContext';
import { ui } from '../imessage/uiText';

/** Companion-only channel policy. No ordinary task/agent fallback. */
export function createDchatChannelAdapter(im: DchatIM, config: ImOrchestratorConfig): ImChannelAdapter {
  return {
    channel: 'dchat', im, config, ui, companionRequired: true, interactionSurface: 'desktop',
    acceptsAgentEvent: (sessionId, event) => im.acceptsExecutionEvent(sessionId, event),
    getBotContextId: () => im.botContextId, silentQueue: true, processingEmoji: '',
    output: { kind: 'chunked-text', bindToInput: true, im, commitFinal: output => im.commitFinal(output) },
    sessions: { source: 'dchat', workspaceKind: 'dialogue',
      sessionIdFor: () => { throw new Error('DCHAT_COMPANION_REQUIRED'); },
      defaultTitle: () => 'D-Chat',
      ensureWorkingDir: () => { throw new Error('DCHAT_COMPANION_REQUIRED'); },
      extraInsertColumns: () => ({}) },
    buildVendorOptions: userId => ({ dchatChatId: im.chatForLane(userId)?.id, source: 'dchat' }),
    companionLane: userId => {
      const chat = im.chatForLane(userId);
      if (!chat) throw new Error('DCHAT_INVALID_LANE');
      if (chat.kind === 'owner-dm') return { kind: 'owner-dm' };
      if (chat.kind === 'guest-dm') return { kind: 'guest-dm', userId: chat.peerId! };
      return { kind: 'group', chatId: chat.parentId ?? chat.id, threadId: chat.kind === 'topic' ? chat.id : '' };
    },
    inputPreparationRequired: true,
    prepareAgentTurnText: async event => {
      const chat = im.chatForLane(event.senderId);
      const input = event.messageId ? im.inputForRequest(event.messageId) : null;
      if (!chat || !input) throw new Error('DCHAT_STALE_INPUT');
      if (!['group', 'topic'].includes(chat.kind)) return null;
      const epoch = captureImAccountGeneration(), db = getCurrentDbClientSnapshot();
      const current = () => epoch !== null && !!db && isImAccountGenerationCurrent(epoch) && getCurrentDbClientSnapshot() === db;
      if (!current()) throw new Error('DCHAT_ACCOUNT_CHANGED');
      const context = await DCHAT_GROUP_WINDOW.buildContextPrefix({ botId: im.botContextId,
        chatId: chat.parentId ?? chat.id, threadId: chat.kind === 'topic' ? chat.id : '',
        triggerMessageId: input.messageId });
      if (!current()) throw new Error('DCHAT_ACCOUNT_CHANGED');
      return { agentText: context.prefix ? context.prefix + '\n\n' + event.text : event.text,
        contextSnapshot: captureImContext({ groupPrefix: context.prefix, groupMessageCount: context.messageCount }),
        commit: async () => { if (!current()) throw new Error('DCHAT_ACCOUNT_CHANGED'); await context.commit(current); } };
    },
    channelNoteSourceFor: event => ({
      toolsHint: 'D-Chat replies are delivered only to this input’s bound chat. Permission requests are handled in Cindy.',
      chatKind: ['group', 'topic'].includes(im.chatForLane(event.senderId)?.kind ?? '') ? 'group' : 'direct',
      chatId: event.chatId, senderId: event.speaker?.id, senderName: event.speaker?.name, senderIsOwner: event.speaker?.isOwner === true }),
    // Never waive guest policy for Full access: unsupported policy remains rejected
    // by the existing runner. No D-Chat response can decide a permission request.
    turnPermissionPolicyFor: event => event.speaker?.isOwner ? undefined : {
      origin: { kind: 'im', channel: 'dchat', taskId: event.messageId },
      autoReviewContext: { requesterAuthority: 'guest', source: 'group' },
      confirmationSurface: 'desktop', confirmationTimeoutMs: 30 * 60_000, forceConfirmToolCall: channelForceConfirmToolCall },
    onUserMessagePersisted: async ({ userMessageId, persisted, sessionId, clientId }) => { if (persisted && userMessageId) {
      const session = getMaker().getSession(sessionId);
      im.acknowledgeIncoming(userMessageId, sessionId, clientId, session && { instanceId: session.instanceId, turnGeneration: session.getTurnGeneration() });
    } },
    handleTextInteraction: async (_userId, request, interactionOptions) => {
      // Shared router keeps the real request in the owner's Cindy interface.
      if (request.kind === 'permission' && interactionOptions?.sharedPermission) return interactionOptions.sharedPermission.result;
      throw new Error('DCHAT_INTERACTION_REQUIRES_CINDY');
    },
  };
}
