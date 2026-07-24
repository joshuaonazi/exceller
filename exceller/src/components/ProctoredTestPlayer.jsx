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
  const [fullNameInput, setFullNameInput] = useState('');
  const [codeError, setCodeError] = useState('');

  // ---- Exam data ------------------------------------------------------
  const [examTitle, setExamTitle] = useState('');
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

  // The timer's setInterval is set up once per test session (see the timer
  // effect below, which only depends on `phase`). Without this ref, that
  // interval would keep calling the very first `handleSubmit` closure it
  // captured — from the moment the test started, when `answers` was still
  // empty — instead of the current one. This ref always points at the
  // latest version, so auto-submit-on-timeout includes whatever the
  // student has actually selected.
  const handleSubmitRef = useRef(null);

  // Same stale-closure concern as handleSubmitRef above — this interval is
  // set up once and must not be recreated on every keystroke, so it reads
  // the latest answers via a ref rather than closing over the `answers`
  // state directly.
  const answersRef = useRef(answers);
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

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

  // Fetch the exam title early so it can be shown on every gate screen
  // (sign-in, access code) — not just once the test itself has started.
  useEffect(() => {
    supabase
      .from('exams_public')
      .select('title')
      .eq('id', examId)
      .single()
      .then(({ data }) => {
        if (data) setExamTitle(data.title);
      });
  }, [examId, user]);
  const submitAccessCode = async (e) => {
    e.preventDefault();
    setCodeError('');

    if (!fullNameInput.trim()) {
      setCodeError('Please enter your full name.');
      return;
    }

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
        p_full_name: fullNameInput.trim(),
      });
      if (attemptErr) throw attemptErr;

      const { started_at, duration_minutes, show_results, already_submitted, prior_score } =
        attemptRows[0];

      const { data: examMeta, error: examMetaErr } = await supabase
        .from('exams_public')
        .select('title')
        .eq('id', examId)
        .single();
      if (examMetaErr) throw examMetaErr;
      setExamTitle(examMeta.title);

      // Student already completed this exam — refresh/re-entry must NOT
      // let them retake it. Route straight to the result screen instead.
      if (already_submitted) {
        setShowResultsFlag(show_results);
        setFinalScore(prior_score);
        setPhase('submitted');
        return;
      }

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

      // Restore any answers that were autosaved before a refresh/disconnect,
      // so reconnecting resumes the test instead of showing it blank.
      const { data: existingSubmission } = await supabase
        .from('submissions')
        .select('answers')
        .eq('exam_id', examId)
        .single();

      if (existingSubmission?.answers?.length) {
        const restoredAnswers = {};
        for (const a of existingSubmission.answers) {
          restoredAnswers[a.q_id] = a.choice;
        }
        setAnswers(restoredAnswers);
      }

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
        handleSubmitRef.current?.({ autoSubmitted: true });
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
          handleSubmitRef.current?.({ autoSubmitted: true });
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
  // 6b. AUTOSAVE — persist in-progress answers so a hard disconnect or
  // refresh doesn't lose everything the student has already picked.
  // Debounced on change (fires ~1.5s after the last click, not on every
  // single one), PLUS a periodic safety-net save every 20s in case a
  // network blip swallows the debounced call. Never fires after the
  // exam has actually been submitted.
  // ==========================================================================
  useEffect(() => {
    if (phase !== 'testing') return;
    if (Object.keys(answers).length === 0) return;

    const timeout = setTimeout(() => {
      if (hasSubmittedRef.current) return;
      const payload = Object.entries(answers).map(([q_id, choice]) => ({ q_id, choice }));
      supabase.rpc('autosave_answers', { p_exam_id: examId, p_answers: payload });
      // Errors are deliberately swallowed here — a failed autosave isn't
      // fatal, since the NEXT successful save always sends the complete
      // answer set (not just a delta), so nothing is permanently lost as
      // long as some later save gets through before submission.
    }, 1500);

    return () => clearTimeout(timeout);
  }, [answers, phase, examId]);

  useEffect(() => {
    if (phase !== 'testing') return;

    const interval = setInterval(() => {
      if (hasSubmittedRef.current) return;
      const currentAnswers = answersRef.current;
      if (Object.keys(currentAnswers).length === 0) return;
      const payload = Object.entries(currentAnswers).map(([q_id, choice]) => ({ q_id, choice }));
      supabase.rpc('autosave_answers', { p_exam_id: examId, p_answers: payload });
    }, 20000);

    return () => clearInterval(interval);
  }, [phase, examId]);

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

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

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
        {examTitle && <p className="text-sm text-gray-500 mb-2">{examTitle}</p>}
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
        {examTitle && <p className="text-sm text-gray-500 mb-2">{examTitle}</p>}
        <h1 className="text-xl font-semibold mb-4">Enter Access Code</h1>
        <p className="text-gray-600 mb-4">Signed in as {user?.email}</p>
        <form onSubmit={submitAccessCode} className="flex flex-col gap-3">
          <div className="text-left">
            <label className="block text-sm font-medium mb-1">
              Full Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={fullNameInput}
              onChange={(e) => setFullNameInput(e.target.value)}
              placeholder="Enter your full name as it should appear on record"
              required
              className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
          </div>
          <div className="text-left">
            <label className="block text-sm font-medium mb-1">
              Access Code <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={accessCodeInput}
              onChange={(e) => setAccessCodeInput(e.target.value)}
              placeholder="Access code"
              required
              className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
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
        {/* Sticky header: brand + exam title + timer + strike indicator */}
        <div className="sticky top-0 bg-white border-b pb-3 mb-6 pt-3 z-10">
          <div className="flex items-center justify-between mb-1">
            <span className="font-semibold text-blue-600 tracking-tight">Exceller</span>
            <TimerBadge secondsLeft={secondsLeft} />
            <span className="text-sm text-gray-500">
              Tab switches: <strong>{tabStrikes}</strong> / {MAX_TAB_STRIKES}
            </span>
          </div>
          <h1 className="text-lg font-semibold text-gray-900">{examTitle}</h1>
        </div>

        {showStrikeWarning && (
          <div className="bg-amber-50 border border-amber-300 text-amber-800 rounded-lg px-4 py-3 mb-6 text-sm">
            ⚠️ Leaving this tab has been logged ({tabStrikes}/{MAX_TAB_STRIKES}). Reaching{' '}
            {MAX_TAB_STRIKES} will auto-submit your exam.
          </div>
        )}

        <div className="flex flex-col gap-6">
          {questions.map((q, idx) => {
            const prevSection = idx > 0 ? questions[idx - 1].section_title : null;
            const showSectionHeader = q.section_title && q.section_title !== prevSection;

            return (
              <div key={q.id}>
                {showSectionHeader && (
                  <h2 className="text-base font-bold text-gray-700 mb-3 mt-2 pb-1 border-b-2 border-blue-100">
                    {q.section_title}
                  </h2>
                )}
                <QuestionCard
                  index={idx}
                  question={q}
                  selected={answers[q.id]}
                  onSelect={(choiceKey) => selectAnswer(q.id, choiceKey)}
                />
              </div>
            );
          })}
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
        {examTitle && <p className="text-sm text-gray-500 mb-2">{examTitle}</p>}
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