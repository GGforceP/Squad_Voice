import { useEffect, useRef, useState } from 'react';
import { Crown, GitFork, HeadphoneOff, MessageSquareOff, MicOff, ShieldCheck } from 'lucide-react';
import { message } from './native';
import type { MemberAction, MemberRole, RoomRules } from './native';
import type { Member } from './voice';

const badges = {
  owner: { title: '总管理', detail: '可管理工作区、频道和权限', Icon: Crown },
  recursive: { title: '递归管理', detail: '可管理频道并委派管理权限', Icon: GitFork },
  channel: { title: '频道管理', detail: '权限仅在获授权的子频道内生效', Icon: ShieldCheck },
};
const colors = ['violet', 'sky', 'amber', 'sage', 'rose'];
const restrictions = [
  { key: 'listenUntil', action: 'listen', name: '静音', release: '恢复收听', Icon: HeadphoneOff },
  { key: 'micUntil', action: 'mic', name: '闭麦', release: '解除闭麦', Icon: MicOff },
  { key: 'chatUntil', action: 'chat', name: '禁言', release: '解除禁言', Icon: MessageSquareOff },
] as const;

export function RoleBadge({ role }: { role?: MemberRole }) {
  if (!role || role === 'member') return null;
  const { title, detail, Icon } = badges[role];
  return <span className={'role-badge role-' + role} data-testid={'role-' + role} role="img" aria-label={title}
    title={title + ' · ' + detail}><Icon size={12} aria-hidden="true" /></span>;
}

export function Avatar({ name, index, speaking = false, className = '' }: { name: string; index?: number; speaking?: boolean; className?: string }) {
  const trimmed = name.trim();
  const letter = trimmed.codePointAt(0) ?? 0;
  const initials = [...trimmed].slice(0, letter > 127 ? 1 : 2).join('').toUpperCase() || '队';
  return <span className={'avatar ' + colors[(index ?? letter) % colors.length] + (speaking ? ' is-speaking' : '') + ' ' + className}
    aria-hidden="true">{initials}</span>;
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
