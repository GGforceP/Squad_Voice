import { imageLimit } from './imageLimits';

let queue: Promise<unknown> = Promise.resolve();

export function prepareChatImage(file: File, signal: AbortSignal): Promise<File> {
  if (file.size <= imageLimit) return Promise.resolve(file);
  const job = queue.then(() => {
    signal.throwIfAborted();
    return new Promise<File>((resolve, reject) => {
      const worker = new Worker(new URL('./imageWorker.ts', import.meta.url), { type: 'module' });
      const cleanup = () => {
        worker.terminate();
        window.clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
      };
      const cancel = () => { cleanup(); reject(signal.reason); };
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('图片压缩超时，请选择尺寸或帧数更少的图片。'));
      }, 45000);
      signal.addEventListener('abort', cancel, { once: true });
      worker.onmessage = ({ data }: MessageEvent<{ file?: File; error?: string }>) => {
        cleanup();
        if (data.file) resolve(data.file);
        else reject(new Error(data.error || '无法将图片压缩到 5 MiB 以内。'));
      };
      worker.onerror = () => { cleanup(); reject(new Error('图片压缩暂不可用。')); };
      worker.postMessage(file);
    });
  });
  queue = job.catch(() => {});
  return job;
}
