import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InterruptedTurnBanner } from '../../../src/renderer/components/chat/InterruptedTurnBanner';
import { mountPage } from '../../ui-page/harness';
import HookTaskCard from '../../../src/renderer/components/chat/HookTaskCard';
import { DchatConnectionDraft } from '../../../src/renderer/features/bots/DchatConnectionDraft';
import type { DchatSetupView } from '../../../src/shared/dchatConnection';
function SyntheticRecovery() {
  const { t } = useTranslation(); const [failure, setFailure] = useState<string | undefined>();
  return <InterruptedTurnBanner failure={failure} onDismiss={() => {}} onContinue={() => new Promise<void>(resolve => {
    setFailure(undefined);
    window.addEventListener('synthetic-recovery-reject', () => { setFailure(t('chat.interruptedBanner.recovery.uncertain')); resolve(); }, { once: true });
  })} />;
}
mountPage({
  host: ctx => {
    let view: DchatSetupView = { platformSupported: ctx.case !== 'unsupported',
      selected: ['identityExecutable', 'sqlcipherExecutable', 'component', 'databaseRoot'],
      accountId: '10001', chatId: '30003', execute: false, control: false, interruptedCount: ctx.case === 'control' ? 2 : 0, enabled: ctx.case === 'offline', status: ctx.case === 'offline' ? 'offline' : 'saved' };
    return { dchatSetup: {
      get: async () => view, pick: async () => view,
      save: async input => (view = { ...view, chatId: input.chatId, execute: input.execute, control: input.control === true, enabled: false, status: 'saved' }),
      enable: async () => { if (ctx.case === 'failure') throw new Error('synthetic local verification failure'); return (view = { ...view, enabled: true, status: 'connected' }); },
      disable: async () => (view = { ...view, enabled: false, status: 'saved' }),
    } };
  },
  render: ctx => <div className="p-4" data-dchat-fixture-ready>{ctx.case === 'recovery' ? <SyntheticRecovery /> : ctx.case === 'incoming'
    ? <HookTaskCard im="dchat" userText="Synthetic D-Chat input" groupContext="Synthetic background"
        groupMessageCount={1} origin={{ chat: { kind: 'group' }, sender: { id: '200', name: 'Synthetic guest', isOwner: false } }} />
    : <DchatConnectionDraft botId="bot_synthetic" />}</div>,
});
