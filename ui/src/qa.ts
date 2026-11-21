import { call, NativeError, subscribe } from './native';
import type { Workspace } from './native';

type UpdateMode = 'optional-update' | 'forced-update' | 'immediate-update' | 'required-exit' | 'update-reopened';
type Input = { number: number; mode: 'normal' | 'full' | 'config' | 'persist' | 'resume' | 'signed-out' | UpdateMode; endpoint: string; username: string; password: string; expectMusic: boolean; accountEndpoints?: boolean; releaseVersion: string };
type TrackReport = { music: boolean; packets: number; bytes: number; energy: number; attached: boolean; muted: boolean };
type Stats = {
  status: string; users: number; mic: boolean; tracks: TrackReport[]; sharing: boolean;
  microphone?: { noiseSuppression?: boolean; echoCancellation?: boolean; autoGainControl?: boolean; maxBitrate?: number; enhancedNoiseSuppression?: boolean };
};
const lab = window as Window & { squadVoiceLab?: (input: Input) => void; squadVoiceStats?: () => Promise<Stats> };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const get = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>('[data-testid="' + id + '"]');
async function until<T>(fn: () => T | Promise<T>, ms = 24000): Promise<NonNullable<T>> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    await delay(170);
  }
  throw new Error('condition timeout');
}
async function click(id: string) {
  const element = await until(() => {
    const target = get<HTMLButtonElement>(id);
    return target && !target.disabled ? target : null;
  });
  element.click();
}
function fill(id: string, text: string) {
  const input = get<HTMLInputElement | HTMLTextAreaElement>(id);
  if (!input) throw new Error('field missing');
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function closeModal() { document.querySelector<HTMLButtonElement>('dialog[open] button[aria-label="关闭"]')?.click(); }
const stats = () => lab.squadVoiceStats!();
const capture = async (name: string) => { await delay(280); return call('qa.capture', { name }); };

async function expectForbidden(operation: () => Promise<unknown>, code: string) {
  try { await operation(); }
  catch (error) { if (error instanceof NativeError && error.code === code) return; throw error; }
  throw new Error('request unexpectedly succeeded');
}

async function chatQA(number: number) {
  if (number === 1) {
    await until(() => get('chat-history')?.textContent?.includes('历史消息 14'));
    if (get('chat-history')?.textContent?.includes('历史消息 01')) throw new Error('initial history was not paged');
    const history = get('chat-history')!;
    history.scrollTop = 0;
    history.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true }));
    await until(() => (get('chat-history')?.querySelectorAll('[data-testid="chat-row"]').length ?? 0) > 5);
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 288;
    const painter = canvas.getContext('2d')!;
    painter.fillStyle = '#3d469d'; painter.fillRect(0, 0, 512, 288);
    painter.fillStyle = '#fff'; painter.font = 'bold 36px Segoe UI'; painter.textAlign = 'center';
    painter.fillText('Squad Voice', 256, 138);
    painter.font = '20px Segoe UI'; painter.fillText('频道图片验证', 256, 180);
    const image = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
    const file = get<HTMLInputElement>('chat-file')!;
    const transfer = new DataTransfer();
    transfer.items.add(new File([image], 'squad-voice.png', { type: 'image/png' }));
    file.files = transfer.files;
    file.dispatchEvent(new Event('change', { bubbles: true }));
    fill('chat-text', '图片验证 🎮');
    await click('chat-send');
    const uploaded = await until(() => [...document.querySelectorAll<HTMLElement>('.chat-row')].find(row => row.textContent?.includes('图片验证 🎮')));
    const picture = await until(() => {
      const image = uploaded.querySelector<HTMLImageElement>('img');
      return image?.naturalWidth === 512 ? image : null;
    });
    picture.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await until(() => get<HTMLDialogElement>('photo-preview')?.open && get('photo-preview')?.querySelector('img')?.naturalWidth === 512);
    await capture('image-preview.png');
    await click('photo-close');
    await capture('chat.png');
    await until(() => get('chat-history')?.textContent?.includes('已收到图片'));
    uploaded.querySelector<HTMLButtonElement>('[data-testid="chat-delete"]')?.click();
    await click('confirm-message-delete');
    await until(() => !get('chat-history')?.textContent?.includes('图片验证 🎮'));
    const cacheShortcut = await until(() => get<HTMLButtonElement>('cache-open'));
    const help = cacheShortcut.closest('.rail')?.querySelector('[aria-label="使用说明"]')?.getBoundingClientRect();
    const shortcutBounds = cacheShortcut.getBoundingClientRect();
    if (!help || shortcutBounds.bottom >= help.top || Math.abs(shortcutBounds.x + shortcutBounds.width / 2 - help.x - help.width / 2) > 1) {
      throw new Error('cache shortcut is not aligned above the help button');
    }
    const tooltip = document.getElementById(cacheShortcut.getAttribute('aria-describedby') ?? '');
    if (!tooltip || getComputedStyle(tooltip).visibility !== 'hidden') throw new Error('cache tooltip is normally visible');
    cacheShortcut.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    await until(() => tooltip.textContent?.includes('聊天缓存') && getComputedStyle(tooltip).visibility === 'visible');
    if (get('cache-settings')) throw new Error('showing cache usage opened the cache dialog');
    await capture('cache-shortcut.png');
    cacheShortcut.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    await until(() => getComputedStyle(tooltip).visibility === 'hidden');
    await click('cache-open');
    await until(() => get<HTMLInputElement>('cache-encrypted')?.checked);
    await capture('cache-settings.png');
    closeModal();
  } else if (number === 2) {
    const photographed = await until(() => [...document.querySelectorAll<HTMLElement>('.chat-row')].find(row => row.textContent?.includes('图片验证 🎮')));
    await until(() => photographed.querySelector<HTMLImageElement>('img')?.naturalWidth === 512);
    const id = Number(photographed.dataset.messageId);
    await expectForbidden(() => call('chat.delete', { channelId: 'voice-lobby', id }), 'admin_required');
    fill('chat-text', '已收到图片');
    await click('chat-send');
    await until(() => !get('chat-history')?.textContent?.includes('图片验证 🎮'));
  }
}

async function moderateQA(number: number) {
  const lobby = 'voice-lobby';
  const controlSelf = (action: string) => call('member.control', { channelId: lobby, targetId: '', action, enabled: false });
  if (number === 1) {
    await until(() => get('roster-self')?.querySelector('[data-testid="role-owner"]'));
    if (document.querySelector('.channels .channel-member, .channels .user-profile')) throw new Error('members still duplicated on the left');
    const split = get('room-split')!;
    const before = split.getBoundingClientRect().top;
    split.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await until(() => split.getBoundingClientRect().top < before - 8);
    const saved = await call<{ preferences: { voiceShare: number } }>('app.bootstrap');
    if (saved.preferences.voiceShare !== 62) throw new Error('new split ratio was not persisted');
    await capture('split-layout.png');

    const peer = (name: string) => [...document.querySelectorAll<HTMLElement>('[data-testid="roster-peer"]')].find(row => row.textContent?.includes(name));
    async function action(name: string, action: string) {
      const row = await until(() => peer(name));
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1000, clientY: 190, button: 2 }));
      await click('member-action-' + action);
      await until(() => !get('member-menu'));
    }
    await action('阿澈', 'channel-admin');
    await until(() => peer('阿澈')?.querySelector('[data-testid="role-channel"]'));
    await action('凌风', 'recursive-admin');
    await until(() => peer('凌风')?.querySelector('[data-testid="role-recursive"]'));
    peer('阿澈')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1000, clientY: 190, button: 2 }));
    await until(() => get('member-menu'));
    await capture('member-actions.png');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    for (const type of ['mic', 'listen', 'chat']) await action('阿澈', type);
    await delay(5500);
    for (const type of ['mic', 'listen', 'chat']) await action('阿澈', type);
    await until(() => peer('阿澈')?.textContent?.includes('麦克风开启'));
  } else if (number === 2) {
    await until(() => get('roster-self')?.querySelector('[data-testid="role-channel"]'));
    await until(() => get('rule-chat') && get('rule-listen') && get('rule-mic'));
    await until(async () => {
      const current = await stats();
      return !current.mic && current.tracks.every(track => track.muted);
    });
    for (const type of ['mic', 'listen', 'chat']) await expectForbidden(() => controlSelf(type), 'restriction_locked');
    if (!get<HTMLTextAreaElement>('chat-text')?.disabled) throw new Error('chat composer remained writable');
    await expectForbidden(() => call('chat.send', { channelId: lobby, nonce: 'qa-cannot-send-while-muted', text: '禁言测试' }), 'chat_restricted');
    await until(() => !get('room-restrictions'));
    await click('mic');
    await until(async () => (await stats()).mic);
  }
}

function rmsAt(samples: number[], frequency: number) {
  let re = 0, im = 0;
  const step = 2 * Math.PI * frequency / 44100;
  for (let i = 0; i < samples.length; i++) {
    re += samples[i] * Math.cos(step * i); im += samples[i] * Math.sin(step * i);
  }
  return 2 * Math.hypot(re, im) / samples.length;
}
async function startIsolated(executable: string, wanted: number, excluded: number) {
  const raw: number[] = [];
  const off = subscribe<string>('accompaniment.pcm', (buffer) => {
    if (raw.length >= 53000) return;
    const bytes = atob(buffer);
    for (let i = 0; i + 1 < bytes.length; i += 2) raw.push(((bytes.charCodeAt(i) | bytes.charCodeAt(i + 1) << 8) << 16 >> 16) / 32768);
  });
  try {
    const item = await until(() => document.querySelector<HTMLButtonElement>('[data-process="' + executable + '" i]'));
    item.click();
    await click('music-start');
    await until(() => get('music-stop'));
    await until(() => raw.length >= 45000, 14000);
    const samples = raw.slice(8820, 44100);
    const selected = rmsAt(samples, wanted), other = rmsAt(samples, excluded);
    if (selected < 0.00005 || selected < other * 12) throw new Error('process audio isolation assertion failed');
    return { selected: Number(selected.toFixed(7)), excluded: Number(other.toFixed(7)), ratio: Number((selected / Math.max(other, 0.00000001)).toFixed(1)) };
  } finally { off(); }
}

async function run(input: Input) {
  let stage = 'start';
  try {
    if (input.mode === 'update-reopened') {
      stage = 'default screen after update';
      await until(() => get('workspace') && get('join'));
      if ((await stats()).status !== 'idle' || document.querySelector('dialog[open]'))
        throw new Error('the previous client state was restored after update');
      await call('qa.report', { ok: true, reopened: true, defaultScreen: true });
      await call('qa.exit');
      return;
    }
    if (input.mode === 'resume' || input.mode === 'signed-out') {
      if (input.mode === 'resume') {
        stage = 'automatic login on restart';
        await until(() => get('workspace'));
        if (document.getElementById('root')?.dataset.loginSeen) throw new Error('login page was displayed during automatic login');
        stage = 'explicit sign-out';
        await click('logout');
      } else {
        stage = 'signed-out restart';
      }
      await until(() => get('login-screen'));
      const remembered = get<HTMLInputElement>('username')?.value === input.username &&
        get<HTMLInputElement>('password')?.value === input.password;
      if (!remembered || get('workspace')) throw new Error('remembered login form mismatch');
      await call('qa.report', { ok: true, autoLogin: input.mode === 'resume', prefilledAfterSignOut: remembered });
      await call('qa.exit');
      return;
    }
    await until(() => get('login-screen'));
    const pre = await call<{ configured: boolean; accompanimentSupported: boolean }>('app.bootstrap');
    if (pre.configured) throw new Error('isolated profile should be blank');
    if (input.number === 1) { await delay(320); await capture('login.png'); }
    stage = 'authentication guard';
    let prevented = false;
    try { await call('voice.join', { channelId: 'voice-lobby' }); } catch { prevented = true; }
    if (!prevented) throw new Error('anonymous join was not rejected');

    stage = 'configure';
    await click('profile-open');
    await until(() => get('endpoint'));
    fill('endpoint', input.endpoint);
    await click('save-profile');
    await until(() => !get('endpoint'));
    if (input.mode === 'config') { await call('qa.report', { ok: true, configured: true }); return; }

    stage = 'invalid credentials';
    if (input.number === 1) {
      fill('username', input.username); fill('password', 'invalid-test-input');
      await click('login');
      await until(() => get('login-error'));
      if (get<HTMLInputElement>('password')?.value !== '') throw new Error('password field not cleared');
    }
    stage = 'valid credentials';
    fill('username', input.username); fill('password', input.password);
    await click('login');
    await until(() => get('workspace'));
    if (input.mode === 'optional-update' || input.mode === 'forced-update' || input.mode === 'immediate-update' || input.mode === 'required-exit') {
      stage = 'client update offer';
      const required = input.mode !== 'optional-update';
      const banner = await until(() => get('update-banner'));
      if (banner.textContent?.includes('必需更新') !== required || get('update-skip')) throw new Error('incorrect update offer');
      if (!required && (await call<{ queued: boolean }>('qa.update.plan')).queued)
        throw new Error('untouched optional update queued an installer');
      if (input.mode === 'immediate-update') {
        await click('join');
        await until(async () => (await stats()).status === 'connected');
      }
      await click('settings-open');
      await click('update-open');
      await until(() => get('updates-dialog'));
      await capture('update.png');
      if (input.mode === 'immediate-update') {
        await call('qa.report', { ok: true, required, startedInCall: true });
        await click('dialog-update-now');
        return;
      }
      if (input.mode !== 'required-exit') {
        await click('dialog-update-later');
        await until(() => get('updates-dialog')?.textContent?.includes('退出时自动安装'));
      }
      closeModal();
      if (!get('update-banner')) throw new Error('update notice disappeared');
      stage = 'verified installer queued on exit';
      const result = await call<{ queued: boolean; required: boolean; version: string }>('qa.update.plan');
      if (!result.queued || result.required !== required || result.version !== input.releaseVersion) throw new Error('verified package was not queued on exit');
      await call('qa.report', { ok: true, required, version: result.version });
      await call('qa.exit');
      return;
    }
    if (input.mode === 'persist') {
      stage = 'new update control in audio settings';
      await click('settings-open');
      const audioSettings = await until(() => get('audio-settings'));
      const preset = get<HTMLSelectElement>('voice-bitrate');
      if (preset?.value !== '64000' || Array.from(preset.options, item => item.value).join(',') !== '16000,24000,40000,48000,64000,80000,96000')
        throw new Error('incorrect microphone bitrate presets');
      const updateButton = get('update-open')?.getBoundingClientRect();
      const saveButton = get('save-audio-settings')?.getBoundingClientRect();
      if (!updateButton || !saveButton || updateButton.right >= saveButton.left || Math.abs(updateButton.top - saveButton.top) > 1 ||
          audioSettings.querySelector('[data-testid="cache-open"]')) throw new Error('audio settings controls are misplaced');
      await click('update-open');
      await until(() => get('updates-dialog'));
      closeModal();
      stage = 'microphone record and playback';
      await click('settings-open');
      await click('mic-record');
      await until(() => get('mic-check')?.getAttribute('data-phase') === 'recording');
      await until(() => /dBFS 峰值/.test(get('mic-peak')?.textContent ?? ''), 7000);
      await until(() => !get<HTMLButtonElement>('mic-preview')?.disabled);
      await capture('audio-settings.png');
      await click('mic-preview');
      await until(() => get('mic-test-feedback')?.textContent?.includes('试听完成'));
      await click('save-audio-settings');
      await until(() => !get('audio-settings'));
      stage = 'close to tray and restore';
      const hidden = await call<{ hidden: boolean; trayVisible: boolean }>('qa.close-to-tray');
      if (!hidden.hidden || !hidden.trayVisible) throw new Error('window did not move to the tray');
      const restored = await call<{ visible: boolean }>('qa.restore');
      if (!restored.visible || !get('workspace')) throw new Error('tray restore failed');
      await call('qa.report', { ok: true, microphoneSample: true, closeToTray: true, trayRestore: true });
      await call('qa.exit');
      return;
    }
    if (input.number === 1 && input.accountEndpoints) {
      stage = 'open personal profile';
      await click('account-open');
      await until(() => get('account-bio'));
      stage = 'save personal profile';
      fill('account-bio', '语音联调测试');
      await click('account-save');
      await until(() => {
        const warning = document.querySelector('dialog[open] [role="alert"]')?.textContent;
        if (warning) throw new Error(warning);
        return document.querySelector('dialog[open] [role="status"]');
      });
      await capture('account-settings.png');
      closeModal();
    }
    if (input.accountEndpoints && input.mode !== 'full') {
      stage = 'preview and chat join guard';
      await until(async () => {
        try {
          await expectForbidden(() => call('chat.history', { channelId: 'voice-lobby', limit: 4 }), 'join_voice_for_chat');
          return true;
        } catch (error) {
          if (error instanceof NativeError && error.code === 'cache_changed') return false;
          throw error;
        }
      });
      if (get('chat-pane')) throw new Error('chat visible before joining');
      if (input.number === 1) {
        stage = 'create a voice channel';
        await click('channel-create');
        await until(() => get('channel-name'));
        fill('channel-name', '联调语音室');
        await click('channel-save');
        await until(() => !get('channel-name'));
        const created = await until(async () => (await call<Workspace>('workspace.state')).channels.find(channel => channel.name === '联调语音室'));
        stage = 'edit a voice channel';
        await click('channel-edit-' + created.id);
        await until(() => get('channel-name'));
        fill('channel-name', '联调语音室已编辑');
        await click('channel-save');
        await until(() => !get('channel-name'));
        await until(async () => (await call<Workspace>('workspace.state')).channels.find(channel => channel.name === '联调语音室已编辑'));
        stage = 'delete a voice channel';
        await click('channel-edit-' + created.id);
        await click('channel-delete');
        await until(() => get('channel-delete')?.textContent === '确认删除');
        await click('channel-delete');
        await until(() => !get('channel-' + created.id));
        stage = 'server-driven voice preview';
        await until(() => get('voice-preview')?.querySelector('[data-testid="peer-tile"]'));
        if (get('chat-pane')) throw new Error('chat visible during voice preview');
        await capture('voice-preview.png');
      } else if (input.number === 2) {
        await expectForbidden(() => call('channel.create', { name: '权限测试', capacity: 5 }), 'admin_required');
      }
    }
    stage = 'join';
    await click('join');
    if (input.mode === 'full') {
      const warning = await until(() => {
        const text = get('voice-notice')?.textContent ?? '';
        return text.includes('房间已满') ? text : null;
      });
      if (input.accountEndpoints) {
        stage = 'change own password';
        await click('account-open');
        await click('account-password-open');
        const next = Array.from(crypto.getRandomValues(new Uint8Array(24)), value => value.toString(16).padStart(2, '0')).join('');
        fill('current-password', input.password);
        fill('new-password', next);
        fill('repeat-password', next);
        await click('account-save');
        await until(() => get('login-screen'));
        stage = 'reject old password';
        fill('password', input.password);
        await click('login');
        await until(() => get('login-error'));
        stage = 'accept new password';
        fill('password', next);
        await click('login');
        await until(() => get('workspace'));
      }
      await call('qa.report', { ok: true, roomFull: Boolean(warning), passwordChanged: Boolean(input.accountEndpoints), users: (await stats()).users });
      return;
    }
    await until(() => get('voice-stage'));
    const initialMicrophone = await until(async () => {
      const report = await stats();
      const mic = report.microphone;
      return report.mic && mic?.enhancedNoiseSuppression && mic.maxBitrate === 64000 &&
        mic.noiseSuppression === false && mic.echoCancellation && mic.autoGainControl ? mic : null;
    });

    stage = 'five participants';
    await until(async () => (await stats()).users === 5, 35000);
    if (input.number === 1) {
      await click('settings-open');
      await until(() => get('audio-settings'));
      await capture('audio-settings.png');
      closeModal();
    }
    if (input.accountEndpoints && input.number <= 2) {
      stage = 'chat history image and deletion';
      await chatQA(input.number);
      stage = 'member role and moderation controls';
      await moderateQA(input.number);
    }
    stage = 'four incoming microphone tracks';
    const microphones = await until(async () => {
      const report = await stats();
      const inbound = report.tracks.filter(track => !track.music && track.attached && !track.muted && track.packets > 12);
      return report.mic && inbound.length === 4 ? inbound : null;
    }, 35000);
    let processing: Stats['microphone'];
    if (input.number === 1) {
      stage = 'reconfigure published microphone';
      await click('settings-open');
      await click('noise-suppression');
      await click('echo-cancellation');
      await click('auto-gain-control');
      const bitrate = get<HTMLSelectElement>('voice-bitrate');
      if (!bitrate) throw new Error('missing bitrate control');
      bitrate.value = '96000';
      bitrate.dispatchEvent(new Event('change', { bubbles: true }));
      await click('save-audio-settings');
      processing = await until(async () => {
        const report = await stats();
        const mic = report.microphone;
        return report.mic && mic?.enhancedNoiseSuppression === false && mic.noiseSuppression === false &&
          mic.echoCancellation === false && mic.autoGainControl === false && mic.maxBitrate === 96000 ? mic : null;
      }, 12000);
    }
    let isolation: unknown = null;
    let remoteMusic: TrackReport | null = null;
    if (input.expectMusic && input.number === 1) {
      stage = 'selected process audio';
      await click('music-open');
      await until(() => get('process-list'));
      const sourceA = await startIsolated('SquadToneA.exe', 540, 1390);
      if (!(await stats()).mic) throw new Error('sharing disabled the microphone');
      await capture('accompaniment.png');
      closeModal();
      await capture('voice-room.png');
      await delay(3200);
      stage = 'switch selected process';
      await click('music-open'); await click('music-stop');
      await until(() => !get('music-stop'));
      const sourceB = await startIsolated('SquadToneB.exe', 1390, 540);
      if (!(await stats()).mic) throw new Error('switching accompaniment disabled microphone');
      isolation = { sourceA, sourceB };
      await click('music-stop');
      closeModal();
    } else if (input.expectMusic) {
      stage = 'receiving accompaniment independently';
      remoteMusic = await until(async () => {
        const report = await stats();
        if (!report.mic || report.tracks.filter(t => !t.music && t.packets > 12).length !== 4) return null;
        return report.tracks.find(t => t.music && t.packets > 12 && t.attached && !t.muted);
      }, 36000);
      if (input.number === 2) {
        await click('deafen');
        await until(async () => {
          const report = await stats();
          return !report.mic && report.tracks.every(t => t.muted);
        });
        await click('deafen');
        await until(async () => (await stats()).mic);
      }
    } else if (input.number === 1) {
      await capture('voice-room.png');
    }
    await call('qa.report', { ok: true, users: 5, mic: true, remoteMicrophones: microphones.length, voicePackets: microphones.map(t => t.packets),
      remoteMusic, isolation, processing, chatVerified: input.accountEndpoints && input.number <= 2, moderationVerified: input.accountEndpoints && input.number <= 2 });
  } catch (failure) {
    const voiceError = get('voice-notice')?.textContent?.slice(0, 140) ?? '';
    const loginError = get('login-error')?.textContent?.slice(0, 140) ?? '';
    const account = get<HTMLButtonElement>('account-save');
    const accountError = account?.form?.querySelector('[role="alert"]')?.textContent?.slice(0, 140) ?? '';
    const accountForm = account && {
      open: Boolean(account.closest('dialog')?.open), valid: account.form?.checkValidity(), disabled: account.disabled,
      notice: Boolean(account.form?.querySelector('[role="status"]')),
    };
    if (account) await capture('account-settings-failed.png').catch(() => {});
    const dialogError = document.querySelector('dialog[open] [role="alert"]')?.textContent?.slice(0, 140) ?? '';
    const chatError = get('chat-pane')?.querySelector('[role="alert"]')?.textContent?.slice(0, 140) ?? '';
    const code = failure instanceof NativeError ? failure.code : undefined;
    const error = failure instanceof Error ? failure.message.slice(0, 160) : '';
    const snapshot = await lab.squadVoiceStats?.().catch(() => undefined);
    await call('qa.report', { ok: false, stage, error, code, voiceError, loginError, accountError, accountForm, dialogError, chatError, snapshot }).catch(() => {});
  }
}
lab.squadVoiceLab = input => { void run(input); };
