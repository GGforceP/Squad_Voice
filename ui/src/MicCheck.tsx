import { useEffect, useRef, useState } from 'react';
import { message, subscribe } from './native';
import type { Preferences } from './native';
import { MicrophoneNoiseProcessor, microphoneOptions } from './microphone';
import type { VoiceEngine } from './voice';

const sampleMs = 4000;
const floor = -60;
type Phase = 'idle' | 'opening' | 'recording' | 'playing';

function recordSample(stream: MediaStream, signal: AbortSignal) {
  return new Promise<Blob>((resolve, reject) => {
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    let timer = 0;
    function stop() { if (recorder.state !== 'inactive') recorder.stop(); }
    function cleanup() {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    }
    recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
    recorder.onerror = () => { cleanup(); reject(new Error('录音未完成，请检查所选麦克风。')); };
    recorder.onstop = () => { cleanup(); resolve(new Blob(chunks, { type: recorder.mimeType })); };
    recorder.start();
    signal.addEventListener('abort', stop, { once: true });
    timer = window.setTimeout(stop, sampleMs);
  });
}

export function MicCheck({ engine, preferences }: { engine: VoiceEngine; preferences: Preferences }) {
  const active = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [sample, setSample] = useState<Blob | null>(null);
  const [level, setLevel] = useState(floor);
  const [peak, setPeak] = useState(floor);
  const [feedback, setFeedback] = useState('');
  const stop = () => active.current?.abort();

  useEffect(() => {
    const unbind = subscribe('app.hidden', stop);
    return () => { stop(); unbind(); };
  }, []);
  useEffect(() => {
    stop();
    setSample(null);
    setFeedback('');
    setLevel(floor);
    setPeak(floor);
  }, [preferences.microphoneId, preferences.echoCancellation, preferences.noiseSuppression, preferences.autoGainControl]);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setFeedback('');
    setPhase('opening');
    try {
      await engine.setMicTesting(controller.signal, true);
      if (!controller.signal.aborted) await action(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setFeedback(message(error, '无法测试所选设备，请检查 Windows 音频和麦克风权限。'));
    } finally {
      await engine.setMicTesting(controller.signal, false);
      active.current = null;
      setPhase('idle');
    }
  }

  async function startRecording(signal: AbortSignal) {
    setSample(null);
    setPeak(floor);
    let stream: MediaStream | undefined;
    let processor: MicrophoneNoiseProcessor | undefined;
    let context: AudioContext | null = null;
    let frame = 0;
    try {
      if (preferences.noiseSuppression) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneOptions(preferences, false) });
        if (signal.aborted) return;
        const candidate = new MicrophoneNoiseProcessor();
        try {
          await candidate.init({ track: stream.getAudioTracks()[0] });
          processor = candidate;
        } catch {
          stream.getTracks().forEach(track => track.stop());
          stream = undefined;
        }
      }
      if (signal.aborted) return;
      stream ??= await navigator.mediaDevices.getUserMedia({ audio: microphoneOptions(preferences) });
      if (signal.aborted) return;
      const sampleStream = processor?.processedTrack ? new MediaStream([processor.processedTrack]) : stream;
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(sampleStream).connect(analyser);
      await context.resume();
      if (signal.aborted) return;
      const samples = new Float32Array(analyser.fftSize);
      let lastUpdate = 0;
      let max = floor;
      const meter = (now: number) => {
        if (signal.aborted) return;
        if (now - lastUpdate >= 75) {
          lastUpdate = now;
          analyser.getFloatTimeDomainData(samples);
          let square = 0, top = 0;
          for (const value of samples) {
            square += value * value;
            top = Math.max(top, Math.abs(value));
          }
          const rms = Math.sqrt(square / samples.length);
          setLevel(Math.round(Math.max(floor, 20 * Math.log10(rms))));
          max = Math.max(max, Math.round(20 * Math.log10(top)));
          setPeak(max);
        }
        frame = window.requestAnimationFrame(meter);
      };
      setPhase('recording');
      frame = window.requestAnimationFrame(meter);
      const recorded = await recordSample(sampleStream, signal);
      if (signal.aborted) return;
      if (!recorded.size) throw new Error('没有录到可播放的声音，请检查所选麦克风。');
      setSample(recorded);
      setFeedback(max <= -55 ? '输入电平很低，请检查麦克风是否静音。' : max >= -1 ? '输入接近满幅，可降低 Windows 麦克风音量。' : '录音完成，可以试听。');
    } finally {
      window.cancelAnimationFrame(frame);
      stream?.getTracks().forEach(track => track.stop());
      await processor?.destroy();
      if (context) await context.close().catch(() => {});
      setLevel(floor);
    }
  }

  async function playSample(signal: AbortSignal) {
    if (!sample) return;
    const url = URL.createObjectURL(sample);
    const audio = new Audio(url) as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    try {
      if (preferences.speakerId !== 'default') {
        if (!audio.setSinkId) throw new Error('当前运行时不支持切换试听设备，请使用 Windows 默认设备。');
        await audio.setSinkId(preferences.speakerId);
      }
      if (signal.aborted) return;
      setPhase('playing');
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal.removeEventListener('abort', finish); resolve(); };
        audio.onended = finish;
        audio.onerror = () => { signal.removeEventListener('abort', finish); reject(new Error('无法播放测试录音。')); };
        signal.addEventListener('abort', finish, { once: true });
        void audio.play().catch(() => {
          signal.removeEventListener('abort', finish);
          reject(new Error('无法从所选播放设备试听。'));
        });
      });
      if (!signal.aborted) setFeedback('试听完成。');
    } finally {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    }
  }

  return <section className="mic-check" aria-label="麦克风测试" data-testid="mic-check" data-phase={phase}>
    <div className="mic-meter">
      <strong>输入电平</strong><meter aria-label="麦克风输入电平" min={floor} max={0} low={-45} high={-6} optimum={-18} value={level} />
      <span data-testid="mic-peak">{peak > floor ? peak + ' dBFS 峰值' : '— dBFS'}</span>
    </div>
    <div className="mic-test-actions">
      <button className="button soft" type="button" data-testid="mic-record" disabled={phase !== 'idle'}
        onClick={() => void run(startRecording)}>{phase === 'recording' ? '录音中…' : '录制 4 秒'}</button>
      <button className="button soft" type="button" data-testid="mic-preview" disabled={!sample || phase !== 'idle'}
        onClick={() => void run(playSample)}>试听</button>
      {phase !== 'idle' && <button className="button soft" type="button" onClick={stop}>停止测试</button>}
    </div>
    <p className="muted-text" data-testid="mic-test-feedback">{feedback || '录音仅用于本机试听，测试期间暂停发送通话麦克风。'}</p>
  </section>;
}
