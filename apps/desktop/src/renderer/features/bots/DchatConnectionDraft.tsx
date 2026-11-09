import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import type { DchatSetupPath, DchatSetupView } from '../../../shared/dchatConnection';
import { useBotTranslation } from './botPronounContext';

/** UI only chooses a conversation. Native identity and paths remain Main-owned. */
export function DchatConnectionDraft({ botId }: { botId: string }) {
  const { t } = useBotTranslation();
  const api = useMemo(() => window.electronAPI?.dchatSetup, []);
  const [view, setView] = useState<DchatSetupView | null>(null);
  const [chatId, setChatId] = useState('');
  const [execute, setExecute] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef(0), mutation = useRef(0), submitting = useRef(false);
  const prefix = 'bots.channels.dchat';
  useEffect(() => {
    const generation = ++request.current;
    submitting.current = false; setBusy(false); setFailed(false); setView(null); setChatId(''); setExecute(false);
    let hydrated = false;
    const load = () => {
      if (!api || submitting.current) return;
      const version = mutation.current;
      void api.get(botId).then(value => {
        if (request.current !== generation || mutation.current !== version || submitting.current) return;
        setView(value);
        if (!hydrated) { setChatId(value.chatId ?? ''); setExecute(value.execute); hydrated = true; }
      }).catch(() => { if (request.current === generation && mutation.current === version) setFailed(true); });
    };
    load(); window.addEventListener('focus', load);
    return () => { ++request.current; window.removeEventListener('focus', load); };
  }, [api, botId]);
  if (!api) return null;
  async function run(action: () => Promise<DchatSetupView>) {
    if (submitting.current) return;
    const generation = request.current;
    ++mutation.current; submitting.current = true; setBusy(true); setFailed(false);
    try { const value = await action(); if (generation === request.current) setView(value); }
    catch { if (generation === request.current) setFailed(true); }
    finally { if (generation === request.current) { submitting.current = false; setBusy(false); } }
  }
  const paths: DchatSetupPath[] = ['identityExecutable', 'sqlcipherExecutable', 'component', 'databaseRoot'];
  const valid = /^\d{1,128}$/.test(chatId);
  return <section className="flex flex-col gap-3 rounded-xl border border-[var(--border-default)] p-4" aria-label="D-Chat">
    <h3 className="text-14 font-medium text-[var(--text-primary)]">D-Chat</h3>
    <p className="text-12 leading-[1.5] text-[var(--text-secondary)]">{t(prefix + '.setupSummary')}</p>
    <p role="status" className="text-12 text-[var(--text-secondary)]">{t(prefix + '.' + (view?.platformSupported === false ? 'unsupported' : view?.status ?? 'loading'))}</p>
    {view?.platformSupported ? <>
      <details><summary className="cursor-pointer text-12 text-[var(--text-secondary)]">{t(prefix + '.localFiles')}</summary>
        <div className="mt-3 flex flex-col gap-2">{paths.map(field => <Button key={field} variant="secondary" size="md" disabled={busy}
          onClick={() => void run(() => api.pick(botId, field))}>{t(prefix + '.' + field)}{view.selected.includes(field) ? ' ✓' : ''}</Button>)}</div>
      </details>
      <FormField label={t(prefix + '.targetChat')}>
        {control => <Input {...control} size="sm" value={chatId} onChange={setChatId} disabled={busy} autoComplete="off" inputMode="numeric" />}
      </FormField>
      <Button variant="secondary" size="md" disabled={busy} onClick={() => setExecute(value => !value)} aria-pressed={execute}>
        {t(prefix + '.' + (execute ? 'executeOn' : 'executeOff'))}
      </Button>
      {view.accountId ? <p className="text-12 text-[var(--text-secondary)]">{t(prefix + '.verifiedAccount', { id: view.accountId })}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="md" loading={busy} disabled={busy || !valid || view.selected.length !== paths.length}
          onClick={() => void run(() => api.save({ botId, chatId, execute }))}>{t(prefix + '.verifySave')}</Button>
        <Button variant="secondary" size="md" disabled={busy || !view.accountId || chatId !== view.chatId || execute !== view.execute}
          onClick={() => void run(() => view.enabled ? api.disable(botId) : api.enable(botId))}>{t(prefix + '.' + (view.enabled ? 'disable' : 'enable'))}</Button>
      </div>
    </> : null}
    {failed ? <p role="alert" className="text-12 text-[var(--text-secondary)]">{t(prefix + '.setupFailed')}</p> : null}
  </section>;
}
