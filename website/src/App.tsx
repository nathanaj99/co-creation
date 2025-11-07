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

// Temporarily exclude AI-CONV to balance group sizes
const GROUPS: GroupKey[] = ["AI-CONV", "SELF-DIV", "SELF-CONV"];
// const GROUPS: GroupKey[] = ["AI-DIV", "AI-CONV", "SELF-DIV", "SELF-CONV"]; // Full randomization

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

    // If participant exists in database, they've already started the experiment
    // Check if they're banned first
    if (participant.is_banned) {
      console.log('🚫 Participant is banned');
      return {
        canProceed: false,
        reason: 'banned',
        existingGroup: participant.group_key
      };
    }

    // Participant exists but is not banned - they started and quit the session
    console.log('🚫 Participant exists in database - already started and quit session');
    return {
      canProceed: false,
      reason: 'already_started',
      existingGroup: participant.group_key
    };

  } catch (err) {
    console.error('Error in checkParticipantStatus:', err);
    return { canProceed: true }; // Allow on error
  }
}

// // ---- Group randomization with balancing ----
// async function assignGroupBalanced(prolificId: string): Promise<GroupKey> {

//   // 1) Check participant status
//   const status = await checkParticipantStatus(prolificId);
  
//   if (!status.canProceed) {
//     throw new Error(status.reason || 'cannot_proceed');
//   }
  
//   // Special case: TEST participant always gets AI-DIV
//   if (prolificId.includes('TEST')) {
//     console.log('🧪 TEST participant detected - assigning to AI-CONV');
//     return 'AI-CONV';
//   }


//   // If participant exists with a group, reuse it
//   if (status.existingGroup) {
//     console.log(`📌 Reusing existing group assignment for ${prolificId}:`, status.existingGroup);
//     return status.existingGroup;
//   }

//   // 2) New participant - fetch counts from Supabase (actual completion counts)
//   let counts: Record<GroupKey, number> = {
//     "AI-DIV": 0,
//     "AI-CONV": 0,
//     "SELF-DIV": 0,
//     "SELF-CONV": 0
//   };

//   if (supabase && supabase.from) {
//     try {
//       // Query submissions table directly and join to get group_key
//       // Filter only participants assigned after October 20, 2025
//       const { data, error } = await supabase
//         .from('submissions')
//         .select(`
//           session_id,
//           sessions!inner (
//             id,
//             prolific_id,
//             participants!inner (
//               prolific_id,
//               group_key,
//               assigned_at
//             )
//           )
//         `)
//         .gte('sessions.participants.assigned_at', '2025-10-20T00:00:00');

//       console.log('📡 Supabase query response:', { data, error });

//       if (error) {
//         console.warn('⚠️ Failed to fetch group counts from Supabase:', error.message);
//         console.log('Falling back to local counts');
//         counts = LocalStats.getCounts();
//       } else if (data) {
//         // Count completions by group
//         const groupCounts: Record<string, number> = {};
//         data.forEach((submission: any) => {
//           const groupKey = submission.sessions?.participants?.group_key;
//           if (groupKey) {
//             groupCounts[groupKey] = (groupCounts[groupKey] || 0) + 1;
//           }
//         });
        
//         // Update counts object
//         GROUPS.forEach(group => {
//           counts[group] = groupCounts[group] || 0;
//         });
        
//         console.log('✅ Supabase completion counts by group:', counts);
//         console.log('📊 Total completions:', data.length);
//         console.log('📋 Raw group counts:', groupCounts);
//       }
//     } catch (err) {
//       console.warn('⚠️ Error querying Supabase:', err);
//       console.log('Falling back to local counts');
//       counts = LocalStats.getCounts();
//     }
//   } else {
//     console.warn('⚠️ Supabase not available, using local counts');
//     counts = LocalStats.getCounts();
//   }

//   console.log('📊 Current group counts:', counts);

//   // 3) Find min count groups, break ties randomly
//   const min = Math.min(...GROUPS.map((g) => counts[g] || 0));
//   const candidates = GROUPS.filter((g) => (counts[g] || 0) === min);
  
//   console.log(`🎲 Minimum count: ${min}, Candidates:`, candidates);
  
//   const chosen = candidates[Math.floor(Math.random() * candidates.length)];

//   console.log(`✨ Assigned ${prolificId} to group: ${chosen}`);

//   return chosen;
// }

// ---- Simple random group assignment (no balancing) ----
async function assignSimpleRandom(prolificId: string): Promise<GroupKey> {
  
  // 1) Check participant status
  const status = await checkParticipantStatus(prolificId);
  
  if (!status.canProceed) {
    throw new Error(status.reason || 'cannot_proceed');
  }
  
  // Special case: TEST participant always gets AI-CONV
  if (prolificId.includes('TEST')) {
    console.log('🧪 TEST participant detected - assigning to AI-CONV');
    return 'AI-CONV';
  }

  // Strictly speaking we won't ever use this, because participants who are already assigned will not be able to re-enter the study.
  // If participant exists with a group, reuse it
  if (status.existingGroup) {
    console.log(`📌 Reusing existing group assignment for ${prolificId}:`, status.existingGroup);
    return status.existingGroup;
  }

  // 2) New participant - randomly assign to one of the four groups
  const chosen = GROUPS[Math.floor(Math.random() * GROUPS.length)];
  
  console.log(`✨ Randomly assigned ${prolificId} to group: ${chosen}`);

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
      <header className="mb-6">
        <h1 className="text-2xl font-bold">{title}</h1>
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
  const [timeRemaining, setTimeRemaining] = useState(DEV_MODE ? 0 : 20); // 15 second timer

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
          Welcome! You'll complete a short creative writing task for a research study. {meta.group.includes("SELF") ? 
            "Our goal is to understand how people write stories without the use of AI, in particular how people brainstorm, write first drafts, and refine their stories." 
            : "Our goal is to understand how people write stories with the use of AI, in particular how it might contribute to less diverse stories."
          } Please read the instructions carefully.
        </p>
        
        {/* Instructions */}
        <div className={`rounded-lg border p-4 ${showError ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
          <h3 className="font-semibold mb-2">Instructions:</h3>
          <ul className="list-disc pl-6 space-y-2">
            <li>Be thoughtful and authentic in your responses!</li>
            <li><span className="font-bold">Stay on the session.</span> Once you leave the session, you will not be able to return or start a new session.</li>
            {meta.group.includes("SELF") ? (
              <li><span className="font-bold">Do not use external AI tools</span> (e.g., Google, ChatGPT). We will be monitoring for prohibited AI usage using keystroke data, attention checks, and your final submission. <span className="font-bold text-red-500">If you are caught using AI, we will return your submission.</span></li>
            ) : (
              <li>You are provided an in-app AI tool to aid in your creative writing task; in fact you are <span className="font-bold">required to use the AI tool when prompted.</span> However, oftentimes the AI tool will not achieve the quality you desire. We encourage you to use the AI tool as a stepping stone and as a helper, but <span className="font-bold">ultimately you are responsible for your own story.</span> Please do not use external AI tools that we do not provide to you.</li>
            )}
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
                  <span>Any AI usage is allowed throughout the study</span>
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
                  <p className="text-red-600 mt-3">
                    Please <a href="https://app.prolific.com/submissions/complete?cc=C246RY97" className="text-blue-600 underline font-semibold">click this link</a> to go back to Prolific and return the study. Alternatively, copy and paste this code: <span className="font-mono font-bold">C246RY97</span>.
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
  const [timeRemaining, setTimeRemaining] = React.useState(DEV_MODE ? 0 : 300); // 5 minutes in seconds
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

  // Timer countdown effect
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
    }
  }, [timeRemaining]); // Only depend on timeRemaining
  
  // Auto-advance when timer expires
  React.useEffect(() => {
    if (!DEV_MODE && timeRemaining === 0) {
      // Save brainstorm data when time runs out
      const brainstormData = JSON.stringify({
        main_char,
        setting,
        conflict,
        resolution,
        plot
      });
      setValue(brainstormData);
      onNext(); // Force proceed when time is up (only in production)
    }
  }, [timeRemaining]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Calculate total word count across all fields
  const totalWords = React.useMemo(() => {
    const allText = [main_char, setting, conflict, resolution, plot].join(' ');
    return allText.trim().split(/\s+/).filter(word => word.length > 0).length;
  }, [main_char, setting, conflict, resolution, plot]);

  const handleNext = () => {
    if (!showConfirmation) {
      setShowConfirmation(true);
      return;
    }
    
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
  };

  return (
    <Shell
      title="Step 1 · Brainstorm"
      footer={
        <div className="flex flex-col items-center gap-4">
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
            <>
              {(timeRemaining > 240 || totalWords < 20) && (
                <div className="text-sm text-gray-600 text-center">
                  {timeRemaining > 240 && (
                    <div>Please spend at least 60 seconds brainstorming ({300 - timeRemaining} / 60 seconds)</div>
                  )}
                  {totalWords < 20 && (
                    <div>Please write at least 20 words in your outline ({totalWords} / 20 words)</div>
                  )}
                </div>
              )}
            <button 
              onClick={handleNext} 
                disabled={timeRemaining > 240 || totalWords < 20}
                className={`px-4 py-2 rounded-xl ${
                  timeRemaining > 240 || totalWords < 20
                    ? 'bg-gray-300 cursor-not-allowed text-gray-600'
                    : 'bg-black text-white'
                }`}
                title={
                  timeRemaining > 240 
                    ? `Please wait ${timeRemaining - 240} more seconds`
                    : totalWords < 20
                      ? `Need ${20 - totalWords} more words`
                      : ''
                }
            >
              Go to Writing
            </button>
            </>
          )}
        </div>
      }
    >
      {/* Timer - Fixed to top-right */}
      <div className="fixed top-4 right-4 z-40">
        <div 
          className={`px-4 py-2 rounded-lg font-bold text-base shadow-lg ${
            timeRemaining <= 30 
              ? 'bg-red-100 text-red-700 border-2 border-red-500' 
              : timeRemaining <= 120 
                ? 'bg-yellow-100 text-yellow-700 border-2 border-yellow-500'
                : 'bg-blue-100 text-blue-700 border-2 border-blue-500'
          }`}
        >
          ⏱️ {formatTime(timeRemaining)}
        </div>
      </div>
      
      {/* Story Guidelines Box */}
      <div className="mb-6 p-4 bg-blue-50 border-2 border-blue-300 rounded-xl">
        <h3 className="font-bold text-blue-900 mb-2 text-base">📖 Story Guidelines</h3>
        <p className="text-sm text-blue-900 mb-2">
          To help spark ideas and make your story easier to shape, we've added a few gentle guidelines to focus your creativity:
        </p>
        <ul className="list-disc pl-5 space-y-1 text-sm text-blue-800">
          <li>Write the story from a <span className="font-bold">first-person</span> point of view.</li>
          <li>The story should take place over <span className="font-bold">no more than one day</span>.</li>
          <li>The story should center on a <span className="font-bold">decision or dilemma</span>.</li>
        </ul>
      </div>

      <p className="mb-4 text-sm text-gray-600">Outline your story plan below. Use as many of the boxes as you find necessary. Remember, your goal is to <span className="font-semibold">{meta.group.includes("DIV")?"win the short story competition with your originality":"get the highest grade possible"}</span>! Remember, the story should be <span className="font-semibold">250-350 words.</span></p>

{/* Quick Ideas Section */}
<div className="mb-6">
<h2 className="text-xl font-bold mb-3 text-gray-800">Quick Ideas</h2>
      <textarea
value={quick_ideas}
onChange={(e) => set_quick_ideas(e.target.value)}
onPaste={(e) => e.preventDefault()}
rows={3}
        className="w-full border rounded-xl p-3 focus:outline-none focus:ring"
placeholder="Jot down as many ideas for a story you have."
/>
</div>

{/* Outline Section */}
<div>
<h2 className="text-xl font-bold mb-4 text-gray-800">Outline</h2>
<div className="flex flex-col gap-4">

<div>
<label className="block mb-1 text-sm font-medium text-gray-700">Main Character</label>
<p className="mb-3 text-sm text-gray-600">Who is your main character? What are their traits?
Additionally, what is your character's goal in the story? What do they want?</p>
<textarea
value={main_char}
onChange={(e) => set_main_char(e.target.value)}
onPaste={(e) => e.preventDefault()}
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
onPaste={(e) => e.preventDefault()}
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
onPaste={(e) => e.preventDefault()}
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
onPaste={(e) => e.preventDefault()}
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
onPaste={(e) => e.preventDefault()}
rows={3}
className="w-full border rounded-xl p-3 focus:outline-none focus:ring"
placeholder="Summarize the main events or structure."
/>
</div>

</div> {/* End Outline section */}
</div> {/* End Outline wrapper */}
    </Shell>
  );
};

// ---- New View: Prompt ----
const PromptView: React.FC<{ meta: SessionMeta; onNext: () => void }> = ({ meta, onNext }) => {
  const isDiv = meta.group.includes("DIV");
  const [timeRemaining, setTimeRemaining] = React.useState(DEV_MODE ? 0 : 20);
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
          Find your voice and be as creative as possible! The short story should be 250-350 words.</p>
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
              <td className="border border-gray-300 p-2">$7.00</td>
            </tr>
            <tr>
              <td className="border border-gray-300 p-2">Top 2-10%</td>
              <td className="border border-gray-300 p-2">$4.00</td>
            </tr>
            <tr>
              <td className="border border-gray-300 p-2">Top 10-25%</td>
              <td className="border border-gray-300 p-2">$2.00</td>
            </tr>

          </tbody>
        </table>
        <div className="my-10"></div>
        <p className="mb-2 text-gray-500 italic">
          In the next step, you will be given at most 5 minutes to brainstorm and outline your story plan. Then, you will have at most 20 minutes to write your story. You do not need to use the entire allotted time. After multiple periods of inactivity, we will flag your submission for manual review.
        </p>
      </>
    )
    : (
      <>
        <p className="text-lg mb-4 font-semibold">You are starting an Intro to Writing class.</p>
        <p className="mb-2">Your first assignment is to create a 250-350 word short story. 
          Your goal is to get an A by submitting a high-quality piece of work.</p>
        
        <div className="my-6 p-4 bg-blue-50 border-2 border-blue-300 rounded-xl">
          <h3 className="font-bold text-blue-900 mb-3 text-base">Grading Rubric</h3>
          <p className="text-sm text-blue-900 mb-3">Your story will be evaluated on two aspects:</p>
          
          <div className="bg-white rounded-lg overflow-hidden mb-3">
            <table className="w-full">
              <tbody>
                <tr className="border-b border-gray-200">
                  <td className="p-3 font-semibold text-blue-900 bg-gray-50 align-top w-1/3">
                    1. Organization<br/>
                    <span className="text-xs font-normal text-gray-600">(Narrative Flow)</span>
                  </td>
                  <td className="p-3 pl-6">
                    <ul className="text-xs text-gray-700 space-y-2 text-left">
                      <li><span className="font-semibold">(4 pt) Excellent:</span> Clear beginning, middle, and end with smooth transitions</li>
                      <li><span className="font-semibold">(3 pt) Competent:</span> Logical flow with minor structural issues</li>
                      <li><span className="font-semibold">(2 pt) Basic:</span> Some organization but lacks coherence</li>
                      <li><span className="font-semibold">(1 pt) Does not meet expectations:</span> Disorganized or unclear structure</li>
                    </ul>
                  </td>
                </tr>
                <tr>
                  <td className="p-3 font-semibold text-blue-900 bg-gray-50 align-top w-1/3">
                    2. Technique<br/>
                    <span className="text-xs font-normal text-gray-600">(Grammar, Spelling, Punctuation)</span>
                  </td>
                  <td className="p-3 pl-6">
                    <ul className="text-xs text-gray-700 space-y-2 text-left">
                      <li><span className="font-semibold">(4 pt) Excellent:</span> No errors; demonstrates mastery</li>
                      <li><span className="font-semibold">(3 pt) Competent:</span> Few minor errors that don't impede understanding</li>
                      <li><span className="font-semibold">(2 pt) Basic:</span> Several errors that occasionally distract</li>
                      <li><span className="font-semibold">(1 pt) Does not meet expectations:</span> Frequent errors that impede understanding</li>
                    </ul>
                  </td>
                </tr>
                <tr>
                  <td className="p-3 font-semibold text-blue-900 bg-gray-50 align-top w-1/3">
                    Creativity<br/>
                  </td>
                  <td className="p-3 pl-6">
                    <p className="text-sm text-blue-900 text-left">
                      <span className="font-semibold">Note:</span> You are <span className="font-bold">not graded on creativity or your voice</span>. While creativity and uniqueness are often contributors to good pieces of writing, for now we are only asking for a technically well-written story.
                    </p>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        
        <p className="mt-4 text-red-600">Your <u>bonus</u> will be determined based on <span className="font-bold">the grade you receive:</span></p>
        <table className="w-full my-4 border-collapse">
          <thead>
            <tr>
            <th className="border border-gray-300 p-2 bg-gray-100">Point Range</th>
              <th className="border border-gray-300 p-2 bg-gray-100">Grade</th>
              <th className="border border-gray-300 p-2 bg-gray-100">Bonus</th>
            </tr>
          </thead>
          <tbody>
          <tr>
              <td className="border border-gray-300 p-2">8 points</td>
              <td className="border border-gray-300 p-2">A</td>
              <td className="border border-gray-300 p-2">$2.50</td>
            </tr>
            <tr>
              <td className="border border-gray-300 p-2">6-7 points</td>
              <td className="border border-gray-300 p-2">B</td>
              <td className="border border-gray-300 p-2">$1.00</td>
            </tr>
            <tr>
              <td className="border border-gray-300 p-2">5 points or lower</td>
              <td className="border border-gray-300 p-2">C or lower</td>
              <td className="border border-gray-300 p-2">None</td>
            </tr>

          </tbody>
        </table>
        <div className="my-10"></div>
        <p className="mb-2 text-gray-500 italic">
          In the next step, you will be given at most 5 minutes to brainstorm and outline your story plan. Then, you will have at most 20 minutes to write your story. You do not need to use the entire allotted time. After 30 seconds of inactivity, we will flag your submission for manual review.
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
                <p className="text-red-600 mt-3">
                  Please <a href="https://app.prolific.com/submissions/complete?cc=C246RY97" className="text-blue-600 underline font-semibold">click this link</a> to go back to Prolific and return the study. Alternatively, copy and paste this code: <span className="font-mono font-bold">C246RY97</span>.
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
                      value={isDiv ? "grade" : "originality"}
                      checked={selectedOption === (isDiv ? "grade" : "originality")}
                      onChange={(e) => setSelectedOption(e.target.value)}
                    />
                    {isDiv ? "The grade I receive" : "Originality and uniqueness"}
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="bonus"
                      value={isDiv ? "originality" : "grade"}
                      checked={selectedOption === (isDiv ? "originality" : "grade")}
                      onChange={(e) => setSelectedOption(e.target.value)}
                    />
                    {isDiv ? "Originality and uniqueness": "The grade I receive"}
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
  setDraft: (s:string)=>void,
  isLoading?: boolean,
  queryCount?: number,
  maxQueries?: number
}>=({ messages, onSend, draft, setDraft, isLoading = false, queryCount = 0, maxQueries = 15 })=>{
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [showConfirmSend, setShowConfirmSend] = useState(false);
  
  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages, isLoading]);
  
  const handleSendClick = () => {
    if (draft.trim()) {
      setShowConfirmSend(true);
    }
  };
  
  const confirmSend = () => {
    if (draft.trim()) {
      onSend(draft.trim());
      setDraft("");
    }
    setShowConfirmSend(false);
  };
  
  const cancelSend = () => {
    setShowConfirmSend(false);
  };
  
  const queriesRemaining = maxQueries - queryCount;
  const isLimitReached = queryCount >= maxQueries;
  
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold">AI Assistant</div>
        <div className={`text-xs font-medium ${
          queriesRemaining <= 3 ? 'text-red-600' : 
          queriesRemaining <= 5 ? 'text-orange-600' : 
          'text-gray-600'
        }`}>
          {queriesRemaining} {queriesRemaining === 1 ? 'query' : 'queries'} remaining
        </div>
      </div>
      <div ref={chatContainerRef} className="border rounded-xl p-3 overflow-y-auto space-y-3 max-h-[800px]">
        {messages.length===0 && (
          <div className="text-sm text-gray-500">Ask the AI for a first draft or to edit.</div>
        )}
        {messages.map((m, i)=> (
          <div key={i} className={"p-2 rounded-lg " + (m.role==="assistant"?"bg-gray-100":"bg-gray-50 border")}> 
            <div className="text-xs uppercase tracking-wide opacity-60">{m.role}</div>
            <div className="whitespace-pre-wrap">{m.content}</div>
          </div>
        ))}
        {isLoading && (
          <div className="p-2 rounded-lg bg-gray-100">
            <div className="text-xs uppercase tracking-wide opacity-60">assistant</div>
            <div className="flex items-center gap-2 text-gray-600">
              <div className="flex gap-1">
                <span className="animate-bounce" style={{ animationDelay: '0ms' }}>●</span>
                <span className="animate-bounce" style={{ animationDelay: '150ms' }}>●</span>
                <span className="animate-bounce" style={{ animationDelay: '300ms' }}>●</span>
      </div>
              <span className="text-sm">AI is thinking...</span>
            </div>
          </div>
        )}
        {isLimitReached && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200">
            <div className="text-sm font-semibold text-red-800 mb-1">Query Limit Reached</div>
            <div className="text-sm text-red-700">
              You've used all {maxQueries} AI queries for this session. You can continue writing and editing your story in the main editor.
            </div>
          </div>
        )}
      </div>
      
      {/* Confirmation dialog */}
      {showConfirmSend && (
        <div className="mt-2 p-3 bg-yellow-50 border border-yellow-300 rounded-lg">
          <p className="text-sm font-semibold text-yellow-900 mb-2">Are you sure you want to send this prompt to the AI?</p>
          <div className="flex gap-2">
            <button 
              className="px-3 py-1 rounded-lg bg-black text-white text-sm"
              onClick={confirmSend}
            >
              Yes, send
            </button>
            <button 
              className="px-3 py-1 rounded-lg border border-gray-300 text-gray-700 text-sm"
              onClick={cancelSend}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      
      <div className="mt-3 flex gap-2">
        <textarea
          className="flex-1 border rounded-xl p-2 resize-y min-h-[60px] max-h-[300px]"
          placeholder={isLimitReached ? "Query limit reached" : "Type a message… (press Enter for new line)"}
          value={draft}
          onChange={(e)=>setDraft(e.target.value)}
          rows={3}
          disabled={isLoading || isLimitReached}
        />
        <button 
          className={`px-3 py-2 rounded-xl ${
            !draft.trim() || isLoading || isLimitReached
              ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
              : 'bg-black text-white'
          }`}
          onClick={handleSendClick}
          disabled={!draft.trim() || isLoading || isLimitReached}
          title={isLimitReached ? `Query limit reached (${maxQueries}/${maxQueries})` : ''}
        >
          {isLoading ? 'Sending...' : isLimitReached ? 'Limit Reached' : 'Send'}
        </button>
      </div>
      
      {/* AI Prompting Tips - Collapsible */}
      <details className="mt-3 p-3 bg-gray-50 rounded-lg text-xs text-gray-700">
        <summary className="font-semibold cursor-pointer hover:text-gray-900">💡 Tips for prompting the AI (click to expand)</summary>
        <ul className="mt-2 space-y-2 text-gray-600">
          <li className="ml-4">
            <div>"In 250-350 words, write a short story with the following elements:</div>
            <div className="ml-4 mt-1 space-y-1">
              <div>- Setting: [your setting]</div>
              <div>- Main character: [your main character]</div>
              <div>- Conflict: [your conflict]</div>
            </div>
            <div className="mt-1">Make sure to write in first person and unfold the story over a single day."</div>
          </li>
          <li className="ml-4">"Rewrite this paragraph in a more [dramatic/humorous/suspenseful] tone: [paragraph]"</li>
        </ul>
      </details>
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
  const [isAILoading, setIsAILoading] = useState(false); // Track if AI is responding
  const [aiQueryCount, setAiQueryCount] = useState(0); // Track number of AI queries sent
  const MAX_AI_QUERIES = 15; // Maximum number of AI queries allowed per session
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const TOTAL_TIME = DEV_MODE ? 30 : 20 * 60; // DEV: 1 minute, PROD: 20 minutes
  const MIN_TIME_REQUIRED = DEV_MODE ? 15 : 5 * 60; // DEV: 15 seconds, PROD: 5 minutes (25% of total time)
  const [timeRemaining, setTimeRemaining] = useState(TOTAL_TIME);
  const [showReminder, setShowReminder] = useState<false | '5min' | '1min'>(false);
  const [wordCount, setWordCount] = useState(0);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [hasUsedAI, setHasUsedAI] = useState(false); // Track if user has interacted with AI
  const [showEditorEnabledMessage, setShowEditorEnabledMessage] = useState(false); // Show the enabled message
  const [showBrainstormOutline, setShowBrainstormOutline] = useState(true); // Control brainstorm visibility
  const [showTimeExpiredWarning, setShowTimeExpiredWarning] = useState(false); // Show warning when time is up but word count invalid
  const [showWordCountWarning, setShowWordCountWarning] = useState<false | '10min' | '5min' | '2min'>(false); // Word count warnings at intervals
  const timeoutHandledRef = useRef(false); // Track if we've already handled timer expiration
  const [graceTimeRemaining, setGraceTimeRemaining] = useState<number | null>(null); // Grace period timer (3 minutes)
  const graceTimeoutHandledRef = useRef(false); // Track if we've handled grace period expiration
  
  // Update word count whenever text changes
  useEffect(() => {
    const words = text.trim().split(/\s+/).filter(word => word.length > 0);
    setWordCount(words.length);
    
    // Clear regular word count warnings (but not grace period)
    const isValidWordCount = words.length >= 250 && words.length <= 385;
    if (isValidWordCount) {
      if (showWordCountWarning) {
        setShowWordCountWarning(false);
      }
    }
  }, [text, showWordCountWarning]);

  // Timer countdown effect
  React.useEffect(() => {
    if (timeRemaining > 0) {
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
          
          // Show word count warnings at 10:00, 5:00, and 2:00 if word count is invalid
          const isWordCountInvalid = wordCount < 250 || wordCount > 350;
          if (isWordCountInvalid) {
            if (newTime === 600) { // 10 minutes
              setShowWordCountWarning('10min');
              setTimeout(() => setShowWordCountWarning(false), 30000); // Show for 30 seconds
            } else if (newTime === 300) { // 5 minutes
              setShowWordCountWarning('5min');
              setTimeout(() => setShowWordCountWarning(false), 30000);
            } else if (newTime === 120) { // 2 minutes
              setShowWordCountWarning('2min');
              setTimeout(() => setShowWordCountWarning(false), 30000);
            }
          }
          
          return newTime;
        });
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [timeRemaining, wordCount]);

  // Handle timer expiration (separate effect to avoid re-triggering)
  React.useEffect(() => {
    if (timeRemaining === 0 && !timeoutHandledRef.current) {
      timeoutHandledRef.current = true; // Mark as handled
      
      // Only force proceed if word count is valid (at least 250 words, allow slightly over 350)
      if (wordCount >= 250 && wordCount <= 385) {
        onNext(text, aiMessages);
    } else {
        // If word count is invalid, show warning and start grace period
        setShowTimeExpiredWarning(true);
        setGraceTimeRemaining(DEV_MODE ? 30 : 3 * 60); // DEV: 30 seconds, PROD: 3 minutes grace period
      }
    }
  }, [timeRemaining, wordCount, text, aiMessages, onNext]);

  // Grace period timer countdown
  React.useEffect(() => {
    if (graceTimeRemaining !== null && graceTimeRemaining > 0) {
      const timer = setTimeout(() => {
        setGraceTimeRemaining(prev => prev! - 1);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [graceTimeRemaining]);

  // Handle grace period expiration - force submit regardless of word count
  React.useEffect(() => {
    if (graceTimeRemaining === 0 && !graceTimeoutHandledRef.current) {
      graceTimeoutHandledRef.current = true;
      
      // Force submit regardless of word count
      onNext(text, aiMessages);
    }
  }, [graceTimeRemaining, wordCount, text, aiMessages, onNext]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const isAI = meta.group.startsWith("AI");

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
    // Check if query limit has been reached
    if (aiQueryCount >= MAX_AI_QUERIES) {
      console.warn('⚠️ AI query limit reached');
      return; // Don't send if limit reached
    }
    
    // Increment query count
    setAiQueryCount(prev => prev + 1);
    
    // Mark that user has interacted with AI
    if (!hasUsedAI) {
      setHasUsedAI(true);
      setShowEditorEnabledMessage(true);
      // Hide message after 30 seconds
      setTimeout(() => {
        setShowEditorEnabledMessage(false);
      }, 30000);
    }
    
    // Save snapshot of the chat prompt when user submits
    if (sessionId) {
      saveSnapshot(sessionId, 'writing', 'chat', message);
    }
    
    // Add user message to chat
    setAiMessages((msgs)=>[...msgs, { role:"user", content: message }]);
    
    // Set loading state
    setIsAILoading(true);
    
    // Call OpenAI API
    try {
      const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY || 'YOUR_OPENAI_API_KEY_HERE';
      
      if (!OPENAI_API_KEY || OPENAI_API_KEY === 'YOUR_OPENAI_API_KEY_HERE') {
        console.warn('⚠️ OpenAI API key not configured');
        setAiMessages((msgs)=>[...msgs, { 
          role:"assistant", 
          content: "[Error: OpenAI API key not configured. Please add VITE_OPENAI_API_KEY to your .env file]" 
        }]);
        return;
      }
      
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-5-mini',
          messages: [
            {
              role: 'system',
              content: `Role and Objective:
- Serve as a helpful assistant guiding the user to write a short story.

Instructions:
- Follow the user's requests: it could be to write a first draft, to make edits, or other requests.
- The story must be composed from a first-person point of view.
- The story should unfold within a single day (no more than 24 hours).

Verbosity and Reasoning Effort:
- Keep guidance and explanations brief. Set reasoning_effort = low.`
            },
            ...aiMessages.map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: message }
          ]
        })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'API request failed');
      }
      
      const data = await response.json();
      const assistantMessage = data.choices[0]?.message?.content || 'No response from AI';
      
      setAiMessages((msgs)=>[...msgs, { role:"assistant", content: assistantMessage }]);
      
    } catch (error) {
      console.error('❌ OpenAI API error:', error);
      setAiMessages((msgs)=>[...msgs, { 
        role:"assistant", 
        content: `[Error communicating with AI: ${error instanceof Error ? error.message : 'Unknown error'}]` 
      }]);
    } finally {
      // Always clear loading state
      setIsAILoading(false);
    }
  };

  const EditorBox = (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold">Write Your Story</div>
        <div className="flex items-center gap-4">
          <div className={`text-sm ${
            wordCount < 250 || wordCount > 350 
              ? 'text-red-600 font-semibold' 
              : 'text-green-600 font-semibold'
          }`}>
            {wordCount} words
          </div>
          <div className="text-xs text-gray-500">Required length: 250-350 words</div>
        </div>
      </div>
      {isAI && !hasUsedAI && !DEV_MODE && (
        <div className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm">
          <p className="text-blue-900 font-semibold mb-1">📝 Please start with the AI Assistant</p>
          <p className="text-blue-800">Use the AI panel on the right to generate a first draft or story components before editing here.</p>
        </div>
      )}
      {isAI && hasUsedAI && showEditorEnabledMessage && (
        <div className="mb-3 p-3 bg-green-50 border border-green-200 rounded-lg text-sm">
          <p className="text-green-900 font-semibold mb-1">✅ Main editor now enabled</p>
          <p className="text-green-800">
            You can now edit, revise, or write your own story. Remember:
            <br/>• You're <span className="font-semibold">not required</span> to use the AI-generated content
            <br/>• You can continue using the AI to edit, refine, or create new drafts with different tones
          </p>
        </div>
      )}
      <textarea
        ref={editorRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e)=>{ 
          // Allow paste for AI groups, prevent for SELF groups
          if (!isAI) {
            e.preventDefault(); 
          }
        }}
        rows={18}
        className="w-full border rounded-xl p-3 focus:outline-none focus:ring h-full"
        placeholder={isAI && !hasUsedAI && !DEV_MODE ? "Please use the AI Assistant first..." : "Write here... (250-350 words)"}
        spellCheck="true"
        disabled={isAI && !hasUsedAI && !DEV_MODE}
        style={isAI && !hasUsedAI && !DEV_MODE ? { backgroundColor: '#f9fafb', cursor: 'not-allowed' } : {}}
      />
      <div className="mt-3 flex justify-end items-center text-xs text-gray-500">
        <div>{isAI ? 'Note: Copy and paste is allowed only within the page' : 'Note: Copy and paste is disabled'}</div>
      </div>
    </div>
  );

  return (
    <Shell
      title="Step 2 · Writing"
      footer={
        <div className="flex flex-col items-center gap-4">
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
            <>
              {/* Show validation messages only if not in grace period or if word count is still < 250 */}
              {!graceTimeRemaining && (timeRemaining > MIN_TIME_REQUIRED || wordCount < 250 || wordCount > 350) && (
                <div className="text-sm text-gray-600 text-center">
                  {timeRemaining > MIN_TIME_REQUIRED && (
                    <div>Please spend at least {DEV_MODE ? '15 seconds' : '5 minutes'} writing ({TOTAL_TIME - timeRemaining} / {MIN_TIME_REQUIRED} seconds)</div>
                  )}
                  {wordCount < 250 && (
                    <div>Required: 250-350 words (currently {wordCount} words)</div>
                  )}
                  {wordCount > 350 && (
                    <div>Please reduce to 350 words or less (currently {wordCount} words)</div>
                  )}
                </div>
              )}
              {graceTimeRemaining && wordCount < 250 && (
                <div className="text-sm text-red-600 text-center font-semibold">
                  ⚠️ Need at least {250 - wordCount} more words to submit now
                </div>
              )}
            <button
              onClick={() => setShowConfirmation(true)}
              disabled={
                (timeRemaining > MIN_TIME_REQUIRED) || 
                (wordCount < 250) || 
                (graceTimeRemaining && wordCount > 385) ||
                (!graceTimeRemaining && wordCount > 350)
              }
              className={`px-4 py-2 rounded-xl ${
                (timeRemaining > MIN_TIME_REQUIRED) || 
                (wordCount < 250) || 
                (graceTimeRemaining && wordCount > 385) ||
                (!graceTimeRemaining && wordCount > 350)
                  ? 'bg-gray-300 cursor-not-allowed'
                  : 'bg-black text-white'
              }`}
              title={
                timeRemaining > MIN_TIME_REQUIRED
                  ? `Please wait ${timeRemaining - MIN_TIME_REQUIRED} more seconds`
                  : wordCount < 250 
                    ? `Need ${250 - wordCount} more words` 
                    : (graceTimeRemaining && wordCount > 385)
                      ? `Story is too long (${wordCount} words). Grace period allows up to 385 words.`
                    : (!graceTimeRemaining && wordCount > 350)
                      ? `Reduce to 350 words or less` 
                    : ''
              }
            >
              Submit
            </button>
            </>
          )}
        </div>
      }
    >
      {/* Timer and Warnings - Fixed to top-right */}
      <div className="fixed top-4 right-4 z-40 flex flex-col items-end gap-3 max-w-md">
        {/* Grace Period Warning - Highest priority */}
        {showTimeExpiredWarning && graceTimeRemaining !== null && graceTimeRemaining > 0 && (
          <div className={`p-4 border-2 rounded-xl shadow-2xl ${
            wordCount >= 250 && wordCount <= 385 
              ? 'bg-green-100 border-green-500 text-green-900'
              : 'bg-orange-100 border-orange-500 text-orange-900'
          }`}>
            <div className="text-lg font-bold mb-2">
              {wordCount >= 250 && wordCount <= 385 ? (
                <>✅ Ready to Submit!</>
              ) : (
                <>⏰ Time&apos;s Up! Grace Period</>
              )}
            </div>
            <div className="mb-2 text-sm">
              {wordCount >= 250 && wordCount <= 385 ? (
                <span className="text-green-800">Word count is valid. You can submit!</span>
              ) : (
                <span>Story must be <span className="font-bold">250-385 words</span>.</span>
              )}
            </div>
            <div className="mb-2 text-sm">
              {wordCount < 250 && (
                <span className="text-red-700 font-bold">⚠️ Need {250 - wordCount} more words!</span>
              )}
              {wordCount >= 250 && wordCount <= 385 && (
                <span className="text-green-700 font-bold">✓ {wordCount} words</span>
              )}
              {wordCount > 385 && (
                <span className="text-orange-700 font-bold">Remove {wordCount - 385} words</span>
              )}
            </div>
            <div className={`font-bold text-base ${
              wordCount >= 250 && wordCount <= 385 ? 'text-green-700' : 'text-red-700'
            }`}>
              ⏱️ Grace: {formatTime(graceTimeRemaining!)}
            </div>
            <div className="text-xs mt-1">
              {wordCount >= 250 && wordCount <= 385 ? (
                <span className="text-green-800">Submit anytime.</span>
              ) : (
                <span className={wordCount >= 250 && wordCount <= 385 ? 'text-green-800' : 'text-orange-800'}>
                  Auto-submit when timer expires.
                </span>
              )}
            </div>
          </div>
        )}
        
        {/* Word Count Warning - High priority (if no grace period) */}
        {showWordCountWarning && !showTimeExpiredWarning && (
          <div className="p-4 bg-red-100 border-2 border-red-600 text-red-900 rounded-xl shadow-2xl">
            <div className="text-lg font-bold mb-2 flex items-center gap-2">
              <span className="text-xl">⚠️</span>
              <span>
                {showWordCountWarning === '10min' && '10 min left!'}
                {showWordCountWarning === '5min' && '5 min left!'}
                {showWordCountWarning === '2min' && '2 min left!'}
              </span>
            </div>
            <div className="text-sm mb-2">
              Story MUST be <span className="font-bold">250-350 words</span>!
            </div>
            <div className="text-sm font-semibold">
              Current: <span className="text-base">{wordCount} words</span>
              {wordCount < 250 && <span className="text-red-700"> (Need {250 - wordCount} more)</span>}
              {wordCount > 350 && <span className="text-red-700"> (Remove {wordCount - 350})</span>}
            </div>
          </div>
        )}
        
        {/* Timer */}
        <div 
          className={`px-4 py-2 rounded-lg font-bold text-base shadow-lg ${
            timeRemaining <= 60 
              ? 'bg-red-100 text-red-700 border-2 border-red-500' 
              : timeRemaining <= 300 
                ? 'bg-yellow-100 text-yellow-700 border-2 border-yellow-500'
                : 'bg-blue-100 text-blue-700 border-2 border-blue-500'
          }`}
        >
          ⏱️ {formatTime(timeRemaining)}
        </div>
        
        {/* Time reminder below timer */}
        {showReminder && !showTimeExpiredWarning && (
          <div className="px-4 py-2 rounded-lg text-sm font-semibold shadow-lg bg-yellow-100 border-2 border-yellow-400 text-yellow-700 animate-pulse">
            {showReminder === '5min' 
              ? "⏰ 5 min left! Wrap up."
              : "⚠️ 1 min left! Finish!"}
          </div>
        )}
      </div>
      
      {/* Story Guidelines (when grace period not active) */}
      {!showTimeExpiredWarning && (
        <>
          {/* Story Guidelines Box */}
          <div className="mb-6 p-4 bg-blue-50 border-2 border-blue-300 rounded-xl">
            <h3 className="font-bold text-blue-900 mb-2 text-base">📖 Story Guidelines</h3>
            <p className="text-sm text-blue-900 mb-2">
              To help spark ideas and make your story easier to shape, we've added a few gentle guidelines to focus your creativity:
            </p>
            <ul className="list-disc pl-5 space-y-1 text-sm text-blue-800">
              <li>Write the story from a <span className="font-bold">first-person</span> point of view.</li>
              <li>The story should take place over <span className="font-bold">no more than one day</span>.</li>
              <li>The story should center on a <span className="font-bold">decision or dilemma</span>.</li>
            </ul>
          </div>

          {meta.group === "AI-CONV" && (
            <>
              <div className="mb-6 p-4 bg-green-50 border-2 border-green-300 rounded-xl">
                <p className="text-sm text-green-900">
                  <span className="font-semibold">Remember:</span> There is <u>no penalty for AI-generated content or for the amount of effort you put in</u>. As long as the writing is free of technical errors and organizationally sound, you will likely receive a good grade. You do not need to use the entire allotted time!
                </p>
              </div>
              <hr className="mb-6 border-t-2 border-gray-300" />
            </>
          )}

          {meta.group === "SELF-CONV" && (
            <>
              <div className="mb-6 p-4 bg-green-50 border-2 border-green-300 rounded-xl">
                <p className="text-sm text-green-900">
                  <span className="font-semibold">Remember:</span> There is <u>no penalty for not using the entire allotted time</u>. As long as the writing is free of technical errors and organizationally sound, you will likely receive a good grade.
                </p>
              </div>
              <hr className="mb-6 border-t-2 border-gray-300" />
            </>
          )}
        </>
      )}

      {isAI ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 min-h-[520px]">
          <div>{EditorBox}</div>
          <div className="border rounded-2xl p-4">
            <AIChatPanel 
              messages={aiMessages} 
              onSend={sendToAI} 
              draft={chatDraft} 
              setDraft={setChatDraft} 
              isLoading={isAILoading}
              queryCount={aiQueryCount}
              maxQueries={MAX_AI_QUERIES}
            />
          </div>
        </div>
      ) : (
        <div className="min-h-[520px]">{EditorBox}</div>
      )}
      {/* Brainstorm Outline - Visible by default with collapse option */}
      <div className="mt-6 border-t pt-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold">Your Brainstorm Outline</h3>
          <button
            onClick={() => setShowBrainstormOutline(!showBrainstormOutline)}
            className="text-sm px-3 py-1 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700"
          >
            {showBrainstormOutline ? '▼ Hide' : '▶ Show'}
          </button>
        </div>
        {showBrainstormOutline && (() => {
          try {
            const brainstormData = JSON.parse(brainstorm || '{}');
            return (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                {brainstormData.main_char && (
                  <div className="p-3 bg-blue-50 rounded-lg">
                    <div className="font-semibold text-blue-900 mb-1">Main Character</div>
                    <div className="text-gray-700 whitespace-pre-wrap">{brainstormData.main_char}</div>
                  </div>
                )}
                {brainstormData.setting && (
                  <div className="p-3 bg-green-50 rounded-lg">
                    <div className="font-semibold text-green-900 mb-1">Setting</div>
                    <div className="text-gray-700 whitespace-pre-wrap">{brainstormData.setting}</div>
                  </div>
                )}
                {brainstormData.conflict && (
                  <div className="p-3 bg-orange-50 rounded-lg">
                    <div className="font-semibold text-orange-900 mb-1">Conflict</div>
                    <div className="text-gray-700 whitespace-pre-wrap">{brainstormData.conflict}</div>
                  </div>
                )}
                {brainstormData.resolution && (
                  <div className="p-3 bg-purple-50 rounded-lg">
                    <div className="font-semibold text-purple-900 mb-1">Resolution</div>
                    <div className="text-gray-700 whitespace-pre-wrap">{brainstormData.resolution}</div>
                  </div>
                )}
                {brainstormData.plot && (
                  <div className="p-3 bg-gray-50 rounded-lg md:col-span-2">
                    <div className="font-semibold text-gray-900 mb-1">Plot</div>
                    <div className="text-gray-700 whitespace-pre-wrap">{brainstormData.plot}</div>
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
const SurveyView: React.FC<{ meta: SessionMeta; onSubmit: (payload: any)=>void }>=({ meta, onSubmit })=>{
  const [q1, setQ1] = useState("");
  const [q2, setQ2] = useState("");
  const [q3Items, setQ3Items] = useState<string[]>(["", ""]); // Start with 2 empty items
  const [q4, setQ4] = useState(""); // AI strategy question (only for AI groups)
  
  const addQ3Item = () => {
    setQ3Items([...q3Items, ""]);
  };
  
  const removeQ3Item = (index: number) => {
    if (q3Items.length > 1) { // Keep at least 1 item
      setQ3Items(q3Items.filter((_, i) => i !== index));
    }
  };
  
  const updateQ3Item = (index: number, value: string) => {
    const newItems = [...q3Items];
    newItems[index] = value;
    setQ3Items(newItems);
  };

  // Check if at least one q3 item is filled
  const hasQ3Response = q3Items.some(item => item.trim().length > 0);
  const isAIGroup = meta.group.startsWith("AI");
  const canSubmit = q1 && q2 && hasQ3Response && (!isAIGroup || q4.trim().length > 0);

  return (
    <Shell
      title="Post-Session Survey"
      footer={
        <>
          {!canSubmit && (
            <div className="text-sm text-gray-600 text-center mb-2">
              Please answer all questions to continue
            </div>
          )}
          <button 
            className={`px-4 py-2 rounded-xl ${
              canSubmit 
                ? 'bg-black text-white' 
                : 'bg-gray-300 text-gray-600 cursor-not-allowed'
            }`}
            onClick={()=> onSubmit({ q1, q2, q3: q3Items, q4: isAIGroup ? q4 : null })}
            disabled={!canSubmit}
          >
          Submit & Finish
        </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="text-sm text-gray-600">Thank you! A few quick questions:</div>
        <label className="block">
          <div className="mb-1 font-medium">How familiar are you with using AI for general tasks? (i.e., what is your level of expertise in using AI?)</div>
          <select className="w-full border rounded-xl p-2" value={q1} onChange={(e)=>setQ1(e.target.value)}>
            <option value="">Select…</option>
            <option>Not at all familiar</option>
            <option>Slightly familiar</option>
            <option>Somewhat familiar</option>
            <option>Very familiar</option>
            <option>Extremely familiar</option>
          </select>
        </label>
        <label className="block">
          <div className="mb-1 font-medium">How familiar are you with using <span className="font-semibold">AI for writing (creative or otherwise)</span>?</div>
          <select className="w-full border rounded-xl p-2" value={q2} onChange={(e)=>setQ2(e.target.value)}>
            <option value="">Select…</option>
            <option>Not at all familiar</option>
            <option>Slightly familiar</option>
            <option>Somewhat familiar</option>
            <option>Very familiar</option>
            <option>Extremely familiar</option>
          </select>
        </label>
        <div className="block">
          <div className="mb-2 font-medium">What aspects would you look out for to determine if a piece of writing is AI-generated?</div>
          <div className="text-xs text-gray-500 mb-2">Add one aspect per line. You can add or remove lines as needed. Please add at least one aspect.</div>
          <div className="space-y-2">
            {q3Items.map((item, index) => (
              <div key={index} className="flex gap-2 items-center">
                <input
                  type="text"
                  className="flex-1 border rounded-lg p-2 text-sm"
                  placeholder={`Aspect ${index + 1}`}
                  value={item}
                  onChange={(e) => updateQ3Item(index, e.target.value)}
                />
                <button
                  onClick={() => removeQ3Item(index)}
                  disabled={q3Items.length === 1}
                  className={`px-3 py-2 rounded-lg text-sm ${
                    q3Items.length === 1
                      ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                      : 'bg-red-100 text-red-600 hover:bg-red-200'
                  }`}
                  title="Remove this item"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              onClick={addQ3Item}
              className="px-3 py-2 rounded-lg text-sm bg-blue-100 text-blue-600 hover:bg-blue-200"
            >
              + Add another aspect
            </button>
          </div>
        </div>
        
        {/* AI Strategy Question (only for AI groups) */}
        {isAIGroup && (
        <label className="block">
            <div className="mb-1 font-medium">Briefly, what was your strategy in using AI to complete your writing task?</div>
            <textarea
              className="w-full border rounded-xl p-2 min-h-[100px]"
              placeholder="Describe your approach to using the AI assistant..."
              value={q4}
              onChange={(e) => setQ4(e.target.value)}
            />
        </label>
        )}
      </div>
    </Shell>
  );
};

// ---- Device Compatibility Check ----
function checkDeviceCompatibility(): { compatible: boolean; reason?: string } {
  // Check 1: Screen size (minimum 1024px width for laptop/desktop)
  const minWidth = 1024;
  const minHeight = 600;
  const screenWidth = window.screen.width;
  const screenHeight = window.screen.height;
  
  if (screenWidth < minWidth || screenHeight < minHeight) {
    return { 
      compatible: false, 
      reason: `Screen size too small. This study requires a laptop or desktop with at least ${minWidth}x${minHeight} resolution. Your device: ${screenWidth}x${screenHeight}.` 
    };
  }
  
  // Check 2: Touch-only devices (tablets and phones typically only have touch)
  const isTouchOnly = ('ontouchstart' in window || navigator.maxTouchPoints > 0) 
    && !window.matchMedia('(pointer: fine)').matches;
  
  if (isTouchOnly) {
    return { 
      compatible: false, 
      reason: 'This study requires a laptop or desktop computer with a keyboard and mouse. Touch-only devices (tablets and phones) are not supported.' 
    };
  }
  
  // Check 3: User agent detection (fallback)
  const userAgent = navigator.userAgent.toLowerCase();
  const mobileKeywords = ['android', 'webos', 'iphone', 'ipad', 'ipod', 'blackberry', 'windows phone'];
  const isMobileUA = mobileKeywords.some(keyword => userAgent.includes(keyword));
  
  if (isMobileUA) {
    return { 
      compatible: false, 
      reason: 'This study requires a laptop or desktop computer. Mobile devices and tablets are not supported.' 
    };
  }
  
  return { compatible: true };
}

// ---- Root App ----
const StudyApp: React.FC = () => {
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState<Step>(1);
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null); // Track if participant is blocked
  const [deviceIncompatible, setDeviceIncompatible] = useState<string | null>(null); // Track device compatibility
  const [brainstorm, setBrainstorm] = useState("");
  const [finalText, setFinalText] = useState("");
  const [aiTranscript, setAiTranscript] = useState<{role:"user"|"assistant"; content:string}[]>([]);
  const [attentionMeta, setAttentionMeta] = useState<any>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [totalViolations, setTotalViolations] = useState(0); // Track fullscreen violations

  // Attention tracking for brainstorm (step 3) and editor (step 4)
  const attn = useWritingAttention(step === 3 || step === 4, {
    graceMs: 5000,
    halfLifeMs: 20000,
    nudgeThreshold: 0.5,
    finalThreshold: 0.35,
    maxNudges: 5,
  });

  // Track if we've already banned for finalStrike or fullscreen violations
  const bannedForStrikeRef = useRef(false);
  const bannedForViolationsRef = useRef(false);
  
  // Ban user when finalStrike occurs
  useEffect(() => {
    if (attn.finalStrike && !bannedForStrikeRef.current && meta) {
      bannedForStrikeRef.current = true;
      banParticipant(meta.prolificId);
      console.log('🚫 User banned due to attention strike');
    }
  }, [attn.finalStrike, meta]);

  // Ban user when fullscreen violations exceed 5
  useEffect(() => {
    if (totalViolations > 5 && !bannedForViolationsRef.current && meta) {
      bannedForViolationsRef.current = true;
      banParticipant(meta.prolificId);
      console.log('🚫 User banned due to excessive fullscreen violations:', totalViolations);
      setBlocked('fullscreen_violations');
    }
  }, [totalViolations, meta]);

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
        // Check device compatibility first
        const deviceCheck = checkDeviceCompatibility();
        if (!deviceCheck.compatible) {
          console.log('🚫 Device incompatible:', deviceCheck.reason);
          setDeviceIncompatible(deviceCheck.reason || 'Device not compatible');
          setLoaded(true);
          return;
        }
        
      const prolificId = getProlificIdFromURL();
        
        // Debug: Check environment variables
        console.log('🔍 Debug Info:');
        console.log('VITE_SUPABASE_URL:', import.meta.env.VITE_SUPABASE_URL ? '✅ Set' : '❌ Missing');
        console.log('VITE_SUPABASE_ANON:', import.meta.env.VITE_SUPABASE_ANON ? '✅ Set' : '❌ Missing');
        console.log('Supabase client:', supabase ? '✅ Created' : '❌ Failed');
        
        // Halt if Supabase is not available
        if (!supabase || !supabase.from || !import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON) {
          console.error('❌ Supabase not properly configured - halting study');
          setBlocked('supabase_error');
          setLoaded(true);
          return;
        }
        
        // Check participant status and assign group
      const group = await assignSimpleRandom(prolificId);
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
        if (error.message === 'already_completed' || error.message === 'writing_started' || error.message === 'banned' || error.message === 'already_started') {
          console.log('🚫 Participant blocked:', error.message);
          setBlocked(error.message);
          setLoaded(true);
        } else {
          // For any other error, halt the study with error message
          console.error('Error details:', error);
          setBlocked('initialization_error');
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
        <p>Your responses have been recorded. You can now return to Prolific <a href="https://app.prolific.com/submissions/complete?cc=C13IMUFI" className="text-blue-600 underline">using this link</a>. Alternatively, copy and paste this code: C13IMUFI.</p>
        {meta?.prolificId && (
          <p className="text-sm text-gray-600">Prolific ID: <span className="font-mono">{meta.prolificId}</span></p>
        )}
      </div>
    </Shell>
  );

  // Blocked participant screen
  const BlockedScreen = (
    <Shell title={
      blocked === 'banned' ? 'Access Denied' : 
      blocked === 'fullscreen_violations' ? 'Session Terminated' :
      blocked === 'supabase_error' ? 'Configuration Error' :
      blocked === 'initialization_error' ? 'System Error' :
      blocked === 'already_started' ? 'Session Already Started' :
      'Already Participated'
    }>
      <div className="prose max-w-none">
        {blocked === 'banned' ? (
          <>
            <h2 className="text-xl font-semibold text-red-600">Study Access Denied</h2>
            <p className="text-red-600">
              You have been removed from this study due to failing attention checks.
            </p>
            <p className="text-gray-600">
              Please <a href="https://app.prolific.com/submissions/complete?cc=C1KB1MCD" className="text-blue-600 underline">click this link</a> to go back to Prolific and return the study. Alternatively, copy and paste this code: C1KB1MCD.
            </p>
          </>
        ) : blocked === 'fullscreen_violations' ? (
          <>
            <h2 className="text-xl font-semibold text-red-600">Session Terminated: Excessive Fullscreen Violations</h2>
            <p className="text-red-600">
              You have been removed from this study due to repeated attempts to exit fullscreen mode.
            </p>
            <p className="text-gray-700 mt-3">
              This study requires fullscreen mode to maintain focus and ensure data quality. After multiple warnings, you exceeded the maximum allowed violations ({totalViolations} violations detected).
            </p>
            <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="font-semibold text-red-800 mb-2">What to do next:</p>
              <p className="text-sm text-red-700">
                Please <a href="https://app.prolific.com/submissions/complete?cc=C10S0BXP" className="text-blue-600 underline font-semibold">click this link</a> to go back to Prolific and return the study. Alternatively, copy and paste this code: <span className="font-mono font-bold">C10S0BXP</span>.
              </p>
            </div>
          </>
        ) : blocked === 'supabase_error' ? (
          <>
            <h2 className="text-xl font-semibold text-red-600">Study Temporarily Unavailable</h2>
            <p className="text-red-600">
              The study system is not properly configured. Data tracking is required for this study.
            </p>
            <p className="text-gray-600">
              Please contact the researcher, refresh the page, or try again later. If you decide to try later, <a href="https://app.prolific.com/submissions/complete?cc=C182OX5Y" className="text-blue-600 underline">click this link</a> to go back to Prolific and return the study. Alternatively, copy and paste this code: C182OX5Y.
            </p>
          </>
        ) : blocked === 'initialization_error' ? (
          <>
            <h2 className="text-xl font-semibold text-red-600">Unable to Start Study</h2>
            <p className="text-red-600">
              An error occurred while initializing your session.
            </p>
            <p className="text-gray-600">
              Please contact the researcher with your Prolific ID or try refreshing the page. If you decide to try later, <a href="https://app.prolific.com/submissions/complete?cc=C182OX5Y" className="text-blue-600 underline">click this link</a> to go back to Prolific and return the study. Alternatively, copy and paste this code: C182OX5Y.
            </p>
          </>
        ) : blocked === 'already_started' ? (
          <>
            <h2 className="text-xl font-semibold text-red-600">Session Already Started</h2>
            <p className="text-red-600">
              Our records show that you have already started this study session.
            </p>
            <p className="text-gray-700 mt-3">
              Once you begin the study, you cannot restart or rejoin if you leave the session. This policy ensures data integrity and prevents participants from seeing study materials multiple times.
            </p>
            <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="font-semibold text-red-800 mb-2">What to do next:</p>
              <p className="text-sm text-red-700">
                Please <a href="https://app.prolific.com/submissions/complete?cc=C16B0MLX" className="text-blue-600 underline font-semibold">click this link</a> to go back to Prolific and return the study. Alternatively, copy and paste this code: <span className="font-mono font-bold">C16B0MLX</span>.
              </p>
            </div>
            <div className="mt-6 p-4 bg-blue-50 rounded-lg">
              <p className="text-sm font-semibold">If you believe this is an error:</p>
              <p className="text-sm">Please contact the researcher with your Prolific ID.</p>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold text-red-600">Study Already Completed</h2>
            <p>
              Our records show that you have already {blocked === 'already_completed' ? 'completed' : 'started'} this study.
              Each participant can only complete the study once. <a href="https://app.prolific.com/submissions/complete?cc=C16B0MLX" className="text-blue-600 underline">Click this link</a> to go back to Prolific and return the study. Alternatively, copy and paste this code: C16B0MLX.
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
  
  // Session invalidated screen (for attention strike during study)
  const InvalidatedScreen = (
    <Shell title="Session Invalidated">
      <div className="prose max-w-none text-center">
        <div className="mb-6">
          <div className="text-6xl mb-4">❌</div>
          <h2 className="text-2xl font-bold text-red-600 mb-4">Your Session Has Been Invalidated</h2>
        </div>
        <p className="text-red-600 mb-4">
          You have been removed from this study due to insufficient attention during the task.
        </p>
        <p className="text-gray-700 mb-6">
          Our system detected prolonged periods of inactivity that indicate you were not actively engaged with the writing task.
        </p>
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="font-semibold text-red-800 mb-2">What to do next:</p>
          <p className="text-sm text-red-700">
            Please close this window and return the study on Prolific <a href="https://app.prolific.com/submissions/complete?cc=C8IDGK63" className="text-blue-600 underline">using this link</a>. Alternatively, copy and paste this code: C8IDGK63.
            Your participation data has been recorded as incomplete.
          </p>
        </div>
      </div>
    </Shell>
  );

  // Device incompatible screen
  const DeviceIncompatibleScreen = (
    <Shell title="Device Not Compatible">
      <div className="prose max-w-none text-center">
        <div className="mb-6">
          <div className="text-6xl mb-4">💻</div>
          <h2 className="text-2xl font-bold text-red-600 mb-4">Device Not Compatible</h2>
        </div>
        <p className="text-red-600 mb-4 font-semibold">
          {deviceIncompatible}
        </p>
        <p className="text-gray-700 mb-6">
          This study requires specific hardware capabilities for accurate data collection and optimal user experience.
        </p>
        <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg mb-4">
          <p className="font-semibold text-blue-800 mb-2">Requirements:</p>
          <ul className="text-sm text-blue-700 text-left list-disc list-inside">
            <li>Laptop or desktop computer</li>
            <li>Physical keyboard and mouse</li>
            <li>Minimum screen resolution: 1024x600</li>
            <li>Not a tablet or mobile device</li>
          </ul>
        </div>
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="font-semibold text-red-800 mb-2">What to do next:</p>
          <p className="text-sm text-red-700">
            Please <a href="https://app.prolific.com/submissions/complete?cc=C1BQO66A" className="text-blue-600 underline font-semibold">click this link</a> to go back to Prolific and return the study. Alternatively, copy and paste this code: <span className="font-mono font-bold">C1BQO66A</span>.
          </p>
          <p className="text-sm text-gray-600 mt-3">
            If you have access to a compatible device, you may try again from that device.
          </p>
        </div>
      </div>
    </Shell>
  );

  if (!loaded) return <div className="p-6 text-gray-500">Loading…</div>;
  
  if (deviceIncompatible) return DeviceIncompatibleScreen;
  
  if (blocked) return BlockedScreen;
  
  // Show invalidated screen if attention strike occurred
  if (attn.finalStrike) return InvalidatedScreen;
  
  if (!meta) return <div className="p-6 text-gray-500">Loading…</div>;

  if ((step as any) === 4.1) return CompletionScreen;

  return (
    <div className="min-h-screen">
      {step === 1 && (
        <ComplianceGate 
          initialViolations={totalViolations}
          onViolation={(n) => {
            console.log("Violation", n);
            setTotalViolations(n);
          }}>
          <InstructionsView meta={meta} sessionId={sessionId} onNext={()=> setStep(2)} />
        </ComplianceGate>
      )}
      
      {step === 2 && (
        <ComplianceGate 
          initialViolations={totalViolations}
          onViolation={(n) => {
            console.log("Violation", n);
            setTotalViolations(n);
          }}>
          <PromptView meta={meta} onNext={() => setStep(3)} />
        </ComplianceGate>
      )}
      {/* {step === 3 && <BrainstormView meta={meta} value={brainstorm} setValue={setBrainstorm} onNext={()=> setStep(4)} />}
      {step === 4 && (
        <EditorView meta={meta} brainstorm={brainstorm} onNext={(t, a)=>{ setFinalText(t); setAiTranscript(a); setStep(5); }} />
      )}
      {step === 5 && <SurveyView meta={meta} onSubmit={onFinishSurvey} />} */}

{step === 3 && (
  <ComplianceGate 
    initialViolations={totalViolations}
    onViolation={(n) => {
      console.log("Violation", n);
      setTotalViolations(n);
    }}>
    {/* Attention warnings for brainstorm phase */}
    {attn.showFinalWarning && !attn.finalStrike && (
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-orange-500 text-white px-6 py-3 rounded-lg shadow-lg text-center max-w-md">
        <div className="font-bold">⚠️ Final Warning</div>
        <div className="text-sm">We need your full attention. Please stay focused or your session may be invalidated.</div>
      </div>
    )}
    
    {attn.showNudge && !attn.showFinalWarning && !attn.finalStrike && (
      <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-40 bg-black text-white px-6 py-4 rounded-lg shadow-lg text-center">
        <div className="text-base font-semibold mb-1">👋 Still with us?</div>
        <div className="text-sm">A quick keystroke or scroll helps maintain your attention score.</div>
      </div>
    )}

    {/* Development mode attention score display */}
    {DEV_MODE && (
      <div className="fixed bottom-4 right-4 z-50 bg-gray-900 text-white p-3 rounded-lg text-sm font-mono shadow-lg">
        <div className="text-xs text-gray-300 mb-1">Attention Score (Dev Mode)</div>
        <div className="flex items-center gap-2">
          <div className="w-20 h-2 bg-gray-700 rounded-full overflow-hidden">
            <div 
              className={`h-full transition-all duration-300 ${
                attn.score > 0.7 ? 'bg-green-500' : 
                attn.score > 0.5 ? 'bg-yellow-500' : 
                attn.score > 0.35 ? 'bg-orange-500' : 'bg-red-500'
              }`}
              style={{ width: `${attn.score * 100}%` }}
            />
          </div>
          <span className="text-xs">{(attn.score * 100).toFixed(0)}%</span>
        </div>
        <div className="text-xs text-gray-400 mt-1">
          Nudges: {attn.nudges} | Worst: {(attn.worstScore * 100).toFixed(0)}%
          {attn.showFinalWarning && <span className="text-orange-400"> | FINAL WARNING</span>}
          {attn.finalStrike && <span className="text-red-400"> | STRIKE</span>}
        </div>
      </div>
    )}
    
    <BrainstormView meta={meta} value={brainstorm} setValue={setBrainstorm} sessionId={sessionId} onNext={()=> setStep(4)} />
  </ComplianceGate>
)}



{step === 4 && (
  <ComplianceGate 
    initialViolations={totalViolations}
    onViolation={(n) => {
      console.log("Violation", n);
      setTotalViolations(n);
    }}>
    {/* Development mode attention score display */}
    {DEV_MODE && (
      <div className="fixed bottom-4 right-4 z-50 bg-gray-900 text-white p-3 rounded-lg text-sm font-mono shadow-lg">
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
    {attn.showFinalWarning && !attn.finalStrike && (
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-40 bg-amber-100 text-amber-900 border border-amber-300 px-4 py-2 rounded-lg text-sm shadow">
        Final warning: keep engaging (typing, moving the mouse). If your attention drops again, your submission may be flagged.
      </div>
    )}
    
    {attn.showNudge && !attn.finalStrike && (
      <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-40 bg-black text-white px-6 py-4 rounded-lg shadow-lg text-center">
        <div className="text-base font-semibold mb-1">👋 Still with us?</div>
        <div className="text-sm">A quick keystroke or scroll helps maintain your attention score.</div>
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
          fullscreenViolations: totalViolations, // Include fullscreen violation count
        });
        setStep(5);
      }}
    />
  </ComplianceGate>
)}

{step === 5 && (
  <ComplianceGate 
    initialViolations={totalViolations}
    onViolation={(n) => {
      console.log("Violation", n);
      setTotalViolations(n);
    }}>
    <SurveyView meta={meta} onSubmit={onFinishSurvey} />
  </ComplianceGate>
)}

    </div>
  );
};

export default StudyApp;
