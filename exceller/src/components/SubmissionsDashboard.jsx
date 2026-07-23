// src/components/SubmissionsDashboard.jsx
//
// Route: /submissions/:examId
// Admin-only view: lists every student submission for one exam, and lets
// the admin drill into any single student to see a per-question
// correct/wrong breakdown.
//
// Relies on the SAME RLS policy that already protects the `questions`
// table (admins can only read questions belonging to exams they created)
// — no new security surface is introduced here.

import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

export default function SubmissionsDashboard() {
  const { examId } = useParams();

  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [exam, setExam] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [selectedSubmissionId, setSelectedSubmissionId] = useState(null);

  // ==========================================================================
  // Auth
  // ==========================================================================
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setAuthChecked(true);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
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
  // Data load: exam meta + full questions (with correct_answer — admin-only,
  // gated by RLS) + all submissions for this exam.
  // ==========================================================================
  const loadData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError('');

    try {
      const { data: examRow, error: examErr } = await supabase
        .from('exams')
        .select('id, title, duration_minutes, show_results_to_students, access_code')
        .eq('id', examId)
        .single();
      if (examErr) throw examErr;
      setExam(examRow);

      const { data: qData, error: qErr } = await supabase
        .from('questions')
        .select('id, question_text, options, correct_answer, points, section_title, question_order')
        .eq('exam_id', examId)
        .order('question_order');
      if (qErr) throw qErr;
      setQuestions(qData);

      const { data: subData, error: subErr } = await supabase
        .from('submissions')
        .select(
          'id, student_name, student_email, score, total_points, tab_switch_count, time_taken_seconds, auto_submitted, submitted_at, answers'
        )
        .eq('exam_id', examId)
        .order('submitted_at', { ascending: false, nullsFirst: false });
      if (subErr) throw subErr;
      setSubmissions(subData);
    } catch (err) {
      setLoadError(err.message || 'Failed to load submissions.');
    } finally {
      setLoading(false);
    }
  }, [user, examId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ==========================================================================
  // RENDER
  // ==========================================================================

  if (!authChecked) return <CenteredMessage text="Loading…" />;

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="bg-white shadow-md rounded-2xl p-8 w-full max-w-md text-center">
          <p className="text-sm font-semibold tracking-wide text-blue-600 mb-1">EXCELLER</p>
          <h1 className="text-xl font-semibold mb-4">Admin Sign In</h1>
          <p className="text-gray-600 mb-6">Sign in with Google to view submissions.</p>
          <button
            onClick={signInWithGoogle}
            className="bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 transition"
          >
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  if (loading) return <CenteredMessage text="Loading submissions…" />;

  if (loadError) {
    return (
      <CenteredMessage
        text={`Could not load this exam's submissions: ${loadError}`}
        isError
      />
    );
  }

  const selectedSubmission = submissions.find((s) => s.id === selectedSubmissionId) || null;
  const completedCount = submissions.filter((s) => s.submitted_at).length;

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <header className="mb-6">
        <p className="text-sm font-semibold tracking-wide text-blue-600">EXCELLER</p>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">{exam?.title}</h1>
          <Link to="/builder" className="text-sm text-gray-500 hover:text-gray-700">
            ← Back to my exams
          </Link>
        </div>
        <p className="text-sm text-gray-500 mt-1">
          {completedCount} completed submission{completedCount !== 1 ? 's' : ''} ·{' '}
          {questions.length} question{questions.length !== 1 ? 's' : ''} · Access code:{' '}
          <span className="font-mono">{exam?.access_code}</span>
        </p>
      </header>

      {submissions.length === 0 ? (
        <p className="text-gray-500 text-sm">No students have attempted this exam yet.</p>
      ) : (
        <div className="border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-600">
              <tr>
                <th className="px-4 py-2 font-medium">Student</th>
                <th className="px-4 py-2 font-medium">Score</th>
                <th className="px-4 py-2 font-medium">Tab Switches</th>
                <th className="px-4 py-2 font-medium">Time Taken</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((sub) => (
                <tr key={sub.id} className="border-t hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <p className="font-medium">{sub.student_name || '—'}</p>
                    <p className="text-gray-500 text-xs">{sub.student_email}</p>
                  </td>
                  <td className="px-4 py-3">
                    {sub.submitted_at ? `${sub.score} / ${sub.total_points}` : '—'}
                  </td>
                  <td className="px-4 py-3">{sub.tab_switch_count}</td>
                  <td className="px-4 py-3">{formatDuration(sub.time_taken_seconds)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge submission={sub} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {sub.submitted_at ? (
                      <button
                        onClick={() => setSelectedSubmissionId(sub.id)}
                        className="text-blue-600 hover:underline text-sm whitespace-nowrap"
                      >
                        View breakdown →
                      </button>
                    ) : (
                      <span className="text-gray-400 text-xs">In progress</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedSubmission && (
        <SubmissionDetailModal
          submission={selectedSubmission}
          questions={questions}
          onClose={() => setSelectedSubmissionId(null)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function StatusBadge({ submission }) {
  if (!submission.submitted_at) {
    return (
      <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-full">
        In progress
      </span>
    );
  }
  if (submission.auto_submitted) {
    return (
      <span className="text-xs bg-amber-100 text-amber-700 px-2 py-1 rounded-full">
        Auto-submitted
      </span>
    );
  }
  return (
    <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full">Completed</span>
  );
}

function SubmissionDetailModal({ submission, questions, onClose }) {
  // answers is [{ q_id, choice }, ...] — build a lookup by question id.
  const answerMap = {};
  (submission.answers || []).forEach((a) => {
    answerMap[a.q_id] = a.choice;
  });

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">{submission.student_name}</h2>
            <p className="text-sm text-gray-500">{submission.student_email}</p>
            <p className="text-sm font-medium text-blue-600 mt-1">
              Score: {submission.score} / {submission.total_points}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">
            ×
          </button>
        </div>

        <div className="flex flex-col gap-4">
          {questions.map((q, idx) => {
            const studentChoice = answerMap[q.id];
            const wasAnswered = studentChoice !== undefined;
            const isCorrect = wasAnswered && studentChoice === q.correct_answer;

            return (
              <div
                key={q.id}
                className={`border rounded-xl p-4 ${
                  !wasAnswered
                    ? 'border-gray-200 bg-gray-50'
                    : isCorrect
                    ? 'border-green-200 bg-green-50'
                    : 'border-red-200 bg-red-50'
                }`}
              >
                <div className="flex justify-between items-start mb-2">
                  <p className="font-medium text-sm">
                    Q{idx + 1}. {q.question_text}
                  </p>
                  <span className="text-xs whitespace-nowrap ml-3">
                    {!wasAnswered ? (
                      <span className="text-gray-400">Not answered</span>
                    ) : isCorrect ? (
                      <span className="text-green-700">✅ Correct</span>
                    ) : (
                      <span className="text-red-700">❌ Wrong</span>
                    )}
                  </span>
                </div>
                <div className="text-sm text-gray-700 flex flex-col gap-1">
                  <p>
                    Student chose:{' '}
                    <strong>
                      {wasAnswered
                        ? `${studentChoice}. ${q.options[studentChoice] ?? ''}`
                        : '—'}
                    </strong>
                  </p>
                  {!isCorrect && (
                    <p>
                      Correct answer:{' '}
                      <strong className="text-green-700">
                        {q.correct_answer}. {q.options[q.correct_answer] ?? ''}
                      </strong>
                    </p>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-2">{q.points} pt{q.points !== 1 ? 's' : ''}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function CenteredMessage({ text, isError = false }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 text-center">
      <p className={isError ? 'text-red-600' : 'text-gray-500'}>{text}</p>
    </div>
  );
}