// UnifiedPush for the Plenum Android app. The native side (android/) talks to the user's distributor app, such as ntfy,
// through the UnifiedPush connector. On the web and on iOS the plugin is unavailable and the shell uses Web Push or nothing.
// Methods are the native ones (index.d.ts), reached through Capacitor's proxy: wave 4 added cancel({ tag }) and cancelAll({ channel? }),
// which take down shown notifications (no-ops on the web), and getState().endpointChanged. Validate their arguments with core.js
// normaliseNotificationTag and normaliseChannel before the call; the native side checks them again. Wave 6 (k3) added setStopCards,
// noteStopCounter, stopCounters (a notification's Stop sent natively, with no unlock) and showNotification.
import { registerPlugin } from '@capacitor/core';

const UnifiedPush = registerPlugin('UnifiedPush', {
  web: () => import('./web.js').then(module => new module.UnifiedPushWeb()),
});

export * from './core.js';
export { UnifiedPush };
export default UnifiedPush;
