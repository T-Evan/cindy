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
