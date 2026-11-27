import type { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import { TrackEvent } from 'livekit-client';
import type { AudioProcessorOptions, LocalTrack, Track, TrackProcessor } from 'livekit-client';
import type { Preferences } from './native';

export function microphoneOptions(prefs: Preferences, noiseSuppression = prefs.noiseSuppression) {
  return {
    deviceId: prefs.microphoneId === 'default' ? undefined : { exact: prefs.microphoneId },
    channelCount: 1, echoCancellation: prefs.echoCancellation, autoGainControl: prefs.autoGainControl, noiseSuppression,
  };
}

let wasmBinary: Promise<ArrayBuffer> | undefined;
function loadModel() {
  wasmBinary ??= fetch(wasmUrl).then(async response => {
    if (!response.ok) throw new Error('RNNoise model is unavailable');
    return response.arrayBuffer();
  }).catch(error => {
    wasmBinary = undefined;
    throw error;
  });
  return wasmBinary;
}

export class MicrophoneNoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'RNNoise';
  processedTrack?: MediaStreamTrack;
  private inputTrack?: MediaStreamTrack;
  private localTrack?: LocalTrack;
  private context?: AudioContext;
  private filter?: RnnoiseWorkletNode;

  constructor(private readonly onFailure?: () => void) {}

  private syncMuted = () => {
    if (this.localTrack && this.processedTrack) this.processedTrack.enabled = !this.localTrack.isMuted;
  };

  inputSettings() { return this.inputTrack?.getSettings(); }

  async init({ track, localTrack }: Pick<AudioProcessorOptions, 'track' | 'localTrack'>) {
    const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.context = context;
    try {
      const [binary, { RnnoiseWorkletNode }] = await Promise.all([
        loadModel(), import('@sapphi-red/web-noise-suppressor'), context.audioWorklet.addModule(workletUrl),
      ]);
      if (this.context !== context || track.readyState !== 'live') throw new Error('Microphone became unavailable');
      const input = context.createMediaStreamSource(new MediaStream([track]));
      const output = context.createMediaStreamDestination();
      output.channelCount = 1;
      const filter = new RnnoiseWorkletNode(context, { wasmBinary: binary, maxChannels: 1 });
      this.filter = filter;
      this.inputTrack = track;
      this.localTrack = localTrack;
      this.processedTrack = output.stream.getAudioTracks()[0];
      input.connect(filter);
      filter.connect(output);
      localTrack?.on(TrackEvent.Muted, this.syncMuted).on(TrackEvent.Unmuted, this.syncMuted);
      this.syncMuted();

      await new Promise<void>((resolve, reject) => {
        let started = false, settled = false;
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          reject(error);
        };
        const timeout = window.setTimeout(() => fail(new Error('RNNoise audio context did not start')), 1800);
        filter.onprocessorerror = () => {
          if (this.filter !== filter) return;
          if (this.processedTrack) this.processedTrack.enabled = false;
          if (started) this.onFailure?.();
          else fail(new Error('RNNoise audio processor failed to start'));
        };
        void context.resume().then(() => {
          // Let the worklet run before handing the track to the caller.
          window.setTimeout(() => {
            if (settled) return;
            if (this.context !== context || track.readyState !== 'live') {
              fail(new Error('Microphone became unavailable'));
              return;
            }
            started = settled = true;
            window.clearTimeout(timeout);
            resolve();
          }, 100);
        }, fail);
      });
    } catch (error) {
      await this.destroy();
      throw error;
    }
  }

  async restart(options: AudioProcessorOptions) {
    await this.destroy();
    await this.init(options);
  }

  async destroy() {
    const context = this.context, filter = this.filter;
    this.context = this.filter = undefined;
    this.localTrack?.off(TrackEvent.Muted, this.syncMuted).off(TrackEvent.Unmuted, this.syncMuted);
    this.localTrack = this.inputTrack = undefined;
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    if (filter) {
      filter.onprocessorerror = null;
      filter.destroy();
      filter.disconnect();
    }
    if (context && context.state !== 'closed') await context.close().catch(() => {});
  }
}
