import { useCallback, useEffect, useRef, useState } from "react";

type Options = {
  requireFullscreen?: boolean;     // default true (enforce fullscreen)
  enableWakeLock?: boolean;        // best-effort
  onViolation?: (count: number) => void;
  onResume?: () => void;
  initialViolations?: number;      // start with a count from parent
};

export function useComplianceGuard(opts: Options = {}) {
  const requireFullscreen = opts.requireFullscreen ?? true;
  const [needsAttention, setNeedsAttention] = useState(false);
  const [violations, setViolations] = useState(opts.initialViolations ?? 0);
  const escapeRef = useRef({ count: 0, timer: 0 as any });
  const wakeLockRef = useRef<any>(null);
  const suppressedRef = useRef(false); // dev override

  const isCompliant = useCallback(() => {
    const visible = document.visibilityState === "visible";
    const focused = document.hasFocus();
    const fsOk = !requireFullscreen || !!document.fullscreenElement;
    return visible && focused && fsOk;
  }, [requireFullscreen]);

  const flagViolation = useCallback(() => {
    if (suppressedRef.current) return;
    setViolations((n) => {
      const next = n + 1;
      opts.onViolation?.(next);
      return next;
    });
    setNeedsAttention(true);
  }, [opts]);

  const requestFullscreen = useCallback(async () => {
    if (!requireFullscreen) return true;
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
      return !!document.fullscreenElement;
    } catch {
      return false;
    }
  }, [requireFullscreen]);

  const releaseWakeLock = useCallback(async () => {
    try { await wakeLockRef.current?.release?.(); } catch {}
    wakeLockRef.current = null;
  }, []);

  const requestWakeLock = useCallback(async () => {
    if (!opts.enableWakeLock) return;
    try {
      // @ts-ignore
      if (navigator.wakeLock?.request) {
        // @ts-ignore
        wakeLockRef.current = await navigator.wakeLock.request("screen");
      }
    } catch {}
  }, [opts.enableWakeLock]);

  // Core: check compliance (used by events + polling)
  const checkNow = useCallback(() => {
    if (suppressedRef.current) return setNeedsAttention(false);
    setNeedsAttention(!isCompliant());
  }, [isCompliant]);

  const resume = useCallback(async () => {
    // try to re-enter fullscreen (user gesture: the overlay button click)
    await requestFullscreen();
    await requestWakeLock();

    // wait a tick for fullscreenchange/visibility to settle
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    if (isCompliant()) {
      setNeedsAttention(false);
      opts.onResume?.();
    } else {
      setNeedsAttention(true); // still out of compliance (e.g., user denied FS)
    }
  }, [isCompliant, opts, requestFullscreen, requestWakeLock]);

  useEffect(() => {
    // Developer escape: Ctrl+Shift+E ×5 (within 2s)
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.code === "KeyE")) {
        e.preventDefault();
        clearTimeout(escapeRef.current.timer);
        escapeRef.current.count += 1;
        escapeRef.current.timer = setTimeout(() => (escapeRef.current.count = 0), 2000);
        if (escapeRef.current.count >= 5) {
          escapeRef.current.count = 0;
          suppressedRef.current = true; // disable guard
          setNeedsAttention(false);
          opts.onResume?.();
        }
      }
    };

    const onVis = () => { if (!isCompliant()) flagViolation(); else checkNow(); };
    const onBlur = () => { if (!isCompliant()) flagViolation(); else checkNow(); };
    const onFocus = () => checkNow();
    const onFS = () => { if (!isCompliant()) flagViolation(); else checkNow(); };

    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("fullscreenchange", onFS, { passive: true });
    window.addEventListener("keydown", onKey, true);

    // light polling to cover odd edge-cases (IMEs, mission control, etc.)
    const poll = setInterval(checkNow, 500);

    // initial state: if non-compliant at mount, show overlay
    checkNow();
    requestWakeLock();

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("fullscreenchange", onFS);
      window.removeEventListener("keydown", onKey, true);
      clearInterval(poll);
      releaseWakeLock();
    };
  }, [checkNow, flagViolation, isCompliant, opts, releaseWakeLock, requestWakeLock]);

  return { needsAttention, violations, resume };
}
