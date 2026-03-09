'use client';

import { useState, useEffect, useRef, type ReactNode } from 'react';

// ============================================================
// localStorage persistence helpers
// ============================================================
const STORAGE_KEY = 'sls-accordion-state';

function loadState(): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveState(id: string, open: boolean) {
  if (typeof window === 'undefined') return;
  try {
    const state = loadState();
    state[id] = open;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

// ============================================================
// Accordion Component
// ============================================================
interface AccordionProps {
  /** Unique ID for localStorage persistence */
  id: string;
  /** Section title */
  title: string;
  /** Optional icon (emoji or text) */
  icon?: string;
  /** Summary text shown in header (e.g. "12件") */
  badge?: string | number;
  /** Default open state (only used if no localStorage entry) */
  defaultOpen?: boolean;
  /** Extra CSS class for the outer wrapper */
  className?: string;
  /** Render children lazily (only when opened at least once) */
  lazy?: boolean;
  children: ReactNode;
}

export function Accordion({
  id, title, icon, badge, defaultOpen = false,
  className = '', lazy = true, children,
}: AccordionProps) {
  const [isOpen, setIsOpen] = useState<boolean>(() => {
    const saved = loadState();
    return saved[id] !== undefined ? saved[id] : defaultOpen;
  });
  const hasOpened = useRef(isOpen);

  useEffect(() => {
    if (isOpen) hasOpened.current = true;
  }, [isOpen]);

  const toggle = () => {
    const next = !isOpen;
    setIsOpen(next);
    saveState(id, next);
  };

  const shouldRender = lazy ? (isOpen || hasOpened.current) : true;

  return (
    <div className={className}>
      {/* Toggle header */}
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2 px-1 py-1.5 mb-2 text-left rounded-lg transition-colors hover:bg-white/[0.03]"
      >
        <span className="text-[10px] transition-transform duration-200"
          style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', color: 'var(--accent-primary)' }}>
          ▶
        </span>
        {icon && <span className="text-xs w-4 text-center">{icon}</span>}
        <span className="flex-1 text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{title}</span>
        {badge !== undefined && badge !== null && (
          <span className="text-[10px] px-2 py-0.5 rounded-full"
            style={{ background: 'rgba(56,189,248,0.08)', color: 'var(--accent-primary)' }}>
            {badge}
          </span>
        )}
      </button>

      {/* Content */}
      <div
        className="transition-all duration-200 ease-in-out"
        style={{
          maxHeight: isOpen ? '9999px' : '0',
          opacity: isOpen ? 1 : 0,
          overflow: isOpen ? 'visible' : 'hidden',
        }}
      >
        {shouldRender && children}
      </div>
    </div>
  );
}
