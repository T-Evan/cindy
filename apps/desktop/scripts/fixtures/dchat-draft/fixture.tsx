import { mountPage } from '../../ui-page/harness';
import { DchatConnectionDraft } from '../../../src/renderer/features/bots/DchatConnectionDraft';
mountPage({
  host: () => ({ dchatConnection: {
    get: async () => ({ draft: { botId: 'bot_synthetic', accountId: '10001', ownerId: '20002', chatId: '30003' }, availability: 'platform-unsupported' }),
    save: async draft => ({ draft, availability: 'platform-unsupported' }),
  } }),
  render: () => <div className="p-4"><DchatConnectionDraft botId="bot_synthetic" /></div>,
});
