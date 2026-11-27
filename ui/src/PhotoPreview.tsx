import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import { call, message } from './native';

type Size = { width: number; height: number };
type View = { zoom: number; x: number; y: number };
const initialView = { zoom: 1, x: 0, y: 0 };
const margin = 22;
const header = 42;
const screen = (): Size => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
const clamp = (number: number, maximum: number) => Math.max(-maximum, Math.min(number, maximum));

function constrain(view: View, fit: Size, stageWidth: number): View {
  return { zoom: view.zoom,
    x: clamp(view.x, Math.max(0, (fit.width * view.zoom - stageWidth) / 2)),
    y: clamp(view.y, Math.max(0, fit.height * (view.zoom - 1) / 2)) };
}

export function PhotoPreview({ url, author, id, channelId, close }: {
  url: string; author: string; id: number; channelId: string; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const [viewport, setViewport] = useState(screen);
  const [natural, setNatural] = useState<Size | null>(null);
  const [view, setView] = useState<View>(initialView);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const availableWidth = Math.max(1, viewport.width - margin * 2 - 2);
  const availableHeight = Math.max(1, viewport.height - margin * 2 - header - 2);
  const ratio = natural ? Math.min(availableWidth / natural.width, availableHeight / natural.height) : 1;
  const width = natural ? Math.max(1, Math.floor(natural.width * ratio)) : Math.min(300, availableWidth);
  const height = natural ? Math.max(1, Math.floor(natural.height * ratio)) : Math.min(150, availableHeight);
  const frameWidth = Math.min(availableWidth, Math.max(152, width));

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const resize = () => setViewport(screen());
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      if (element?.open) element.close();
    };
  }, []);
  useLayoutEffect(() => {
    setView(value => constrain(value, { width, height }, frameWidth));
  }, [width, height, frameWidth]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const x = event.clientX - bounds.left - bounds.width / 2;
      const y = event.clientY - bounds.top - bounds.height / 2;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      setView(value => {
        const zoom = Math.max(1, Math.min(8, value.zoom * Math.exp(-delta * 0.0018)));
        const scale = zoom / value.zoom;
        return constrain({ zoom, x: x - (x - value.x) * scale, y: y - (y - value.y) * scale }, { width, height }, frameWidth);
      });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [width, height, frameWidth]);

  async function save() {
    setSaving(true);
    setError('');
    try { await call('chat.download', { id, channelId }); }
    catch (failure) { setError(message(failure, '下载失败，请重试。')); }
    finally { setSaving(false); }
  }
  function finishDrag() {
    pointer.current = null;
    setDragging(false);
  }

  return <dialog className="photo-preview" aria-label="图片预览" data-testid="photo-preview" ref={dialog}
    style={{ width: frameWidth + 2 }} onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="photo-viewer"><header><span title={author + ' 发送的图片'}>{author} 发送的图片</span>
      <div className="photo-actions">
        <button type="button" className="icon-button" aria-label="下载图片" title="下载图片" disabled={saving} data-testid="photo-download" onClick={() => void save()}><Download size={17} /></button>
        <button type="button" className="icon-button" aria-label="关闭图片" title="关闭图片" data-testid="photo-close" onClick={close}><X size={19} /></button>
      </div></header>
      <div ref={stage} className={'photo-stage' + (view.zoom > 1 ? ' is-zoomed' : '') + (dragging ? ' is-dragging' : '')}
        aria-label="滚轮缩放，放大后按住左键拖动" data-testid="photo-viewport" data-zoom={view.zoom.toFixed(3)}
        style={{ height }}
        onPointerDown={event => {
          if (event.button !== 0 || view.zoom <= 1) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
          setDragging(true);
        }}
        onPointerMove={event => {
          const previous = pointer.current;
          if (!previous || previous.id !== event.pointerId) return;
          const x = event.clientX - previous.x, y = event.clientY - previous.y;
          pointer.current = { id: previous.id, x: event.clientX, y: event.clientY };
          setView(value => constrain({ zoom: value.zoom, x: value.x + x, y: value.y + y }, { width, height }, frameWidth));
        }}
        onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}>
        <img src={url} alt={author + ' 发送的图片'} draggable={false}
          onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          style={{ width, height, transform: 'translate(-50%, -50%) translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.zoom + ')' }} />
        {view.zoom > 1 && <button type="button" className="photo-zoom" aria-label="还原预览尺寸" title="还原预览尺寸"
          onPointerDown={event => event.stopPropagation()} onClick={() => setView(initialView)}>{Math.round(view.zoom * 100)}%</button>}
        {error && <p className="photo-error" role="alert">{error}</p>}
      </div>
    </div>
  </dialog>;
}
