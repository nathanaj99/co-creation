import React, { useEffect, useMemo, useRef, useState } from "react";

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

type GroupKey = "AI-DIV" | "AI-CONV" | "SELF-DIV" | "SELF-CONV";

const GROUPS: GroupKey[] = ["AI-DIV", "AI-CONV", "SELF-DIV", "SELF-CONV"];

// ---- Utilities ----
const qs = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
const getProlificIdFromURL = () => qs.get("PROLIFIC_PID") || qs.get("prolific_id") || qs.get("pid") || "ANON";

const todayISO = () => new Date().toISOString();

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
class LocalAssignment {
  static KEY_PREFIX = "study_assignment_v1_";

  static get(prolificId: string): GroupKey | null {
    const raw = localStorage.getItem(LocalAssignment.KEY_PREFIX + prolificId);
    return (raw as GroupKey) || null;
  }

  static set(prolificId: string, group: GroupKey) {
    localStorage.setItem(LocalAssignment.KEY_PREFIX + prolificId, group);
  }
}

// ---- Group randomization with balancing ----
async function assignGroupBalanced(prolificId: string): Promise<GroupKey> {
  // 1) If already assigned, reuse
  const existing = LocalAssignment.get(prolificId);
  if (existing) return existing;

  // 2) Fetch counts (placeholder with LocalStats). Replace this with your server endpoint.
  const counts = LocalStats.getCounts();

  // 3) Find min count groups, break ties randomly
  const min = Math.min(...GROUPS.map((g) => counts[g] || 0));
  const candidates = GROUPS.filter((g) => (counts[g] || 0) === min);
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];

  // 4) Persist locally (your backend should atomically lock this)
  LocalAssignment.set(prolificId, chosen);
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
const InstructionsView: React.FC<{ meta: SessionMeta; onNext: () => void }>=({ meta, onNext }) => {
  const [ack, setAck] = useState(false);
  const [showAICheck, setShowAICheck] = useState(false);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [showError, setShowError] = useState(false);
  const [showFinalError, setShowFinalError] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(15); // 15 second timer

  const correctAnswer = meta.group.includes("SELF") ? "zero_tolerance" : "ai_when_provided";

  // Timer effect
  React.useEffect(() => {
    if (timeRemaining > 0) {
      const timer = setTimeout(() => setTimeRemaining(prev => prev - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [timeRemaining]);

  const handleNext = () => {
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
        setTimeout(() => setShowError(false), 5000);
      } else {
        setShowFinalError(true);
      }
    }
  };

  return (
    <Shell
      title="Instructions"
      footer={
        showFinalError ? (
          <a 
            href="/"
            className="px-4 py-2 rounded-xl bg-red-600 text-white hover:bg-red-700"
            onClick={(e) => {
              e.preventDefault();
              window.location.href = '/';
            }}
          >
            Exit Study
          </a>
        ) : (
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
        <div className="text-sm text-gray-600">Participant: <span className="font-mono">{meta.prolificId}</span> · Group: <span className="font-mono">{meta.group}</span></div>
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
const BrainstormView: React.FC<{ onNext: () => void; meta: SessionMeta; value: string; setValue: (s: string)=>void }>=({ onNext, meta, value, setValue }) => {
  const [timeRemaining, setTimeRemaining] = React.useState(150); // 5 minutes in seconds
  const [showConfirmation, setShowConfirmation] = React.useState(false);
  const [showReminder, setShowReminder] = React.useState<false | '2min' | '30sec'>(false);

  React.useEffect(() => {
    if (timeRemaining > 0) {
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
    } else {
      onNext(); // Force proceed when time is up
    }
  }, [timeRemaining]);

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
                  onClick={onNext} 
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
      <p className="mb-3 text-sm text-gray-600">Outline your story plan. Remember, your goal is to <span className="font-semibold">{meta.group.includes("DIV")?"win the short story competition with your originality":"get the highest grade possible"}</span>!</p>
      <textarea
        value={value}
        onChange={(e)=>setValue(e.target.value)}
        rows={12}
        className="w-full border rounded-xl p-3 focus:outline-none focus:ring"
        placeholder={meta.group.includes("DIV")?"Placeholder...":"Placeholder..."}
      />
    </Shell>
  );
};

// ---- New View: Prompt ----
const PromptView: React.FC<{ meta: SessionMeta; onNext: () => void }> = ({ meta, onNext }) => {
  const isDiv = meta.group.includes("DIV");
  const [timeRemaining, setTimeRemaining] = React.useState(15);
  const [showAttentionCheck, setShowAttentionCheck] = React.useState(false);
  const [selectedOption, setSelectedOption] = React.useState<string | null>(null);
  const [showWarning, setShowWarning] = React.useState(false);
  const correctAnswer = isDiv ? "originality" : "grade";

  React.useEffect(() => {
    if (timeRemaining > 0) {
      const timer = setTimeout(() => setTimeRemaining(prev => prev - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [timeRemaining]);

  const handleProceed = () => {
    if (timeRemaining > 0) return;
    if (!showAttentionCheck) {
      setShowAttentionCheck(true);
      return;
    }
    if (selectedOption) {
      if (selectedOption === correctAnswer) {
        onNext();
      } else {
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
        <div className="my-30"></div>
        <p className="text-sm text-gray-500 italic">
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
        <div className="my-30"></div>
        <p className="text-sm text-gray-500 italic">
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
              <div className="bg-red-100 border-2 border-red-500 rounded-lg p-4 mb-4">
                <p className="text-red-700 font-bold text-lg mb-2">⚠️ Warning: Attention Check Failed</p>
                <p className="text-red-600">
                  Your answer indicates that you did not read the prompt carefully. 
                  This is a serious concern as careful reading is essential for this task.
                </p>
                <p className="text-red-600 mt-2">
                  Unfortunately, we cannot proceed with the study if participants do not read instructions carefully.
                </p>
              </div>
              <a 
                href="/"
                className="px-4 py-2 rounded-xl bg-red-600 text-white hover:bg-red-700"
                onClick={(e) => {
                  e.preventDefault();
                  window.location.href = '/';
                }}
              >
                Exit Study
              </a>
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
const AIChatPanel: React.FC<{ messages: {role:"user"|"assistant"; content:string}[], onSend: (m:string)=>void }>=({ messages, onSend })=>{
  const [draft, setDraft] = useState("");
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
}> = ({ meta, brainstorm, onNext }) => {
  const [text, setText] = useState("");
  const [aiMessages, setAiMessages] = useState<{role:"user"|"assistant"; content:string}[]>([]);
  const [keys, setKeys] = useState<{t:string; k:string}[]>([]);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const [timeRemaining, setTimeRemaining] = useState(20 * 60); // 20 minutes in seconds
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
          return newTime;
        });
      }, 1000);
      return () => clearTimeout(timer);
    } else {
      onNext(text, aiMessages); // Force proceed when time is up
    }
  }, [timeRemaining]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Keystroke logging scaffold
  useEffect(()=>{
    const handler = (e: KeyboardEvent) => {
      setKeys((prev)=> prev.length < 5000 ? [...prev, { t: new Date().toISOString(), k: e.key }] : prev);
    };
    window.addEventListener("keydown", handler);
    return ()=> window.removeEventListener("keydown", handler);
  }, []);

  const isAI = meta.group.startsWith("AI");

  const sendToAI = async (message: string) => {
    // Placeholder: append user message and a fake assistant reply
    setAiMessages((msgs)=>[...msgs, { role:"user", content: message }]);
    // ---- Replace below with your API call ----
    await new Promise((r)=>setTimeout(r, 300));
    setAiMessages((msgs)=>[...msgs, { role:"assistant", content: "[placeholder] API not connected yet. Your note: " + message }]);
  };

  const EditorBox = (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold">Write Your Story</div>
        <div className="flex items-center gap-4">
          <div className={`text-sm ${
            wordCount < 300 || wordCount > 500 
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
        onChange={(e)=>setText(e.target.value)}
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
              disabled={wordCount < 300 || wordCount > 500}
              className={`px-4 py-2 rounded-xl ${
                wordCount < 300 || wordCount > 500
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
            <AIChatPanel messages={aiMessages} onSend={sendToAI} />
          </div>
        </div>
      ) : (
        <div className="min-h-[520px]">{EditorBox}</div>
      )}
      <details className="mt-4 text-sm text-gray-600">
        <summary className="cursor-pointer">Show Brainstorm Outline</summary>
        <pre className="mt-2 bg-gray-50 p-3 rounded-lg whitespace-pre-wrap">{brainstorm || "(empty)"}</pre>
      </details>
    </Shell>
  );
};

// ---- View 4: Survey ----
const SurveyView: React.FC<{ meta: SessionMeta; onSubmit: (payload: any)=>void }>=({ meta, onSubmit })=>{
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
  const [brainstorm, setBrainstorm] = useState("");
  const [finalText, setFinalText] = useState("");
  const [aiTranscript, setAiTranscript] = useState<{role:"user"|"assistant"; content:string}[]>([]);

  // Boot: capture prolific id, assign group
  useEffect(() => {
    const init = async () => {
      const prolificId = getProlificIdFromURL();
      const group = await assignGroupBalanced(prolificId);
      const startedAt = todayISO();
      setMeta({ prolificId, group, startedAt });
      setLoaded(true);
    };
    init();
  }, []);

  const onFinishSurvey = (survey: any) => {
    if (!meta) return;
    // Persist locally and update balancing counts as a placeholder for server submission
    LocalStats.increment(meta.group);
    LocalStats.markCompleted(meta.prolificId);

    // Bundle session payload (replace this with network POST)
    const payload = {
      meta,
      brainstorm,
      finalText,
      aiTranscript,
      survey,
      finishedAt: todayISO(),
    };
    console.log("[SUBMIT] session payload", payload);

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

  if (!loaded || !meta) return <div className="p-6 text-gray-500">Loading…</div>;

  if ((step as any) === 4.1) return CompletionScreen;

  return (
    <div className="min-h-screen">
      {step === 1 && <InstructionsView meta={meta} onNext={()=> setStep(2)} />}
      {step === 2 && <PromptView meta={meta} onNext={() => setStep(3)} />}
      {step === 3 && <BrainstormView meta={meta} value={brainstorm} setValue={setBrainstorm} onNext={()=> setStep(4)} />}
      {step === 4 && (
        <EditorView meta={meta} brainstorm={brainstorm} onNext={(t, a)=>{ setFinalText(t); setAiTranscript(a); setStep(5); }} />
      )}
      {step === 5 && <SurveyView meta={meta} onSubmit={onFinishSurvey} />}
    </div>
  );
};

export default StudyApp;
