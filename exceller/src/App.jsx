// src/App.jsx
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import ProctoredTestPlayer from './components/ProctoredTestPlayer';
import ExamBuilder from './components/ExamBuilder';
import SubmissionsDashboard from './components/SubmissionsDashboard';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/builder" element={<ExamBuilder />} />
        <Route path="/submissions/:examId" element={<SubmissionsDashboard />} />
        <Route path="/test/:examId" element={<ProctoredTestPlayer />} />
      </Routes>
    </BrowserRouter>
  );
}

// Minimal landing page — just enough to navigate to the builder during dev.
function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4">
      <p className="text-sm font-semibold tracking-wide text-blue-600">EXCELLER</p>
      <h1 className="text-2xl font-bold">Proctored Testing Platform</h1>
      <Link
        to="/builder"
        className="bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 transition"
      >
        Go to Exam Builder
      </Link>
    </div>
  );
}