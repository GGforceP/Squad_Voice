import { imageLimit, originalImageLimit } from './imageLimits';

type Dimensions = { width: number; height: number };
type ImageInfo = Dimensions & { mime: string; alpha: boolean; animated: boolean };
const canvasLimit = 8192;
const pixelLimit = 40_000_000;
const invalidImage = '无法读取这张图片，请选择有效的 JPEG、PNG、GIF 或 WebP 文件。';
const worker = self as unknown as { onmessage: ((event: MessageEvent<File>) => void) | null; postMessage(data: unknown): void };
const chars = (bytes: Uint8Array, at: number, size: number) => String.fromCharCode(...bytes.subarray(at, at + size));
const read24 = (bytes: Uint8Array, at: number) => bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16;

function inspect(bytes: Uint8Array): ImageInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 26 && bytes[0] === 137 && chars(bytes, 1, 3) === 'PNG' && chars(bytes, 12, 4) === 'IHDR') {
    const info = { mime: 'image/png', width: view.getUint32(16), height: view.getUint32(20), alpha: [4, 6].includes(bytes[25]), animated: false };
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const type = chars(bytes, offset + 4, 4);
      if (type === 'IDAT' || type === 'IEND') break;
      if (type === 'tRNS') info.alpha = true;
      if (type === 'acTL') info.animated = true;
      offset += 12 + view.getUint32(offset);
    }
    return info;
  }
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(chars(bytes, 0, 6))) {
    return { mime: 'image/gif', width: view.getUint16(6, true), height: view.getUint16(8, true), alpha: true, animated: true };
  }
  if (bytes.length >= 20 && chars(bytes, 0, 4) === 'RIFF' && chars(bytes, 8, 4) === 'WEBP') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = chars(bytes, offset, 4);
      const size = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (start + size > bytes.length) break;
      if (type === 'VP8X' && size === 10) {
        return { mime: 'image/webp', width: read24(bytes, start + 4) + 1, height: read24(bytes, start + 7) + 1,
          alpha: (bytes[start] & 16) !== 0, animated: (bytes[start] & 2) !== 0 };
      }
      if (type === 'VP8L' && size >= 5 && bytes[start] === 47) {
        const dimension = view.getUint32(start + 1, true);
        return { mime: 'image/webp', width: (dimension & 16383) + 1, height: ((dimension >>> 14) & 16383) + 1,
          alpha: (dimension & (1 << 28)) !== 0, animated: false };
      }
      if (type === 'VP8 ' && size >= 10) {
        return { mime: 'image/webp', width: view.getUint16(start + 6, true) & 16383, height: view.getUint16(start + 8, true) & 16383,
          alpha: false, animated: false };
      }
      offset = start + size + (size & 1);
    }
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset < bytes.length && bytes[offset++] === 255) {
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && size >= 7) {
        return { mime: 'image/jpeg', width: view.getUint16(offset + 5), height: view.getUint16(offset + 3), alpha: false, animated: false };
      }
      offset += size;
    }
  }
  throw new Error(invalidImage);
}

function scaled(dimensions: Dimensions, factor: number): Dimensions {
  return { width: Math.max(1, Math.floor(dimensions.width * factor)), height: Math.max(1, Math.floor(dimensions.height * factor)) };
}

async function renderStill(image: CanvasImageSource, original: Dimensions, type: string): Promise<Blob> {
  const canvas = new OffscreenCanvas(original.width, original.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法加速读取图片。');
  context.drawImage(image, 0, 0);
  let result: Blob;
  for (const quality of [0.9, 0.82, 0.72]) {
    result = await canvas.convertToBlob({ type, quality });
    if (result.size <= imageLimit && result.type === type) return result;
  }
  let factor = 1;
  for (let attempt = 0; attempt < 2; attempt++) {
    factor *= Math.max(0.45, Math.min(0.88, Math.sqrt(imageLimit / result!.size) * 0.92));
    const { width, height } = scaled(original, factor);
    canvas.width = width;
    canvas.height = height;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    result = await canvas.convertToBlob({ type, quality: 0.82 });
    if (result.size <= imageLimit && result.type === type) return result;
  }
  throw new Error('无法将图片压缩到 5 MiB 以内。');
}

type ImageTrack = { frameCount: number; repetitionCount: number };
type FrameDecoder = {
  tracks: { ready: Promise<void>; selectedTrack: ImageTrack | null };
  completed: Promise<void>;
  decode(options: { frameIndex: number }): Promise<{ image: VideoFrame }>;
  close(): void;
};
type DecoderClass = {
  new(options: { data: ReadableStream<Uint8Array>; type: string; preferAnimation: boolean }): FrameDecoder;
  isTypeSupported(type: string): Promise<boolean>;
};

const put24 = (target: Uint8Array, at: number, value: number) => {
  target[at] = value & 255;
  target[at + 1] = (value >> 8) & 255;
  target[at + 2] = (value >> 16) & 255;
};

function riffHeader(name: string, length: number) {
  const header = new Uint8Array(8);
  header.set(new TextEncoder().encode(name));
  new DataView(header.buffer).setUint32(4, length, true);
  return header;
}

// WebP animation stores independently encoded frame bitstreams in ANMF chunks.
// Each frame here replaces the entire canvas, preserving decoded transparency.
function webpFrame(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let alpha = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = chars(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size + (size & 1);
    if (end > bytes.length) throw new Error(invalidImage);
    if (type === 'ALPH' || type === 'VP8 ' || type === 'VP8L') parts.push(bytes.subarray(offset, end));
    if (type === 'ALPH' || type === 'VP8L' && size >= 5 && (bytes[offset + 12] & 16) !== 0) alpha = true;
    offset = end;
  }
  if (parts.length === 0) throw new Error(invalidImage);
  return { parts, alpha };
}

async function encodeAnimation(decoder: FrameDecoder, track: ImageTrack, size: Dimensions, quality: number) {
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error(invalidImage);
  context.imageSmoothingQuality = 'high';
  const chunks: BlobPart[] = [];
  let length = 44;
  let alpha = false;
  for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
    const { image } = await decoder.decode({ frameIndex });
    const duration = Math.min(0xffffff, Math.max(1, Math.round((image.duration ?? 100_000) / 1000)));
    try {
      context.clearRect(0, 0, size.width, size.height);
      context.drawImage(image, 0, 0, size.width, size.height);
    } finally { image.close(); }
    const still = await canvas.convertToBlob({ type: 'image/webp', quality });
    if (still.type !== 'image/webp') throw new Error('此系统的图片组件不支持 WebP 编码。');
    const frame = webpFrame(await still.arrayBuffer());
    alpha ||= frame.alpha;
    const header = new Uint8Array(16);
    put24(header, 6, size.width - 1);
    put24(header, 9, size.height - 1);
    put24(header, 12, duration);
    header[15] = 2;
    const sizeOfFrame = 16 + frame.parts.reduce((sum, part) => sum + part.length, 0);
    length += 8 + sizeOfFrame;
    if (length > imageLimit) return null;
    chunks.push(riffHeader('ANMF', sizeOfFrame), header, ...frame.parts);
  }
  const extended = new Uint8Array(10);
  extended[0] = 2 | (alpha ? 16 : 0);
  put24(extended, 4, size.width - 1);
  put24(extended, 7, size.height - 1);
  const animation = new Uint8Array(6);
  const loops = Number.isFinite(track.repetitionCount) ? Math.max(1, Math.min(65535, track.repetitionCount + 1)) : 0;
  new DataView(animation.buffer).setUint16(4, loops, true);
  return new Blob([riffHeader('RIFF', length - 8), 'WEBP', riffHeader('VP8X', 10), extended,
    riffHeader('ANIM', 6), animation, ...chunks], { type: 'image/webp' });
}

async function renderAnimated(file: File, info: ImageInfo) {
  const Decoder = (self as unknown as { ImageDecoder?: DecoderClass }).ImageDecoder;
  if (!Decoder || !await Decoder.isTypeSupported(info.mime)) throw new Error('此系统无法在保留动画的情况下压缩该图片。');
  const decoder = new Decoder({ data: file.stream(), type: info.mime, preferAnimation: true });
  try {
    await decoder.tracks.ready;
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    if (!track?.frameCount) throw new Error(invalidImage);
    if (track.frameCount === 1) {
      const { image } = await decoder.decode({ frameIndex: 0 });
      try { return await renderStill(image, info, 'image/webp'); }
      finally { image.close(); }
    }
    const factor = Math.min(1, Math.sqrt(72_000_000 / (info.width * info.height * track.frameCount)));
    const result = await encodeAnimation(decoder, track, scaled(info, factor), 0.85) ??
      await encodeAnimation(decoder, track, scaled(info, factor * 0.68), 0.72);
    if (!result) throw new Error('无法在保留动画的情况下压缩到 5 MiB 以内，请选择较短的动图。');
    return result;
  } finally { decoder.close(); }
}

async function prepare(file: File) {
  if (!file.size || file.size > originalImageLimit) throw new Error('请选择不超过 50 MiB 的图片。');
  const info = inspect(new Uint8Array(await file.arrayBuffer()));
  if (info.width < 1 || info.height < 1 || info.width > canvasLimit || info.height > canvasLimit || info.width * info.height > pixelLimit) {
    throw new Error('图片长边需在 8192 像素以内，总像素需在 4000 万以内。');
  }
  let result: Blob;
  if (info.animated) result = await renderAnimated(file, info);
  else {
    const image = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try { result = await renderStill(image, image, info.alpha ? 'image/webp' : 'image/jpeg'); }
    finally { image.close(); }
  }
  const extension = result.type === 'image/webp' ? '.webp' : '.jpg';
  return new File([result], file.name.replace(/\.[^.]+$/, '') + extension, { type: result.type });
}

worker.onmessage = ({ data }) => {
  void prepare(data).then(file => worker.postMessage({ file })).catch(error =>
    worker.postMessage({ error: error instanceof Error ? error.message : invalidImage }));
};
