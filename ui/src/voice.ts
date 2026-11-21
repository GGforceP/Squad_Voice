import {
  ConnectionQuality, ConnectionState, LocalAudioTrack, LogLevel, Participant, RemoteAudioTrack,
  Room, RoomEvent, Track, setLogLevel,
} from 'livekit-client';
import { call, initialPreferences, message, subscribe } from './native';
import type { Channel, MemberRole, Preferences, RoomRules, VoiceTicket } from './native';
import { MicrophoneNoiseProcessor, microphoneOptions } from './microphone';

setLogLevel(LogLevel.silent);

export type AudioApp = { pid: number; name: string; executable: string; active: boolean };
export type Member = { id: string; name: string; self: boolean; speaking: boolean; mic: boolean; music: boolean; quality: string; volume: number; role?: MemberRole; rules?: RoomRules };
export type VoiceState = {
  status: 'idle' | 'joining' | 'connected' | 'reconnecting';
  channelId: string | null; members: Member[]; since: number | null;
  mic: boolean; deafened: boolean; quality: string; error: string;
  playbackBlocked: boolean; sharing: string | null; musicVolume: number; shareLevel: number; musicBusy: boolean;
};
const blank = (): VoiceState => ({
  status: 'idle', channelId: null, members: [], since: null, mic: false, deafened: false, quality: 'unknown',
  error: '', playbackBlocked: false, sharing: null, musicVolume: 50, shareLevel: 75, musicBusy: false,
});

type AudioEntry = { track: RemoteAudioTrack; element: HTMLMediaElement; identity: string; music: boolean };
type Share = { context: AudioContext; node: AudioWorkletNode; track: LocalAudioTrack | null; label: string; remove: () => void };

export class VoiceEngine {
  private room: Room | null = null;
  private leaseId = '';
  private events = new Set<(state: VoiceState) => void>();
  private incoming = new Map<string, AudioEntry>();
  private volume = new Map<string, number>();
  private prefs = initialPreferences;
  private wantsMic = false;
  private ptt = false;
  private rules: RoomRules = {};
  private micQueue: Promise<void> = Promise.resolve();
  private micTests = new Set<AbortSignal>();
  private micRevision = 0;
  private appliedMicRevision = -1;
  private noiseFallbackRoom: Room | null = null;
  private share: Share | null = null;
  private shareEpoch = 0;
  private generation = 0;
  private unbindPtt = subscribe<boolean>('ptt', (held) => { this.ptt = held; void this.syncMic(); });
  private unbindEnded = subscribe('accompaniment.ended', () => {
    void this.stopShare().then(() => this.notice('所选伴奏进程已结束，语音通话继续。'));
  });
  state = blank();

  onChange(fn: (state: VoiceState) => void) {
    this.events.add(fn);
    return () => { this.events.delete(fn); };
  }
  private update(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    this.events.forEach(fn => fn(this.state));
  }
  notice(error: string) { this.update({ error }); }

  async join(channel: Channel) {
    if (this.state.status === 'joining' || this.state.channelId === channel.id) return;
    await this.leave();
    const generation = ++this.generation;
    this.update({ status: 'joining', channelId: channel.id, error: '' });
    const room = new Room({
      adaptiveStream: false, dynacast: false,
      audioCaptureDefaults: microphoneOptions(this.prefs),
      audioOutput: { deviceId: this.prefs.speakerId },
      publishDefaults: { audioPreset: { maxBitrate: this.prefs.voiceBitrate }, dtx: true, red: false, forceStereo: false },
    });
    this.room = room;
    const current = () => this.room === room && this.generation === generation;
    const refresh = () => { if (current()) this.refresh(); };
    room.on(RoomEvent.ParticipantConnected, refresh).on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh).on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh).on(RoomEvent.TrackPublished, refresh)
      .on(RoomEvent.TrackUnpublished, refresh).on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh).on(RoomEvent.ConnectionQualityChanged, refresh)
      .on(RoomEvent.ParticipantPermissionsChanged, (_previous, participant) => {
        if (!current() || participant !== room.localParticipant) return;
        if (!this.micAllowed()) { this.wantsMic = false; this.ptt = false; }
        this.applyVolumes();
        void this.syncMic();
        refresh();
      })
      .on(RoomEvent.TrackSubscribed, (track, pub, member) => {
        if (!current() || !(track instanceof RemoteAudioTrack)) return;
        this.removeTrack(pub.trackSid);
        const element = track.attach();
        document.getElementById('voice-audio')?.append(element);
        this.incoming.set(pub.trackSid, { track, element, identity: member.identity, music: pub.source === Track.Source.ScreenShareAudio });
        this.applyVolumes();
        this.resolveShareConflict();
        refresh();
      })
      .on(RoomEvent.TrackUnsubscribed, (_track, pub) => { if (current()) { this.removeTrack(pub.trackSid); refresh(); } })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => { if (current()) this.update({ playbackBlocked: !room.canPlaybackAudio }); })
      .on(RoomEvent.Reconnecting, () => {
        if (!current()) return;
        this.ptt = false;
        void this.syncMic();
        this.update({ status: 'reconnecting' });
      })
      .on(RoomEvent.Reconnected, () => {
        if (!current()) return;
        this.update({ status: 'connected' });
        void this.syncMic();
        refresh();
      })
      .on(RoomEvent.MediaDevicesError, () => { if (current()) this.notice('无法使用当前音频设备，请检查 Windows 权限或改用其他设备。'); })
      .on(RoomEvent.Disconnected, () => {
        if (!current()) return;
        void this.leave().then(() => this.notice('语音连接已断开，可以重新加入频道。'));
      });
    try {
      const ticket = await call<VoiceTicket>('voice.join', { channelId: channel.id });
      if (!current()) {
        if (ticket.leaseId) void call('voice.leave', { leaseId: ticket.leaseId }).catch(() => {});
        return;
      }
      this.leaseId = ticket.leaseId;
      this.rules = ticket.rules ?? {};
      try {
        await room.connect(ticket.serverUrl, ticket.accessToken, { autoSubscribe: true, maxRetries: 0, peerConnectionTimeout: 11000, websocketTimeout: 9000 });
      } catch {
        throw new Error('语音连接未建立，请检查网络或联系房主。');
      }
      if (!current()) { await room.disconnect(); return; }
      this.wantsMic = !this.prefs.pushToTalk && this.micAllowed();
      this.update({ status: 'connected', since: Date.now() });
      void room.startAudio().catch(() => this.update({ playbackBlocked: true }));
      this.refresh();
      await this.syncHotkey();
      await this.syncMic();
    } catch (error) {
      if (!current()) return;
      await this.leave();
      this.notice(message(error, '加入语音失败，请稍后重试。'));
    }
  }

  async leave() {
    ++this.generation;
    const old = this.room;
    const leaseId = this.leaseId;
    this.room = null;
    this.noiseFallbackRoom = null;
    this.leaseId = '';
    this.wantsMic = false;
    this.ptt = false;
    this.rules = {};
    await this.stopShare(old);
    void call('ptt.set', { enabled: false }).catch(() => {});
    for (const sid of [...this.incoming.keys()]) this.removeTrack(sid);
    this.update({ ...blank(), musicVolume: this.state.musicVolume, shareLevel: this.state.shareLevel });
    if (old) await old.disconnect().catch(() => {});
    if (leaseId) void call('voice.leave', { leaseId }).catch(() => {});
  }

  async dispose() {
    this.unbindPtt();
    this.unbindEnded();
    await this.leave();
  }
  async startAudio() {
    try { await this.room?.startAudio(); this.update({ playbackBlocked: false }); }
    catch { this.notice('播放仍被系统阻止，请检查扬声器设置。'); }
  }
  toggleMic() {
    if (this.state.status !== 'connected') return;
    if (!this.micAllowed()) { this.notice('麦克风已被管理员关闭，请在频道内解除限制后再开麦。'); return; }
    if (this.prefs.pushToTalk) { this.notice('已启用按住说话：按住 ' + this.prefs.hotkey + ' 开麦，松开静音。'); return; }
    this.wantsMic = !this.wantsMic;
    void this.syncMic();
  }
  toggleDeafen() {
    if (!this.room || this.state.status !== 'connected') return;
    if (!this.listenAllowed()) { this.notice('管理员已暂停你的语音收听，请在频道内解除限制。'); return; }
    this.update({ deafened: !this.state.deafened });
    this.applyVolumes();
    void this.syncMic();
  }
  async setMicTesting(test: AbortSignal, testing: boolean) {
    if (testing) this.micTests.add(test);
    else this.micTests.delete(test);
    await this.syncMic();
    if (testing && this.room?.localParticipant.isMicrophoneEnabled) {
      this.micTests.delete(test);
      throw new Error('无法暂停通话麦克风，请先手动静音再测试。');
    }
  }

  private maySendMic() {
    return this.micTests.size === 0 && this.micAllowed() && !this.state.deafened && this.state.status === 'connected'
      && (this.prefs.pushToTalk ? this.ptt : this.wantsMic);
  }

  applyRoomRules(rules: RoomRules) {
    const previous = this.rules;
    this.rules = rules;
    if (rules.micUntil === previous.micUntil && rules.listenUntil === previous.listenUntil) return;
    if (!this.micAllowed()) { this.wantsMic = false; this.ptt = false; }
    this.applyVolumes();
    void this.syncMic();
  }

  private micAllowed() {
    const permission = this.room?.localParticipant.permissions;
    return !this.rules.micUntil && (!permission || (permission.canPublish &&
      (permission.canPublishSources.length === 0 || permission.canPublishSources.includes(Track.sourceToProto(Track.Source.Microphone)))));
  }

  private listenAllowed() {
    return !this.rules.listenUntil && this.room?.localParticipant.permissions?.canSubscribe !== false;
  }

  private async createMicrophone(room: Room) {
    const prefs = this.prefs;
    const participant = room.localParticipant;
    if (prefs.noiseSuppression && this.noiseFallbackRoom !== room) {
      const [track] = await participant.createTracks({ audio: microphoneOptions(prefs, false) });
      if (!(track instanceof LocalAudioTrack)) throw new DOMException('Microphone track unavailable', 'NotFoundError');
      const processor = new MicrophoneNoiseProcessor(() => {
        if (this.room !== room || track.getProcessor() !== processor) return;
        this.noiseFallbackRoom = room;
        this.micRevision++;
        this.notice('增强降噪中断，正在切换到基础降噪。');
        void this.syncMic();
      });
      try {
        await track.setProcessor(processor);
        return track;
      } catch {
        track.stop();
        if (this.room === room) {
          this.noiseFallbackRoom = room;
          this.notice('增强降噪暂时无法启动，已切换到基础降噪。');
        }
      }
    }
    const [track] = await participant.createTracks({ audio: microphoneOptions(prefs) });
    if (!track) throw new DOMException('Microphone track unavailable', 'NotFoundError');
    return track;
  }

  private syncMic() {
    const room = this.room;
    if (!room) return Promise.resolve();
    this.micQueue = this.micQueue.catch(() => {}).then(async () => {
      if (this.room !== room) return;
      const participant = room.localParticipant;
      try {
        const current = participant.getTrackPublication(Track.Source.Microphone)?.track;
        if (current && this.maySendMic() && this.appliedMicRevision !== this.micRevision)
          await participant.unpublishTrack(current);
        if (this.room !== room) return;
        const allowed = this.maySendMic();
        if (participant.isMicrophoneEnabled === allowed) return;
        const revision = this.micRevision;
        if (allowed && !participant.getTrackPublication(Track.Source.Microphone)) {
          const track = await this.createMicrophone(room);
          if (this.room !== room || !this.maySendMic() || revision !== this.micRevision) {
            track.stop();
            return;
          }
          try {
            await participant.publishTrack(track, {
              audioPreset: { maxBitrate: this.prefs.voiceBitrate }, dtx: true, red: false, forceStereo: false,
            });
          } catch (error) {
            track.stop();
            throw error;
          }
        } else await participant.setMicrophoneEnabled(allowed);
        if (this.room !== room) return;
        if (allowed) this.appliedMicRevision = revision;
        if (allowed && !this.maySendMic()) await participant.setMicrophoneEnabled(false);
        this.refresh();
      } catch (error) {
        if (this.room === room) {
          this.wantsMic = false;
          this.ptt = false;
          const noInput = error instanceof DOMException && error.name === 'NotFoundError';
          this.notice(noInput ? '未检测到可用的麦克风，已保持静音。' : '麦克风无法打开，请检查设备或 Windows 麦克风权限。');
          this.refresh();
        }
      }
    });
    return this.micQueue;
  }
  private async syncHotkey() {
    if (!this.room || this.state.status !== 'connected') return;
    try { await call('ptt.set', { enabled: this.prefs.pushToTalk }); }
    catch (error) { this.notice(message(error, '无法注册全局按键说话。')); }
  }
  async setPreferences(next: Preferences, followChanges = false) {
    const previous = this.prefs;
    this.prefs = { ...next };
    if (previous.noiseSuppression !== next.noiseSuppression) this.noiseFallbackRoom = null;
    if (previous.microphoneId !== next.microphoneId || previous.noiseSuppression !== next.noiseSuppression ||
        previous.echoCancellation !== next.echoCancellation || previous.autoGainControl !== next.autoGainControl ||
        previous.voiceBitrate !== next.voiceBitrate || (followChanges && next.microphoneId === 'default'))
      this.micRevision++;
    if (previous.pushToTalk !== next.pushToTalk || previous.hotkey !== next.hotkey) {
      this.wantsMic = false;
      this.ptt = false;
      await this.syncHotkey();
    }
    const room = this.room;
    if (!room) return;
    if (previous.speakerId !== next.speakerId || (followChanges && next.speakerId === 'default')) {
      try {
        const ok = await room.switchActiveDevice('audiooutput', next.speakerId, next.speakerId !== 'default');
        if (!ok) this.notice('无法切换所选播放设备，请在音频设置中重新选择。');
      } catch { this.notice('播放设备已变化，请在音频设置中重新选择。'); }
    }
    await this.syncMic();
  }

  setVolume(id: string, volume: number) {
    this.volume.set(id, Math.max(0, Math.min(100, volume)));
    this.applyVolumes(); this.refresh();
  }
  setMusicVolume(volume: number) {
    this.update({ musicVolume: Math.max(0, Math.min(100, volume)) });
    this.applyVolumes();
  }
  setShareLevel(volume: number) {
    const level = Math.max(0, Math.min(100, volume));
    this.update({ shareLevel: level });
    this.share?.node.port.postMessage({ gain: level / 100 });
  }
  private applyVolumes() {
    const muted = this.state.deafened || !this.listenAllowed();
    for (const { track, identity, music, element } of this.incoming.values()) {
      track.setVolume(muted ? 0 : (music ? this.state.musicVolume : this.volume.get(identity) ?? 100) / 100);
      element.muted = muted;
    }
  }
  private removeTrack(sid: string) {
    const item = this.incoming.get(sid);
    if (item) { item.track.detach(item.element); item.element.remove(); this.incoming.delete(sid); }
  }
  private refresh() {
    const room = this.room;
    if (!room || this.state.status === 'idle' || room.state === ConnectionState.Disconnected) return;
    const rows: Member[] = [room.localParticipant, ...room.remoteParticipants.values()].map((p: Participant) => {
      const mic = p.getTrackPublication(Track.Source.Microphone);
      const music = p.getTrackPublication(Track.Source.ScreenShareAudio);
      return {
        id: p.identity, name: (p.name || p.identity).slice(0, 64), self: p === room.localParticipant,
        speaking: Boolean(p.isSpeaking && mic && !mic.isMuted), mic: Boolean(mic && !mic.isMuted), music: Boolean(music && !music.isMuted),
        quality: p.connectionQuality || ConnectionQuality.Unknown, volume: this.volume.get(p.identity) ?? 100,
      };
    });
    this.update({ members: rows, mic: room.localParticipant.isMicrophoneEnabled, quality: room.localParticipant.connectionQuality });
  }

  async startShare(app: AudioApp) {
    const room = this.room;
    if (!room || this.state.status !== 'connected' || this.state.musicBusy) return;
    if (this.hasRemoteMusic()) { this.notice('本频道已有队友在共享伴奏。'); return; }
    await this.stopShare();
    if (this.room !== room) return;
    const epoch = ++this.shareEpoch;
    this.update({ musicBusy: true, error: '' });
    let context: AudioContext | undefined;
    let track: LocalAudioTrack | undefined;
    let share: Share | null = null;
    try {
      context = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
      await context.resume();
      await context.audioWorklet.addModule(new URL('./process-pcm.js', document.baseURI).href);
      if (epoch !== this.shareEpoch || this.room !== room) { await context.close(); return; }
      const dest = context.createMediaStreamDestination();
      dest.channelCount = 1;
      const node = new AudioWorkletNode(context, 'squad-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      node.connect(dest);
      node.port.postMessage({ gain: this.state.shareLevel / 100 });
      const remove = subscribe<string>('accompaniment.pcm', (encoded) => {
        if (this.share !== share || typeof encoded !== 'string' || encoded.length > 2500) return;
        const raw = atob(encoded);
        const samples = new Float32Array(raw.length >> 1);
        for (let i = 0; i < samples.length; i++) {
          const sample = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
          samples[i] = ((sample << 16) >> 16) / 32768;
        }
        node.port.postMessage({ samples }, [samples.buffer]);
      });
      share = { context, node, track: null, label: app.name, remove };
      this.share = share;
      await call('accompaniment.start', { pid: app.pid });
      if (epoch !== this.shareEpoch || this.room !== room || this.share !== share) return;
      track = new LocalAudioTrack(dest.stream.getAudioTracks()[0], undefined, true);
      share.track = track;
      await room.localParticipant.publishTrack(track, {
        source: Track.Source.ScreenShareAudio, name: 'accompaniment', audioPreset: { maxBitrate: 48000 },
        forceStereo: false, red: false, dtx: true,
      });
      if (epoch !== this.shareEpoch || this.room !== room || this.share !== share) {
        await room.localParticipant.unpublishTrack(track).catch(() => {}); track.stop(); return;
      }
      this.update({ sharing: app.name });
      this.resolveShareConflict();
      this.refresh();
    } catch (error) {
      if (epoch === this.shareEpoch) {
        await this.stopShare(room);
        if (context && context.state !== 'closed') await context.close().catch(() => {});
        this.notice(message(error, '无法共享所选应用的伴奏，请检查应用是否在播放以及频道权限。'));
      }
    } finally {
      if (epoch === this.shareEpoch) this.update({ musicBusy: false });
    }
  }
  async stopShare(room = this.room) {
    ++this.shareEpoch;
    const old = this.share;
    this.share = null;
    if (old) {
      void call('accompaniment.stop').catch(() => {});
      old.remove();
      if (old.track) {
        old.track.stop();
        if (room) await room.localParticipant.unpublishTrack(old.track).catch(() => {});
      }
      old.node.disconnect();
      old.node.port.close();
      await old.context.close().catch(() => {});
    }
    if (this.state.sharing || this.state.musicBusy) this.update({ sharing: null, musicBusy: false });
  }
  private hasRemoteMusic() { return [...this.incoming.values()].some(t => t.music); }
  private resolveShareConflict() {
    const me = this.room?.localParticipant.identity;
    if (!this.share || !me) return;
    if ([...this.incoming.values()].some(t => t.music && t.identity < me)) {
      void this.stopShare().then(() => this.notice('另一位队友已开始共享伴奏，你的麦克风不受影响。'));
    }
  }

  async inspectForLab() {
    const result = [];
    for (const { track, music, element } of this.incoming.values()) {
      const stats = await track.getRTCStatsReport();
      let packets = 0, bytes = 0, energy = 0;
      stats?.forEach(row => {
        if (row.type === 'inbound-rtp' && (row.kind === 'audio' || row.mediaType === 'audio')) {
          packets += row.packetsReceived || 0; bytes += row.bytesReceived || 0; energy += row.totalAudioEnergy || 0;
        }
      });
      result.push({ music, packets, bytes, energy, attached: element.isConnected, muted: element.muted });
    }
    const publication = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const processor = publication?.track?.getProcessor();
    const settings = processor instanceof MicrophoneNoiseProcessor ? processor.inputSettings() : publication?.track?.mediaStreamTrack.getSettings();
    return {
      status: this.state.status, users: this.state.members.length, mic: this.state.mic, tracks: result,
      sharing: Boolean(this.share),
      microphone: settings ? {
        noiseSuppression: settings.noiseSuppression, echoCancellation: settings.echoCancellation,
        autoGainControl: settings.autoGainControl, maxBitrate: publication?.options?.audioPreset?.maxBitrate,
        enhancedNoiseSuppression: processor instanceof MicrophoneNoiseProcessor,
      } : null,
    };
  }
}
