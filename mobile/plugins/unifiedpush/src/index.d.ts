// Types for the UnifiedPush plugin (mob-13). Runtime code is in index.js and core.js.
import type { PluginListenerHandle } from '@capacitor/core';

export type UnifiedPushEventName = 'endpoint' | 'registrationFailed' | 'unregistered' | 'tempUnavailable' | 'message';
export type FailedReason = 'INTERNAL_ERROR' | 'NETWORK' | 'ACTION_REQUIRED' | 'VAPID_REQUIRED';

export interface EndpointRecord {
  url: string;
  temporary: boolean;
}

export type NotificationChannelId = 'plenum-approvals' | 'plenum-finished' | 'plenum-problems' | 'plenum-limits';

export interface UnifiedPushState {
  supported: boolean;
  distributor: string | null;
  endpoints: Record<string, EndpointRecord>;
  failures: Record<string, FailedReason>;
  registrations: string[];
  visible: boolean;
  /** The push app gave a new endpoint while Plenum was closed: register again so the computer gets it. Absent on older builds. */
  endpointChanged?: boolean;
}

/** The `message` event. shown: the plugin already showed it as a notification. clear: a 'clear' that took a notification down. */
export interface UnifiedPushMessageEvent {
  instance: string;
  content: string;
  decrypted: boolean;
  shown?: boolean;
  clear?: boolean;
}

export interface UnifiedPushPlugin {
  getState(): Promise<UnifiedPushState>;
  cancel(options: { tag: string }): Promise<{ cancelled: number }>;
  cancelAll(options?: { channel?: NotificationChannelId }): Promise<{ cancelled: number }>;
  getDistributors(): Promise<{ distributors: string[]; saved: string | null }>;
  chooseDistributor(options: { packageName: string }): Promise<{ saved: string }>;
  pickDistributor(): Promise<{ ok: boolean }>;
  register(options?: { instance?: string; messageForDistributor?: string; vapid?: string }): Promise<void>;
  unregister(options?: { instance?: string }): Promise<void>;
  requestNotificationPermission(): Promise<{ granted: boolean }>;
  getNotificationPermission(): Promise<{ granted: boolean }>;
  addListener(event: UnifiedPushEventName, handler: (data: Record<string, unknown>) => void): Promise<PluginListenerHandle>;
}

export declare const UnifiedPush: UnifiedPushPlugin;
export default UnifiedPush;
export * from './core';
