// src/components/EditExam.jsx
//
// Route: /builder/edit/:examId
// Reuses the same section/question editing UI as ExamBuilder's create flow.
// On save: updates the exam's metadata directly, and REPLACES its entire
// question set (delete old rows, insert the new ones). This is simple and
// safe for exams with no submissions yet. If submissions already exist,
// a warning banner explains that past submissions' per-question review
// may become inaccurate (their SCORE stays correct either way — only the
// answer-by-answer replay could break, since old question IDs won't match
// the new ones).

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
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

// Reconstructs the sections/questions structure the builder UI expects
// from the flat, ordered rows the database actually stores.
function groupQuestionsIntoSections(rows) {
  const sections = [];
  let current = null;

  for (const row of rows) {
    const sectionLabel = row.section_title || '';
    if (!current || current.title !== sectionLabel) {
      current = { tempId: crypto.randomUUID(), title: sectionLabel, questions: [] };
      sections.push(current);
    }
    current.questions.push({
      tempId: crypto.randomUUID(),
      question_text: row.question_text,
      options: { A: '', B: '', C: '', D: '', ...row.options },
      correct_answer: row.correct_answer,
      points: row.points,
    });
  }

  return sections.length > 0 ? sections : [blankSection('Section 1')];
}

export default function EditExam() {
  const { examId } = useParams();
  const navigate = useNavigate();

  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [isOwner, setIsOwner] = useState(false);
  const [submissionCount, setSubmissionCount] = useState(0);

  const [title, setTitle] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [accessCode, setAccessCode] = useState('');
  const [showResults, setShowResults] = useState(true);
  const [instructions, setInstructions] = useState('');
  const [sections, setSections] = useState([blankSection('Section 1')]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // ==========================================================================
  // Auth
  // ==========================================================================
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setAuthChecked(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_e, session) => {
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
  // Load existing exam + questions + submission count
  // ==========================================================================
  const loadExam = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError('');

    try {
      const { data: examRow, error: examErr } = await supabase
        .from('exams')
        .select('*')
        .eq('id', examId)
        .single();
      if (examErr) throw examErr;

      setIsOwner(examRow.created_by === user.id);
      setTitle(examRow.title);
      setDurationMinutes(examRow.duration_minutes);
      setAccessCode(examRow.access_code);
      setShowResults(examRow.show_results_to_students);
      setInstructions(examRow.instructions || '');

      const { data: qData, error: qErr } = await supabase
        .from('questions')
        .select('question_text, options, correct_answer, points, section_title, question_order')
        .eq('exam_id', examId)
        .order('question_order');
      if (qErr) throw qErr;

      setSections(groupQuestionsIntoSections(qData));

      const { count, error: countErr } = await supabase
        .from('submissions')
        .select('id', { count: 'exact', head: true })
        .eq('exam_id', examId)
        .not('submitted_at', 'is', null);
      if (!countErr) setSubmissionCount(count || 0);
    } catch (err) {
      setLoadError(err.message || 'Failed to load exam.');
    } finally {
      setLoading(false);
    }
  }, [user, examId]);

  useEffect(() => {
    loadExam();
  }, [loadExam]);

  // ==========================================================================
  // Section/question helpers — identical to ExamBuilder's create flow
  // ==========================================================================
  const addSection = () =>
    setSections((prev) => [...prev, blankSection(`Section ${prev.length + 1}`)]);

  const removeSection = (sectionId) =>
    setSections((prev) => prev.filter((s) => s.tempId !== sectionId));

  const updateSectionTitle = (sectionId, newTitle) =>
    setSections((prev) =>
      prev.map((s) => (s.tempId === sectionId ? { ...s, title: newTitle } : s))
    );

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
  // Validation — identical rules to ExamBuilder's create flow
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
  // Save: update exam metadata, then replace the entire question set
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
      const { error: examErr } = await supabase
        .from('exams')
        .update({
          title: title.trim(),
          duration_minutes: Number(durationMinutes),
          access_code: accessCode.trim(),
          show_results_to_students: showResults,
          instructions: instructions.trim() || null,
        })
        .eq('id', examId);
      if (examErr) throw examErr;

      const { error: deleteErr } = await supabase
        .from('questions')
        .delete()
        .eq('exam_id', examId);
      if (deleteErr) throw deleteErr;

      const questionRows = [];
      let runningOrder = 0;
      for (const section of sections) {
        const sectionLabel = section.title.trim() || null;
        for (const q of section.questions) {
          const cleanOptions = Object.fromEntries(
            Object.entries(q.options).filter(([, v]) => v.trim() !== '')
          );
          questionRows.push({
            exam_id: examId,
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

      const { error: insertErr } = await supabase.from('questions').insert(questionRows);
      if (insertErr) throw insertErr;

      navigate('/builder');
    } catch (err) {
      setSaveError(err.message || 'Failed to save changes.');
    } finally {
      setSaving(false);
    }
  };

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

  if (loading) return <CenteredMessage text="Loading exam…" />;
  if (loadError) return <CenteredMessage text={loadError} isError />;

  if (!isOwner) {
    return (
      <CenteredMessage
        text="You can only edit exams you created yourself. You can still view this exam's submissions from the exam list."
        isError
      />
    );
  }

  const totalQuestionCount = sections.reduce((sum, s) => sum + s.questions.length, 0);

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <header className="flex items-center justify-between mb-6">
        <div>
          <p className="text-sm font-semibold tracking-wide text-blue-600">EXCELLER</p>
          <h1 className="text-2xl font-bold">Edit Exam</h1>
        </div>
        <Link to="/builder" className="text-sm text-gray-500 hover:text-gray-700">
          ← Back to my exams
        </Link>
      </header>

      {submissionCount > 0 && (
        <div className="bg-amber-50 border border-amber-300 text-amber-800 rounded-lg px-4 py-3 mb-6 text-sm">
          ⚠️ {submissionCount} student{submissionCount !== 1 ? 's have' : ' has'} already completed
          this exam. Saving changes will replace the question set — those students' scores stay
          exactly as originally graded, but their per-question review in the dashboard may no
          longer line up correctly against the new questions. Editing wording/typos is generally
          fine; removing or reordering questions after real submissions exist is riskier.
        </div>
      )}

      <div className="flex flex-col gap-8">
        <div className="border rounded-xl p-5 flex flex-col gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Exam Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Instructions <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={3}
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
              <input
                type="text"
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value.toUpperCase())}
                className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
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
              onOptionChange={(qId, key, value) => updateOption(section.tempId, qId, key, value)}
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
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Section / Question editors — same as ExamBuilder's create flow
// ============================================================================

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

      {canRemove && (
        <button onClick={onRemove} className="self-end text-xs text-red-500 hover:text-red-700">
          Remove question
        </button>
      )}
    </div>
  );
}

function CenteredMessage({ text, isError = false }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 text-center">
      <p className={isError ? 'text-red-600' : 'text-gray-500'}>{text}</p>
    </div>
  );
}