// src/components/ProctoredTestPlayer.jsx
//
// Route: /test/:examId
// Assumes a configured Supabase client exported from ../lib/supabaseClient.js:
//
//   import { createClient } from '@supabase/supabase-js';
//   export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
//
// Flow: AUTH GATE (Google OAuth) -> ACCESS CODE GATE -> TEST -> RESULT
//
// Max tab-switch strikes before auto-submit.
const MAX_TAB_STRIKES = 3;

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

export default function ProctoredTestPlayer() {
  const { examId } = useParams();

  // ---- High-level phase machine ------------------------------------------
  // 'checking_auth' | 'need_auth' | 'need_code' | 'loading_exam' |
  // 'testing' | 'submitting' | 'submitted' | 'error'
  const [phase, setPhase] = useState('checking_auth');
  const [errorMsg, setErrorMsg] = useState('');

  // ---- Auth ---------------------------------------------------------------
  const [user, setUser] = useState(null);

  // ---- Access code gate -----------------------------------------------
  const [accessCodeInput, setAccessCodeInput] = useState('');
  const [codeError, setCodeError] = useState('');

  // ---- Exam data ------------------------------------------------------
  const [duration, setDuration] = useState(0);       // minutes
  const [showResultsFlag, setShowResultsFlag] = useState(false);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});          // { [q_id]: choiceKey }

  // ---- Timer ------------------------------------------------------------
  const [secondsLeft, setSecondsLeft] = useState(null);
  const deadlineRef = useRef(null);      // absolute Date.now()-space deadline
  const clockOffsetRef = useRef(0);      // serverNow - clientNow, in ms

  // ---- Proctoring ----------------------------------------------------
  const [tabStrikes, setTabStrikes] = useState(0);
  const [showStrikeWarning, setShowStrikeWarning] = useState(false);

  // ---- Result ------------------------------------------------------------
  const [finalScore, setFinalScore] = useState(null);

  // Guard against double-submit (timer + strike limit racing each other).
  const hasSubmittedRef = useRef(false);

  // ==========================================================================
  // 1. AUTH GATE — Supabase Google OAuth
  // ==========================================================================
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUser(session.user);
        setPhase('need_code');
      } else {
        setPhase('need_auth');
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setUser(session.user);
        setPhase((prev) => (prev === 'need_auth' ? 'need_code' : prev));
      }
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  const signInWithGoogle = () => {
    supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.href },
    });
  };

  // ==========================================================================
  // 2. ACCESS CODE GATE
  // ==========================================================================
  const submitAccessCode = async (e) => {
    e.preventDefault();
    setCodeError('');

    const { data: isValid, error } = await supabase.rpc('verify_access_code', {
      p_exam_id: examId,
      p_code: accessCodeInput.trim(),
    });

    if (error || !isValid) {
      setCodeError('Incorrect access code. Please check with your invigilator.');
      return;
    }

    setPhase('loading_exam');
    await beginAttempt();
  };

  // ==========================================================================
  // 3. START ATTEMPT — server writes started_at; client derives deadline
  //    from server time, not its own clock, so refreshing can't reset it.
  // ==========================================================================
  const beginAttempt = async () => {
    try {
      const clientNowBefore = Date.now();

      const { data: attemptRows, error: attemptErr } = await supabase.rpc('start_attempt', {
        p_exam_id: examId,
        p_code: accessCodeInput.trim(),
      });
      if (attemptErr) throw attemptErr;

      const { started_at, duration_minutes, show_results } = attemptRows[0];

      const { data: serverNowIso, error: timeErr } = await supabase.rpc('get_server_time');
      if (timeErr) throw timeErr;

      // Clock offset = serverTime - clientTime, measured close together so
      // round-trip latency barely matters for a POC-grade timer.
      const clientNowAfter = Date.now();
      const roundTrippedClientNow = (clientNowBefore + clientNowAfter) / 2;
      clockOffsetRef.current = new Date(serverNowIso).getTime() - roundTrippedClientNow;

      const startedAtMs = new Date(started_at).getTime();
      deadlineRef.current = startedAtMs + duration_minutes * 60 * 1000;

      setDuration(duration_minutes);
      setShowResultsFlag(show_results);

      const { data: qData, error: qErr } = await supabase
        .from('questions_public')
        .select('*')
        .eq('exam_id', examId)
        .order('question_order');
      if (qErr) throw qErr;

      setQuestions(qData);
      setPhase('testing');
    } catch (err) {
      setErrorMsg(err.message || 'Could not start the exam.');
      setPhase('error');
    }
  };

  // ==========================================================================
  // 4. RESILIENT TIMER — always computed from (serverNow) vs (deadline),
  //    never from a locally-stored "time remaining" value.
  // ==========================================================================
  useEffect(() => {
    if (phase !== 'testing' || !deadlineRef.current) return;

    const tick = () => {
      const approxServerNow = Date.now() + clockOffsetRef.current;
      const remainingMs = deadlineRef.current - approxServerNow;
      const remaining = Math.max(0, Math.floor(remainingMs / 1000));
      setSecondsLeft(remaining);

      if (remaining <= 0) {
        handleSubmit({ autoSubmitted: true });
      }
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ==========================================================================
  // 5. TAB-SWITCH DETECTION (Page Visibility API)
  // ==========================================================================
  useEffect(() => {
    if (phase !== 'testing') return;

    const handleVisibilityChange = async () => {
      if (document.hidden) {
        const { data: newCount } = await supabase.rpc('log_tab_switch', { p_exam_id: examId });
        const count = newCount ?? tabStrikes + 1;
        setTabStrikes(count);
        setShowStrikeWarning(true);

        if (count >= MAX_TAB_STRIKES) {
          handleSubmit({ autoSubmitted: true });
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, tabStrikes]);

  // ==========================================================================
  // 6. COPY / PASTE PREVENTION
  // ==========================================================================
  const blockClipboardEvent = useCallback((e) => {
    e.preventDefault();
  }, []);

  // ==========================================================================
  // 7. ANSWER SELECTION
  // ==========================================================================
  const selectAnswer = (questionId, choiceKey) => {
    setAnswers((prev) => ({ ...prev, [questionId]: choiceKey }));
  };

  // ==========================================================================
  // 8. SUBMIT (manual, timer-expiry, or strike-limit)
  // ==========================================================================
  const handleSubmit = useCallback(
    async ({ autoSubmitted = false } = {}) => {
      if (hasSubmittedRef.current) return;
      hasSubmittedRef.current = true;
      setPhase('submitting');

      const payload = Object.entries(answers).map(([q_id, choice]) => ({ q_id, choice }));

      const { data, error } = await supabase.rpc('submit_exam', {
        p_exam_id: examId,
        p_answers: payload,
        p_tab_switch_count: tabStrikes,
        p_auto_submitted: autoSubmitted,
      });

      if (error) {
        setErrorMsg(error.message);
        setPhase('error');
        return;
      }

      const { score, show_results } = data[0];
      setFinalScore(score);
      setShowResultsFlag(show_results);
      setPhase('submitted');
    },
    [answers, examId, tabStrikes]
  );

  // ==========================================================================
  // RENDER
  // ==========================================================================

  if (phase === 'checking_auth' || phase === 'loading_exam' || phase === 'submitting') {
    return <CenteredMessage text="Loading…" />;
  }

  if (phase === 'error') {
    return <CenteredMessage text={`Something went wrong: ${errorMsg}`} isError />;
  }

  if (phase === 'need_auth') {
    return (
      <CenteredCard>
        <p className="text-sm font-semibold tracking-wide text-blue-600 mb-1">EXCELLER</p>
        <h1 className="text-xl font-semibold mb-4">Sign in to continue</h1>
        <p className="text-gray-600 mb-6">You must sign in with Google to access this exam.</p>
        <button
          onClick={signInWithGoogle}
          className="bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 transition"
        >
          Sign in with Google
        </button>
      </CenteredCard>
    );
  }

  if (phase === 'need_code') {
    return (
      <CenteredCard>
        <p className="text-sm font-semibold tracking-wide text-blue-600 mb-1">EXCELLER</p>
        <h1 className="text-xl font-semibold mb-4">Enter Access Code</h1>
        <p className="text-gray-600 mb-4">Signed in as {user?.email}</p>
        <form onSubmit={submitAccessCode} className="flex flex-col gap-3">
          <input
            type="text"
            value={accessCodeInput}
            onChange={(e) => setAccessCodeInput(e.target.value)}
            placeholder="Access code"
            className="border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            autoFocus
          />
          {codeError && <p className="text-red-600 text-sm">{codeError}</p>}
          <button
            type="submit"
            className="bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 transition"
          >
            Unlock Exam
          </button>
        </form>
      </CenteredCard>
    );
  }

  if (phase === 'testing') {
    return (
      <div
        className="max-w-2xl mx-auto py-8 px-4 select-none"
        onCopy={blockClipboardEvent}
        onPaste={blockClipboardEvent}
        onCut={blockClipboardEvent}
        onContextMenu={blockClipboardEvent}
      >
        {/* Sticky header: brand + timer + strike indicator */}
        <div className="sticky top-0 bg-white border-b py-3 mb-6 flex items-center justify-between z-10">
          <span className="font-semibold text-blue-600 tracking-tight">Exceller</span>
          <TimerBadge secondsLeft={secondsLeft} />
          <span className="text-sm text-gray-500">
            Tab switches: <strong>{tabStrikes}</strong> / {MAX_TAB_STRIKES}
          </span>
        </div>

        {showStrikeWarning && (
          <div className="bg-amber-50 border border-amber-300 text-amber-800 rounded-lg px-4 py-3 mb-6 text-sm">
            ⚠️ Leaving this tab has been logged ({tabStrikes}/{MAX_TAB_STRIKES}). Reaching{' '}
            {MAX_TAB_STRIKES} will auto-submit your exam.
          </div>
        )}

        <div className="flex flex-col gap-6">
          {questions.map((q, idx) => (
            <QuestionCard
              key={q.id}
              index={idx}
              question={q}
              selected={answers[q.id]}
              onSelect={(choiceKey) => selectAnswer(q.id, choiceKey)}
            />
          ))}
        </div>

        <button
          onClick={() => handleSubmit({ autoSubmitted: false })}
          className="mt-8 w-full bg-green-600 text-white py-3 rounded-lg hover:bg-green-700 transition font-medium"
        >
          Submit Exam
        </button>
      </div>
    );
  }

  if (phase === 'submitted') {
    return (
      <CenteredCard>
        <p className="text-sm font-semibold tracking-wide text-blue-600 mb-1">EXCELLER</p>
        {showResultsFlag ? (
          <>
            <h1 className="text-xl font-semibold mb-2">Exam Submitted</h1>
            <p className="text-gray-600 mb-4">Here's your score:</p>
            <p className="text-4xl font-bold text-blue-600">{finalScore}</p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold mb-2">Thank you</h1>
            <p className="text-gray-600">Your response has been recorded.</p>
          </>
        )}
      </CenteredCard>
    );
  }

  return null;
}

// ============================================================================
// Small presentational helpers
// ============================================================================

function CenteredCard({ children }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="bg-white shadow-md rounded-2xl p-8 w-full max-w-md text-center">
        {children}
      </div>
    </div>
  );
}

function CenteredMessage({ text, isError = false }) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <p className={isError ? 'text-red-600' : 'text-gray-500'}>{text}</p>
    </div>
  );
}

function TimerBadge({ secondsLeft }) {
  if (secondsLeft === null) return null;
  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const isCritical = secondsLeft <= 60;

  return (
    <span
      className={`font-mono text-lg font-semibold px-3 py-1 rounded-lg ${
        isCritical ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-800'
      }`}
    >
      {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
    </span>
  );
}

function QuestionCard({ index, question, selected, onSelect }) {
  const options = question.options || {};

  return (
    <div className="border rounded-xl p-5 shadow-sm">
      <div className="flex justify-between items-start mb-3">
        <p className="font-medium">
          {index + 1}. {question.question_text}
        </p>
        <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-full whitespace-nowrap ml-3">
          {question.points} pt{question.points !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {Object.entries(options).map(([key, label]) => (
          <label
            key={key}
            className={`flex items-center gap-3 border rounded-lg px-3 py-2 cursor-pointer transition ${
              selected === key ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'
            }`}
          >
            <input
              type="radio"
              name={`question-${question.id}`}
              checked={selected === key}
              onChange={() => onSelect(key)}
              className="accent-blue-600"
            />
            <span>
              <strong className="mr-1">{key}.</strong> {label}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
