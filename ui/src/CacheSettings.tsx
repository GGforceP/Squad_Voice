import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { FolderOpen, HardDrive, Trash2 } from 'lucide-react';
import { call, message } from './native';

type Usage = {
  path: string; encrypted: boolean; messages: number; images: number; webView: number;
  driveTotal: number; driveFree: number; defaultLocation: boolean;
};

function size(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function CacheSettings({ connected, close }: { connected: boolean; close: () => void }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [encrypted, setEncrypted] = useState(true);
  const [target, setTarget] = useState('');
  const [defaultLocation, setDefaultLocation] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void call<Usage>('cache.usage').then(result => {
      if (active) { setUsage(result); setEncrypted(result.encrypted); }
    }).catch(failure => { if (active) setError(message(failure, '无法读取缓存空间。')); });
    return () => { active = false; };
  }, []);
  async function browse() {
    try {
      const path = await call<string | null>('cache.pick');
      if (path) { setTarget(path); setDefaultLocation(false); setConfirm(false); }
    } catch (failure) { setError(message(failure, '无法选择缓存目录。')); }
  }
  async function save(clear: boolean) {
    if (busy) return;
    setError('');
    setBusy(true);
    try { await call('cache.apply', { location: clear ? '' : target, encrypted, clear, defaultLocation: !clear && defaultLocation }); }
    catch (failure) { setBusy(false); setError(message(failure, '无法保存缓存设置。')); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void save(false); }
  if (!usage) return error ? <p className="form-error" role="alert">{error}</p> : <p className="muted-text">正在统计缓存…</p>;
  const total = usage.messages + usage.images;
  const allUsed = Math.min(100, Math.max(0, 100 * (usage.driveTotal - usage.driveFree) / Math.max(usage.driveTotal, 1)));
  const cacheUsed = Math.min(allUsed, 100 * total / Math.max(usage.driveTotal, 1));

  return <form className="modal-form cache-settings" onSubmit={submit} data-testid="cache-settings">
    <div className="cache-usage-card">
      <div className="cache-usage-heading"><HardDrive size={18} /><strong>聊天缓存</strong><span data-testid="cache-total">{size(total)}</span></div>
      <div className="cache-drive" role="meter" aria-label="缓存所在磁盘使用率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(allUsed)}>
        <span className="cache-drive-used" style={{ width: allUsed + '%' }} />
        {total > 0 && <span className="cache-drive-squad" style={{ width: Math.max(cacheUsed, 0.6) + '%' }} />}
      </div>
      {usage.driveTotal > 0 && <p>可用 {size(usage.driveFree)}，总容量 {size(usage.driveTotal)}</p>}
      <dl className="cache-stats"><dt>聊天记录</dt><dd>{size(usage.messages)}</dd><dt>图片</dt><dd>{size(usage.images)}</dd><dt>WebView2 运行数据</dt><dd>{size(usage.webView)}</dd></dl>
      <div className="cache-location" title={usage.path}>{usage.path}</div>
    </div>
    <label className="toggle-label"><span><strong>加密聊天缓存</strong><small>使用当前 Windows 用户的 DPAPI。</small></span>
      <input type="checkbox" data-testid="cache-encrypted" checked={encrypted} onChange={event => setEncrypted(event.target.checked)} disabled={busy} /></label>
    <button className="button soft cache-browse" type="button" onClick={() => void browse()} disabled={busy}><FolderOpen size={16} /> 迁移聊天缓存</button>
    {!usage.defaultLocation && <button className="link-button cache-browse" type="button" disabled={busy} onClick={() => { setTarget(''); setDefaultLocation(true); }}>恢复安装目录默认位置</button>}
    {target && <div className="cache-location" title={target}>{target}<button className="link-button" type="button" onClick={() => setTarget('')} disabled={busy}>取消迁移</button></div>}
    {defaultLocation && <div className="cache-location">目标为安装目录<button className="link-button" type="button" onClick={() => setDefaultLocation(false)} disabled={busy}>取消迁移</button></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {confirm && <p className="muted-text">清除本机文字和图片缓存？再次进频道后可从服务器重新加载。</p>}
    {connected && <p className="muted-text">保存后会重启客户端，当前通话将断开。</p>}
    <div className="modal-actions settings-actions">
      <button className={confirm ? 'button danger' : 'link-button'} type="button" data-testid="clear-cache" disabled={busy} onClick={() => confirm ? void save(true) : setConfirm(true)}>
        <Trash2 size={15} /> {confirm ? '清除并重启' : '清除缓存'}</button>
      <button className="button soft" type="button" onClick={close} disabled={busy}>关闭</button>
      <button className="button primary" type="submit" data-testid="save-cache" disabled={busy || (!target && !defaultLocation && encrypted === usage.encrypted)}>{busy ? '处理中…' : '保存并重启'}</button>
    </div>
  </form>;
}
