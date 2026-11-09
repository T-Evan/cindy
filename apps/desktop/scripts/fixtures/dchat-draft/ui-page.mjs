export default {
  name: 'dchat-draft', entry: './fixture.tsx', viewport: { width: 360, height: 700 },
  real: 'DchatConnectionDraft, HookTaskCard with native source name and saved context, shared Input/Button/FormField, real translations and theme tokens',
  notCovered: 'Native D-Chat access, trusted IPC, disk persistence, parent teammate settings route, agent execution and real messages',
  cases: {
    control: { about: 'Owner chooses an exact command chat, save stays disabled, interrupted inputs are visible', data: {} },
    incoming: { about: 'D-Chat source label and saved context use the existing native message card', data: {} },
    default: { about: 'Saved connection requires explicit enable; focus preserves unsaved target edits', data: {} },
    failure: { about: 'Main verification failure remains visible and does not claim activation', data: {} },
    offline: { about: 'Saved enabled connection reports native transport unavailable', data: {} },
    unsupported: { about: 'Linux cannot enable the macOS native reader', data: {} },
  },
  async ready(page) { await page.locator('[data-dchat-fixture-ready]').waitFor(); },
  async check(page, ui) {
    if (ui.case === 'incoming') {
      await page.getByText(await ui.t('chat.threadContext.memberFromPlatform', { name: 'Synthetic guest', platform: 'D-Chat' }), { exact: true }).waitFor();
      await page.getByRole('button').click();
      await page.getByText('Synthetic background', { exact: true }).waitFor();
      await ui.capture('native-source-and-saved-context'); return;
    }
    const status = page.getByRole('status').first();
    if (ui.case === 'control') {
      await page.getByText(await ui.t('bots.channels.dchat.controlTitle'), { exact: true }).click();
      await page.getByRole('button', { name: await ui.t('bots.channels.dchat.controlOff'), exact: true }).click();
      const enable = page.getByRole('button', { name: await ui.t('bots.channels.dchat.enable'), exact: true });
      if (!await enable.isDisabled()) throw new Error('Unsaved control choice was enabled');
      await page.getByRole('button', { name: await ui.t('bots.channels.dchat.verifySave'), exact: true }).click();
      await page.getByRole('button', { name: await ui.t('bots.channels.dchat.controlOn'), exact: true }).waitFor();
      if (await status.innerText() !== await ui.t('bots.channels.dchat.saved')) throw new Error('Control save activated reader');
      await page.getByText(await ui.t('bots.channels.dchat.interrupted', { count: 2 }), { exact: true }).waitFor();
      await ui.capture('control-and-interrupted'); return;
    }
    if (ui.case === 'unsupported') {
      if (await status.innerText() !== await ui.t('bots.channels.dchat.unsupported')) throw new Error('Unsupported platform not visible');
    } else if (ui.case === 'offline') {
      if (await status.innerText() !== await ui.t('bots.channels.dchat.offline')) throw new Error('Offline state not visible');
    } else {
      const enable = page.getByRole('button', { name: await ui.t('bots.channels.dchat.enable'), exact: true });
      await enable.click();
      if (ui.case === 'failure') {
        await page.getByRole('alert').waitFor();
        if (await status.innerText() !== await ui.t('bots.channels.dchat.saved')) throw new Error('Failed verification claimed activation');
      } else {
        await page.getByRole('button', { name: await ui.t('bots.channels.dchat.disable'), exact: true }).waitFor();
        if (await status.innerText() !== await ui.t('bots.channels.dchat.connected')) throw new Error('Connected state not rendered');
        const target = page.getByRole('textbox'); await target.fill('99999');
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await page.waitForFunction(() => document.querySelector('input')?.value === '99999');
        const save = page.getByRole('button', { name: await ui.t('bots.channels.dchat.verifySave'), exact: true });
        await save.click();
        await page.getByRole('button', { name: await ui.t('bots.channels.dchat.enable'), exact: true }).waitFor();
        if (await status.innerText() !== await ui.t('bots.channels.dchat.saved')) throw new Error('Save implicitly enabled execution');
      }
    }
    await ui.capture('verified-synthetic-state');
  },
};
