import React, { useEffect, useRef, useState } from "react";
import { ComplianceGate } from "./ComplianceGate";
import { useWritingAttention } from "./useWritingAttention"; 
import { supabase } from './lib/supabase';


/*
  Prolific User Study Skeleton (TypeScript/React, single-file)
  -----------------------------------------------------------
  Features:
  - 4 sequential views: Instructions → Brainstorm → Editor → Survey
  - 2×2 randomized groups with balancing: (AI vs SELF) × (Divergent vs Convergent)
  - Tracks Prolific ID from URL (?PROLIFIC_PID=...)
  - Persists assignment and progress in localStorage (placeholder for a real backend)
  - Editor view supports optional AI Chat panel (split 50/50 when AI group)
  - Keystroke logging scaffold & paste prevention hook in editor
  - Minimal Tailwind-based styling (works in this canvas preview)

  How to plug a backend:
  - Replace LocalStats with API calls in StatsService.
  - Replace LocalStorageAssignment with your server-based assignment lock.
  - POST events (keystrokes, timestamps, content) from each view for audit.

  Group keys: "AI-DIV", "AI-CONV", "SELF-DIV", "SELF-CONV"
*/

// Development mode - set to true to disable all timers for faster development
const DEV_MODE = false;

type GroupKey = "AI-DIV" | "AI-CONV" | "SELF-DIV" | "SELF-CONV";

const GROUPS: GroupKey[] = ["AI-DIV", "AI-CONV", "SELF-DIV", "SELF-CONV"];

// ---- Utilities ----
const qs = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
const getProlificIdFromURL = () => qs.get("PROLIFIC_PID") || qs.get("prolific_id") || qs.get("pid") || "ANON";

const todayISO = () => new Date().toISOString();

// ---- Supabase Integration ----
// Call once per participant (idempotent-ish)
// async function ensureParticipant(prolificId: string, group_key: string) {
//   try {
//     if (!supabase || !supabase.from) {
//       console.warn('Supabase client not available, skipping participant creation');
//       return;
//     }
//     await supabase.from('participants').insert({ prolific_id: prolificId, group_key });
//   } catch (error) {
//     console.warn('Failed to create participant:', error);
//   }
// }

// ensureParticipant: use UPSERT so repeated visits don't fail
async function ensureParticipant(prolificId: string, group_key: string) {
  try {
    if (!supabase || !supabase.from) {
      console.warn('Supabase client not available, skipping participant creation');
      return;
    }
    
    // Check if participant already exists
    const { data: existing, error: checkError } = await supabase
      .from('participants')
      .select('prolific_id')
      .eq('prolific_id', prolificId)
      .single();

    if (checkError && checkError.code !== 'PGRST116') { // PGRST116 = no rows returned
      console.error('Error checking participant:', checkError);
      return;
    }

    if (existing) {
      console.log('participants already exists, skipping insert');
      return;
    }

    // Only insert if participant doesn't exist
    const { error } = await supabase
      .from('participants')
      .insert({ prolific_id: prolificId, group_key, is_banned: false });

    if (error) {
      console.log('participants insert:', error.message);
    } else {
      console.log('participants insert: OK');
    }
  } catch (error) {
    console.warn('Failed to create participant:', error);
  }
}

// Ban a participant
async function banParticipant(prolificId: string) {
  try {
    if (!supabase || !supabase.from) {
      console.warn('Supabase client not available, cannot ban participant');
      return;
    }

    console.log('🚫 Attempting to ban participant:', prolificId);

    const { data, error, count } = await supabase
      .from('participants')
      .update({ is_banned: true })
      .eq('prolific_id', prolificId)
      .select();

    console.log('Ban result:', { 
      data, 
      error, 
      count,
      errorCode: error?.code,
      errorMessage: error?.message,
      errorDetails: error?.details,
      errorHint: error?.hint
    });

    if (error) {
      console.error('❌ Failed to ban participant:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
    } else {
      console.log('✅ Participant banned successfully:', prolificId);
      console.log('Updated rows:', data);
    }
  } catch (error) {
    console.error('❌ Exception banning participant:', error);
  }
}


// Start a session (get session_id)
// async function startSession(prolificId: string) {
//   if (!supabase || !supabase.from) {
//     console.warn('Supabase client not available, using mock session ID');
//     return `mock-session-${Date.now()}`;
//   }
//   const { data, error } = await supabase
//     .from('sessions')
//     .insert({ prolific_id: prolificId })
//     .select('id')
//     .single();
//   if (error) throw error;
//   return data.id as string;
// }

// startSession: generate a UUID locally and DO NOT .select()
async function startSession(prolificId: string) {
  const sessionId = crypto.randomUUID(); // avoids SELECT after INSERT
  const { error } = await supabase
    .from('sessions')
    .insert({ id: sessionId, prolific_id: prolificId });

  console.log('sessions insert:', error?.message || 'OK');

  // if (error) {
  //   console.error('sessions insert failed:', error);
  //   throw error;
  // }
  return sessionId;
}


// ---- Snapshot Tracking System ----
const snapshotBuffer: any[] = [];
let flushTimer: number | undefined;

// Save a text snapshot to the database
function saveSnapshot(session_id: string, phase: 'brainstorm'|'writing', textbox: 'main'|'chat', text: string) {
  snapshotBuffer.push({
    session_id,
    timestamp: new Date().toISOString(),
    phase,
    textbox,
    text
  });
  
  // Batch flush snapshots
  if (!flushTimer) {
    flushTimer = window.setTimeout(async () => {
      const batch = snapshotBuffer.splice(0, snapshotBuffer.length);
      flushTimer = undefined;
      if (batch.length && supabase && supabase.from) {
        try {
          await supabase.from('snapshots').insert(batch);
          console.log(`💾 Saved ${batch.length} snapshot(s)`);
        } catch (error) {
          console.error('Failed to flush snapshots:', error);
        }
      } else if (batch.length) {
        console.log('Snapshots buffered (Supabase not available):', batch.length);
      }
    }, 1000);
  }
}

// ---- Placeholder Stats Service (replace with your backend) ----
class LocalStats {
  static COUNTS_KEY = "study_group_counts_v1";
  static COMPLETED_KEY = "study_completed_ids_v1";

  static getCounts(): Record<GroupKey, number> {
    const raw = localStorage.getItem(LocalStats.COUNTS_KEY);
    if (!raw) return { "AI-DIV": 0, "AI-CONV": 0, "SELF-DIV": 0, "SELF-CONV": 0 };
    try {
      const parsed = JSON.parse(raw);
      return { "AI-DIV": 0, "AI-CONV": 0, "SELF-DIV": 0, "SELF-CONV": 0, ...parsed };
    } catch {
      return { "AI-DIV": 0, "AI-CONV": 0, "SELF-DIV": 0, "SELF-CONV": 0 };
    }
  }

  static increment(group: GroupKey) {
    const counts = LocalStats.getCounts();
    counts[group] = (counts[group] || 0) + 1;
    localStorage.setItem(LocalStats.COUNTS_KEY, JSON.stringify(counts));
  }

  static markCompleted(prolificId: string) {
    const raw = localStorage.getItem(LocalStats.COMPLETED_KEY);
    const arr: string[] = raw ? JSON.parse(raw) : [];
    if (!arr.includes(prolificId)) {
      arr.push(prolificId);
      localStorage.setItem(LocalStats.COMPLETED_KEY, JSON.stringify(arr));
    }
  }

  static isCompleted(prolificId: string) {
    const raw = localStorage.getItem(LocalStats.COMPLETED_KEY);
    const arr: string[] = raw ? JSON.parse(raw) : [];
    return arr.includes(prolificId);
  }
}

// ---- Assignment Persistence (placeholder) ----
// ---- Check participant status and handle re-entry ----
async function checkParticipantStatus(prolificId: string): Promise<{
  canProceed: boolean;
  existingGroup?: GroupKey;
  reason?: string;
}> {
  if (!supabase || !supabase.from) {
    console.warn('⚠️ Supabase not available, allowing participant');
    return { canProceed: true };
  }

  try {
    // Check if participant exists in database
    const { data: participant, error: partError } = await supabase
      .from('participants')
      .select('prolific_id, group_key, is_banned')
      .eq('prolific_id', prolificId)
      .single();

    if (partError && partError.code !== 'PGRST116') { // PGRST116 = no rows returned
      console.error('Error checking participant:', partError);
      return { canProceed: true }; // Allow on error
    }

    if (!participant) {
      // New participant - can proceed
      console.log('✨ New participant');
      return { canProceed: true };
    }

    // Check if participant is banned
    if (participant.is_banned) {
      console.log('🚫 Participant is banned');
      return {
        canProceed: false,
        reason: 'banned',
        existingGroup: participant.group_key
      };
    }

    console.log(`📌 Existing participant found: ${prolificId}, group: ${participant.group_key}`);

    // Check if they have a submission (completed study)
    const { data: sessions, error: sessError } = await supabase
      .from('sessions')
      .select('id')
      .eq('prolific_id', prolificId);

    if (sessError) {
      console.error('Error checking sessions:', sessError);
      return { canProceed: true, existingGroup: participant.group_key };
    }

    if (sessions && sessions.length > 0) {
      const sessionIds = sessions.map((s: any) => s.id);

      // Check for submission
      const { data: submission, error: subError } = await supabase
        .from('submissions')
        .select('session_id')
        .in('session_id', sessionIds)
        .limit(1);

      if (subError) {
        console.error('Error checking submissions:', subError);
        return { canProceed: true, existingGroup: participant.group_key };
      }

      if (submission && submission.length > 0) {
        console.log('🚫 Participant has already completed the study');
        return { 
          canProceed: false, 
          reason: 'already_completed',
          existingGroup: participant.group_key
        };
      }

      // Check for writing phase snapshots
      const { data: writingSnapshot, error: snapError } = await supabase
        .from('snapshots')
        .select('session_id')
        .in('session_id', sessionIds)
        .eq('phase', 'writing')
        .limit(1);

      if (snapError) {
        console.error('Error checking snapshots:', snapError);
        return { canProceed: true, existingGroup: participant.group_key };
      }

      if (writingSnapshot && writingSnapshot.length > 0) {
        console.log('🚫 Participant has started writing phase');
        return { 
          canProceed: false, 
          reason: 'writing_started',
          existingGroup: participant.group_key
        };
      }
    }

    // Participant exists but hasn't reached writing phase - allow restart with same group
    console.log('✅ Participant can restart with existing group:', participant.group_key);
    return { canProceed: true, existingGroup: participant.group_key };

  } catch (err) {
    console.error('Error in checkParticipantStatus:', err);
    return { canProceed: true }; // Allow on error
  }
}

// ---- Group randomization with balancing ----
async function assignGroupBalanced(prolificId: string): Promise<GroupKey> {
  // 1) Check participant status
  const status = await checkParticipantStatus(prolificId);
  
  if (!status.canProceed) {
    throw new Error(status.reason || 'cannot_proceed');
  }

  // If participant exists with a group, reuse it
  if (status.existingGroup) {
    console.log(`📌 Reusing existing group assignment for ${prolificId}:`, status.existingGroup);
    return status.existingGroup;
  }

  // 2) New participant - fetch counts from Supabase (actual completion counts)
  let counts: Record<GroupKey, number> = {
    "AI-DIV": 0,
    "AI-CONV": 0,
    "SELF-DIV": 0,
    "SELF-CONV": 0
  };

  if (supabase && supabase.from) {
    try {
      // Query submissions table directly and join to get group_key
      const { data, error } = await supabase
        .from('submissions')
        .select(`
          session_id,
          sessions!inner (
            id,
            prolific_id,
            participants!inner (
              prolific_id,
              group_key
            )
          )
        `);

      console.log('📡 Supabase query response:', { data, error });

      if (error) {
        console.warn('⚠️ Failed to fetch group counts from Supabase:', error.message);
        console.log('Falling back to local counts');
        counts = LocalStats.getCounts();
      } else if (data) {
        // Count completions by group
        const groupCounts: Record<string, number> = {};
        data.forEach((submission: any) => {
          const groupKey = submission.sessions?.participants?.group_key;
          if (groupKey) {
            groupCounts[groupKey] = (groupCounts[groupKey] || 0) + 1;
          }
        });
        
        // Update counts object
        GROUPS.forEach(group => {
          counts[group] = groupCounts[group] || 0;
        });
        
        console.log('✅ Supabase completion counts by group:', counts);
        console.log('📊 Total completions:', data.length);
        console.log('📋 Raw group counts:', groupCounts);
      }
    } catch (err) {
      console.warn('⚠️ Error querying Supabase:', err);
      console.log('Falling back to local counts');
      counts = LocalStats.getCounts();
    }
  } else {
    console.warn('⚠️ Supabase not available, using local counts');
    counts = LocalStats.getCounts();
  }

  console.log('📊 Current group counts:', counts);

  // 3) Find min count groups, break ties randomly
  const min = Math.min(...GROUPS.map((g) => counts[g] || 0));
  const candidates = GROUPS.filter((g) => (counts[g] || 0) === min);
  
  console.log(`🎲 Minimum count: ${min}, Candidates:`, candidates);
  
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  
  console.log(`✨ Assigned ${prolificId} to group: ${chosen}`);

  return chosen;
}

// ---- Study Flow State ----

type Step = 1 | 2 | 3 | 4 | 5; // 1=Instructions, 2=Brainstorm, 3=Editor, 4=Survey

interface SessionMeta {
  prolificId: string;
  group: GroupKey;
  startedAt: string;
}

// ---- Shared Containers ----
const Shell: React.FC<{ title: string; children: React.ReactNode; footer?: React.ReactNode }>=({ title, children, footer }) => (
  <div className="min-h-screen bg-gray-50 text-gray-900">
    {DEV_MODE && (
      <div className="bg-red-100 border-b-2 border-red-500 text-red-700 px-4 py-2 text-center font-semibold">
        🚧 DEVELOPMENT MODE - All timers disabled
      </div>
    )}
    <div className="max-w-5xl mx-auto px-4 py-6">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">{title}</h1>
        <div className="text-sm opacity-70">Prolific Study Prototype</div>
      </header>
      <main className="bg-white rounded-2xl shadow p-6">{children}</main>
      {footer && <footer className="mt-6 flex justify-end">{footer}</footer>}
    </div>
  </div>
);

// ---- View 1: Instructions ----
const InstructionsView: React.FC<{ meta: SessionMeta; sessionId?: string | null; onNext: () => void }>=({ meta, sessionId, onNext }) => {
  const [ack, setAck] = useState(false);
  const [showAICheck, setShowAICheck] = useState(false);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [showError, setShowError] = useState(false);
  const [showFinalError, setShowFinalError] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(DEV_MODE ? 0 : 15); // 15 second timer

  const correctAnswer = meta.group.includes("SELF") ? "zero_tolerance" : "ai_when_provided";

  // Timer effect
  React.useEffect(() => {
    if (!DEV_MODE && timeRemaining > 0) {
      const timer = setTimeout(() => setTimeRemaining(prev => prev - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [timeRemaining]);

  const handleNext = async () => {
    if (timeRemaining > 0) return;
    
    if (!showAICheck) {
      setShowAICheck(true);
      return;
    }

    if (selectedOption === correctAnswer) {
      onNext();
    } else {
      if (attempts < 1) {
        setAttempts(prev => prev + 1);
        setShowError(true);
        if (!DEV_MODE) {
          setTimeout(() => setShowError(false), 5000);
        } else {
          setShowError(false); // Immediately hide error in dev mode
        }
      } else {
        // Failed all attempts - ban participant
        await banParticipant(meta.prolificId);
        setShowFinalError(true);
      }
    }
  };

  return (
    <Shell
      title="Instructions"
      footer={
        showFinalError ? null : (
          <div className="flex flex-col items-center gap-3">
            {!showAICheck && timeRemaining > 0 && (
              <div className="text-sm text-gray-500">
                Please read the instructions carefully. You can proceed in {timeRemaining} seconds.
              </div>
            )}
            <button
              onClick={handleNext}
              disabled={!ack || timeRemaining > 0 || (showAICheck && !selectedOption)}
              className={`px-4 py-2 rounded-xl ${
                !ack || timeRemaining > 0 || (showAICheck && !selectedOption)
                  ? 'bg-gray-300 cursor-not-allowed'
                  : 'bg-black text-white'
              }`}
            >
              {showAICheck ? "Continue" : "Begin Study"}
            </button>
          </div>
        )
      }
    >
      <div className="space-y-4">
        {DEV_MODE && (
          <div className="text-sm text-gray-600">
            Participant: <span className="font-mono">{meta.prolificId}</span> · Group: <span className="font-mono">{meta.group}</span>
            {sessionId && (
              <> · Session: <span className="font-mono text-xs">{sessionId}</span></>
            )}
          </div>
        )}
        <p className="leading-relaxed">
          Welcome! You'll complete a short creative writing task for a research study. Your screen time and key presses are
          recorded for research purposes only. Please read the instructions carefully.
        </p>
        
        {/* Instructions */}
        <div className={`rounded-lg border p-4 ${showError ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
          <h3 className="font-semibold mb-2">Instructions:</h3>
          <ul className="list-disc pl-6 space-y-2">
            {meta.group.includes("SELF") ? (
              <li><span className="font-bold">Do not use external AI tools</span> (e.g., Google, ChatGPT). We will be monitoring for prohibited AI usage using keystroke data, attention checks, and your final responses. <span className="font-bold text-red-500">If you are caught using AI, we will reject your submission.</span></li>
            ) : (
              <li>You are provided an in-app AI tool to aid in your creative writing task; in fact you are <span className="font-bold">required to use the AI tool when prompted.</span> However, oftentimes the AI tool will not achieve the quality you desire. We encourage you to use the AI tool as a stepping stone and as a helper, but <span className="font-bold">ultimately you are expected to write your own story.</span> Please do not use external AI tools that we do not provide to you.</li>
            )}
            <li>Stay on the page; progress may not be saved if you navigate away.</li>
            <li>Be thoughtful and authentic in your responses!</li>
          </ul>
        </div>

        {/* Acknowledgment */}
        <label className="inline-flex items-center gap-2 mt-4">
          <input type="checkbox" className="w-4 h-4" checked={ack} onChange={(e)=>setAck(e.target.checked)} />
          <span>I have read and understand the instructions.</span>
        </label>

        {/* Attention Check */}
        {showAICheck && (
          <div className="mt-8 border-t pt-6">
            <div className="text-center">
              <h2 className="text-xl font-bold mb-4">Attention Check</h2>
              <p className="mb-6">Based on the instructions above, what is the policy regarding AI usage in this study?</p>
              
              <div className="flex flex-col gap-3 max-w-xl mx-auto">
                <label className="flex items-center gap-2 p-3 border rounded-lg hover:bg-gray-50 cursor-pointer">
                  <input
                    type="radio"
                    name="ai_policy"
                    value="zero_tolerance"
                    checked={selectedOption === "zero_tolerance"}
                    onChange={(e) => setSelectedOption(e.target.value)}
                  />
                  <span>Zero tolerance - No AI usage allowed at any point</span>
                </label>
                
                <label className="flex items-center gap-2 p-3 border rounded-lg hover:bg-gray-50 cursor-pointer">
                  <input
                    type="radio"
                    name="ai_policy"
                    value="ai_when_provided"
                    checked={selectedOption === "ai_when_provided"}
                    onChange={(e) => setSelectedOption(e.target.value)}
                  />
                  <span>AI usage is only allowed when specifically provided by the study</span>
                </label>
                
                <label className="flex items-center gap-2 p-3 border rounded-lg hover:bg-gray-50 cursor-pointer">
                  <input
                    type="radio"
                    name="ai_policy"
                    value="ai_allowed"
                    checked={selectedOption === "ai_allowed"}
                    onChange={(e) => setSelectedOption(e.target.value)}
                  />
                  <span>AI usage is generally allowed throughout the study</span>
                </label>
              </div>

              {showError && (
                <div className="mt-4 p-4 bg-red-100 border-2 border-red-400 rounded-lg text-red-700">
                  <p className="font-bold">⚠️ Incorrect Answer</p>
                  <p>Please review the instructions above carefully and try again. You have one more attempt.</p>
                </div>
              )}

              {showFinalError && (
                <div className="mt-4 p-4 bg-red-100 border-2 border-red-500 rounded-lg">
                  <p className="text-red-700 font-bold text-lg mb-2">⚠️ Attention Check Failed</p>
                  <p className="text-red-600">
                    You have failed to correctly identify the AI usage policy after multiple attempts.
                    This indicates that you may not have read the instructions carefully enough.
                  </p>
                  <p className="text-red-600 mt-2">
                    Unfortunately, we cannot proceed with the study if participants do not understand the key requirements.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
};

// ---- View 2: Brainstorm ----
const BrainstormView: React.FC<{ onNext: () => void; meta: SessionMeta; value: string; setValue: (s: string)=>void; sessionId?: string | null }>=({ onNext, meta, value, setValue, sessionId }) => {
  const [timeRemaining, setTimeRemaining] = React.useState(DEV_MODE ? 0 : 150); // 5 minutes in seconds
  const [showConfirmation, setShowConfirmation] = React.useState(false);
  const [showReminder, setShowReminder] = React.useState<false | '2min' | '30sec'>(false);
  
  // Brainstorm field states
  const [quick_ideas, set_quick_ideas] = React.useState('')
  const [main_char, set_main_char] = React.useState('')
  const [setting, set_setting] = React.useState('')
  const [conflict, set_conflict] = React.useState('')
  const [resolution, set_resolution] = React.useState('')
  const [plot, set_plot] = React.useState('')
  
  // Ref to track current brainstorm value without re-renders
  const valueRef = React.useRef(value);
  React.useEffect(() => {
    valueRef.current = value;
  }, [value]);

  React.useEffect(() => {
    if (!DEV_MODE && timeRemaining > 0) {
      const timer = setTimeout(() => {
        setTimeRemaining(prev => {
          const newTime = prev - 1;
          // Show reminder at 2:00 and 0:30
          if (newTime === 120) {
            setShowReminder('2min');
            setTimeout(() => setShowReminder(false), 10000);
          } else if (newTime === 30) {
            setShowReminder('30sec');
            setTimeout(() => setShowReminder(false), 10000);
          }
          return newTime;
        });
      }, 1000);
      return () => clearTimeout(timer);
    } else if (!DEV_MODE && timeRemaining === 0) {
      onNext(); // Force proceed when time is up (only in production)
    }
  }, [timeRemaining]);

  // Refs to track current brainstorm values without triggering re-renders
  const brainstormRefs = React.useRef({
    quick_ideas,
    main_char,
    setting,
    conflict,
    resolution,
    plot
  });

  // Keep refs in sync with state
  React.useEffect(() => {
    brainstormRefs.current = {
      quick_ideas,
      main_char,
      setting,
      conflict,
      resolution,
      plot
    };
  }, [quick_ideas, main_char, setting, conflict, resolution, plot]);

  // Periodic snapshot tracking for brainstorm phase - save as JSON
  React.useEffect(() => {
    if (!sessionId) return;
    
    const SNAPSHOT_INTERVAL = 5000; // 5 seconds
    const lastSavedRef = { text: '' };
    
    const snapshotTimer = setInterval(() => {
      // Compile all brainstorm fields into JSON from refs
      const brainstormData = JSON.stringify(brainstormRefs.current);
      
      if (brainstormData !== lastSavedRef.text) {
        saveSnapshot(sessionId, 'brainstorm', 'main', brainstormData);
        lastSavedRef.text = brainstormData;
      }
    }, SNAPSHOT_INTERVAL);
    
    // Save final snapshot on unmount
    return () => {
      clearInterval(snapshotTimer);
      const brainstormData = JSON.stringify(brainstormRefs.current);
      
      if (brainstormData !== lastSavedRef.text) {
        saveSnapshot(sessionId, 'brainstorm', 'main', brainstormData);
      }
    };
  }, [sessionId]); // Only depend on sessionId

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleNext = () => {
    if (!showConfirmation) {
      setShowConfirmation(true);
      return;
    }
    onNext();
  };

  return (
    <Shell
      title="Step 1 · Brainstorm"
      footer={
        <div className="flex flex-col items-center gap-4">
          <div 
            className={`px-6 py-3 rounded-lg font-bold text-lg ${
              timeRemaining <= 30 
                ? 'bg-red-100 text-red-700 border-2 border-red-500' 
                : timeRemaining <= 120 
                  ? 'bg-yellow-100 text-yellow-700 border-2 border-yellow-500'
                  : 'bg-blue-100 text-blue-700 border-2 border-blue-500'
            }`}
          >
            ⏱️ Time Remaining: {formatTime(timeRemaining)}
          </div>
          {showReminder && (
            <div className="bg-yellow-100 border-2 border-yellow-400 text-yellow-700 px-6 py-3 rounded-lg text-base font-semibold animate-pulse">
              {showReminder === '2min'
                ? "⏰ 2 minutes remaining! Start wrapping up your brainstorming."
                : "⚠️ Only 30 seconds left! Finish your thoughts quickly!"}
            </div>
          )}
          {showConfirmation ? (
            <div className="flex flex-col items-center gap-3">
              <p className="text-sm text-gray-600">Are you sure you're done brainstorming?</p>
              <div className="flex gap-3">
                <button 
                  onClick={() => {
                    // Compile brainstorm data as JSON
                    const brainstormData = JSON.stringify({
                      main_char,
                      setting,
                      conflict,
                      resolution,
                      plot
                    });
                    setValue(brainstormData);
                    onNext();
                  }} 
                  className="px-4 py-2 rounded-xl bg-black text-white"
                >
                  Yes, proceed to writing
                </button>
                <button 
                  onClick={() => setShowConfirmation(false)} 
                  className="px-4 py-2 rounded-xl border border-gray-300"
                >
                  No, continue brainstorming
                </button>
              </div>
            </div>
          ) : (
            <button 
              onClick={handleNext} 
              className="px-4 py-2 rounded-xl bg-black text-white"
            >
              Go to Writing
            </button>
          )}
        </div>
      }
    >
      {/* <p className="mb-3 text-sm text-gray-600">Outline your story plan. Remember, your goal is to <span className="font-semibold">{meta.group.includes("DIV")?"win the short story competition with your originality":"get the highest grade possible"}</span>!</p>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={12}
        className="w-full border rounded-xl p-3 focus:outline-none focus:ring"
        placeholder={meta.group.includes("DIV")?"Placeholder...":"Placeholder..."}
      /> */}
      <p className="mb-3 text-sm text-gray-600">Outline your story plan below. Use as many of the boxes as you find necessary. Remember, your goal is to <span className="font-semibold">{meta.group.includes("DIV")?"win the short story competition with your originality":"get the highest grade possible"}</span>!</p>
<div className="flex flex-col gap-4">
<div>
<label className="block mb-1 text-sm font-medium text-gray-700">Quick Ideas</label>
<textarea
value={quick_ideas}
onChange={(e) => set_quick_ideas(e.target.value)}
rows={3}
className="w-full border rounded-xl p-3 focus:outline-none focus:ring"
placeholder="Jot down as many ideas for a story you have."
/>
</div>

<div>
<label className="block mb-1 text-sm font-medium text-gray-700">Main Character</label>
<p className="mb-3 text-sm text-gray-600">Who is your main character? What are their traits?
Additionally, what is your character's goal in the story? What do they want?</p>
<textarea
value={main_char}
onChange={(e) => set_main_char(e.target.value)}
rows={3}
className="w-full border rounded-xl p-3 focus:outline-none focus:ring"
placeholder="Who is your main character?"
/>
</div>

<div>
<label className="block mb-1 text-sm font-medium text-gray-700">Setting</label>
<p className="mb-3 text-sm text-gray-600">Where does this story take place? When does this story take place? What time period does the
story occur over (1 year? 1 day? 20 minutes?)</p>
<textarea
value={setting}
onChange={(e) => set_setting(e.target.value)}
rows={3}
className="w-full border rounded-xl p-3 focus:outline-none focus:ring"
placeholder="Where and when does the story take place?"
/>
</div>

<div>
<label className="block mb-1 text-sm font-medium text-gray-700">Conflict</label>
<p className="mb-3 text-sm text-gray-600">What is the main conflict of this story? How does this conflict
prevent the character from getting what they want? </p>
<textarea
value={conflict}
onChange={(e) => set_conflict(e.target.value)}
rows={3}
className="w-full border rounded-xl p-3 focus:outline-none focus:ring"
placeholder="What problem drives the story?"
/>
</div>

<div>
<label className="block mb-1 text-sm font-medium text-gray-700">Resolution</label>
<p className="mb-3 text-sm text-gray-600">How does the story end? Does the main character achieve their goal? Why or why not? </p>
<textarea
value={resolution}
onChange={(e) => set_resolution(e.target.value)}
rows={3}
className="w-full border rounded-xl p-3 focus:outline-none focus:ring"
placeholder="How is the conflict resolved?"
/>
</div>

<div>
<label className="block mb-1 text-sm font-medium text-gray-700">Plot</label>
<p className="mb-3 text-sm text-gray-600">Now, write out the events of the story. How does the story
get from beginning to end? What happens? How is the resolution reached?</p>
<textarea
value={plot}
onChange={(e) => set_plot(e.target.value)}
rows={3}
className="w-full border rounded-xl p-3 focus:outline-none focus:ring"
placeholder="Summarize the main events or structure."
/>
</div>
</div>
    </Shell>
  );
};

// ---- New View: Prompt ----
const PromptView: React.FC<{ meta: SessionMeta; onNext: () => void }> = ({ meta, onNext }) => {
  const isDiv = meta.group.includes("DIV");
  const [timeRemaining, setTimeRemaining] = React.useState(DEV_MODE ? 0 : 15);
  const [showAttentionCheck, setShowAttentionCheck] = React.useState(false);
  const [selectedOption, setSelectedOption] = React.useState<string | null>(null);
  const [showWarning, setShowWarning] = React.useState(false);
  const correctAnswer = isDiv ? "originality" : "grade";

  React.useEffect(() => {
    if (!DEV_MODE && timeRemaining > 0) {
      const timer = setTimeout(() => setTimeRemaining(prev => prev - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [timeRemaining]);

  const handleProceed = async () => {
    if (timeRemaining > 0) return;
    if (!showAttentionCheck) {
      setShowAttentionCheck(true);
      return;
    }
    if (selectedOption) {
      if (selectedOption === correctAnswer) {
        onNext();
      } else {
        // Failed attention check - ban participant
        await banParticipant(meta.prolificId);
        setShowWarning(true);
      }
    }
  };

  const promptText = isDiv
    ? (
      <>
        <p className="text-lg mb-4 font-semibold">You are participating in a short story competition.</p>
        <p className="mb-2">There are thousands of submissions, so <span className="font-bold">your goal is to stand out</span> as much as possible. 
          Find your voice and be as creative as possible! The short story should be around 300–500 words.</p>
        <p className="mt-4 text-red-600">In other words, your <u>bonus</u> will be determined based on <span className="font-bold">originality and uniqueness.</span></p>
        <table className="w-full my-4 border-collapse">
          <thead>
            <tr>
              <th className="border border-gray-300 p-2 bg-gray-100">Top % Originality</th>
              <th className="border border-gray-300 p-2 bg-gray-100">Bonus</th>
            </tr>
          </thead>
          <tbody>
          <tr>
              <td className="border border-gray-300 p-2">Top 2%</td>
              <td className="border border-gray-300 p-2">$10.00</td>
            </tr>
            <tr>
              <td className="border border-gray-300 p-2">Top 2-10%</td>
              <td className="border border-gray-300 p-2">$7.00</td>
            </tr>
            <tr>
              <td className="border border-gray-300 p-2">Top 10-25%</td>
              <td className="border border-gray-300 p-2">$5.00</td>
            </tr>

          </tbody>
        </table>
        <div className="my-10"></div>
        <p className="mb-2 text-gray-500 italic">
          In the next step, you will be given at most 5 minutes to brainstorm and outline your story plan. Then, you will have at most 20 minutes to write your story. You do not need to use the entire allotted time. After 30 seconds of inactivity, your story will be automatically submitted.
        </p>
      </>
    )
    : (
      <>
        <p className="text-lg mb-4 font-semibold">You are starting an Intro to Writing class.</p>
        <p className="mb-2">Your first assignment is to create a 300-500 word short story. 
          Your goal is to get an A by submitting a high-quality piece of work; there is no limit to the number of A's the teacher gives!</p>
        <p className="mt-4 text-red-600">In other words, your <u>bonus</u> will be determined based on <span className="font-bold">the grade you receive.</span></p>
        <table className="w-full my-4 border-collapse">
          <thead>
            <tr>
              <th className="border border-gray-300 p-2 bg-gray-100">Grade</th>
              <th className="border border-gray-300 p-2 bg-gray-100">Bonus</th>
            </tr>
          </thead>
          <tbody>
          <tr>
              <td className="border border-gray-300 p-2">A</td>
              <td className="border border-gray-300 p-2">$5.00</td>
            </tr>
            <tr>
              <td className="border border-gray-300 p-2">B</td>
              <td className="border border-gray-300 p-2">$3.00</td>
            </tr>
            <tr>
              <td className="border border-gray-300 p-2">C or lower</td>
              <td className="border border-gray-300 p-2">None</td>
            </tr>

          </tbody>
        </table>
        <div className="my-10"></div>
        <p className="mb-2 text-gray-500 italic">
          In the next step, you will be given at most 5 minutes to brainstorm and outline your story plan. Then, you will have at most 20 minutes to write your story. You do not need to use the entire allotted time. After 30 seconds of inactivity, your story will be automatically submitted.
        </p>
        
      </>
    );

  return (
    <Shell
      title="Prompt"
      footer={
        <div className="flex flex-col items-center gap-4">
          {showWarning ? (
            <div className="text-center">
              <div className="bg-red-100 border-2 border-red-500 rounded-lg p-4">
                <p className="text-red-700 font-bold text-lg mb-2">⚠️ Warning: Attention Check Failed</p>
                <p className="text-red-600">
                  Your answer indicates that you did not read the prompt carefully. 
                  This is a serious concern as careful reading is essential for this task.
                </p>
                <p className="text-red-600 mt-2">
                  Unfortunately, we cannot proceed with the study. You have been removed from participation.
                </p>
                <p className="text-red-600 mt-2 text-sm">
                  Please close this window and return the study on Prolific.
                </p>
              </div>
            </div>
          ) : !showAttentionCheck ? (
            <>
              <div className="text-sm text-gray-500">
                Please read the prompt carefully. You can proceed in {timeRemaining} seconds.
              </div>
              <button
                onClick={handleProceed}
                className={`px-4 py-2 rounded-xl ${
                  timeRemaining > 0 ? 'bg-gray-300 cursor-not-allowed' : 'bg-black text-white'
                }`}
                disabled={timeRemaining > 0}
              >
                Continue
              </button>
            </>
          ) : (
            <>
              <div className="text-center mb-4">
                <p className="font-semibold mb-2">Based on the prompt, what is your bonus determined by?</p>
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="bonus"
                      value={isDiv ? "originality" : "grade"}
                      checked={selectedOption === (isDiv ? "originality" : "grade")}
                      onChange={(e) => setSelectedOption(e.target.value)}
                    />
                    {isDiv ? "Originality and uniqueness" : "The grade I receive"}
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="bonus"
                      value={isDiv ? "grade" : "originality"}
                      checked={selectedOption === (isDiv ? "grade" : "originality")}
                      onChange={(e) => setSelectedOption(e.target.value)}
                    />
                    {isDiv ? "The grade I receive" : "Originality and uniqueness"}
                  </label>
                </div>
              </div>
              <button
                onClick={handleProceed}
                className={`px-4 py-2 rounded-xl ${
                  !selectedOption ? 'bg-gray-300 cursor-not-allowed' : 'bg-black text-white'
                }`}
                disabled={!selectedOption}
              >
                Begin Brainstorm
              </button>
            </>
          )}
        </div>
      }
    >
      <div className="prose max-w-none text-center">{promptText}</div>
    </Shell>
  );
};

// ---- Editor: AI Chat (placeholder) ----
const AIChatPanel: React.FC<{ 
  messages: {role:"user"|"assistant"; content:string}[], 
  onSend: (m:string)=>void,
  draft: string,
  setDraft: (s:string)=>void
}>=({ messages, onSend, draft, setDraft })=>{
  return (
    <div className="h-full flex flex-col">
      <div className="font-semibold mb-2">AI Assistant</div>
      <div className="flex-1 border rounded-xl p-3 overflow-y-auto space-y-3">
        {messages.length===0 && (
          <div className="text-sm text-gray-500">Ask the AI for help brainstorming or editing. (Wire up your API in onSend)</div>
        )}
        {messages.map((m, i)=> (
          <div key={i} className={"p-2 rounded-lg " + (m.role==="assistant"?"bg-gray-100":"bg-gray-50 border")}> 
            <div className="text-xs uppercase tracking-wide opacity-60">{m.role}</div>
            <div className="whitespace-pre-wrap">{m.content}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          className="flex-1 border rounded-xl p-2"
          placeholder="Type a message…"
          value={draft}
          onChange={(e)=>setDraft(e.target.value)}
          onKeyDown={(e)=>{ if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); if(draft.trim()) { onSend(draft.trim()); setDraft(""); } } }}
        />
        <button className="px-3 py-2 rounded-xl bg-black text-white" onClick={()=>{ if(draft.trim()){ onSend(draft.trim()); setDraft(""); } }}>Send</button>
      </div>
    </div>
  );
};

// ---- View 3: Editor ----
const EditorView: React.FC<{
  meta: SessionMeta;
  brainstorm: string;
  onNext: (finalText: string, aiTranscript: {role:"user"|"assistant"; content:string}[])=>void;
  sessionId?: string | null;
}> = ({ meta, brainstorm, onNext, sessionId }) => {
  const [text, setText] = useState("");
  const [aiMessages, setAiMessages] = useState<{role:"user"|"assistant"; content:string}[]>([]);
  const [chatDraft, setChatDraft] = useState(""); // Lift chat input state
  const [keys, setKeys] = useState<{t:string; k:string}[]>([]);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const [timeRemaining, setTimeRemaining] = useState(DEV_MODE ? 0 : 20 * 60); // 20 minutes in seconds
  const [showReminder, setShowReminder] = useState<false | '5min' | '1min'>(false);
  const [wordCount, setWordCount] = useState(0);
  const [showConfirmation, setShowConfirmation] = useState(false);
  
  // Update word count whenever text changes
  useEffect(() => {
    const words = text.trim().split(/\s+/).filter(word => word.length > 0);
    setWordCount(words.length);
  }, [text]);

  // Timer effect
  React.useEffect(() => {
    if (!DEV_MODE && timeRemaining > 0) {
      const timer = setTimeout(() => {
        setTimeRemaining(prev => {
          const newTime = prev - 1;
          // Show reminders at 5:00 and 1:00
          if (newTime === 300) {
            setShowReminder('5min');
            setTimeout(() => setShowReminder(false), 10000);
          } else if (newTime === 60) {
            setShowReminder('1min');
            setTimeout(() => setShowReminder(false), 10000);
          }
          return newTime;
        });
      }, 1000);
      return () => clearTimeout(timer);
    } else if (!DEV_MODE && timeRemaining === 0) {
      onNext(text, aiMessages); // Force proceed when time is up (only in production)
    }
  }, [timeRemaining]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const isAI = meta.group.startsWith("AI");

  // Keystroke logging scaffold (for internal tracking)
  useEffect(()=>{
    const handler = (e: KeyboardEvent) => {
      setKeys((prev)=> prev.length < 5000 ? [...prev, { t: new Date().toISOString(), k: e.key }] : prev);
    };
    window.addEventListener("keydown", handler);
    return ()=> window.removeEventListener("keydown", handler);
  }, []);
  
  // Refs to access current values without triggering re-renders
  const textRef = useRef(text);
  const chatDraftRef = useRef(chatDraft);
  
  // Keep refs in sync with state
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  
  useEffect(() => {
    chatDraftRef.current = chatDraft;
  }, [chatDraft]);
  
  // Periodic snapshot tracking for writing phase - saves both main text and chat input every N seconds
  useEffect(() => {
    if (!sessionId) return;
    
    const SNAPSHOT_INTERVAL = 5000; // 5 seconds
    const lastSavedRef = { mainText: '', chatText: '' };
    
    const snapshotTimer = setInterval(() => {
      const currentMainText = textRef.current;
      const currentChatText = chatDraftRef.current;
      
      // Save main text if changed
      if (currentMainText !== lastSavedRef.mainText) {
        saveSnapshot(sessionId, 'writing', 'main', currentMainText);
        lastSavedRef.mainText = currentMainText;
      }
      
      // Save chat text if changed (only for AI groups)
      if (isAI && currentChatText !== lastSavedRef.chatText) {
        saveSnapshot(sessionId, 'writing', 'chat', currentChatText);
        lastSavedRef.chatText = currentChatText;
      }
    }, SNAPSHOT_INTERVAL);
    
    // Save final snapshots on unmount
    return () => {
      clearInterval(snapshotTimer);
      const currentMainText = textRef.current;
      const currentChatText = chatDraftRef.current;
      
      if (currentMainText !== lastSavedRef.mainText) {
        saveSnapshot(sessionId, 'writing', 'main', currentMainText);
      }
      if (isAI && currentChatText !== lastSavedRef.chatText) {
        saveSnapshot(sessionId, 'writing', 'chat', currentChatText);
      }
    };
  }, [sessionId, isAI]); // Only depend on sessionId and isAI

  const sendToAI = async (message: string) => {
    // Placeholder: append user message and a fake assistant reply
    setAiMessages((msgs)=>[...msgs, { role:"user", content: message }]);
    // ---- Replace below with your API call ----
    if (!DEV_MODE) {
      await new Promise((r)=>setTimeout(r, 300));
    }
    setAiMessages((msgs)=>[...msgs, { role:"assistant", content: "[placeholder] API not connected yet. Your note: " + message }]);
  };

  const EditorBox = (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold">Write Your Story</div>
        <div className="flex items-center gap-4">
          <div className={`text-sm ${
            wordCount < 10 || wordCount > 500 
              ? 'text-red-600 font-semibold' 
              : 'text-green-600 font-semibold'
          }`}>
            {wordCount} words
          </div>
          <div className="text-xs text-gray-500">Required length: 300-500 words</div>
        </div>
      </div>
      <textarea
        ref={editorRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e)=>{ e.preventDefault(); }}
        rows={18}
        className="w-full border rounded-xl p-3 focus:outline-none focus:ring h-full"
        placeholder="Write here... (300-500 words)"
        spellCheck="true"
      />
      <div className="mt-3 flex justify-between items-center text-xs text-gray-500">
        <div>Keystrokes captured: {keys.length}</div>
        <div>Note: Copy and paste is disabled</div>
      </div>
    </div>
  );

  return (
    <Shell
      title="Step 2 · Writing"
      footer={
        <div className="flex flex-col items-center gap-4">
          <div 
            className={`px-6 py-3 rounded-lg font-bold text-lg ${
              timeRemaining <= 60 
                ? 'bg-red-100 text-red-700 border-2 border-red-500' 
                : timeRemaining <= 300 
                  ? 'bg-yellow-100 text-yellow-700 border-2 border-yellow-500'
                  : 'bg-blue-100 text-blue-700 border-2 border-blue-500'
            }`}
          >
            ⏱️ Time Remaining: {formatTime(timeRemaining)}
          </div>
          {showReminder && (
            <div className="bg-yellow-100 border-2 border-yellow-400 text-yellow-700 px-6 py-3 rounded-lg text-base font-semibold animate-pulse">
              {showReminder === '5min' 
                ? "⏰ 5 minutes remaining! Start wrapping up your story."
                : "⚠️ Only 1 minute left! Finish your thoughts quickly!"}
            </div>
          )}
          {showConfirmation ? (
            <div className="flex flex-col items-center gap-3">
              <p className="text-sm text-gray-600">Are you sure you want to submit your story?</p>
              <div className="flex gap-3">
                <button 
                  onClick={() => onNext(text, aiMessages)} 
                  className="px-4 py-2 rounded-xl bg-black text-white"
                >
                  Yes, submit story
                </button>
                <button 
                  onClick={() => setShowConfirmation(false)} 
                  className="px-4 py-2 rounded-xl border border-gray-300"
                >
                  No, continue writing
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowConfirmation(true)}
              disabled={wordCount < 10 || wordCount > 500}
              className={`px-4 py-2 rounded-xl ${
                wordCount < 10 || wordCount > 500
                  ? 'bg-gray-300 cursor-not-allowed'
                  : 'bg-black text-white'
              }`}
              title={
                wordCount < 300 
                  ? `Need ${300 - wordCount} more words` 
                  : wordCount > 500 
                    ? `Remove ${wordCount - 500} words` 
                    : ''
              }
            >
              Submit
            </button>
          )}
        </div>
      }
    >
      {isAI ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 min-h-[520px]">
          <div>{EditorBox}</div>
          <div className="border rounded-2xl p-4">
            <AIChatPanel messages={aiMessages} onSend={sendToAI} draft={chatDraft} setDraft={setChatDraft} />
          </div>
        </div>
      ) : (
        <div className="min-h-[520px]">{EditorBox}</div>
      )}
      {/* Brainstorm Outline - Always Visible */}
      <div className="mt-6 border-t pt-4">
        <h3 className="text-lg font-semibold mb-3">Your Brainstorm Outline</h3>
        {(() => {
          try {
            const brainstormData = JSON.parse(brainstorm || '{}');
            return (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                {brainstormData.main_char && (
                  <div className="p-3 bg-blue-50 rounded-lg">
                    <div className="font-semibold text-blue-900 mb-1">Main Character</div>
                    <div className="text-gray-700">{brainstormData.main_char}</div>
                  </div>
                )}
                {brainstormData.setting && (
                  <div className="p-3 bg-green-50 rounded-lg">
                    <div className="font-semibold text-green-900 mb-1">Setting</div>
                    <div className="text-gray-700">{brainstormData.setting}</div>
                  </div>
                )}
                {brainstormData.conflict && (
                  <div className="p-3 bg-orange-50 rounded-lg">
                    <div className="font-semibold text-orange-900 mb-1">Conflict</div>
                    <div className="text-gray-700">{brainstormData.conflict}</div>
                  </div>
                )}
                {brainstormData.resolution && (
                  <div className="p-3 bg-purple-50 rounded-lg">
                    <div className="font-semibold text-purple-900 mb-1">Resolution</div>
                    <div className="text-gray-700">{brainstormData.resolution}</div>
                  </div>
                )}
                {brainstormData.plot && (
                  <div className="p-3 bg-gray-50 rounded-lg md:col-span-2">
                    <div className="font-semibold text-gray-900 mb-1">Plot</div>
                    <div className="text-gray-700">{brainstormData.plot}</div>
                  </div>
                )}
              </div>
            );
          } catch {
            // Fallback for old format (plain text)
            return <pre className="mt-2 bg-gray-50 p-3 rounded-lg whitespace-pre-wrap text-sm">{brainstorm || "(no brainstorm)"}</pre>;
          }
        })()}
      </div>
    </Shell>
  );
};

// ---- View 4: Survey ----
const SurveyView: React.FC<{ meta: SessionMeta; onSubmit: (payload: any)=>void }>=({ meta: _meta, onSubmit })=>{
  const [q1, setQ1] = useState("");
  const [q2, setQ2] = useState("");
  const [q3, setQ3] = useState("");

  return (
    <Shell
      title="Post-Session Survey"
      footer={
        <button className="px-4 py-2 rounded-xl bg-black text-white" onClick={()=> onSubmit({ q1, q2, q3 })}>
          Submit & Finish
        </button>
      }
    >
      <div className="space-y-4">
        <div className="text-sm text-gray-600">Thank you! A few quick questions:</div>
        <label className="block">
          <div className="mb-1 font-medium">How difficult was the task?</div>
          <select className="w-full border rounded-xl p-2" value={q1} onChange={(e)=>setQ1(e.target.value)}>
            <option value="">Select…</option>
            <option>Very easy</option>
            <option>Easy</option>
            <option>Moderate</option>
            <option>Hard</option>
            <option>Very hard</option>
          </select>
        </label>
        <label className="block">
          <div className="mb-1 font-medium">Briefly describe your approach:</div>
          <textarea className="w-full border rounded-xl p-2" rows={5} value={q2} onChange={(e)=>setQ2(e.target.value)} />
        </label>
        <label className="block">
          <div className="mb-1 font-medium">Any feedback on the interface?</div>
          <textarea className="w-full border rounded-xl p-2" rows={4} value={q3} onChange={(e)=>setQ3(e.target.value)} />
        </label>
      </div>
    </Shell>
  );
};

// ---- Root App ----
const StudyApp: React.FC = () => {
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState<Step>(1);
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null); // Track if participant is blocked
  const [brainstorm, setBrainstorm] = useState("");
  const [finalText, setFinalText] = useState("");
  const [aiTranscript, setAiTranscript] = useState<{role:"user"|"assistant"; content:string}[]>([]);
  const [attentionMeta, setAttentionMeta] = useState<any>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Attention tracking for editor step only
  const attn = useWritingAttention(step === 4, {
    graceMs: 3000,
    halfLifeMs: 12000,
    nudgeThreshold: 0.5,
    finalThreshold: 0.35,
    maxNudges: 2,
  });

  // Boot: capture prolific id, assign group, and start Supabase session
  const initRef = useRef(false); // Prevent duplicate initialization
  
  useEffect(() => {
    // Guard against double-initialization (React Strict Mode in dev)
    if (initRef.current) {
      console.log('⚠️ Skipping duplicate initialization (React Strict Mode)');
      return;
    }
    initRef.current = true;
    
    const init = async () => {
      try {
        const prolificId = getProlificIdFromURL();
        
        // Debug: Check environment variables
        console.log('🔍 Debug Info:');
        console.log('VITE_SUPABASE_URL:', import.meta.env.VITE_SUPABASE_URL ? '✅ Set' : '❌ Missing');
        console.log('VITE_SUPABASE_ANON:', import.meta.env.VITE_SUPABASE_ANON ? '✅ Set' : '❌ Missing');
        console.log('Supabase client:', supabase ? '✅ Created' : '❌ Failed');
        
        // Check participant status and assign group
        const group = await assignGroupBalanced(prolificId);
        const startedAt = todayISO();
        
        // Ensure participant exists in database and start session
        await ensureParticipant(prolificId, group);
        const sid = await startSession(prolificId);
        console.log('Session ID:', sid);
        
        setMeta({ prolificId, group, startedAt });
        setSessionId(sid);
        setLoaded(true);
      } catch (error: any) {
        console.error('❌ Failed to initialize session:', error);
        
        // Check if participant is blocked
        if (error.message === 'already_completed' || error.message === 'writing_started' || error.message === 'banned') {
          console.log('🚫 Participant blocked:', error.message);
          setBlocked(error.message);
          setLoaded(true);
        } else {
          console.error('Error details:', error);
          // For other errors, try fallback
          const prolificId = getProlificIdFromURL();
          const group = await assignGroupBalanced(prolificId);
          const startedAt = todayISO();
          setMeta({ prolificId, group, startedAt });
          setLoaded(true);
        }
      }
    };
    init();
  }, []);

  const onFinishSurvey = async (survey: any) => {
    if (!meta) return;
    
    try {
      // Flush any remaining snapshots before completing
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      if (snapshotBuffer.length > 0 && sessionId && supabase && supabase.from) {
        try {
          await supabase.from('snapshots').insert(snapshotBuffer.splice(0, snapshotBuffer.length));
          console.log('💾 Final snapshots saved');
        } catch (error) {
          console.error('Failed to flush final snapshots:', error);
        }
      }
      
      // Submit final data to Supabase
      if (sessionId) {
        const wordCount = finalText.trim().split(/\s+/).filter(word => word.length > 0).length;
        
        console.log('🔄 Submitting to Supabase...');
        console.log('Session ID:', sessionId);
        console.log('Word count:', wordCount);
        console.log('Final text length:', finalText.length);
        
        if (supabase && supabase.from) {
          const submissionResult = await supabase.from('submissions').insert({
            session_id: sessionId,
            brainstorm_text: brainstorm, // This is now a JSON string with structured brainstorm data
            final_text: finalText,
            word_count: wordCount,
            attention_meta: attentionMeta,   // include finalStrike etc.
            survey_responses: survey,
            ai_transcript: aiTranscript,
          });

          if (submissionResult.error) {
            console.error('❌ Submission failed:', submissionResult.error);
          } else {
            console.log('✅ Submission successful:', submissionResult.data);
          }

          // Mark session as finished
          const sessionResult = await supabase.from('sessions')
            .update({ finished_at: new Date().toISOString() })
            .eq('id', sessionId);
            
          if (sessionResult.error) {
            console.error('❌ Session update failed:', sessionResult.error);
          } else {
            console.log('✅ Session marked as finished');
          }
        } else {
          console.warn('⚠️ Supabase not available, data saved locally only');
        }
      } else {
        console.error('❌ No session ID available for submission');
      }
      
      // Persist locally and update balancing counts as a placeholder for server submission
      LocalStats.increment(meta.group);
      LocalStats.markCompleted(meta.prolificId);

      // Bundle session payload (for console logging/debugging)
      const payload = {
        meta,
        sessionId, // Include Supabase session ID
        brainstorm,
        finalText,
        aiTranscript,
        survey,
        attentionMeta, // Include attention tracking data
        finishedAt: todayISO(),
      };
      console.log("[SUBMIT] session payload", payload);

    } catch (error) {
      console.error('❌ Failed to submit study data:', error);
      // Still proceed to completion screen even if submission fails
    }

    // Confirmation view (inline)
    setStep(4.1 as any); // pseudo-step for completion screen
  };

  const CompletionScreen = (
    <Shell title="All set!">
      <div className="prose max-w-none">
        <h2 className="text-xl font-semibold">Thanks for participating! 🎉</h2>
        <p>Your responses have been recorded. You can now return to Prolific.</p>
        {meta?.prolificId && (
          <p className="text-sm text-gray-600">Prolific ID: <span className="font-mono">{meta.prolificId}</span></p>
        )}
      </div>
    </Shell>
  );

  // Blocked participant screen
  const BlockedScreen = (
    <Shell title={blocked === 'banned' ? 'Access Denied' : 'Already Participated'}>
      <div className="prose max-w-none">
        {blocked === 'banned' ? (
          <>
            <h2 className="text-xl font-semibold text-red-600">Study Access Denied</h2>
            <p className="text-red-600">
              You have been removed from this study due to failing attention checks.
            </p>
            <p className="text-gray-600">
              Please close this window and return the study on Prolific.
            </p>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold text-red-600">Study Already Completed</h2>
            <p>
              Our records show that you have already {blocked === 'already_completed' ? 'completed' : 'started'} this study.
              Each participant can only complete the study once.
            </p>
            <p className="text-gray-600">
              Thank you for your interest! Please return to Prolific and mark this study as complete if you have already submitted it.
            </p>
            <div className="mt-6 p-4 bg-blue-50 rounded-lg">
              <p className="text-sm font-semibold">If you believe this is an error:</p>
              <p className="text-sm">Please contact the researcher with your Prolific ID.</p>
            </div>
          </>
        )}
      </div>
    </Shell>
  );

  if (!loaded) return <div className="p-6 text-gray-500">Loading…</div>;
  
  if (blocked) return BlockedScreen;
  
  if (!meta) return <div className="p-6 text-gray-500">Loading…</div>;

  if ((step as any) === 4.1) return CompletionScreen;

  return (
    <div className="min-h-screen">
      {step === 1 && <InstructionsView meta={meta} sessionId={sessionId} onNext={()=> setStep(2)} />}
      {step === 2 && <PromptView meta={meta} onNext={() => setStep(3)} />}
      {/* {step === 3 && <BrainstormView meta={meta} value={brainstorm} setValue={setBrainstorm} onNext={()=> setStep(4)} />}
      {step === 4 && (
        <EditorView meta={meta} brainstorm={brainstorm} onNext={(t, a)=>{ setFinalText(t); setAiTranscript(a); setStep(5); }} />
      )}
      {step === 5 && <SurveyView meta={meta} onSubmit={onFinishSurvey} />} */}

{step === 3 && (
  <ComplianceGate 
  onViolation={(n) => console.log("Violation", n)}>
    <BrainstormView meta={meta} value={brainstorm} setValue={setBrainstorm} sessionId={sessionId} onNext={()=> setStep(4)} />
  </ComplianceGate>
)}



{step === 4 && (
  <ComplianceGate onViolation={(n)=>console.log("Violation", n)}>
    {/* Development mode attention score display */}
    {DEV_MODE && (
      <div className="fixed top-16 right-4 z-50 bg-gray-900 text-white p-3 rounded-lg text-sm font-mono shadow-lg">
        <div className="text-xs text-gray-300 mb-1">Attention Score (Dev Mode)</div>
        <div className="flex items-center gap-2">
          <div className="w-20 h-2 bg-gray-700 rounded-full overflow-hidden">
            <div 
              className={`h-full transition-all duration-300 ${
                attn.score > 0.7 ? 'bg-green-500' : 
                attn.score > 0.4 ? 'bg-yellow-500' : 'bg-red-500'
              }`}
              style={{ width: `${attn.score * 100}%` }}
            />
          </div>
          <span className="text-xs">{(attn.score * 100).toFixed(1)}%</span>
        </div>
        <div className="text-xs text-gray-400 mt-1">
          Nudges: {attn.nudges} | Worst: {(attn.worstScore * 100).toFixed(1)}%
        </div>
        {attn.showFinalWarning && (
          <div className="text-xs text-amber-400 mt-1">⚠️ Final Warning Active</div>
        )}
        {attn.finalStrike && (
          <div className="text-xs text-red-400 mt-1">🚨 Final Strike!</div>
        )}
      </div>
    )}

    {/* attention banners/toasts */}
    {attn.showFinalWarning && (
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-40 bg-amber-100 text-amber-900 border border-amber-300 px-4 py-2 rounded-lg text-sm shadow">
        Final warning: keep engaging (typing, moving the mouse). If your attention drops again, your submission may be flagged.
      </div>
    )}
    {attn.finalStrike && (
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-40 bg-red-100 text-red-700 border border-red-400 px-4 py-2 rounded-lg text-sm shadow">
        Attention dropped again. Your submission will be flagged for review.
      </div>
    )}
    {attn.showNudge && !attn.finalStrike && (
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-black text-white text-xs px-3 py-2 rounded-lg opacity-90">
        Still with us? A quick keystroke or scroll helps.
      </div>
    )}

    {/* Your existing EditorView */}
    <EditorView
      meta={meta}
      brainstorm={brainstorm}
      sessionId={sessionId}
      onNext={(t, a) => {
        // record attention status in your payload
        setFinalText(t);
        setAiTranscript(a);
        // example: store to state to include at submit
        setAttentionMeta({
          attentionScoreAtSubmit: attn.score,
          worstAttentionScore: attn.worstScore,
          nudges: attn.nudges,
          finalWarningShown: attn.showFinalWarning,
          finalStrike: attn.finalStrike, // <-- flag this if you want to invalidate/mark
        });
        setStep(5);
      }}
    />
  </ComplianceGate>
)}

{step === 5 && (
  <ComplianceGate onViolation={(n) => console.log("Violation", n)}>
    <SurveyView meta={meta} onSubmit={onFinishSurvey} />
  </ComplianceGate>
)}

    </div>
  );
};

export default StudyApp;
