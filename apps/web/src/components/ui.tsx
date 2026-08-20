import { useState } from 'react';
import type { ReactNode, ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  default: 'border-slate-700 bg-slate-800 hover:bg-slate-700',
  primary: 'border-emerald-700 bg-emerald-700 hover:bg-emerald-600 text-white',
  danger: 'border-rose-800 bg-rose-900/60 hover:bg-rose-800 text-rose-100',
  ghost: 'border-transparent bg-transparent hover:bg-slate-800',
};

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Btn({ variant = 'default', className = '', children, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      className={`rounded border px-3 py-1.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <section className="rounded-md border border-slate-800 bg-slate-900/60 p-3">
      {title && (
        <h2 className="text-xs uppercase tracking-wide text-slate-500 mb-2">
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

/**
 * Minimal "⋯" overflow menu — keeps secondary actions off the primary
 * surface. Closes on any selection or on clicking the backdrop.
 */
export function OverflowMenu({ items, label = '⋯' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Btn onClick={() => setOpen((o) => !o)} aria-label="More actions" aria-expanded={open}>
        {label}
      </Btn>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-30 min-w-[140px] rounded border border-slate-700 bg-slate-900 py-1 shadow-lg">
            {items.map((it) => (
              <button
                key={it.label}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-slate-800 ${
                  it.danger ? 'text-rose-300' : 'text-slate-200'
                }`}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ErrorBanner({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="fixed top-4 right-4 z-50 max-w-md rounded border border-rose-700 bg-rose-950 px-3 py-2 text-rose-100 text-xs flex gap-3 items-start">
      <span className="flex-1">{message}</span>
      <button onClick={onClose} className="text-rose-300 hover:text-white">
        ✕
      </button>
    </div>
  );
}
