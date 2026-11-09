/** Local Desktop configuration drafts. No native identity or execution authority is implied. */
export interface DchatConnectionDraft {
  botId: string; accountId: string; ownerId: string; chatId: string;
}
export interface DchatConnectionView {
  draft: DchatConnectionDraft | null;
  availability: 'platform-unsupported' | 'reader-unavailable';
}
export interface DchatConnectionApi {
  get(botId: string): Promise<DchatConnectionView>;
  save(draft: DchatConnectionDraft): Promise<DchatConnectionView>;
  remove(botId: string): Promise<DchatConnectionView>;
}

export type DchatSetupPath = 'identityExecutable' | 'sqlcipherExecutable' | 'component' | 'databaseRoot';
export interface DchatSetupView {
  platformSupported: boolean; selected: DchatSetupPath[];
  accountId: string | null; chatId: string | null;
  execute: boolean; enabled: boolean;
  status: 'unconfigured' | 'saved' | 'connected' | 'offline';
}
export interface DchatSetupApi {
  get(botId: string): Promise<DchatSetupView>;
  pick(botId: string, field: DchatSetupPath): Promise<DchatSetupView>;
  save(input: { botId: string; chatId: string; execute: boolean }): Promise<DchatSetupView>;
  enable(botId: string): Promise<DchatSetupView>;
  disable(botId: string): Promise<DchatSetupView>;
}
