import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import type { DchatConnectionDraft as Draft, DchatConnectionView } from '../../../shared/dchatConnection';
import { useBotTranslation } from './botPronounContext';

/** An explicitly inactive binding draft; never accepts native events from Renderer. */
export function DchatConnectionDraft({ botId }: { botId: string }) {
  const { t } = useBotTranslation();
  const api = window.electronAPI?.dchatConnection;
  const getDraft = api?.get;
  const [view, setView] = useState<DchatConnectionView | null>(null);
  const [draft, setDraft] = useState<Draft>({ botId, accountId: '', ownerId: '', chatId: '' });
  const [message, setMessage] = useState<'saved' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  useEffect(() => {
    let active = true;
    if (getDraft) void getDraft(botId).then(value => {
      if (!active) return;
      setView(value); if (value.draft) setDraft(value.draft);
    }).catch(() => { if (active) setMessage('failed'); });
    return () => { active = false; };
  }, [getDraft, botId]);
  if (!api) return null;
  const prefix = 'bots.channels.dchat';
  const valid = [draft.accountId, draft.ownerId, draft.chatId].every(value => /^\d{1,128}$/.test(value));
  const change = (key: 'accountId' | 'ownerId' | 'chatId', value: string) => {
    setDraft(current => ({ ...current, [key]: value })); setMessage(null);
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!api || !valid || submitting.current || !view) return;
    submitting.current = true; setBusy(true); setMessage(null);
    try { setView(await api.save(draft)); setMessage('saved'); }
    catch { setMessage('failed'); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <section className="flex flex-col gap-3 rounded-xl border border-[var(--border-default)] p-4" aria-label="D-Chat">
    <h3 className="text-14 font-medium text-[var(--text-primary)]">D-Chat</h3>
    <p className="text-12 leading-[1.5] text-[var(--text-secondary)]">{t(`${prefix}.summary`)}</p>
    {view ? <p className="text-12 leading-[1.5] text-[var(--text-secondary)]">{t(`${prefix}.${view.availability}`)}</p> : null}
    <form onSubmit={event => void save(event)} className="flex flex-col gap-3">
      {(['accountId', 'ownerId', 'chatId'] as const).map(key => <FormField key={key} label={t(`${prefix}.${key}`)}>
        {control => <Input {...control} size="sm" value={draft[key]} onChange={value => change(key, value)}
          disabled={busy || !view} autoComplete="off" spellCheck={false} inputMode="numeric" />}
      </FormField>)}
      <Button type="submit" variant="secondary" size="md" loading={busy} disabled={busy || !view || !valid}>
        {t(`${prefix}.save`)}
      </Button>
    </form>
    {message ? <p role={message === 'failed' ? 'alert' : 'status'} className="text-12 leading-[1.5] text-[var(--text-secondary)]">{t(`${prefix}.${message}`)}</p> : null}
  </section>;
}
