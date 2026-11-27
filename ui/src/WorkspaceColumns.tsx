import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

type Pane = 'channels' | 'members';
const railWidth = 60;
const minimumChat = 300;
const minimum = { channels: 155, members: 135 };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function useWorkspaceColumns(showMembers: boolean) {
  const [preferred, setPreferred] = useState({ channels: 200, members: 190 });
  const [width, setWidth] = useState(() => document.documentElement.clientWidth);

  useEffect(() => {
    const resize = () => setWidth(document.documentElement.clientWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const available = width - railWidth - minimumChat;
  const channels = clamp(preferred.channels, minimum.channels, available - (showMembers ? minimum.members : 0));
  const members = showMembers ? clamp(preferred.members, minimum.members, available - channels) : 0;

  function divider(pane: Pane) {
    const value = pane === 'channels' ? channels : members;
    const max = Math.max(minimum[pane], available - (pane === 'channels' ? members : channels));
    return {
      pane, value, min: minimum[pane], max,
      change: (next: number) => setPreferred(previous => ({ ...previous, [pane]: clamp(next, minimum[pane], max) })),
    };
  }

  const style = {
    '--rail-width': railWidth + 'px',
    '--channels-width': channels + 'px',
    '--members-width': members + 'px',
  } as CSSProperties;
  return { style, divider };
}

export function ColumnDivider({ pane, value, min, max, change }: {
  pane: Pane; value: number; min: number; max: number; change: (value: number) => void;
}) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const direction = pane === 'channels' ? 1 : -1;
  const label = pane === 'channels' ? '调整子频道栏宽度' : '调整成员栏宽度';
  const finish = () => {
    drag.current = null;
    setResizing(false);
  };

  return <div className={'column-divider divider-' + pane} role="separator" aria-label={label} title={label}
    aria-orientation="vertical" aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}
    tabIndex={0} data-testid={'resize-' + pane} data-resizing={resizing || undefined}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, width: value };
      setResizing(true);
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (start && start.id === event.pointerId) change(start.width + (event.clientX - start.x) * direction);
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onKeyDown={event => {
      const step = event.shiftKey ? 32 : 8;
      switch (event.key) {
        case 'ArrowLeft': change(value - step * direction); break;
        case 'ArrowRight': change(value + step * direction); break;
        case 'Home': change(min); break;
        case 'End': change(max); break;
        default: return;
      }
      event.preventDefault();
    }} />;
}
