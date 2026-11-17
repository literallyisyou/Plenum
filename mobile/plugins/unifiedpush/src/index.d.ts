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

/** Wave 6 (k3): what a Stop-only message needs for one computer (core.js stopCardFromRecord). Never any other key. */
export interface StopCard {
  id: string;
  name: string;
  deviceId: string;
  stopKey: string;
  ways: { kind: 'lan' | 'tailscale' | 'relay'; url: string }[];
  lastCarrier?: 'lan' | 'tailscale' | 'relay';
  lastUrl?: string;
  counter: number;
}

export interface UnifiedPushPlugin {
  getState(): Promise<UnifiedPushState>;
  /** Wave 6 (k3): replaces the native Stop cards (a computer left out is forgotten). stored is false when the Keystore could not be used. */
  setStopCards(options: { cards: StopCard[] }): Promise<{ count: number; stored: boolean }>;
  /** Wave 6 (k3): the shell raised its handshake counter for this computer. */
  noteStopCounter(options: { computer: string; counter: number }): Promise<void>;
  /** Wave 6 (k3): the counter of each computer with a card, which a Stop sent from a notification may have raised. */
  stopCounters(): Promise<{ counters: Record<string, number> }>;
  /** Wave 6 (k3): shows a message (the event's base64 content) as the plugin's own notification. */
  showNotification(options: { content: string }): Promise<{ shown: boolean }>;
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
