import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, MouseEvent, ReactNode } from 'react';
import {
  ArrowRight, AudioLines, Check, ChevronDown, ChevronRight, CircleHelp, Download, Headphones, HeadphoneOff, KeyRound,
  LoaderCircle, LockKeyhole, LogOut, Mic, MicOff, MonitorSpeaker, Music2, PhoneOff, Plus, RefreshCw, Settings,
  ShieldCheck, SlidersHorizontal, UserRound, Users, Volume2, Wifi, X,
} from 'lucide-react';
import { call, initialPreferences, isDesktop, message, NativeError, subscribe } from './native';
import type { Account, Bootstrap, Channel, Defaults, Identity, MemberAction, MemberRole, Preferences, RememberedLogin, RoomRules, UpdateState, Workspace } from './native';
import { VoiceEngine } from './voice';
import { MicCheck } from './MicCheck';
import { ChatPanel } from './ChatPanel';
import { CacheSettings } from './CacheSettings';
import { canModerate, ChannelSplit, MemberMenu, RoleBadge, RoomRestrictions } from './ChannelControls';
import type { AudioApp, Member, VoiceState } from './voice';

const nativeBlank: Bootstrap = { configured: false, profileError: false, version: '0.5.0', devices: { microphone: null, speaker: null }, preferences: initialPreferences, accompanimentSupported: false };
const noRules: RoomRules = {};
const noUpdate: UpdateState = { status: 'none', version: '', required: false };
const colors = ['violet', 'sky', 'amber', 'sage', 'rose'];
const initials = (value: string) => [...value.trim()].slice(0, value.charCodeAt(0) > 127 ? 1 : 2).join('').toUpperCase() || '队';
const clock = (seconds: number) => String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
const qualityLabel: Record<string, string> = { excellent: '连接良好', good: '连接正常', poor: '连接不稳', lost: '连接中断', unknown: '正在检测' };

function IconButton({ label, children, onClick, disabled, className = '', test, pressed }: {
  label: string; children: ReactNode; onClick: () => void; disabled?: boolean; className?: string; test?: string; pressed?: boolean;
}) {
  return <button type="button" className={'icon-button ' + className} aria-label={label} title={label} data-testid={test} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{children}</button>;
}
function Logo({ small = false }: { small?: boolean }) {
  return <span className={'logo ' + (small ? 'logo-small' : '')} aria-hidden="true"><AudioLines strokeWidth={2.35} /></span>;
}
function Avatar({ name, index = 0, speaking = false, className = '' }: { name: string; index?: number; speaking?: boolean; className?: string }) {
  return <span className={'avatar ' + colors[index % colors.length] + (speaking ? ' is-speaking' : '') + ' ' + className} aria-hidden="true">{initials(name)}</span>;
}
function Modal({ label, subtitle, icon, children, close }: { label: string; subtitle?: string; icon: ReactNode; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => { if (ref.current?.open) ref.current.close(); }; }, []);
  return <dialog ref={ref} aria-label={label} className="modal" onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="modal-body">
      <header className="modal-heading"><span className="modal-icon">{icon}</span><div><h2>{label}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton label="关闭" onClick={close}><X /></IconButton></header>
      {children}
    </div>
  </dialog>;
}

export function App() {
  const [engine] = useState(() => new VoiceEngine());
  const [voice, setVoice] = useState<VoiceState>(engine.state);
  const [boot, setBoot] = useState<Bootstrap>(nativeBlank);
  const [ready, setReady] = useState(!isDesktop);
  const [account, setAccount] = useState<Account | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [rememberLogin, setRememberLogin] = useState(true);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [loginNotice, setLoginNotice] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cacheOpen, setCacheOpen] = useState(false);
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [chatReady, setChatReady] = useState(false);
  const [chatError, setChatError] = useState('');
  const [musicOpen, setMusicOpen] = useState(false);
  const [roster, setRoster] = useState(true);
  const [memberMenu, setMemberMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const dismissMemberMenu = useCallback(() => setMemberMenu(null), []);
  const [draggedSplit, setDraggedSplit] = useState<number | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateState>(noUpdate);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [skippedUpdate, setSkippedUpdate] = useState('');
  const [volumeFor, setVolumeFor] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [showHelp, setShowHelp] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioApps, setAudioApps] = useState<AudioApp[]>([]);
  const [audioApp, setAudioApp] = useState<AudioApp | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const previousDefaults = useRef<Defaults>(nativeBlank.devices);

  useEffect(() => {
    const unsubscribe = engine.onChange(setVoice);
    if (isDesktop) void call<Bootstrap>('app.bootstrap').then(value => {
      const { account: restoredAccount, remembered, loginError: startupError, ...startup } = value;
      setBoot(startup);
      previousDefaults.current = startup.devices;
      void engine.setPreferences(startup.preferences);
      if (restoredAccount) {
        setSelectedId(restoredAccount.workspace.channels[0]?.id ?? null);
        setAccount(restoredAccount);
      } else if (remembered) {
        setLoginName(remembered.username);
        setPassword(remembered.password);
      }
      if (startup.profileError) setLoginError('之前的接入配置无法读取，请重新设置。');
      else if (startupError) setLoginError(startupError);
    }).catch(() => setLoginError('无法读取 Windows 客户端配置。')).finally(() => setReady(true));
    if (import.meta.env.MODE === 'qa') {
      (window as Window & { squadVoiceStats?: () => Promise<unknown> }).squadVoiceStats = () => engine.inspectForLab();
    }
    return () => { unsubscribe(); void engine.dispose(); };
  }, [engine]);

  const accountId = account?.user.id;
  useEffect(() => {
    if (!accountId) return;
    let active = true;
    let timer = 0;
    const onUpdate = subscribe('chat.update', () => { setChatReady(true); setChatError(''); });
    const onOffline = subscribe<string>('chat.offline', error => { setChatReady(false); setChatError(error); });
    const onExpired = subscribe('account.expired', () => void logout('登录已失效，请重新登录。'));
    const onClientUpdate = subscribe<UpdateState>('update.state', setUpdateInfo);
    void call('chat.connect').catch(() => {});
    void call<UpdateState>('update.check').then(result => { if (active) setUpdateInfo(result); }).catch(() => {});
    const refresh = async () => {
      try {
        const result = await call<Workspace>('workspace.state');
        if (active) setWorkspace(result);
      } catch (failure) {
        if (failure instanceof NativeError && failure.code === 'not_found') return;
      }
      if (active) timer = window.setTimeout(refresh, 2200);
    };
    void refresh();
    return () => {
      active = false;
      window.clearTimeout(timer);
      onUpdate(); onOffline(); onExpired(); onClientUpdate();
    };
  }, [accountId]);

  useEffect(() => {
    if (!workspace) return;
    setSelectedId(id => workspace.channels.some(channel => channel.id === id) ? id : workspace.channels[0]?.id ?? null);
    const current = engine.state.channelId;
    if (current && !workspace.channels.some(channel => channel.id === current)) void engine.leave();
  }, [workspace, engine]);

  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);

  useEffect(() => {
    if (!isDesktop) return;
    let running = true;
    let refreshTimer = 0;
    const refresh = async (changed: boolean) => {
      try {
        const [value, list] = await Promise.all([
          call<Defaults>('devices.defaults'),
          navigator.mediaDevices?.enumerateDevices().catch(() => []) ?? [],
        ]);
        if (!running) return;
        setDevices(list);
        const last = previousDefaults.current;
        const preferences = { ...boot.preferences };
        let fallback = false;
        for (const [kind, key] of [['audioinput', 'microphoneId'], ['audiooutput', 'speakerId']] as const) {
          const known = list.filter(device => device.kind === kind && device.deviceId);
          if (preferences[key] !== 'default' && known.length && !known.some(device => device.deviceId === preferences[key])) {
            preferences[key] = 'default';
            fallback = true;
          }
        }
        if (last.microphone !== value.microphone || last.speaker !== value.speaker || changed || fallback) {
          previousDefaults.current = value;
          setBoot(b => ({ ...b, devices: value, preferences: fallback ? preferences : b.preferences }));
          if (engine.state.status !== 'idle') void engine.setPreferences(preferences, true);
        }
      } catch { /* Device list will retry on focus, hot-plug or the next refresh. */ }
    };
    const onChange = () => { window.clearTimeout(refreshTimer); refreshTimer = window.setTimeout(() => void refresh(true), 260); };
    const onFocus = () => void refresh(false);
    navigator.mediaDevices?.addEventListener('devicechange', onChange);
    window.addEventListener('focus', onFocus);
    const interval = window.setInterval(() => void refresh(false), 4000);
    void refresh(false);
    return () => {
      running = false;
      window.clearInterval(interval); window.clearTimeout(refreshTimer);
      navigator.mediaDevices?.removeEventListener('devicechange', onChange);
      window.removeEventListener('focus', onFocus);
    };
  }, [engine, boot.preferences]);

  async function login(event: FormEvent) {
    event.preventDefault();
    if (loginBusy) return;
    setLoginError('');
    setLoginNotice('');
    if (!boot.configured) { setProfileOpen(true); return; }
    const supplied = password;
    setPassword('');
    setLoginBusy(true);
    try {
      const result = await call<Account>('account.login', { username: loginName.trim(), password: supplied, remember: rememberLogin });
      setSelectedId(result.workspace.channels[0]?.id ?? null);
      setAccount(result);
    } catch (error) { setLoginError(message(error, '登录未完成，请稍后再试。')); }
    finally { setLoginBusy(false); }
  }
  async function forgetLogin(remember: boolean) {
    setRememberLogin(remember);
    if (remember) return;
    try { await call('account.forget'); }
    catch (error) {
      setRememberLogin(true);
      setLoginError(message(error, '无法清除已保存的登录信息。'));
    }
  }
  async function logout(notice = '') {
    if (leaving) return;
    setLeaving(true);
    setAccountOpen(false); setSettingsOpen(false); setMusicOpen(false); setVolumeFor(null); setCacheOpen(false); setEditing(null);
    setUpdatesOpen(false); setUpdateInfo(noUpdate); dismissMemberMenu();
    await engine.leave();
    let remembered: RememberedLogin | null = null;
    let error = '';
    try { remembered = await call<RememberedLogin | null>('account.logout'); }
    catch (failure) { error = message(failure, '退出完成，但无法更新本地登录设置。'); }
    setAccount(null); setLoginError(error); setLoginNotice(notice); setSelectedId(null);
    setWorkspace(null); setChatReady(false); setChatError('');
    setLoginName(remembered?.username ?? loginName);
    setPassword(remembered?.password ?? '');
    setLeaving(false);
  }
  async function changePrefs(next: Preferences) {
    const saved = await call<Preferences>('preferences.save', next);
    setBoot(b => ({ ...b, preferences: saved }));
    await engine.setPreferences(saved);
  }
  const channels = workspace?.channels ?? account?.workspace.channels ?? [];
  const workspaceName = workspace?.name ?? account?.workspace.name ?? 'Squad Voice';
  const admin = workspace?.admin ?? account?.user.admin ?? false;
  const globalRole: MemberRole = workspace?.role || account?.user.role || (admin ? 'recursive' : 'member');
  const selected = channels.find(c => c.id === selectedId);
  const joined = channels.find(c => c.id === voice.channelId);
  const live = voice.status === 'connected' || voice.status === 'reconnecting';
  const inSelected = Boolean(selected && selected.id === joined?.id && live);
  const chatOpen = Boolean(selected && inSelected && voice.status === 'connected');
  const channelManageable = (id: string) => admin || Boolean(workspace?.managedChannels?.includes(id));
  const selectedRole = selected && globalRole === 'member' && channelManageable(selected.id) ? 'channel' : globalRole;
  const members = (channelId: string): Member[] => {
    const presence = workspace?.presence[channelId] ?? [];
    if (channelId === voice.channelId && live) return voice.members.map(member => {
      const matching = presence.find(row => row.id === member.id);
      return { ...member, name: matching?.name ?? member.name, role: matching?.role ?? (member.self ? selectedRole : undefined), rules: matching?.rules };
    });
    return presence.map(member => ({ ...member, self: false, speaking: false, quality: 'unknown', volume: 100 }));
  };
  const selectedMembers = selected ? members(selected.id) : [];
  const presenceUnavailable = Boolean(selected && workspace?.presenceUnavailable.includes(selected.id) && !inSelected);
  const duration = voice.since ? clock(Math.max(0, Math.floor((now - voice.since) / 1000))) : '00:00';
  const hasMusic = selectedMembers.some(m => m.music);
  const volumeMember = voice.members.find(m => m.id === volumeFor);
  const modalMember = selectedMembers.find(m => m.id === memberMenu?.id);
  const ownVoiceId = voice.members.find(m => m.self)?.id;
  const ownRules = voice.channelId ? workspace?.presence[voice.channelId]?.find(m => m.id === ownVoiceId)?.rules : undefined;
  const split = draggedSplit ?? boot.preferences.voiceShare;

  useEffect(() => { if (ownRules) engine.applyRoomRules(ownRules); }, [engine, ownRules]);
  useEffect(() => { if (!chatOpen || !roster) dismissMemberMenu(); }, [chatOpen, roster, dismissMemberMenu]);

  function openMemberMenu(event: MouseEvent<HTMLButtonElement>, member: Member) {
    if (!chatOpen || !canModerate(selectedRole, member)) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setMemberMenu({ id: member.id, x: event.clientX || rect.left, y: event.clientY || rect.bottom });
  }
  async function controlMember(action: MemberAction, enabled: boolean, targetId = '') {
    if (!selected || !chatOpen || engine.state.channelId !== selected.id || engine.state.status !== 'connected')
      throw new Error('加入该语音频道后才能管理成员。');
    const changed = await call<{ role: MemberRole; rules: RoomRules }>('member.control', { channelId: selected.id, targetId, action, enabled });
    if (!targetId) engine.applyRoomRules(changed.rules);
    setWorkspace(await call<Workspace>('workspace.state'));
  }
  function saveSplit(value: number) {
    setBoot(current => ({ ...current, preferences: { ...current.preferences, voiceShare: value } }));
    setDraggedSplit(null);
    void call('layout.split', { value }).catch(failure => engine.notice(message(failure, '无法保存区域高度。')));
  }
  function checkForUpdate() {
    setSettingsOpen(false);
    setUpdatesOpen(true);
    void call<UpdateState>('update.check', { interactive: true }).then(setUpdateInfo).catch(() => setUpdateInfo({ ...noUpdate, status: 'error' }));
  }

  async function listApps() {
    setListBusy(true);
    try {
      const list = await call<AudioApp[]>('accompaniment.list');
      setAudioApps(list);
      setAudioApp(old => list.find(item => item.pid === old?.pid) ?? null);
    } catch (error) { engine.notice(message(error, '无法读取音频进程列表。')); }
    finally { setListBusy(false); }
  }
  function openMusic() {
    setMusicOpen(true);
    if (boot.accompanimentSupported) void listApps();
  }
  function selectChannel(channel: Channel) { setSelectedId(channel.id); setVolumeFor(null); engine.notice(''); }

  if (!ready) return <main className="startup-shell" data-testid="startup">
    <Logo /><span>Squad Voice</span><LoaderCircle className="spin" aria-label="正在连接" />
  </main>;

  if (!account) return <main className="login-shell" data-testid="login-screen">
    <div className="login-top"><Logo small /><span>Squad Voice</span><i /><span className="en">WINDOWS</span></div>
    <div className="login-layout">
      <section className="login-art" aria-label="私有小队语音">
        <div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" /><div className="hero-orbit orbit-three" />
        <div className="login-grid" />
        <div className="hero-signal"><AudioLines aria-hidden="true" /></div>
        <div className="hero-copy"><span className="eyebrow"><i className="status-dot" /> PRIVATE VOICE</span><h1>开黑，<br />进频道就聊。</h1><p>一个小队，一间语音房。声音和账号由你的房主掌握。</p></div>
        <div className="hero-chips"><span><Users /> 5 人小队</span><span><LockKeyhole /> 邀请加入</span></div>
      </section>
      <section className="login-card">
        <div className="login-card-top"><Logo small /><span className="tiny-tag"><ShieldCheck /> 私有空间</span></div>
        <h2>欢迎回到小队</h2>
        <p>使用房主分配给你的账号登录。</p>
        <form onSubmit={login} autoComplete="off">
          <label htmlFor="account-name">账号</label>
          <input id="account-name" autoComplete="off" placeholder="输入账号" required value={loginName} onChange={e => setLoginName(e.target.value)} maxLength={96} disabled={loginBusy} data-testid="username" />
          <label htmlFor="account-password">密码</label>
          <input id="account-password" type="password" autoComplete="off" placeholder="输入密码" required value={password} onChange={e => setPassword(e.target.value)} maxLength={256} disabled={loginBusy} data-testid="password" />
          <label className="remember-login"><input type="checkbox" checked={rememberLogin} disabled={loginBusy}
            onChange={event => void forgetLogin(event.target.checked)} /> 记住账号和密码</label>
        {loginError && <div className="form-error" role="alert" data-testid="login-error">{loginError}</div>}
        {loginNotice && <div className="secure-note" role="status"><Check /> {loginNotice}</div>}
          <button className="button primary login-button" type="submit" disabled={!ready || loginBusy || !isDesktop || leaving} data-testid="login">{loginBusy ? <LoaderCircle className="spin" /> : <ArrowRight />} {loginBusy ? '正在登录…' : '登录小队'}</button>
        </form>
        <div className="login-footer"><span className={boot.configured ? 'configured' : ''}><i className="status-dot" />{!isDesktop ? '界面预览' : boot.configured ? '接入已配置' : '尚未配置接入'}</span>
          <button className="link-button" onClick={() => setProfileOpen(true)} disabled={loginBusy} data-testid="profile-open"><Settings /> 接入配置</button></div>
      </section>
    </div>
    <div className="login-bottom"><span>仅限受邀成员</span><span>Windows · v{boot.version}</span></div>
    {profileOpen && <ProfileDialog configured={boot.configured} close={() => setProfileOpen(false)} onSaved={changed => {
      setBoot(b => ({ ...b, configured: true, profileError: false }));
      if (changed) { setLoginName(''); setPassword(''); }
      setLoginError(''); setProfileOpen(false);
    }} />}
  </main>;

  return <main className={'desktop ' + (!roster ? 'roster-closed' : '')} data-testid="workspace">
    <aside className="rail" aria-label="小队">
      <span className="rail-active" /><div className="rail-logo" title={workspaceName}><Logo /></div>
      <div className="rail-divider" />
      {admin ? <IconButton className="rail-lock" label="创建语音频道" onClick={() => setEditing('new')}><Plus size={19} /></IconButton> :
        <span className="rail-lock" title="私有小队"><LockKeyhole size={17} /></span>}
      <div className="rail-spacer" />
      <IconButton label="使用说明" onClick={() => setShowHelp(true)}><CircleHelp /></IconButton>
      <IconButton label="音频设置" test="settings-open-rail" onClick={() => setSettingsOpen(true)}><Settings /></IconButton>
    </aside>
    <aside className="channels" aria-label="频道">
      <div className="workspace-heading"><span>{workspaceName}</span>{admin ? <ShieldCheck size={16} aria-label="管理员" /> : <LockKeyhole size={15} />}</div>
      <div className="channel-scroll">
        <div className="small-label"><ChevronDown /> 语音频道
          {admin && <IconButton className="channel-action" label="新增语音频道" test="channel-create" onClick={() => setEditing('new')}><Plus /></IconButton>}
        </div>
        {channels.length === 0 && <p className="channel-empty">还没有语音频道。</p>}
        {channels.map(channel => (
            <div className="channel-row" key={channel.id}>
              <button data-testid={'channel-' + channel.id} className={'channel ' + (channel.id === selectedId ? 'selected' : '')} onClick={() => selectChannel(channel)}>
                <Volume2 size={19} /><span>{channel.name}</span><span className="channel-count">{members(channel.id).length}</span>
              </button>
              {channelManageable(channel.id) && <IconButton className="channel-action" label={'编辑 ' + channel.name} test={'channel-edit-' + channel.id} onClick={() => setEditing(channel)}><Settings /></IconButton>}
            </div>
        ))}
      </div>
      {live && <div className="voice-connection"><div><strong><Wifi /> {voice.status === 'reconnecting' ? '正在重连' : '语音已连接'}</strong><span>{joined?.name} · {duration}</span></div><IconButton label="断开语音" className="hangup" onClick={() => void engine.leave()} test="leave-rail"><PhoneOff /></IconButton></div>}
    </aside>
    <section className="room">
      <header className="room-top"><Volume2 className="header-icon" /><div className="header-label"><strong>{selected?.name ?? '语音频道'}</strong><span>{selected?.description || '小队语音'}</span></div>
        <span className="top-spacer" /><span className="private-badge"><LockKeyhole /> 仅受邀</span>
        <IconButton label={roster ? '隐藏成员列表' : '显示成员列表'} pressed={roster} onClick={() => setRoster(!roster)}><Users /></IconButton>
      </header>
      {updateInfo.version && skippedUpdate !== updateInfo.version && ['available', 'downloading', 'ready'].includes(updateInfo.status) &&
        <div className="update-banner" data-testid="update-banner" role="status"><Download size={15} />
          <span>{updateInfo.status === 'downloading' ? '正在后台下载 ' + updateInfo.version : updateInfo.status === 'ready' ? '更新已下载，退出时可安装' : '有新版本 ' + updateInfo.version}</span>
          {updateInfo.status === 'available' && !updateInfo.required && <button className="link-button" type="button" data-testid="update-download" onClick={() => void call('update.accept')}>下载更新</button>}
          <button className="link-button" type="button" data-testid="update-skip" onClick={() => setSkippedUpdate(updateInfo.version)}>稍后</button>
        </div>}
      <div className={'room-content' + (chatOpen ? ' with-chat' : '')} style={chatOpen ? { '--voice-share': split + 'fr', '--chat-share': (100 - split) + 'fr' } as CSSProperties : undefined}>
      <div className="room-body">
        {voice.error && <div className="status-banner" role="alert" data-testid="voice-notice"><span>{voice.error}</span><IconButton label="关闭提示" onClick={() => engine.notice('')}><X /></IconButton></div>}
        {voice.playbackBlocked && <div className="status-banner"><span>系统暂未开始播放队友的声音。</span><button className="button soft" onClick={() => void engine.startAudio()}>启用收听</button></div>}
        {chatOpen && <RoomRestrictions key={selected?.id} rules={ownRules ?? noRules} now={now} release={controlMember} />}
        {selected && <div className="room-caption"><div className={'caption-label' + (inSelected ? '' : ' caption-preview')}><span className="status-dot" />
          {inSelected ? voice.status === 'reconnecting' ? '重连中' : '通话中' : '语音预览'}
        </div><span data-testid="room-count">{presenceUnavailable ? '成员状态暂不可用' : selectedMembers.length + ' / ' + selected.capacity + ' 人'}</span></div>}
        {selectedMembers.length > 0 ? <>
          <div className={'stage stage-' + Math.min(selectedMembers.length, 5)} data-testid={inSelected ? 'voice-stage' : 'voice-preview'}>
            {selectedMembers.map((m, i) => <button className={'member-card ' + colors[i % colors.length] + (m.speaking ? ' talking' : '')} key={m.id} disabled={m.self || !inSelected} onClick={() => setVolumeFor(m.id)} title={m.self || !inSelected ? m.name : '调整 ' + m.name + ' 的音量'} data-testid={m.self ? 'self-tile' : 'peer-tile'}>
              <div className="card-waves" />
              <Avatar name={m.name} index={i} speaking={m.speaking} />
              <span className="member-label">{m.name}{m.self && <small> 你</small>}</span>
              <span className="tile-icons">{m.music && <Music2 />}{m.mic ? <Mic /> : <MicOff />}</span>
            </button>)}
          </div>
          {hasMusic && <div className="music-strip" data-testid="music-strip"><span className="music-note"><Music2 /></span><div><strong>{inSelected && voice.sharing ? '你正在共享伴奏' : '房间正在播放伴奏'}</strong>
            {inSelected && <small>{voice.sharing ?? '与队友语音分开调节'}</small>}</div>
            {inSelected && <><label>伴奏音量<input data-testid="music-receive-volume" type="range" min={0} max={100} value={voice.musicVolume} onChange={e => engine.setMusicVolume(Number(e.target.value))} /></label><span>{voice.musicVolume}%</span></>}
          </div>}
        </> : <div className="room-empty" data-testid="room-empty">
          <span className="empty-glyph"><Volume2 /></span>
          <h1>{selected?.name ?? '选择一个语音频道'}</h1>
          <p>{selected ? '当前频道没有语音成员。' : '房主配置频道后，你就可以加入语音。'}</p>
        </div>}
        {selected && !inSelected && <div className="preview-actions">
          <button className="button primary join-button" data-testid="join" disabled={voice.status === 'joining'} onClick={() => void engine.join(selected)}>
            {voice.status === 'joining' ? <LoaderCircle className="spin" /> : <Headphones />} {voice.status === 'joining' ? '正在连接…' : '加入语音'}
          </button>
          {live && <button className="link-button" onClick={() => setSelectedId(voice.channelId)}>返回通话中的频道 <ChevronRight /></button>}
          <small>加入后可查看聊天{boot.preferences.pushToTalk ? '' : '，麦克风可用时自动开启'}</small>
        </div>}
      </div>
      {selected && chatOpen && <><ChannelSplit value={split} preview={setDraggedSplit} commit={saveSplit} />
        <ChatPanel key={selected.id} channelId={selected.id} admin={channelManageable(selected.id)} ready={chatReady} connectionError={chatError} restricted={Boolean(ownRules?.chatUntil)} />
      </>}
      </div>
      <footer className="call-bar">
        <div className="call-status"><span className={'status-dot ' + (live ? 'green' : 'gray')} /><div><strong>{live ? (qualityLabel[voice.quality] || '已连接') : '尚未加入语音'}</strong><small>{live ? (boot.preferences.pushToTalk ? '按住 ' + boot.preferences.hotkey + ' 说话' : '语音优先') : '加入后使用通话控件'}</small></div></div>
        <div className="call-buttons">
          <IconButton label={voice.mic ? '关闭麦克风' : '打开麦克风'} test="mic" pressed={voice.mic} className={!voice.mic ? 'control-muted' : 'control-active'} onClick={() => engine.toggleMic()} disabled={!live}>{voice.mic ? <Mic /> : <MicOff />}</IconButton>
          <IconButton label={voice.deafened ? '恢复收听' : '关闭收听和麦克风'} test="deafen" pressed={voice.deafened} className={voice.deafened ? 'control-muted' : ''} onClick={() => engine.toggleDeafen()} disabled={!live}>{voice.deafened ? <HeadphoneOff /> : <Headphones />}</IconButton>
          <IconButton label="共享伴奏" test="music-open" pressed={Boolean(voice.sharing)} className={voice.sharing ? 'control-active' : ''} onClick={openMusic} disabled={!live}><Music2 /></IconButton>
          <IconButton label="断开语音" test="leave" className="hangup" onClick={() => void engine.leave()} disabled={!live}><PhoneOff /></IconButton>
        </div>
        <IconButton className="call-settings" label="音频设置" onClick={() => setSettingsOpen(true)}><SlidersHorizontal /></IconButton>
      </footer>
    </section>
    {roster && <aside className="roster" aria-label="成员列表">
      <div className="roster-heading"><Users /> <span>成员</span><span className="member-number">{selectedMembers.length}</span></div>
      <div className="roster-scroll">
        <div className="small-label roster-label">语音在线</div>
        {selectedMembers.map((m, i) => <button key={m.id} type="button" className="roster-member" data-testid={'roster-' + (m.self ? 'self' : 'peer')}
          disabled={m.self || !inSelected} data-member-id={m.id} onContextMenu={event => openMemberMenu(event, m)} onClick={() => setVolumeFor(m.id)}
          title={chatOpen && canModerate(selectedRole, m) ? '右键管理 ' + m.name : m.self || !inSelected ? m.name : '调整队友音量'}>
          <Avatar name={m.name} index={i} speaking={m.speaking} /><span className="roster-name">
            <span className="roster-name-row"><strong>{m.name}{m.self && <small> 你</small>}</strong><RoleBadge role={m.role} /></span>
            <small>{m.rules?.micUntil ? '已闭麦' : m.rules?.listenUntil ? '收听已暂停' : m.rules?.chatUntil ? '已禁言' : m.speaking ? '正在讲话' : m.music ? '共享伴奏' : m.mic ? '麦克风开启' : '已静音'}</small></span>
          {m.music ? <Music2 size={15} /> : m.mic ? <Mic size={15} /> : <MicOff size={15} />}
        </button>)}
        {!selectedMembers.length && <div className="roster-tip">{presenceUnavailable ? '成员状态暂不可用' : '频道里暂无成员'}</div>}
      </div>
      <div className="user-bar">
        <button type="button" className="user-profile" title="个人资料与账号" aria-label="个人资料与账号" data-testid="account-open" onClick={() => setAccountOpen(true)}>
          <Avatar name={account.user.name} /><span className="user-name"><strong>{account.user.name}</strong><span><i className="status-dot" /> 在线 <RoleBadge role={selectedRole} /></span></span>
        </button>
        <IconButton label="音频设置" test="settings-open" onClick={() => setSettingsOpen(true)}><Settings /></IconButton>
        <IconButton label="退出登录" test="logout" onClick={() => void logout()}><LogOut /></IconButton>
      </div>
    </aside>}
    {memberMenu && modalMember && chatOpen && roster && canModerate(selectedRole, modalMember) && <MemberMenu member={modalMember} actor={selectedRole}
      x={memberMenu.x} y={memberMenu.y} close={dismissMemberMenu} control={(action, enabled) => controlMember(action, enabled, modalMember.id)} />}
    {settingsOpen && <SettingsDialog boot={boot} devices={devices} engine={engine} save={changePrefs} close={() => setSettingsOpen(false)} logout={() => void logout()}
      openCache={() => { setSettingsOpen(false); setCacheOpen(true); }} checkUpdate={checkForUpdate} />}
    {updatesOpen && <Modal label="客户端更新" subtitle={'当前版本 ' + boot.version} icon={<Download />} close={() => setUpdatesOpen(false)}>
      <div className="modal-form" data-testid="updates-dialog">
        <p className="muted-text" role="status">{updateInfo.status === 'ready' ? '已下载 ' + updateInfo.version + '，退出时可安装。' :
          updateInfo.status === 'downloading' ? '正在后台下载 ' + updateInfo.version + '。' :
          updateInfo.status === 'available' ? '发现新版本 ' + updateInfo.version + '。' :
          updateInfo.status === 'error' ? '暂时无法完成更新，请稍后重试。' :
          updateInfo.status === 'disabled' ? '当前连接未配置签名更新。' :
          updateInfo.status === 'current' ? '当前没有可下载的新版本。' : '正在检查更新…'}</p>
        <div className="modal-actions"><button className="button soft" type="button" onClick={() => setUpdatesOpen(false)}>关闭</button>
          {updateInfo.version && ['available', 'error'].includes(updateInfo.status) && <button className="button primary" type="button" onClick={() => void call('update.accept')}>下载更新</button>}
          {updateInfo.status === 'error' && !updateInfo.version && <button className="button primary" type="button" onClick={checkForUpdate}>重新检查</button>}
        </div>
      </div>
    </Modal>}
    {cacheOpen && <Modal label="缓存管理" icon={<Settings />} close={() => setCacheOpen(false)}>
      <CacheSettings connected={live} close={() => setCacheOpen(false)} />
    </Modal>}
    {editing && (editing === 'new' ? admin : channelManageable(editing.id)) && <ChannelDialog value={editing === 'new' ? null : editing} close={() => setEditing(null)}
      changed={async () => { setWorkspace(await call<Workspace>('workspace.state')); setEditing(null); }} />}
    {accountOpen && <AccountDialog user={account.user} close={() => setAccountOpen(false)} saved={user => setAccount(current => current && { ...current, user })}
      passwordChanged={saved => void logout(saved ? '密码已更新，请使用新密码重新登录。' : '密码已更新，本地保存失败，请输入新密码。')} />}
    {musicOpen && <Modal label="共享伴奏" subtitle="把所选应用的声音单独发给队友。" icon={<Music2 />} close={() => setMusicOpen(false)}>
      {!boot.accompanimentSupported ? <p className="muted-text">按进程共享需要支持应用音频捕获的 Windows 版本（Windows 10 2004 或以上）。当前仍可正常使用麦克风语音。</p> :
        <div className="music-options">
          <div className="device-line"><div><strong>音频进程</strong><small>只采集所选进程及其子进程。</small></div><IconButton label="刷新音频进程" onClick={() => void listApps()}><RefreshCw className={listBusy ? 'spin' : ''} /></IconButton></div>
          <div className="process-list" data-testid="process-list">
            {audioApps.length ? audioApps.map(app => <button type="button" key={app.pid} className={'process-option ' + (audioApp?.pid === app.pid ? 'selected' : '')} data-process={app.executable} onClick={() => setAudioApp(app)}><MonitorSpeaker /><span><strong>{app.name}</strong><small>{app.active ? '有活动音频会话' : '可在应用中开始播放'}</small></span>{audioApp?.pid === app.pid && <Check />}</button>) :
              <div className="list-empty">{listBusy ? '正在寻找音频进程…' : '打开音乐播放器或浏览器后，点刷新。'}</div>}
          </div>
          <label className="range-label">分享音量 <input type="range" min={0} max={100} value={voice.shareLevel} onChange={e => engine.setShareLevel(Number(e.target.value))} /><span>{voice.shareLevel}%</span></label>
          <p className="muted-text">在所选应用里播放音乐即可。浏览器按整个进程共享；请只让要分享的标签页发声。</p>
          {voice.error && <p className="form-error" role="alert">{voice.error}</p>}
          <div className="modal-actions">{voice.sharing ? <button className="button danger" data-testid="music-stop" onClick={() => void engine.stopShare()}>停止共享 · {voice.sharing}</button> : <button className="button primary" data-testid="music-start" disabled={!audioApp || !live || voice.musicBusy} onClick={() => audioApp && void engine.startShare(audioApp)}>{voice.musicBusy ? <LoaderCircle className="spin" /> : <Music2 />} {voice.musicBusy ? '正在开启…' : '开始共享'}</button>}</div>
        </div>}
    </Modal>}
    {volumeMember && <Modal label={volumeMember.name + ' 的音量'} icon={<Volume2 />} close={() => setVolumeFor(null)}>
      <label className="range-label">队友语音<input type="range" min={0} max={100} value={volumeMember.volume} onChange={e => engine.setVolume(volumeMember.id, Number(e.target.value))} /><span>{volumeMember.volume}%</span></label>
      <p className="muted-text">仅改变你听到的这位队友的语音音量。</p>
    </Modal>}
    {showHelp && <Modal label="如何开黑" subtitle="Squad Voice · Windows" icon={<CircleHelp />} close={() => setShowHelp(false)}>
      <ul className="help-list"><li>选择频道预览在线成员。加入语音后可查看该频道的聊天。</li><li>有可用麦克风时加入即开麦。也可在音频设置启用全局按住说话。</li><li>点队友可调个人音量，伴奏可另行调整。</li><li>共享伴奏时只采集你选中的音频进程。</li></ul>
    </Modal>}
  </main>;
}

function ProfileDialog({ configured, close, onSaved }: { configured: boolean; close: () => void; onSaved: (changed: boolean) => void }) {
  const [endpoint, setEndpoint] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const saved = await call<{ changed: boolean }>('profile.save', { endpoint });
      setEndpoint(''); onSaved(saved.changed);
    }
    catch (err) { setError(message(err, '无法保存接入配置。')); }
    finally { setBusy(false); }
  }
  return <Modal label="接入配置" subtitle={configured ? '已保存连接。输入新地址即可替换。' : '填写房主提供的接入地址。'} icon={<KeyRound />} close={close}>
    <form onSubmit={submit} className="modal-form" autoComplete="off">
      <label htmlFor="endpoint">HTTPS 接入地址</label>
      <input id="endpoint" type="password" autoComplete="off" spellCheck={false} required value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="输入管理员提供的地址" data-testid="endpoint" />
      <div className="secure-note"><ShieldCheck /> 连接配置由当前 Windows 用户加密保存。</div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions"><button className="button soft" type="button" onClick={close}>取消</button><button className="button primary" type="submit" disabled={busy} data-testid="save-profile">{busy ? '正在保存…' : '保存配置'}</button></div>
    </form>
  </Modal>;
}

function ChannelDialog({ value, close, changed }: { value: Channel | null; close: () => void; changed: () => Promise<void> }) {
  const [name, setName] = useState(value?.name ?? '');
  const [description, setDescription] = useState(value?.description ?? '');
  const [capacity, setCapacity] = useState(value?.capacity ?? 5);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(remove = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (remove) await call('channel.delete', { id: value?.id });
      else await call(value ? 'channel.update' : 'channel.create', { id: value?.id ?? '', name: name.trim(), description, capacity });
      await changed();
    } catch (failure) {
      setError(message(failure, '频道更新失败，请稍后重试。'));
    } finally { setBusy(false); }
  }
  return <Modal label={value ? '编辑语音频道' : '创建语音频道'} icon={<Volume2 />} close={() => { if (!busy) close(); }}>
    <form className="modal-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label htmlFor="channel-name">频道名称</label>
      <input id="channel-name" data-testid="channel-name" required value={name} maxLength={64} disabled={busy} onChange={event => setName(event.target.value)} />
      <label htmlFor="channel-description">描述</label>
      <input id="channel-description" value={description} maxLength={180} disabled={busy} onChange={event => setDescription(event.target.value)} />
      <label htmlFor="channel-capacity">人数上限</label>
      <select id="channel-capacity" value={capacity} disabled={busy} onChange={event => setCapacity(Number(event.target.value))}>
        {[1, 2, 3, 4, 5].map(limit => <option value={limit} key={limit}>{limit} 人</option>)}
      </select>
      {error && <p className="form-error" role="alert">{error}</p>}
      {confirm && <p className="form-error">删除这个频道会移除其中的聊天记录和图片，并中断频道内的通话。</p>}
      <div className="modal-actions">
        {value && <button className={confirm ? 'button danger' : 'link-button'} type="button" disabled={busy}
          data-testid="channel-delete" onClick={() => confirm ? void save(true) : setConfirm(true)}>{confirm ? '确认删除' : '删除频道'}</button>}
        <button className="button soft" type="button" disabled={busy} onClick={() => confirm ? setConfirm(false) : close()}>取消</button>
        <button className="button primary" type="submit" data-testid="channel-save" disabled={busy || !name.trim() || confirm}>{value ? '保存频道' : '创建频道'}</button>
      </div>
    </form>
  </Modal>;
}

function AccountDialog({ user, close, saved, passwordChanged }: {
  user: Identity; close: () => void; saved: (value: Identity) => void; passwordChanged: (saved: boolean) => void;
}) {
  const [name, setName] = useState(user.name);
  const [bio, setBio] = useState(user.bio);
  const [editPassword, setEditPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function togglePassword() {
    setEditPassword(value => !value);
    setCurrentPassword('');
    setNewPassword('');
    setRepeatPassword('');
    setError('');
    setNotice('');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setNotice('');
    if (editPassword && newPassword !== repeatPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    setBusy(true);
    try {
      if (editPassword) {
        const payload = { currentPassword, newPassword };
        setCurrentPassword('');
        setNewPassword('');
        setRepeatPassword('');
        const updated = await call<{ saved: boolean }>('account.password', payload);
        passwordChanged(updated.saved);
      } else {
        const updated = await call<Identity>('account.profile', { name, bio });
        saved(updated);
        setName(updated.name);
        setBio(updated.bio);
        setNotice('个人资料已保存。');
      }
    } catch (err) {
      setError(message(err, '暂时无法更新账号，请稍后再试。'));
    } finally {
      setBusy(false);
    }
  }

  return <Modal label="个人资料与账号" subtitle={user.username ? '登录账号 · ' + user.username : undefined}
    icon={<UserRound />} close={() => { if (!busy) close(); }}>
    <form className="modal-form" onSubmit={submit} autoComplete="off">
      {editPassword ? <>
        <label htmlFor="current-password">当前密码</label>
        <input id="current-password" data-testid="current-password" type="password" autoComplete="current-password" required maxLength={256} disabled={busy} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} />
        <label htmlFor="new-password">新密码</label>
        <input id="new-password" data-testid="new-password" type="password" autoComplete="new-password" required minLength={9} maxLength={256} disabled={busy} value={newPassword} onChange={event => setNewPassword(event.target.value)} />
        <label htmlFor="repeat-password">确认新密码</label>
        <input id="repeat-password" data-testid="repeat-password" type="password" autoComplete="new-password" required minLength={9} maxLength={256} disabled={busy} value={repeatPassword} onChange={event => setRepeatPassword(event.target.value)} />
        <p className="muted-text">新密码须为 9 至 128 个字符，须包含大写字母、小写字母、数字、符号中的至少两类。改密后需要重新登录，当前通话会断开。</p>
      </> : <>
        <label htmlFor="display-name">显示名称</label>
        <input id="display-name" data-testid="display-name" required maxLength={64} disabled={busy} value={name} onChange={event => setName(event.target.value)} />
        <label htmlFor="account-bio">个人简介</label>
        <input id="account-bio" data-testid="account-bio" maxLength={160} disabled={busy} value={bio} onChange={event => setBio(event.target.value)} />
      </>}
      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <div className="secure-note" role="status"><Check /> {notice}</div>}
      <div className="modal-actions settings-actions">
        <button className="link-button" type="button" data-testid="account-password-open" disabled={busy} onClick={togglePassword}><KeyRound /> {editPassword ? '返回个人资料' : '修改密码'}</button>
        <button className="button primary" type="submit" data-testid="account-save" disabled={busy}>{busy ? '正在保存…' : editPassword ? '保存新密码' : '保存资料'}</button>
      </div>
    </form>
  </Modal>;
}

function SettingsDialog({ boot, devices, engine, save, close, logout, openCache, checkUpdate }: {
  boot: Bootstrap; devices: MediaDeviceInfo[]; engine: VoiceEngine; save: (value: Preferences) => Promise<void>;
  close: () => void; logout: () => void; openCache: () => void; checkUpdate: () => void;
}) {
  const [draft, setDraft] = useState(boot.preferences);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) => setDraft(p => ({ ...p, [key]: value }));
  const options = (kind: MediaDeviceKind) => devices.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await save(draft); close(); }
    catch (err) { setError(message(err, '无法保存音频设置。')); }
    finally { setBusy(false); }
  };
  return <Modal label="音频设置" subtitle="设置语音设备、麦克风处理和通话音质。"  icon={<SlidersHorizontal />} close={close}>
    <form className="modal-form" onSubmit={submit} data-testid="audio-settings">
      <div className="settings-navigation"><span>音频</span>
        <button type="button" className="link-button" data-testid="update-open" disabled={busy} onClick={checkUpdate}>检查更新 <ChevronRight size={13} /></button>
        <button type="button" className="link-button" data-testid="cache-open" disabled={busy} onClick={openCache}>缓存管理 <ChevronRight size={13} /></button>
      </div>
      <label htmlFor="mic-device"><Mic /> 麦克风</label>
      <select id="mic-device" value={draft.microphoneId} onChange={e => update('microphoneId', e.target.value)}>
        <option value="default">跟随 Windows 默认设备</option>
        {options('audioinput').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || '麦克风 ' + (i + 1)}</option>)}
      </select>
      <div className="default-device" data-testid="default-mic">{boot.devices.microphone ?? 'Windows 未检测到默认麦克风'}</div>
      <label htmlFor="out-device"><Headphones /> 扬声器 / 耳机</label>
      <select id="out-device" value={draft.speakerId} onChange={e => update('speakerId', e.target.value)}>
        <option value="default">跟随 Windows 默认设备</option>
        {options('audiooutput').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || '扬声器 ' + (i + 1)}</option>)}
      </select>
      <div className="default-device" data-testid="default-output">{boot.devices.speaker ?? 'Windows 未检测到默认扬声器'}</div>
      <div className="settings-divider" />
      <div className="mic-processing">
        <label><input type="checkbox" data-testid="noise-suppression" checked={draft.noiseSuppression} onChange={event => update('noiseSuppression', event.target.checked)} /> 噪声抑制</label>
        <label><input type="checkbox" data-testid="echo-cancellation" checked={draft.echoCancellation} onChange={event => update('echoCancellation', event.target.checked)} /> 回声消除</label>
        <label><input type="checkbox" data-testid="auto-gain-control" checked={draft.autoGainControl} onChange={event => update('autoGainControl', event.target.checked)} /> 自动增益</label>
      </div>
      <label htmlFor="voice-bitrate">麦克风音质</label>
      <select id="voice-bitrate" data-testid="voice-bitrate" value={draft.voiceBitrate}
        onChange={event => update('voiceBitrate', Number(event.target.value) as Preferences['voiceBitrate'])}>
        <option value={16000}>节省带宽 · 16 kbps</option>
        <option value={24000}>标准 · 24 kbps</option>
        <option value={40000}>清晰 · 40 kbps</option>
      </select>
      <MicCheck engine={engine} preferences={draft} />
      <div className="settings-divider" />
      <label className="toggle-label"><span><strong>全局按住说话</strong><small>游戏在前台时也可使用，松开即静音。</small></span><input type="checkbox" checked={draft.pushToTalk} onChange={e => update('pushToTalk', e.target.checked)} /></label>
      {draft.pushToTalk && <label className="hotkey-picker">快捷键<select value={draft.hotkey} onChange={e => update('hotkey', e.target.value as Preferences['hotkey'])}>{['F6', 'F7', 'F8', 'F9', 'F10'].map(key => <option key={key}>{key}</option>)}</select></label>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions settings-actions"><button className="link-button" type="button" onClick={logout}><LogOut /> 退出账号</button><button className="button primary" type="submit" data-testid="save-audio-settings" disabled={busy}>保存设置</button></div>
    </form>
  </Modal>;
}
