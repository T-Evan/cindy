import type { DchatIM } from '@cindy/im';
import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import { channelForceConfirmToolCall } from '../shared/channelToolPolicy';
import { ui } from '../imessage/uiText';

/** Companion-only channel policy. No ordinary task/agent fallback. */
export function createDchatChannelAdapter(im: DchatIM, config: ImOrchestratorConfig): ImChannelAdapter {
  return {
    channel: 'dchat', im, config, ui, companionRequired: true,
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
    onUserMessagePersisted: async ({ userMessageId, persisted }) => { if (persisted && userMessageId) im.acknowledgeIncoming(userMessageId); },
    handleTextInteraction: async (_userId, request, interactionOptions) => {
      // Shared router keeps the real request in the owner's Cindy interface.
      if (request.kind === 'permission' && interactionOptions?.sharedPermission) return interactionOptions.sharedPermission.result;
      throw new Error('DCHAT_INTERACTION_REQUIRES_CINDY');
    },
  };
}
