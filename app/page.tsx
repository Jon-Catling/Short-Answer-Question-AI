"use client";

import { ChangeEvent, FormEvent, useMemo, useRef, useState } from "react";
import { EmailGate } from "./email-gate";
import { currentUserEmail, recordTokenUsage, TokenCounter } from "./token-counter";

type ShortAnswerQuestion = {
  question: string;
  source: string;
  focus: string;
};

type QuestionSet = {
  title: string;
  questions: ShortAnswerQuestion[];
};

type GenerationResponse = {
  jobId?: string;
  status?: string;
  questionSet?: QuestionSet;
  error?: string;
};

const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = ["pdf", "doc", "docx", "ppt", "pptx", "txt", "md", "rtf", "odt"];

function extension(name: string) { return name.split(".").pop()?.toLowerCase() ?? ""; }
function formatBytes(bytes: number) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function wait(milliseconds: number) { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }

async function responseData(response: Response): Promise<GenerationResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new Error("The website server returned an unexpected response. Please try again.");
  return response.json() as Promise<GenerationResponse>;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [questionCount, setQuestionCount] = useState("3");
  const [difficulty, setDifficulty] = useState("mixed");
  const [questionSet, setQuestionSet] = useState<QuestionSet | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [generationStatus, setGenerationStatus] = useState("");
  const [dragging, setDragging] = useState(false);
  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);

  function addFiles(incoming: File[]) {
    setError("");
    const unique = incoming.filter((file) => !files.some((current) => current.name === file.name && current.size === file.size));
    const next = [...files, ...unique];
    if (next.length > MAX_FILES) return setError(`You can upload a maximum of ${MAX_FILES} files.`);
    if (next.some((file) => !ACCEPTED_EXTENSIONS.includes(extension(file.name)))) return setError("Please use PDF, Word, PowerPoint, RTF, ODT, Markdown or text files.");
    if (next.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) return setError("The combined file size must be 25 MB or less.");
    setFiles(next); setQuestionSet(null);
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }

  async function generate(event: FormEvent) {
    event.preventDefault();
    if (!files.length) return setError("Add at least one source file before generating questions.");
    setLoading(true); setGenerationStatus("Uploading your files…"); setError(""); setQuestionSet(null);
    try {
      const form = new FormData();
      files.forEach((file) => form.append("files", file));
      form.append("questionCount", questionCount); form.append("difficulty", difficulty);
      const response = await fetch("/api/generate", { method: "POST", body: form, headers: { "x-user-email": currentUserEmail() } });
      let data = await responseData(response);
      if (!response.ok) throw new Error(data.error || "The questions could not be generated.");
      void recordTokenUsage(currentUserEmail(), Number(response.headers.get("x-openai-total-tokens") || 0));
      if (data.questionSet) setQuestionSet(data.questionSet);
      else {
        if (!data.jobId) throw new Error("Generation could not be started. Please try again.");
        setGenerationStatus("Creating questions from your materials…");
        const deadline = Date.now() + 9 * 60 * 1000;
        while (Date.now() < deadline) {
          await wait(2000);
          const statusResponse = await fetch(`/api/generate/status?id=${encodeURIComponent(data.jobId)}`, { cache: "no-store", headers: { "x-user-email": currentUserEmail() } });
          data = await responseData(statusResponse);
          if (!statusResponse.ok) throw new Error(data.error || "The questions could not be generated.");
          if (data.questionSet) { setQuestionSet(data.questionSet); break; }
        }
        if (!data.questionSet) throw new Error("This is taking longer than expected. Please try again with fewer questions or a smaller file.");
      }
      window.setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The questions could not be generated."); }
    finally { setLoading(false); setGenerationStatus(""); }
  }

  function clearQuestionsAndFiles() { setFiles([]); setQuestionSet(null); setError(""); setGenerationStatus(""); setDragging(false); if (inputRef.current) inputRef.current.value = ""; window.scrollTo({ top: 0, behavior: "smooth" }); }

  return <EmailGate><main>
    <header className="topbar"><a className="brand" href="#top" aria-label="Short Answer Question AI home"><span className="brand-mark">S</span><span>Short Answer Question AI</span></a><div className="header-actions"><TokenCounter /><span className="header-note">Focused questions for concise 150-word answers</span></div></header>
    <section className="hero" id="top">
      <div className="hero-copy"><p className="eyebrow"><span>✦</span> TURN TEACHING MATERIALS INTO SHORT-ANSWER QUESTIONS</p><h1>Your lecture files,<br/><em>made answerable.</em></h1><p className="intro">Upload your materials and generate focused, descriptive questions that test factual understanding in answers of up to 150 words.</p><div className="trust-row"><span>✓ Up to 10 files</span><span>✓ Questions for every file</span><span>✓ 150-word answers</span></div></div>
      <form className="builder-card" onSubmit={generate}>
        <div className="card-heading"><div><p className="card-kicker">BUILD A NEW QUESTION SET</p><h2>Choose your source files</h2></div><span className="step-pill">1 of 2</span></div>
        <input ref={inputRef} className="sr-only" type="file" multiple accept={ACCEPTED_EXTENSIONS.map((item) => `.${item}`).join(",")} onChange={handleFileInput}/>
        <button className={`dropzone ${dragging ? "dragging" : ""}`} type="button" onClick={() => inputRef.current?.click()} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}><span className="upload-icon" aria-hidden="true">↑</span><strong>Drop files here or browse</strong><small>PDF, Word, PowerPoint or text · 10 files · 25 MB total</small></button>
        {files.length > 0 && <div className="file-list" aria-label="Selected files"><div className="file-summary"><strong>{files.length} {files.length === 1 ? "file" : "files"} ready</strong><span>{formatBytes(totalBytes)}</span></div>{files.map((file, index) => <div className="file-row" key={`${file.name}-${file.size}`}><span className="file-type">{extension(file.name).toUpperCase()}</span><span className="file-name">{file.name}</span><span>{formatBytes(file.size)}</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => { setFiles(files.filter((_, i) => i !== index)); setQuestionSet(null); }}>×</button></div>)}</div>}
        <div className="settings-heading"><div><p className="card-kicker">QUESTION SETTINGS</p><h2>Set the challenge</h2></div><span className="step-pill">2 of 2</span></div>
        <div className="settings-grid"><label><span>Questions per file</span><select value={questionCount} onChange={(e) => setQuestionCount(e.target.value)}>{Array.from({length:10}, (_, i) => i + 1).map((count) => <option key={count} value={count}>{count}</option>)}</select></label><label><span>Difficulty</span><select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}><option value="easy">Easy</option><option value="medium">Medium</option><option value="challenging">Challenging</option><option value="mixed">Mixed</option></select></label></div>
        {files.length > 0 && <p className="question-total">This will create <strong>{Number(questionCount) * files.length} questions</strong> in total.</p>}
        {error && <div className="error" role="alert">{error}</div>}
        <button className="generate-button" type="submit" disabled={loading || files.length === 0}>{loading ? <><span className="spinner"/>{generationStatus || "Creating your questions…"}</> : <>Generate short-answer questions <span aria-hidden="true">→</span></>}</button>
        <p className="privacy-note">Files are sent securely for this generation and are not stored by this website. OpenAI API usage charges may apply.</p>
      </form>
    </section>
    {questionSet && <section className="results" ref={resultsRef}><div className="results-head"><div><p className="eyebrow">QUESTION SET READY</p><h2>{questionSet.title}</h2><p>{questionSet.questions.length} short-answer questions · grouped by source file</p></div></div><div className="question-list">{questionSet.questions.map((item, index) => <article className="question-card" key={index}><div className="question-number">{String(index + 1).padStart(2, "0")}</div><div className="question-content"><p className="source-tag">{item.source}</p><h3>{item.question}</h3><div className="focus"><strong>Answer focus</strong><p>{item.focus}</p></div></div></article>)}</div><div className="results-actions"><button className="start-over" onClick={clearQuestionsAndFiles}>Clear questions &amp; files</button></div></section>}
    <section className="how-it-works"><p className="eyebrow centered">DESIGNED FOR CONCISE KNOWLEDGE CHECKS</p><div className="features"><article><span>01</span><h3>Source faithful</h3><p>Every uploaded file receives the selected number of questions grounded in its content.</p></article><article><span>02</span><h3>Clear and factual</h3><p>Prompts focus on accurate description, explanation and understanding rather than extended analysis.</p></article><article><span>03</span><h3>Easy to answer</h3><p>Each question is tightly focused so a student can answer it clearly in no more than 150 words.</p></article></div></section>
    <footer><div className="brand"><span className="brand-mark">S</span><span>Short Answer Question AI</span></div><p>Focused knowledge checks in 150 words.</p></footer>
  </main></EmailGate>;
}
