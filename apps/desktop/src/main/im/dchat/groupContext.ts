import { createChannelGroupWindow } from '../shared/channelGroupWindow';
import { DEFAULT_GROUP_WINDOW_RETENTION } from '../shared/groupWindowCore';
import { createLogger } from '../../logger';

/** Existing owner-DB window, partitioned by connection, parent chat and topic.
 * No transcript/history endpoint is used to synthesize an outward response. */
export const DCHAT_GROUP_WINDOW = createChannelGroupWindow({
  providerPrefix: 'dchat-personal', retention: { ...DEFAULT_GROUP_WINDOW_RETENTION },
  log: createLogger('dchat-group-window'),
});
