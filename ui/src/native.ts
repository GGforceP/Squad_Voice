export type Defaults = { microphone: string | null; speaker: string | null };
export type Preferences = {
  microphoneId: string;
  speakerId: string;
  pushToTalk: boolean;
  hotkey: 'F6' | 'F7' | 'F8' | 'F9' | 'F10';
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  voiceBitrate: 16000 | 24000 | 40000;
  voiceShare: number;
};
export const initialPreferences: Preferences = {
  microphoneId: 'default', speakerId: 'default', pushToTalk: false, hotkey: 'F8',
  echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceBitrate: 24000, voiceShare: 67,
};
export type RememberedLogin = { username: string; password: string };
export type Bootstrap = {
  configured: boolean; profileError: boolean; version: string;
  devices: Defaults; preferences: Preferences; accompanimentSupported: boolean;
  account?: Account | null; remembered?: RememberedLogin | null; loginError?: string | null;
};
export type Channel = { id: string; name: string; description: string; capacity: number };
export type MemberRole = 'owner' | 'recursive' | 'channel' | 'member';
export type RoomRules = { channelAdmin?: boolean; listenUntil?: number; micUntil?: number; chatUntil?: number };
export type MemberAction = 'listen' | 'mic' | 'chat' | 'channel-admin' | 'recursive-admin';
export type Identity = { id: string; name: string; username: string; bio: string; admin?: boolean; role?: MemberRole };
export type Account = { user: Identity; workspace: { name: string; channels: Channel[] } };
export type Presence = { id: string; name: string; mic: boolean; music: boolean; role?: MemberRole; rules?: RoomRules };
export type Workspace = { name: string; admin: boolean; role?: MemberRole; managedChannels?: string[]; channels: Channel[]; presence: Record<string, Presence[]>; presenceUnavailable: string[] };
export type VoiceTicket = { serverUrl: string; accessToken: string; leaseId: string; rules?: RoomRules };
export type UpdateState = { status: 'none' | 'disabled' | 'current' | 'available' | 'downloading' | 'ready' | 'error'; version: string; required: boolean; choice: 'none' | 'now' | 'later' };

type NativeMessage = { id?: string; ok?: boolean; value?: unknown; error?: string; code?: string; event?: string };
export class NativeError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
type WebView = {
  postMessage: (data: unknown) => void;
  addEventListener: (kind: 'message', handler: (e: MessageEvent<NativeMessage>) => void) => void;
};
const bridge = (window as Window & { chrome?: { webview?: WebView } }).chrome?.webview;
export const isDesktop = Boolean(bridge);
const pending = new Map<string, { done: (value: unknown) => void; fail: (error: Error) => void }>();
const subscribers = new Map<string, Set<(value: unknown) => void>>();
let sequence = 0;

bridge?.addEventListener('message', ({ data }) => {
  if (!data || typeof data !== 'object') return;
  if (data.event) subscribers.get(data.event)?.forEach((fn) => fn(data.value));
  if (!data.id) return;
  const request = pending.get(data.id);
  if (!request) return;
  if (data.ok) request.done(data.value);
  else request.fail(new NativeError(data.error || '客户端请求没有完成。', data.code));
});

export function call<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!bridge) return Promise.reject(new Error('请从 Windows 客户端打开 Squad Voice。'));
  const id = String(++sequence);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => { window.clearTimeout(timer); pending.delete(id); };
    const timeout = ['chat.send', 'chat.image', 'cache.apply', 'cache.usage'].includes(command) ? 220000 : 16000;
    const timer = window.setTimeout(() => { cleanup(); reject(new Error('请求超时，请重试。')); }, timeout);
    pending.set(id, {
      done(value) { cleanup(); resolve(value as T); },
      fail(error) { cleanup(); reject(error); },
    });
    try { bridge.postMessage({ id, command, args }); }
    catch { cleanup(); reject(new Error('Windows 客户端连接不可用。')); }
  });
}

export function subscribe<T>(event: string, fn: (value: T) => void): () => void {
  const wrapped = (value: unknown) => fn(value as T);
  const listeners = subscribers.get(event) || new Set();
  subscribers.set(event, listeners);
  listeners.add(wrapped);
  return () => { listeners.delete(wrapped); };
}

export function message(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  // The native broker returns user-facing Chinese text. Never show raw network URLs or token errors.
  return /^[\u3400-\u9fff][^\r\n]{0,105}$/.test(error.message) && !/https?:|wss?:|eyJ/i.test(error.message)
    ? error.message : fallback;
}
