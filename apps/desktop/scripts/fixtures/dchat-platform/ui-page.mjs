import assert from 'node:assert/strict';
export default {
  name: 'dchat-platform', entry: './platform-fixture.tsx', viewport: { width: 640, height: 800 },
  real: 'BotChannelsPage Add Platform dialog and DchatConnectionDraft',
  notCovered: 'Real account identity, native setup persistence, companion execution, D-Chat reads and sends',
  stubs: {
    'src/renderer/features/bots/localBotSettingsTarget': 'export const localBotSettingsTarget = {};',
    'src/renderer/contexts/AuthContext': { partial: 'export const useOptionalAuthUser = () => null;' },
  },
  cases: {
    default: { about: 'D-Chat opens setup without saving or enabling a connection' },
    remote: { about: 'A teammate in another instance shows the connection boundary and cannot configure locally' },
  },
  async ready(page) { await page.getByRole('button', { name: /./ }).first().waitFor(); },
  async check(page, ui) {
    await page.getByRole('button', { name: await ui.t('bots.channels.add.button'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('radio', { name: 'D-Chat', exact: true }).click();
    await ui.capture('dchat-option');
    const configure = dialog.getByRole('button', { name: await ui.t('bots.channels.dchat.configure'), exact: true });
    if (ui.case === 'remote') {
      assert.equal(await configure.isDisabled(), true);
      await dialog.getByText(await ui.t('bots.channels.dchat.remoteUnavailable'), { exact: true }).waitFor();
    } else {
      await configure.click();
      await page.getByRole('region', { name: 'D-Chat', exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0);
      await ui.capture('setup');
    }
  },
};
