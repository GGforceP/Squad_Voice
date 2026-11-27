import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, ClipboardEvent, DragEvent } from 'react';
import { Check, Copy, Download, ImagePlus, Send, Smile, Trash2, X } from 'lucide-react';
import { NativeError, call, message, subscribe } from './native';
import type { MemberRole } from './native';
import { Avatar, RoleBadge } from './ChannelControls';
import { PhotoPreview } from './PhotoPreview';
import { imageLimit, imageTypes, originalImageLimit } from './imageLimits';
import { prepareChatImage } from './imageUpload';

type Item = {
  id: number; channelId: string; author: string; authorId: string; time: string; text: string;
  image?: string; imageSize?: number; imageGone?: boolean;
};
type Page = { tag: string; more: boolean; messages: Item[] };
export type ChatUpdate = { reset: boolean; events: { op: string; channelId: string; id?: number }[] };
const emoji = ['😀', '😂', '🤣', '🥹', '😅', '😎', '🤔', '😮', '😵', '😭', '👍', '👀', '👏', '💪', '🙏', '🔥', '🎉', '🎮', '💯', '❤️', '💤', '🫡', '🤝', '✅'];
const timeLabel = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });
const dateLabel = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });

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
      <button type="button" className="chat-photo" aria-label="查看大图" title="查看大图" onClick={() => setPreview(true)}>
        <img src={url} alt={item.author + ' 发送的图片'} data-testid="chat-image" onLoad={onLoad} />
      </button>
      {preview && <PhotoPreview url={url} author={item.author} id={item.id} channelId={item.channelId} close={() => setPreview(false)} />}
    </> :
      failure ? <button className="link-button" type="button" onClick={() => setAttempt(value => value + 1)}>{failure}</button> :
        <span>图片 · 正在加载</span>}
  </div>;
}

export function ChatPanel({ channelId, selfId, conversationName, direct, admin, ready, connectionError, restricted, roleFor }: {
  channelId: string; selfId: string; conversationName: string; direct?: boolean;
  admin: boolean; ready: boolean; connectionError: string; restricted: boolean; roleFor: (id: string) => MemberRole | undefined;
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
  const [compressing, setCompressing] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const [download, setDownload] = useState<number | null>(null);
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
  const sendJob = useRef<AbortController | null>(null);
  const copyTimer = useRef(0);
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
    return () => {
      mounted.current = false;
      sendJob.current?.abort();
      window.clearTimeout(retryDelay.current);
      window.clearTimeout(copyTimer.current);
    };
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
    if (file.size > originalImageLimit || file.size === 0) { setError('请选择不超过 50 MiB 的有效图片。'); return; }
    if (file.type && !imageTypes.includes(file.type)) {
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
    if (!canSend || sendJob.current || (!text.trim() && !image)) return;
    const job = new AbortController();
    sendJob.current = job;
    setSending(true);
    setError('');
    try {
      const nonce = retryKey.current || crypto.randomUUID();
      retryKey.current = nonce;
      const args: Record<string, unknown> = { channelId, text, nonce };
      if (image) {
        setCompressing(image.size > imageLimit);
        const prepared = await prepareChatImage(image, job.signal);
        if (job.signal.aborted) return;
        setCompressing(false);
        if (prepared !== image) setImage(prepared);
        args.image = await fileData(prepared);
        if (job.signal.aborted) return;
      }
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
    } finally {
      if (sendJob.current === job) sendJob.current = null;
      if (mounted.current) { setSending(false); setCompressing(false); }
    }
  }
  async function copy(row: Item) {
    try {
      if (!await call<boolean>('chat.copy', { text: row.text })) return;
      if (!mounted.current) return;
      setCopied(row.id);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(null), 1800);
    } catch (failure) { if (mounted.current) setError(message(failure, '复制失败，请重试。')); }
  }
  async function save(row: Item) {
    setDownload(row.id);
    try { await call('chat.download', { id: row.id, channelId }); }
    catch (failure) { if (mounted.current) setError(message(failure, '下载失败，请重试。')); }
    finally { if (mounted.current) setDownload(null); }
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

  return <section className="chat-pane" aria-label={direct ? '私信聊天' : '频道聊天'} data-testid="chat-pane">
    <div className="chat-history" ref={setScroller} data-testid="chat-history" tabIndex={0}
      onScroll={event => onScroll(event.currentTarget)}
      onWheel={event => { if (event.deltaY < 0 && event.currentTarget.scrollTop <= 12) { stickToEnd.current = false; void load(true); } }}
      onKeyDown={event => { if (['PageUp', 'Home', 'ArrowUp'].includes(event.key) && event.currentTarget.scrollTop <= 12) { stickToEnd.current = false; void load(true); } }}>
      {more && <button className="link-button chat-more" type="button" disabled={loading || !ready} onClick={() => { stickToEnd.current = false; void load(true); }}>查看更早的消息</button>}
      {loaded && items.length === 0 && <p className="chat-empty">还没有消息</p>}
      {!loaded && !error && <p className="chat-empty">{loading ? '正在加载消息' : offlineLabel(ready, connectionError)}</p>}
      {items.map((row, index) => {
        const mine = row.authorId === selfId;
        const date = dateLabel.format(new Date(row.time));
        const previous = items[index - 1];
        return <div className="chat-item" key={row.id}>
          {(!previous || dateLabel.format(new Date(previous.time)) !== date) && <div className="chat-date">{date}</div>}
          <article className={'chat-row' + (mine ? ' own' : '')} data-testid="chat-row" data-message-id={row.id}>
            <Avatar name={row.author} />
            <div className="chat-message">
              <div className="chat-meta"><span className="chat-author"><strong>{row.author}</strong><RoleBadge role={roleFor(row.authorId)} /></span>
                <time dateTime={row.time}>{timeLabel.format(new Date(row.time))}</time>
                <div className="chat-actions" aria-label="消息操作">
                {row.text && <button className="icon-button" type="button" aria-label={copied === row.id ? '已复制' : '复制文字'}
                  title={copied === row.id ? '已复制' : '复制文字'} data-testid="chat-copy" onClick={() => void copy(row)}>
                  {copied === row.id ? <Check size={14} /> : <Copy size={14} />}</button>}
                {row.image && <button className="icon-button" type="button" aria-label="下载图片" title="下载图片"
                  disabled={download !== null} onClick={() => void save(row)}><Download size={14} /></button>}
                {admin && <button className="icon-button chat-delete" type="button" aria-label="删除消息" title="删除消息"
                  data-testid="chat-delete" onClick={() => setConfirm(row.id)}><Trash2 size={14} /></button>}
                </div>
              </div>
              {row.text && <p className="chat-text">{row.text}</p>}
              {row.image && <Attachment item={row} scroller={scroller} onLoad={followNewImage} />}
              {row.imageGone && <small className="chat-image-gone">图片已被服务器清理</small>}
              {confirm === row.id && <div className="chat-confirm">从所有成员的记录中删除这条消息？
                <button type="button" className="button danger" data-testid="confirm-message-delete" onClick={() => void remove(row.id)}>删除</button>
                <button type="button" className="button soft" onClick={() => setConfirm(null)}>取消</button>
              </div>}
            </div>
          </article>
        </div>;
      })}
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
        <button className="icon-button" type="button" aria-label="添加图片" title="添加图片 · 超过 5 MiB 自动压缩" onClick={() => filePicker.current?.click()} disabled={!canSend || sending}><ImagePlus size={18} /></button>
        <button className="icon-button" type="button" aria-label="表情" title="表情" aria-expanded={picker && canSend} onClick={() => setPicker(!picker)} disabled={!canSend || sending}><Smile size={18} /></button>
        <textarea ref={input} rows={1} maxLength={2000} aria-label={direct ? '私信消息' : '频道消息'} data-testid="chat-text"
          placeholder={restricted ? '管理员已暂停你的发言' : direct ? '发私信给 ' + conversationName : '发消息到 #' + conversationName} disabled={!canSend || sending}
          value={text} onChange={event => updateText(event.target.value)} onPaste={paste}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <button className="button primary chat-send" type="submit" data-testid="chat-send" disabled={!canSend || sending || !(text.trim() || image)}><Send size={15} /> {compressing ? '压缩中' : sending ? '发送中' : '发送'}</button>
      </div>
    </form>
  </section>;
}

function offlineLabel(ready: boolean, error: string) {
  return !ready && !error ? <span>正在同步</span> : null;
}
