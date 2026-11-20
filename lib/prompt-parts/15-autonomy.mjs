import { AUTONOMY_RECOVERY } from '../prompt-policy.mjs';

export const parts = [{
  id: 'autonomy-recovery',
  order: 15,
  contexts: ['chat', 'planner', 'coder', 'reviewer', 'council', 'moderator', 'relay', 'compare', 'pipeline'],
  text: async () => AUTONOMY_RECOVERY,
}];
