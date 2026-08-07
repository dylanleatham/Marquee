/**
 * How a panel performs an action that can fail.
 *
 * The page owns the try/catch and the re-poll; a panel hands it a thunk and stays presentational.
 * That is why every panel takes `run` rather than calling `api` and rendering its own error — one
 * place decides what a failure looks like, so the four panels can't drift into four idioms for it.
 *
 * It lived in `components/workflow.tsx` until 2026-08-05, alongside the five workstations (ADR
 * 0052). The workstations are gone; this outlived them, so it gets its own file rather than keeping
 * a thousand-line module alive to host one type.
 */
export type Run = (fn: () => Promise<unknown>) => Promise<void>;
