export default {
  name: 'dchat-draft',
  entry: './fixture.tsx',
  viewport: { width: 360, height: 700 },
  real: 'DchatConnectionDraft, shared Input/Button/FormField, real translations and theme tokens',
  notCovered: 'Native D-Chat access, trusted IPC, disk persistence, parent teammate settings route, agent execution and real messages',
  cases: { default: { about: 'Inactive synthetic binding draft; saving shows a receipt without enabling a connection', data: {} } },
  async ready(page) { await page.getByRole('button').filter({ hasText: /.+/ }).last().waitFor(); },
  async check(page, ui) {
    const save = page.getByRole('button', { name: await ui.t('bots.channels.dchat.save'), exact: true });
    await save.waitFor({ state: 'visible' });
    await save.click();
    const receipt = page.getByRole('status');
    await receipt.waitFor();
    if (await receipt.innerText() !== await ui.t('bots.channels.dchat.saved')) throw new Error('Binding draft receipt not rendered');
    await ui.capture('saved-draft');
  },
};
