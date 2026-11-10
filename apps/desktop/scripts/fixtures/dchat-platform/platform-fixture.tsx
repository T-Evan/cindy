import { mountPage, ctx, forbid, subscription } from '../../ui-page/harness';
import { BotChannelsPage } from '../../../src/renderer/features/bots/BotChannelsPage';
import { BotSettingsTargetContext, type BotSettingsTarget } from '../../../src/renderer/features/bots/botSettingsTarget';
import type { BotProfile } from '../../../src/renderer/features/bots/botStore';

const bot = { id: 'fixture', name: 'Mia', enabled: true, status: 'active', skills: [], capabilities: {}, sessions: [] } as unknown as BotProfile;
mountPage({
  host: () => ({
    botImConnection: {
      list: async () => ({ connections: [] }), listAdoptable: async () => ({ bots: [] }),
      onChanged: subscription('connections'), add: forbid('botImConnection.add'), adopt: forbid('botImConnection.adopt'),
    },
    dchatConnection: {},
    dchatSetup: {
      get: async () => ({ platformSupported: true, status: 'unconfigured', selected: [], execute: false, enabled: false }),
      pick: forbid('dchatSetup.pick'), save: forbid('dchatSetup.save'), enable: forbid('dchatSetup.enable'), disable: forbid('dchatSetup.disable'),
    },
    hookControl: { setXCompanion: undefined }, wechatBot: { setCompanion: undefined },
  }),
  render: () => {
    const target = { kind: ctx.case === 'remote' ? 'remote' : 'local', deviceName: 'Studio',
      channels: { im: window.electronAPI.botImConnection, canEnterCredentials: ctx.case !== 'remote', wechat: null, x: null },
    } as unknown as BotSettingsTarget;
    return <main className="p-4"><BotSettingsTargetContext.Provider value={target}><BotChannelsPage bot={bot} /></BotSettingsTargetContext.Provider></main>;
  },
});
