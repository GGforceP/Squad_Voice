import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { HeadphoneOff, MessageSquareOff, MicOff, ShieldCheck } from 'lucide-react';
import { message } from './native';
import type { MemberAction, MemberRole, RoomRules } from './native';
import type { Member } from './voice';

const titles = { owner: '总管理', recursive: '递归管理', channel: '频道管理' };
const restrictions = [
  { key: 'listenUntil', action: 'listen', name: '静音', release: '恢复收听', Icon: HeadphoneOff },
  { key: 'micUntil', action: 'mic', name: '闭麦', release: '解除闭麦', Icon: MicOff },
  { key: 'chatUntil', action: 'chat', name: '禁言', release: '解除禁言', Icon: MessageSquareOff },
] as const;

export function RoleBadge({ role }: { role?: MemberRole }) {
  return role && role !== 'member' ? <span className={'role-badge role-' + role} data-testid={'role-' + role}>{titles[role]}</span> : null;
}

export function canModerate(actor: MemberRole, member: Member) {
  if (member.self || member.role === 'owner') return false;
  if (actor === 'owner' || actor === 'recursive') return true;
  return actor === 'channel' && (member.role === 'member' || member.role === 'channel');
}

type Control = (action: MemberAction, enabled: boolean) => Promise<void>;

export function MemberMenu({ member, actor, x, y, control, close }: {
  member: Member; actor: MemberRole; x: number; y: number; control: Control; close: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [close]);
  async function apply(action: MemberAction, enabled: boolean) {
    setBusy(true); setError('');
    try { await control(action, enabled); close(); }
    catch (failure) { setError(message(failure, '未能更新成员状态，请重试。')); }
    finally { setBusy(false); }
  }
  const recursive = member.role === 'recursive';
  return <div className="member-menu-layer" onClick={event => { if (event.target === event.currentTarget) close(); }}
    onContextMenu={event => { event.preventDefault(); if (event.target === event.currentTarget) close(); }}>
    <div className="member-menu" ref={root} role="menu" aria-label={member.name + ' 的管理操作'} data-testid="member-menu"
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - 224)), top: Math.max(8, Math.min(y, window.innerHeight - 285)) }}>
      <header><strong>{member.name}</strong><RoleBadge role={member.role} /></header>
      {restrictions.map(({ key, action, name, release, Icon }) => {
        const enabled = Boolean(member.rules?.[key]);
        return <button key={key} type="button" role="menuitem" disabled={busy} data-testid={'member-action-' + action}
          onClick={() => void apply(action, !enabled)}><Icon size={16} />{enabled ? release : name}</button>;
      })}
      {!recursive && <button type="button" role="menuitem" disabled={busy} data-testid="member-action-channel-admin"
        onClick={() => void apply('channel-admin', !member.rules?.channelAdmin)}><ShieldCheck size={16} />{member.rules?.channelAdmin ? '撤销频道管理' : '分配频道管理'}</button>}
      {(actor === 'owner' || actor === 'recursive') && <button type="button" role="menuitem" disabled={busy} data-testid="member-action-recursive-admin"
        onClick={() => void apply('recursive-admin', !recursive)}><ShieldCheck size={16} />{recursive ? '撤销递归管理' : '分配递归管理'}</button>}
      {error && <p role="alert" className="form-error">{error}</p>}
    </div>
  </div>;
}

export function RoomRestrictions({ rules, now, release }: { rules: RoomRules; now: number; release: Control }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function unlock(action: MemberAction) {
    setBusy(true); setError('');
    try { await release(action, false); }
    catch (failure) { setError(message(failure, '暂时无法解除限制，请重试。')); }
    finally { setBusy(false); }
  }
  const items = restrictions.filter(item => rules[item.key]);
  return items.length > 0 ? <div className="room-restrictions" data-testid="room-restrictions" aria-label="管理员限制">
    {items.map(({ key, action, name, release, Icon }) => {
      const remaining = Math.max(0, Math.ceil((rules[key]! - now) / 1000));
      return <button key={key} type="button" className="restriction-chip" disabled={busy || remaining > 0} data-testid={'rule-' + action}
        onClick={() => void unlock(action)}><Icon size={14} />{remaining ? name + ' · ' + remaining + ' 秒后可解除' : release}</button>;
    })}
    {error && <span role="alert">{error}</span>}
  </div> : null;
}

const clamp = (value: number) => Math.min(85, Math.max(15, Math.round(value)));

export function ChannelSplit({ value, preview, commit }: { value: number; preview: (value: number | null) => void; commit: (value: number) => void }) {
  const ratioAt = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
    return clamp(100 * (event.clientY - bounds.top - 4) / Math.max(1, bounds.height - 8));
  };
  return <div className="room-split" data-testid="room-split" role="separator" tabIndex={0} aria-label="调整语音和聊天区域高度"
    aria-orientation="horizontal" aria-valuemin={15} aria-valuemax={85} aria-valuenow={value} title="上下拖动调整语音和聊天区域"
    onPointerDown={event => { if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) preview(ratioAt(event)); }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) commit(ratioAt(event)); }}
    onPointerCancel={() => preview(null)}
    onKeyDown={event => {
      const adjustment = event.key === 'ArrowDown' ? value + 5 : event.key === 'ArrowUp' ? value - 5 :
        event.key === 'Home' ? 15 : event.key === 'End' ? 85 : null;
      if (adjustment != null) { event.preventDefault(); commit(clamp(adjustment)); }
    }}><span /></div>;
}
