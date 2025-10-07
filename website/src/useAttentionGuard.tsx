// useAttentionGuard.tsx
import React from "react";

type GuardOptions = {
  onAllowedResume?: () => void;     // called when user returns/fixes state
  onViolation?: (count: number) => void; // increments whenever we detect a violation
  enableWakeLock?: boolean;         // best-effort screen wake lock
};

export function useAttentionGuard(opts: GuardOptions = {}) {
  const [needsAttention, setNeedsAttention] = React.useState(false);
  const [violationCount, setViolationCount] = React.useState(0);
  const escapeRef = React.useRef({ count: 0, timer: 0 as any });
  const wakeLockRef = React.useRef<any>(null);

  const requestFullscreen = React.useCallback(async () => {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
    } catch (e) {
      // user may need to click; we'll show overlay button
    }
  }, []);

  const releaseWakeLock = React.useCallback(async () => {
    try {
      await wakeLockRef.current?.release?.();
    } catch {}
    wakeLockRef.current = null;
  }, []);

  const requestWakeLock = React.useCallback(async () => {
    if (!opts.enableWakeLock) return;
    try {
      // @ts-ignore
      if (navigator.wakeLock?.request) {
        // @ts-ignore
        wakeLockRef.current = await navigator.wakeLock.request("screen");
      }
    } catch {
      // ignore (not supported or blocked)
    }
  }, [opts.enableWakeLock]);

  const flagViolation = React.useCallback(() => {
    setViolationCount((c) => {
      const next = c + 1;
      opts.onViolation?.(next);
      return next;
    });
    setNeedsAttention(true);
  }, [opts]);

  React.useEffect(() => {
    // Initial attempts
    requestFullscreen();
    requestWakeLock();

    // Dev escape: Ctrl+Shift+E five times within 2 seconds
    const onKey = (e: KeyboardEvent) => {
      // Count developer escape presses
      if (e.ctrlKey && e.shiftKey && (e.key === "E" || e.key === "e")) {
        e.preventDefault();
        escapeRef.current.count += 1;
        window.clearTimeout(escapeRef.current.timer);
        escapeRef.current.timer = setTimeout(() => {
          escapeRef.current.count = 0;
        }, 2000);
        if (escapeRef.current.count >= 5) {
          escapeRef.current.count = 0;
          // developer override: allow resume and do not enforce
          setNeedsAttention(false);
          opts.onAllowedResume?.();
          // optionally: do something (e.g., auto-advance)
        }
        return;
      }

      // We can discourage some keys (cannot block OS-level or Escape fullscreen exit)
      const blockCombos =
        (e.key === "F11") ||
        (e.ctrlKey && ["w","n","t","r","l","h","j","k"].includes(e.key.toLowerCase())) ||
        (e.ctrlKey && e.shiftKey && ["i","c","j","k","delete"].includes(e.key.toLowerCase()));

      if (blockCombos) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        flagViolation();
      }
    };

    const onBlur = () => {
      // user switched window/app
      flagViolation();
    };

    const onFullscreenChange = () => {
      if (!document.fullscreenElement) {
        flagViolation();
      }
    };

    window.addEventListener("keydown", onKey, true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    document.addEventListener("fullscreenchange", onFullscreenChange);

    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      releaseWakeLock();
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    };
  }, [flagViolation, opts, releaseWakeLock, requestFullscreen, requestWakeLock]);

  const resume = React.useCallback(async () => {
    await requestFullscreen();
    await requestWakeLock();
    setNeedsAttention(false);
    opts.onAllowedResume?.();
  }, [opts, requestFullscreen, requestWakeLock]);

  return { needsAttention, violationCount, resume };
}
