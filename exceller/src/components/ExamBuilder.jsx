// src/components/ExamBuilder.jsx
//
// Admin-side dynamic exam builder.
// Structure: an exam has one or more SECTIONS, and each section has one or
// more QUESTIONS. Sections are the primary organizing unit — you add a
// section once, then add as many questions as you like inside it (10, 20,
// whatever), rather than tagging every individual question with a repeated
// label.
//
// Assumes a configured Supabase client exported from ../lib/supabaseClient.js
// and that the signed-in user reaches this route already authenticated
// (wrap this route in your own admin-auth guard / layout).

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

const EMPTY_OPTION_KEYS = ['A', 'B', 'C', 'D'];

function blankQuestion() {
  return {
    tempId: crypto.randomUUID(),
    question_text: '',
    options: { A: '', B: '', C: '', D: '' },
    correct_answer: 'A',
    points: 1,
  };
}

function blankSection(label) {
  return {
    tempId: crypto.randomUUID(),
    title: label || '',
    questions: [blankQuestion()],
  };
}

function randomAccessCode() {
  // 6-char, human-typeable, no ambiguous chars (0/O, 1/I).
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export default function ExamBuilder() {
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [view, setView] = useState('list'); // 'list' | 'create' | 'created'

  const [myExams, setMyExams] = useState([]);
  const [loadingExams, setLoadingExams] = useState(true);

  // ---- Exam meta fields ----------------------------------------------------
  const [title, setTitle] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [accessCode, setAccessCode] = useState(randomAccessCode());
  const [showResults, setShowResults] = useState(true);

  // ---- Sections (each containing its own questions) ------------------------
  const [sections, setSections] = useState([blankSection('Section 1')]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [createdExam, setCreatedExam] = useState(null);

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

  const loadMyExams = useCallback(async () => {
    if (!user) return;
    setLoadingExams(true);
    const { data, error } = await supabase
      .from('exams')
      .select('id, title, duration_minutes, access_code, show_results_to_students, created_at')
      .eq('created_by', user.id)
      .order('created_at', { ascending: false });

    if (!error) setMyExams(data);
    setLoadingExams(false);
  }, [user]);

  useEffect(() => {
    loadMyExams();
  }, [loadMyExams]);

  const [deletingId, setDeletingId] = useState(null);

  const deleteExam = async (examToDelete) => {
    const confirmed = window.confirm(
      `Delete "${examToDelete.title}"? This permanently removes the exam, all its questions, and every student submission for it. This cannot be undone.`
    );
    if (!confirmed) return;

    setDeletingId(examToDelete.id);
    try {
      const { error } = await supabase.from('exams').delete().eq('id', examToDelete.id);
      if (error) throw error;
      setMyExams((prev) => prev.filter((e) => e.id !== examToDelete.id));
    } catch (err) {
      alert(`Could not delete exam: ${err.message}`);
    } finally {
      setDeletingId(null);
    }
  };

  // ==========================================================================
  // Section helpers
  // ==========================================================================
  const addSection = () =>
    setSections((prev) => [...prev, blankSection(`Section ${prev.length + 1}`)]);

  const removeSection = (sectionId) =>
    setSections((prev) => prev.filter((s) => s.tempId !== sectionId));

  const updateSectionTitle = (sectionId, newTitle) =>
    setSections((prev) =>
      prev.map((s) => (s.tempId === sectionId ? { ...s, title: newTitle } : s))
    );

  // ==========================================================================
  // Question helpers (scoped to a specific section)
  // ==========================================================================
  const addQuestion = (sectionId) =>
    setSections((prev) =>
      prev.map((s) =>
        s.tempId === sectionId ? { ...s, questions: [...s.questions, blankQuestion()] } : s
      )
    );

  const removeQuestion = (sectionId, questionTempId) =>
    setSections((prev) =>
      prev.map((s) =>
        s.tempId === sectionId
          ? { ...s, questions: s.questions.filter((q) => q.tempId !== questionTempId) }
          : s
      )
    );

  const updateQuestion = (sectionId, questionTempId, patch) =>
    setSections((prev) =>
      prev.map((s) =>
        s.tempId === sectionId
          ? {
              ...s,
              questions: s.questions.map((q) =>
                q.tempId === questionTempId ? { ...q, ...patch } : q
              ),
            }
          : s
      )
    );

  const updateOption = (sectionId, questionTempId, key, value) =>
    setSections((prev) =>
      prev.map((s) =>
        s.tempId === sectionId
          ? {
              ...s,
              questions: s.questions.map((q) =>
                q.tempId === questionTempId
                  ? { ...q, options: { ...q.options, [key]: value } }
                  : q
              ),
            }
          : s
      )
    );

  // ==========================================================================
  // Validation
  // ==========================================================================
  const validate = () => {
    if (!title.trim()) return 'Exam title is required.';
    if (!durationMinutes || durationMinutes <= 0) return 'Duration must be greater than 0.';
    if (!accessCode.trim()) return 'Access code is required.';
    if (sections.length === 0) return 'Add at least one section.';

    for (const [sIdx, section] of sections.entries()) {
      if (section.questions.length === 0) {
        return `Section ${sIdx + 1} ("${section.title || 'Untitled'}") needs at least one question.`;
      }
      for (const [qIdx, q] of section.questions.entries()) {
        const label = `Section ${sIdx + 1}, Question ${qIdx + 1}`;
        if (!q.question_text.trim()) return `${label} is missing its text.`;
        const filledOptions = Object.values(q.options).filter((v) => v.trim() !== '');
        if (filledOptions.length < 2) return `${label} needs at least 2 options.`;
        if (!q.options[q.correct_answer]?.trim())
          return `${label}'s correct answer points to an empty option.`;
        if (!q.points || q.points <= 0) return `${label} needs points greater than 0.`;
      }
    }
    return null;
  };

  // ==========================================================================
  // Save exam + sections' questions
  // ==========================================================================
  const handleSave = async () => {
    setSaveError('');
    const validationError = validate();
    if (validationError) {
      setSaveError(validationError);
      return;
    }

    setSaving(true);
    try {
      const { data: examRow, error: examErr } = await supabase
        .from('exams')
        .insert({
          title: title.trim(),
          duration_minutes: Number(durationMinutes),
          access_code: accessCode.trim(),
          show_results_to_students: showResults,
          created_by: user.id,
        })
        .select()
        .single();
      if (examErr) throw examErr;

      // Flatten sections -> question rows, with a single running
      // question_order across the whole exam so ordering is preserved
      // end-to-end (section boundaries are implied by section_title
      // staying constant across consecutive rows).
      const questionRows = [];
      let runningOrder = 0;
      for (const section of sections) {
        const sectionLabel = section.title.trim() || null;
        for (const q of section.questions) {
          const cleanOptions = Object.fromEntries(
            Object.entries(q.options).filter(([, v]) => v.trim() !== '')
          );
          questionRows.push({
            exam_id: examRow.id,
            section_title: sectionLabel,
            question_text: q.question_text.trim(),
            options: cleanOptions,
            correct_answer: q.correct_answer,
            points: Number(q.points),
            question_order: runningOrder,
          });
          runningOrder += 1;
        }
      }

      const { error: qErr } = await supabase.from('questions').insert(questionRows);
      if (qErr) throw qErr;

      setCreatedExam(examRow);
      setView('created');
      loadMyExams();
    } catch (err) {
      setSaveError(err.message || 'Failed to save exam.');
    } finally {
      setSaving(false);
    }
  };

  const resetForm = () => {
    setTitle('');
    setDurationMinutes(30);
    setAccessCode(randomAccessCode());
    setShowResults(true);
    setSections([blankSection('Section 1')]);
    setSaveError('');
    setCreatedExam(null);
  };

  // ==========================================================================
  // RENDER
  // ==========================================================================

  if (!authChecked) {
    return <CenteredMessage text="Loading…" />;
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="bg-white shadow-md rounded-2xl p-8 w-full max-w-md text-center">
          <p className="text-sm font-semibold tracking-wide text-blue-600 mb-1">EXCELLER</p>
          <h1 className="text-xl font-semibold mb-4">Admin Sign In</h1>
          <p className="text-gray-600 mb-6">Sign in with Google to create and manage exams.</p>
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

  const totalQuestionCount = sections.reduce((sum, s) => sum + s.questions.length, 0);

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <header className="flex items-center justify-between mb-8">
        <div>
          <p className="text-sm font-semibold tracking-wide text-blue-600">EXCELLER</p>
          <h1 className="text-2xl font-bold">Exam Builder</h1>
        </div>
        {view !== 'list' && (
          <button
            onClick={() => {
              setView('list');
              resetForm();
            }}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            ← Back to my exams
          </button>
        )}
      </header>

      {view === 'list' && (
        <ExamList
          exams={myExams}
          loading={loadingExams}
          onCreateNew={() => setView('create')}
          onDelete={deleteExam}
          deletingId={deletingId}
        />
      )}

      {view === 'create' && (
        <div className="flex flex-col gap-8">
          <ExamMetaForm
            title={title}
            setTitle={setTitle}
            durationMinutes={durationMinutes}
            setDurationMinutes={setDurationMinutes}
            accessCode={accessCode}
            setAccessCode={setAccessCode}
            showResults={showResults}
            setShowResults={setShowResults}
          />

          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                Sections ({sections.length}) · {totalQuestionCount} question
                {totalQuestionCount !== 1 ? 's' : ''} total
              </h2>
              <button
                onClick={addSection}
                className="text-sm bg-blue-600 text-white hover:bg-blue-700 px-3 py-1.5 rounded-lg"
              >
                + Add Section
              </button>
            </div>

            {sections.map((section, sIdx) => (
              <SectionEditor
                key={section.tempId}
                index={sIdx}
                section={section}
                canRemoveSection={sections.length > 1}
                onTitleChange={(newTitle) => updateSectionTitle(section.tempId, newTitle)}
                onRemoveSection={() => removeSection(section.tempId)}
                onAddQuestion={() => addQuestion(section.tempId)}
                onRemoveQuestion={(qId) => removeQuestion(section.tempId, qId)}
                onQuestionChange={(qId, patch) => updateQuestion(section.tempId, qId, patch)}
                onOptionChange={(qId, key, value) =>
                  updateOption(section.tempId, qId, key, value)
                }
              />
            ))}
          </div>

          {saveError && (
            <p className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-4 py-3">
              {saveError}
            </p>
          )}

          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 transition font-medium disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Exam'}
          </button>
        </div>
      )}

      {view === 'created' && createdExam && (
        <CreatedSummary
          exam={createdExam}
          onDone={() => {
            setView('list');
            resetForm();
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function ExamList({ exams, loading, onCreateNew, onDelete, deletingId }) {
  return (
    <div className="flex flex-col gap-4">
      <button
        onClick={onCreateNew}
        className="bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 transition font-medium"
      >
        + Create New Exam
      </button>

      {loading ? (
        <p className="text-gray-500 text-sm">Loading your exams…</p>
      ) : exams.length === 0 ? (
        <p className="text-gray-500 text-sm">No exams yet. Create your first one above.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {exams.map((exam) => (
            <div key={exam.id} className="border rounded-xl p-4 flex justify-between items-center">
              <div>
                <p className="font-medium">{exam.title}</p>
                <p className="text-sm text-gray-500">
                  {exam.duration_minutes} min · Code: {exam.access_code} ·{' '}
                  {exam.show_results_to_students ? 'Shows results' : 'Hides results'}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  Created {new Date(exam.created_at).toLocaleDateString()} at{' '}
                  {new Date(exam.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
              <div className="flex items-center gap-4 ml-4">
                <a
                  href={`/test/${exam.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-blue-600 hover:underline whitespace-nowrap"
                >
                  Open link →
                </a>
                <a
                  href={`/submissions/${exam.id}`}
                  className="text-sm text-gray-600 hover:underline whitespace-nowrap"
                >
                  View submissions →
                </a>
                <button
                  onClick={() => onDelete(exam)}
                  disabled={deletingId === exam.id}
                  className="text-sm text-red-500 hover:text-red-700 whitespace-nowrap disabled:opacity-50"
                >
                  {deletingId === exam.id ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ExamMetaForm({
  title,
  setTitle,
  durationMinutes,
  setDurationMinutes,
  accessCode,
  setAccessCode,
  showResults,
  setShowResults,
}) {
  return (
    <div className="border rounded-xl p-5 flex flex-col gap-4">
      <div>
        <label className="block text-sm font-medium mb-1">Exam Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Midterm — Data Structures"
          className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Duration (minutes)</label>
          <input
            type="number"
            min={1}
            value={durationMinutes}
            onChange={(e) => setDurationMinutes(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Access Code</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value.toUpperCase())}
              className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            />
            <button
              type="button"
              onClick={() => setAccessCode(randomAccessCode())}
              className="text-sm bg-gray-100 hover:bg-gray-200 px-3 rounded-lg whitespace-nowrap"
            >
              Randomize
            </button>
          </div>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={showResults}
          onChange={(e) => setShowResults(e.target.checked)}
          className="accent-blue-600"
        />
        Show results to students instantly upon submission
      </label>
    </div>
  );
}

// ---- Section editor: a titled container holding N question editors --------
function SectionEditor({
  index,
  section,
  canRemoveSection,
  onTitleChange,
  onRemoveSection,
  onAddQuestion,
  onRemoveQuestion,
  onQuestionChange,
  onOptionChange,
}) {
  return (
    <div className="border-2 border-blue-100 rounded-2xl p-5 flex flex-col gap-4 bg-blue-50/30">
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold text-blue-600 whitespace-nowrap">
          SECTION {index + 1}
        </span>
        <input
          type="text"
          value={section.title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="Section title (e.g. Part A — Multiple Choice)"
          className="flex-1 border rounded-lg px-3 py-2 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
        />
        {canRemoveSection && (
          <button
            onClick={onRemoveSection}
            className="text-xs text-red-500 hover:text-red-700 whitespace-nowrap"
          >
            Remove section
          </button>
        )}
      </div>

      <div className="flex flex-col gap-4 pl-1">
        {section.questions.map((q, qIdx) => (
          <QuestionEditor
            key={q.tempId}
            index={qIdx}
            question={q}
            canRemove={section.questions.length > 1}
            onChange={(patch) => onQuestionChange(q.tempId, patch)}
            onOptionChange={(key, value) => onOptionChange(q.tempId, key, value)}
            onRemove={() => onRemoveQuestion(q.tempId)}
          />
        ))}
      </div>

      <button
        onClick={onAddQuestion}
        className="self-start text-sm bg-white border border-gray-200 hover:bg-gray-50 px-3 py-1.5 rounded-lg"
      >
        + Add Question to this section
      </button>
    </div>
  );
}

function QuestionEditor({ index, question, canRemove, onChange, onOptionChange, onRemove }) {
  return (
    <div className="border rounded-xl p-5 flex flex-col gap-3 bg-white">
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-semibold text-gray-500 mt-2">Q{index + 1}</span>
        <textarea
          value={question.question_text}
          onChange={(e) => onChange({ question_text: e.target.value })}
          placeholder="Question text"
          rows={2}
          className="flex-1 border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="flex flex-col items-end gap-1">
          <label className="text-xs text-gray-500">Points</label>
          <input
            type="number"
            min={0.5}
            step={0.5}
            value={question.points}
            onChange={(e) => onChange({ points: e.target.value })}
            className="w-20 border rounded-lg px-2 py-1 text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {EMPTY_OPTION_KEYS.map((key) => (
          <div key={key} className="flex items-center gap-2">
            <input
              type="radio"
              name={`correct-${question.tempId}`}
              checked={question.correct_answer === key}
              onChange={() => onChange({ correct_answer: key })}
              title="Mark as correct answer"
              className="accent-green-600"
            />
            <span className="text-sm font-medium w-4">{key}</span>
            <input
              type="text"
              value={question.options[key]}
              onChange={(e) => onOptionChange(key, e.target.value)}
              placeholder={`Option ${key}`}
              className="flex-1 border rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-400">Select the radio button next to the correct option.</p>

      {canRemove && (
        <button onClick={onRemove} className="self-end text-xs text-red-500 hover:text-red-700">
          Remove question
        </button>
      )}
    </div>
  );
}

function CreatedSummary({ exam, onDone }) {
  const link = `${window.location.origin}/test/${exam.id}`;

  return (
    <div className="border rounded-xl p-6 flex flex-col gap-4">
      <p className="text-sm font-semibold tracking-wide text-blue-600">EXCELLER</p>
      <h2 className="text-xl font-semibold">Exam Created 🎉</h2>
      <div>
        <p className="text-sm text-gray-500">Shareable link</p>
        <div className="flex gap-2 mt-1">
          <input
            readOnly
            value={link}
            className="flex-1 border rounded-lg px-3 py-2 font-mono text-sm bg-gray-50"
          />
          <button
            onClick={() => navigator.clipboard.writeText(link)}
            className="bg-gray-100 hover:bg-gray-200 px-3 rounded-lg text-sm"
          >
            Copy
          </button>
        </div>
      </div>
      <div>
        <p className="text-sm text-gray-500">Access code</p>
        <p className="font-mono text-lg font-semibold">{exam.access_code}</p>
      </div>
      <button
        onClick={onDone}
        className="mt-2 bg-blue-600 text-white py-2.5 rounded-lg hover:bg-blue-700 transition font-medium"
      >
        Done
      </button>
    </div>
  );
}

function CenteredMessage({ text }) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <p className="text-gray-500">{text}</p>
    </div>
  );
}