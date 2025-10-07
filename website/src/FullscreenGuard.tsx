// FullscreenGuard.tsx
import React from "react";
import { useAttentionGuard } from "./useAttentionGuard";

export const FullscreenGuard: React.FC<{
  children: React.ReactNode;
  onViolation?: (n: number) => void;
  enableWakeLock?: boolean;
}> = ({ children, onViolation, enableWakeLock }) => {
  const { needsAttention, violationCount, resume } = useAttentionGuard({
    onViolation,
    enableWakeLock,
  });

  return (
    <div className="relative">
      {children}
      {needsAttention && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6 text-center space-y-4">
            <h2 className="text-xl font-bold">Return to Fullscreen</h2>
            <p className="text-sm text-gray-600">
              Please stay in fullscreen and keep this tab focused for the remainder of the task.
              <br />
              Violations detected: <span className="font-semibold">{violationCount}</span>
            </p>
            <button
              className="px-4 py-2 rounded-xl bg-black text-white"
              onClick={resume}
            >
              Re-enter Fullscreen & Continue
            </button>
            <p className="text-xs text-gray-500 mt-2">
              (Developer escape: press <span className="font-mono">Ctrl+Shift+E</span> five times quickly)
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
