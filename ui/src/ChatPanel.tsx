import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, ClipboardEvent, DragEvent } from 'react';
import { ImagePlus, MessageCircle, Send, Smile, Trash2, X } from 'lucide-react';
import { NativeError, call, message, subscribe } from './native';

type Item = {
  id: number; channelId: string; author: string; authorId: string; time: string; text: string;
  image?: string; imageSize?: number; imageGone?: boolean;
};
type Page = { tag: string; more: boolean; messages: Item[] };
export type ChatUpdate = { reset: boolean; events: { op: string; channelId: string; id?: number }[] };
const fileLimit = 5 * 1024 * 1024;
const emoji = ['😀', '😂', '🤣', '🥹', '😅', '😎', '🤔', '😮', '😵', '😭', '👍', '👀', '👏', '💪', '🙏', '🔥', '🎉', '🎮', '💯', '❤️', '💤', '🫡', '🤝', '✅'];
const timeLabel = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function fileData(file: File): Promise<string> {
  return new Promise((done, reject) => {
    const reader = new FileReader();
    reader.onload = () => done(String(reader.result).split(',', 2)[1] || '');
    reader.onerror = () => reject(new Error('无法读取这张图片。'));
    reader.readAsDataURL(file);
  });
}

function Attachment({ item, scroller, onLoad }: { item: Item; scroller: HTMLDivElement | null; onLoad: () => void }) {
  const marker = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState('');
  const [failure, setFailure] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    if (!marker.current || !scroller || !item.image) return;
    let active = true;
    let objectUrl = '';
    setFailure('');
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void call<{ data: string }>('chat.image', { channelId: item.channelId, id: item.id }).then(result => {
        if (!active) return;
        const data = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
        objectUrl = URL.createObjectURL(new Blob([data], { type: item.image }));
        setUrl(objectUrl);
      }).catch(error => {
        if (active) setFailure(message(error, '图片未加载，点击重试。'));
      });
    }, { root: scroller });
    observer.observe(marker.current);
    return () => {
      active = false;
      observer.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl('');
    };
  }, [item.image, item.id, item.channelId, scroller, attempt]);
  return <div className="chat-attachment" ref={marker}>
    {url ? <>
      <button type="button" className="chat-photo" aria-label="双击查看大图" title="双击查看大图" onDoubleClick={() => setPreview(true)}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setPreview(true); } }}>
        <img src={url} alt={item.author + ' 发送的图片'} data-testid="chat-image" onLoad={onLoad} />
      </button>
      {preview && <PhotoPreview url={url} author={item.author} close={() => setPreview(false)} />}
    </> :
      failure ? <button className="link-button" type="button" onClick={() => setAttempt(value => value + 1)}>{failure}</button> :
        <span>图片 · 正在加载</span>}
  </div>;
}

function PhotoPreview({ url, author, close }: { url: string; author: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="photo-preview" aria-label="图片预览" data-testid="photo-preview" ref={dialog}
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="photo-viewer"><header><span>{author} 发送的图片</span>
      <button type="button" className="icon-button" aria-label="关闭图片" data-testid="photo-close" onClick={close}><X size={19} /></button></header>
      <img src={url} alt={author + ' 发送的原图'} />
    </div>
  </dialog>;
}

export function ChatPanel({ channelId, admin, ready, connectionError, restricted }: {
  channelId: string; admin: boolean; ready: boolean; connectionError: string; restricted: boolean;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [picker, setPicker] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const current = useRef<Item[]>([]);
  const requested = useRef(false);
  const refresh = useRef(false);
  const mounted = useRef(true);
  const stickToEnd = useRef(true);
  const restoreScroll = useRef<{ height: number; top: number } | null>(null);
  const loadedOnce = useRef(false);
  const retryKey = useRef('');
  const moreRef = useRef(false);
  const filtered = useRef(new Map<number, 'delete' | 'image'>());
  const retryDelay = useRef(0);
  const retryCount = useRef(0);
  const canSend = ready && !restricted;
  const entryLimit = useCallback(() => Math.max(2, Math.min(14, Math.floor((scroller?.clientHeight ?? 150) / 42) + 1)), [scroller]);

  const update = useCallback((next: Item[]) => {
    const allowed = next.flatMap(item => {
      const op = filtered.current.get(item.id);
      if (op === 'delete') return [];
      return [op === 'image' ? { ...item, image: undefined, imageGone: true } : item];
    });
    current.current = allowed;
    setItems(allowed);
  }, []);

  const load = useCallback(async (older = false) => {
    if (!ready || !mounted.current) return;
    if (requested.current) {
      if (!older) refresh.current = true;
      return;
    }
    const before = older ? current.current[0]?.id : 0;
    if (older && (!before || !moreRef.current)) return;
    requested.current = true;
    setLoading(true);
    try {
      const page = await call<Page>('chat.history', { channelId, before, limit: entryLimit() });
      if (!mounted.current) return;
      const previous = current.current;
      const incoming = page.messages ?? [];
      if (scroller && older) restoreScroll.current = { height: scroller.scrollHeight, top: scroller.scrollTop };
      const first = incoming[0]?.id;
      const hasOverlap = first != null && previous.some(row => row.id >= first);
      const keepOlder = !older && loadedOnce.current && page.more && hasOverlap;
      const combined = new Map((older ? previous : keepOlder ? previous.filter(row => row.id < first) : []).map(row => [row.id, row]));
      for (const row of incoming) combined.set(row.id, row);
      update([...combined.values()].sort((a, b) => a.id - b.id));
      if (!keepOlder || older) {
        moreRef.current = page.more;
        setMore(page.more);
      }
      setError('');
      retryCount.current = 0;
      loadedOnce.current = true;
      setLoaded(true);
    } catch (failure) {
      if (mounted.current && !older && failure instanceof NativeError &&
          (failure.code === 'join_voice_for_chat' || failure.code === 'cache_changed') && retryCount.current < 4) {
        retryCount.current++;
        window.clearTimeout(retryDelay.current);
        retryDelay.current = window.setTimeout(() => void load(), 750);
      } else if (mounted.current) setError(message(failure, '无法加载聊天记录。'));
    } finally {
      requested.current = false;
      if (mounted.current) setLoading(false);
      if (refresh.current && mounted.current) {
        refresh.current = false;
        void load();
      }
    }
  }, [ready, channelId, scroller, update, entryLimit]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; window.clearTimeout(retryDelay.current); };
  }, []);
  useEffect(() => {
    if (ready && scroller) void load();
  }, [ready, scroller, load]);
  useEffect(() => subscribe<ChatUpdate>('chat.update', change => {
    let changed = change.reset;
    let invalidated = change.reset;
    if (change.reset) {
      filtered.current.clear();
      loadedOnce.current = false;
      update([]);
    }
    for (const event of change.events ?? []) {
      if (event.channelId !== channelId) continue;
      changed = true;
      if (event.op === 'delete' || event.op === 'image') {
        filtered.current.set(event.id!, event.op);
        invalidated = true;
      }
      if (event.op === 'channel') {
        filtered.current.clear();
        loadedOnce.current = false;
        update([]);
      }
    }
    if (invalidated) update(current.current);
    if (changed) void load();
  }), [channelId, load, update]);

  useLayoutEffect(() => {
    if (!scroller) return;
    const restore = restoreScroll.current;
    restoreScroll.current = null;
    if (restore) scroller.scrollTop = restore.top + scroller.scrollHeight - restore.height;
    else if (stickToEnd.current) scroller.scrollTop = scroller.scrollHeight;
  }, [items, scroller]);

  function updateText(value: string) { setText(value.slice(0, 2000)); retryKey.current = ''; }
  function choose(file?: File) {
    if (!file) return;
    if (file.size > fileLimit || file.size === 0) { setError('图片大小需在 5 MB 以内。'); return; }
    if (file.type && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
      setError('请选择 PNG、JPEG、GIF 或 WebP 图片。'); return;
    }
    setImage(file);
    retryKey.current = '';
    setError('');
  }
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file = [...event.clipboardData.files].find(item => item.type.startsWith('image/'));
    if (file) { event.preventDefault(); choose(file); }
  }
  function drop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSend && !sending) choose(event.dataTransfer.files[0]);
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!canSend || sending || (!text.trim() && !image)) return;
    setSending(true);
    setError('');
    try {
      const nonce = retryKey.current || crypto.randomUUID();
      retryKey.current = nonce;
      const args: Record<string, unknown> = { channelId, text, nonce };
      if (image) args.image = await fileData(image);
      const sent = await call<Item>('chat.send', args);
      if (!mounted.current) return;
      stickToEnd.current = true;
      update([...current.current.filter(row => row.id !== sent.id), sent].sort((a, b) => a.id - b.id));
      updateText('');
      setImage(null);
      setPicker(false);
      input.current?.focus();
    } catch (failure) {
      if (mounted.current) setError(message(failure, '消息发送失败，请重试。'));
    } finally { if (mounted.current) setSending(false); }
  }
  async function remove(id: number) {
    try {
      await call('chat.delete', { channelId, id });
      filtered.current.set(id, 'delete');
      update(current.current);
      setConfirm(null);
    } catch (failure) { setError(message(failure, '无法删除这条消息。')); }
  }
  function onScroll(element: HTMLDivElement) {
    stickToEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 30;
  }
  function followNewImage() {
    if (scroller && stickToEnd.current) scroller.scrollTop = scroller.scrollHeight;
  }
  function addEmoji(value: string) {
    const position = input.current?.selectionStart ?? text.length;
    const end = input.current?.selectionEnd ?? position;
    updateText(text.slice(0, position) + value + text.slice(end));
    setPicker(false);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(position + value.length, position + value.length); });
  }

  return <section className="chat-pane" aria-label="频道聊天" data-testid="chat-pane">
    <header className="chat-heading"><MessageCircle size={16} /><strong>频道聊天</strong>
      {loading && <span>正在加载</span>}{offlineLabel(ready, connectionError)}
    </header>
    <div className="chat-history" ref={setScroller} data-testid="chat-history" tabIndex={0}
      onScroll={event => onScroll(event.currentTarget)}
      onWheel={event => { if (event.deltaY < 0 && event.currentTarget.scrollTop <= 12) { stickToEnd.current = false; void load(true); } }}
      onKeyDown={event => { if (['PageUp', 'Home', 'ArrowUp'].includes(event.key) && event.currentTarget.scrollTop <= 12) { stickToEnd.current = false; void load(true); } }}>
      {more && <button className="link-button chat-more" type="button" disabled={loading || !ready} onClick={() => { stickToEnd.current = false; void load(true); }}>查看更早的消息</button>}
      {loaded && items.length === 0 && <p className="chat-empty">还没有消息</p>}
      {items.map(row => <article className="chat-row" data-testid="chat-row" data-message-id={row.id} key={row.id}>
        <div className="chat-meta"><strong>{row.author}</strong><time dateTime={row.time}>{timeLabel.format(new Date(row.time))}</time>
          {admin && <button className="icon-button chat-delete" type="button" aria-label="删除消息" title="删除消息" data-testid="chat-delete" onClick={() => setConfirm(row.id)}><Trash2 size={14} /></button>}
        </div>
        {row.text && <p>{row.text}</p>}
        {row.image && <Attachment item={row} scroller={scroller} onLoad={followNewImage} />}
        {row.imageGone && <small className="chat-image-gone">图片已被服务器清理</small>}
        {confirm === row.id && <div className="chat-confirm">从所有成员的记录中删除这条消息？
          <button type="button" className="button danger" data-testid="confirm-message-delete" onClick={() => void remove(row.id)}>删除</button>
          <button type="button" className="button soft" onClick={() => setConfirm(null)}>取消</button>
        </div>}
      </article>)}
    </div>
    {(error || (!ready && connectionError)) && <div className="chat-error" role="alert">{error || connectionError}
      {error && !loaded && <button type="button" className="link-button" onClick={() => void load()}>重试</button>}</div>}
    <form className="chat-composer" onSubmit={send} onDragOver={event => event.preventDefault()} onDrop={drop}>
      {image && <div className="chat-file"><span>{image.name}</span><button className="icon-button" type="button" aria-label="移除图片" disabled={sending} onClick={() => { setImage(null); retryKey.current = ''; }}><X size={15} /></button></div>}
      {picker && canSend && <div className="emoji-picker" role="group" aria-label="选择表情">{emoji.map(value =>
        <button key={value} type="button" onClick={() => addEmoji(value)}>{value}</button>)}</div>}
      <input hidden ref={filePicker} type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-testid="chat-file"
        onChange={event => { choose(event.target.files?.[0]); event.target.value = ''; }} />
      <div className="chat-entry">
        <button className="icon-button" type="button" aria-label="添加图片，最大 5 MB" title="图片 · 最大 5 MB" onClick={() => filePicker.current?.click()} disabled={!canSend || sending}><ImagePlus size={18} /></button>
        <button className="icon-button" type="button" aria-label="表情" title="表情" aria-expanded={picker && canSend} onClick={() => setPicker(!picker)} disabled={!canSend || sending}><Smile size={18} /></button>
        <textarea ref={input} rows={1} maxLength={2000} aria-label="频道消息" data-testid="chat-text" placeholder={restricted ? '管理员已暂停你的发言' : '发送消息'} disabled={!canSend || sending}
          value={text} onChange={event => updateText(event.target.value)} onPaste={paste}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <button className="button primary chat-send" type="submit" data-testid="chat-send" disabled={!canSend || sending || !(text.trim() || image)}><Send size={15} /> {sending ? '发送中' : '发送'}</button>
      </div>
    </form>
  </section>;
}

function offlineLabel(ready: boolean, error: string) {
  return !ready && !error ? <span>正在同步</span> : null;
}
