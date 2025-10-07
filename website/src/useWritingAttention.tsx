// --- Attention hook: only active when enabled (Editor step) ---
import { useEffect, useRef, useState } from "react";

type AttnOpts = {
  graceMs?: number;            // no decay for this long after last activity
  halfLifeMs?: number;         // exponential half-life for decay
  nudgeThreshold?: number;     // show small nudge when score < this
  finalThreshold?: number;     // after final warning, dipping below this triggers flag
  maxNudges?: number;          // how many nudges before showing final warning
  minScore?: number;           // floor
  nudgeCooldownMs?: number;    // min gap between nudges
};

type AttnState = {
  score: number;               // 0..1
  showNudge: boolean;          // transient toast
  showFinalWarning: boolean;   // persistent banner after nudges exhausted
  finalStrike: boolean;        // if true, submission should be flagged
  nudges: number;              // how many nudges shown
  worstScore: number;          // lowest observed score (for logging)
};

export function useWritingAttention(enabled: boolean, opts: AttnOpts = {}): AttnState {
  const {
    graceMs = 5000,
    halfLifeMs = 30000,
    nudgeThreshold = 0.5,
    finalThreshold = 0.35,
    maxNudges = 2,
    minScore = 0.05,
    nudgeCooldownMs = 15000,
  } = opts;

  const [score, setScore] = useState(1);
  const [showNudge, setShowNudge] = useState(false);
  const [nudges, setNudges] = useState(0);
  const [showFinalWarning, setShowFinalWarning] = useState(false);
  const [finalStrike, setFinalStrike] = useState(false);
  const [worstScore, setWorstScore] = useState(1);

  const lastActRef = useRef<number>(performance.now());
  const lastNudgeRef = useRef<number>(0);
  const armedFinalRef = useRef<boolean>(false);     // true after we show final warning
  const hysteresisOkRef = useRef<boolean>(true);    // require recovery above (finalThreshold+0.08) before next dip counts
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const markActive = () => { lastActRef.current = performance.now(); setScore(1); };
    const key = (e: KeyboardEvent) => {
      // ignore pure meta combos
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      markActive();
    };
    const input = () => markActive();
    const mouse = () => markActive();
    const wheel = () => markActive();
    const sel = () => markActive();

    window.addEventListener("keydown", key, true);
    window.addEventListener("input", input, true);
    window.addEventListener("mousemove", mouse, { passive: true });
    window.addEventListener("mousedown", mouse, true);
    window.addEventListener("wheel", wheel, { passive: true });
    document.addEventListener("selectionchange", sel);

    const loop = () => {
      const now = performance.now();
      const idle = now - lastActRef.current;

      let s = 1;
      if (idle > graceMs) {
        const t = idle - graceMs;
        // exponential decay: s = exp(-ln 2 * t / halfLife)
        s = Math.max(minScore, Math.exp(-Math.log(2) * (t / halfLifeMs)));
      }
      setScore(s);
      if (s < worstScore) setWorstScore(s);

      // Handle nudges
      if (!finalStrike && !showFinalWarning && s < nudgeThreshold && nudges < maxNudges) {
        const sinceLast = now - lastNudgeRef.current;
        if (sinceLast > nudgeCooldownMs) {
          lastNudgeRef.current = now;
          setNudges(n => n + 1);
          setShowNudge(true);
          setTimeout(() => setShowNudge(false), 2500);
          // After last nudge, arm final warning
          if (nudges + 1 >= maxNudges) {
            setShowFinalWarning(true);
            armedFinalRef.current = true;
            hysteresisOkRef.current = false; // require recovery before we count next dip
          }
        }
      }

      // Hysteresis: once above finalThreshold+0.08, allow next dip to count
      if (armedFinalRef.current && s > finalThreshold + 0.08) {
        hysteresisOkRef.current = true;
      }

      // Final strike: after final warning shown, if s dips below threshold *again* (with hysteresis), flag
      if (armedFinalRef.current && !finalStrike && s < finalThreshold && hysteresisOkRef.current) {
        setFinalStrike(true);
        hysteresisOkRef.current = false; // avoid multiple toggles
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("input", input, true);
      window.removeEventListener("mousemove", mouse as any);
      window.removeEventListener("mousedown", mouse, true);
      window.removeEventListener("wheel", wheel as any);
      document.removeEventListener("selectionchange", sel);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      // reset visuals when leaving editor
      setShowNudge(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return { score, showNudge, showFinalWarning, finalStrike, nudges, worstScore };
}
