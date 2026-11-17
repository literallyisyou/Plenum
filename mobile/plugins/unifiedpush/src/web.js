// Web implementation of the UnifiedPush plugin. There is no UnifiedPush in a browser: state is empty, and every action
// that needs the Android app says so. The PWA uses Web Push through the desktop (lib/remote/push.mjs) instead.
import { WebPlugin } from '@capacitor/core';

const NOT_ON_WEB = 'UnifiedPush is only in the Android app. The browser uses Web Push.';

export class UnifiedPushWeb extends WebPlugin {
  async getState() {
    return { supported: false, distributor: null, endpoints: {}, failures: {}, registrations: [], visible: false, endpointChanged: false };
  }

  // Nothing to take down: the browser's notifications are the service worker's (sw.js closes them itself).
  async cancel() {
    return { cancelled: 0 };
  }

  async cancelAll() {
    return { cancelled: 0 };
  }

  // Wave 6 (k3): no native Stop in a browser; the PWA's lock screen sends its own Stop (mobile/shell/app.js lockedStop).
  async setStopCards() {
    return { count: 0, stored: false };
  }

  async noteStopCounter() {
    return undefined;
  }

  async stopCounters() {
    return { counters: {} };
  }

  async showNotification() {
    return { shown: false };
  }

  async getDistributors() {
    return { distributors: [], saved: null };
  }

  async chooseDistributor() {
    throw this.unavailable(NOT_ON_WEB);
  }

  async pickDistributor() {
    throw this.unavailable(NOT_ON_WEB);
  }

  async register() {
    throw this.unavailable(NOT_ON_WEB);
  }

  async unregister() {
    throw this.unavailable(NOT_ON_WEB);
  }

  async requestNotificationPermission() {
    return { granted: false };
  }

  async getNotificationPermission() {
    return { granted: false };
  }
}
