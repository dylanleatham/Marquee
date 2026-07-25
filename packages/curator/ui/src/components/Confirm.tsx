// In-app confirmation, replacing window.confirm (curator-ui-ux §2). Curator is an Electron app that
// otherwise controls its own surface: a native dialog renders as OS chrome, can't be styled, and
// blocks the renderer. This one matches the design language and resolves a promise, so call sites
// read the same as before.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive actions get the alert treatment on the confirm button. */
  destructive?: boolean;
}

type Ask = (req: ConfirmRequest) => Promise<boolean>;

const ConfirmContext = createContext<Ask | null>(null);

/**
 * `const confirm = useConfirm()` → `await confirm({ title })`. Outside a provider it falls back to
 * resolving true rather than throwing: a missing provider should never make a button silently dead.
 */
export function useConfirm(): Ask {
  const ask = useContext(ConfirmContext);
  return ask ?? (async () => true);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const ask = useCallback<Ask>((next) => {
    setReq(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setReq(null);
  }, []);

  // Escape cancels, matching every other dialog the user has ever used.
  useEffect(() => {
    if (!req) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        settle(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req, settle]);

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {req && (
        <div className="modal-scrim" onClick={() => settle(false)}>
          <div
            className="modal"
            role="alertdialog"
            aria-modal="true"
            aria-label={req.title}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="modal__title">{req.title}</h2>
            {req.body && <p className="modal__body">{req.body}</p>}
            <div className="row-actions">
              <button
                ref={confirmRef}
                className={`btn ${req.destructive ? "btn--danger" : "btn--primary"}`}
                onClick={() => settle(true)}
              >
                {req.confirmLabel ?? "Confirm"}
              </button>
              <button className="btn btn--ghost" onClick={() => settle(false)}>
                {req.cancelLabel ?? "Cancel"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
