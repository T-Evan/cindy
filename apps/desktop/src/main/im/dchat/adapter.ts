import type { DchatIM } from '@cindy/im';
import type { ImOrchestratorConfig } from '../shared/types';
import { createImOrchestrator } from '../shared/orchestrator';
import { createDchatChannelAdapter } from './channelAdapter';

export function wireDchatOrchestrator(im: DchatIM, config: ImOrchestratorConfig,
  options: { instanceKey: string; companionBotId: string }) {
  return createImOrchestrator(createDchatChannelAdapter(im, config), options);
}
