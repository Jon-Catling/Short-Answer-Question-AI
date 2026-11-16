import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher; OPENAI_API_KEY?: string; DB: D1Database; COST_REPORTER_SECRET?: string;
  IMAGES: { input(stream: ReadableStream): { transform(options: Record<string, unknown>): { output(options: { format: string; quality: number }): Promise<{ response(): Response }> } } };
}
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; }
type GenerationRequest = { questionCount: number; difficulty: "easy" | "medium" | "challenging" | "mixed" };
type OpenAIResponse = { id?: string; status?: "queued" | "in_progress" | "completed" | "failed" | "cancelled" | "incomplete"; output?: Array<{ content?: Array<{ type?: string; text?: string }> }>; error?: { message?: string }; incomplete_details?: { reason?: string }; usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number } };

const allowedExtensions = new Set(["pdf", "doc", "docx", "ppt", "pptx", "txt", "md", "rtf", "odt"]);
const mimeByExtension: Record<string, string> = { pdf:"application/pdf", doc:"application/msword", docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document", ppt:"application/vnd.ms-powerpoint", pptx:"application/vnd.openxmlformats-officedocument.presentationml.presentation", txt:"text/plain", md:"text/markdown", rtf:"application/rtf", odt:"application/vnd.oasis.opendocument.text" };
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type":"application/json; charset=utf-8", "cache-control":"no-store" } }); }
const allowedEmails = new Set(["j.c.catling@bham.ac.uk", "a.z.brzozowski@bham.ac.uk"]);
const dashboardUsageUrl = "https://ai-teaching-dashboard.utah1974.chatgpt.site/api/cost-usage";
function user(request: Request) { const email = request.headers.get("x-user-email")?.trim().toLowerCase() ?? ""; return allowedEmails.has(email) ? email : null; }
async function tables(env: Env) { await env.DB.batch([env.DB.prepare("CREATE TABLE IF NOT EXISTS token_counters (user_email TEXT PRIMARY KEY, total_tokens INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)"), env.DB.prepare("CREATE TABLE IF NOT EXISTS token_usage_events (response_id TEXT PRIMARY KEY, user_email TEXT NOT NULL, tokens INTEGER NOT NULL, created_at TEXT NOT NULL)")]); }
async function record(env: Env, email: string, payload: OpenAIResponse) { const tokens = payload.usage?.total_tokens ?? ((payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0)); if (!payload.id || tokens <= 0) return; await tables(env); const now = new Date().toISOString(); const saved = await env.DB.prepare("INSERT OR IGNORE INTO token_usage_events (response_id, user_email, tokens, created_at) VALUES (?, ?, ?, ?)").bind(payload.id, email, tokens, now).run(); if ((saved.meta.changes ?? 0) > 0) { await env.DB.prepare("INSERT INTO token_counters (user_email, total_tokens, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_email) DO UPDATE SET total_tokens = total_tokens + excluded.total_tokens, updated_at = excluded.updated_at").bind(email, tokens, now).run(); const response = await fetch(dashboardUsageUrl, { method: "POST", headers: { "content-type": "application/json", "x-cost-reporter-secret": env.COST_REPORTER_SECRET || "" }, body: JSON.stringify({ action: "add", email, tokens, eventId: `short-answer-question-ai:${payload.id}` }) }); if (!response.ok) throw new Error("Unable to update shared usage total."); } }
async function usage(request: Request, env: Env) { const email = new URL(request.url).searchParams.get("email")?.trim().toLowerCase() ?? ""; if(!allowedEmails.has(email) || user(request) !== email) return json({error:"Please sign in with an approved email address."},401); await tables(env); const row = await env.DB.prepare("SELECT total_tokens FROM token_counters WHERE user_email = ?").bind(email).first<{total_tokens:number}>(); return json({totalTokens:row?.total_tokens ?? 0}); }
async function dashboardUsage(request: Request, env: Env) { const email = new URL(request.url).searchParams.get("email")?.trim().toLowerCase() ?? ""; if (!allowedEmails.has(email)) return json({error:"Please sign in with an approved email address."},401); await tables(env); const row = await env.DB.prepare("SELECT total_tokens FROM token_counters WHERE user_email = ?").bind(email).first<{total_tokens:number}>(); const response = json({totalTokens:row?.total_tokens ?? 0}); const headers = new Headers(response.headers); headers.set("access-control-allow-origin", "https://ai-teaching-dashboard.utah1974.chatgpt.site"); headers.set("vary", "Origin"); return new Response(response.body, { status: response.status, headers }); }
async function resetUsage(request: Request, env: Env) { const {email=""}=await request.json() as {email?:string}; const value=email.trim().toLowerCase(); if(!allowedEmails.has(value) || user(request) !== value) return json({error:"Please sign in with an approved email address."},401); await tables(env); await env.DB.prepare("INSERT INTO token_counters (user_email,total_tokens,updated_at) VALUES (?,0,?) ON CONFLICT(user_email) DO UPDATE SET total_tokens=0,updated_at=excluded.updated_at").bind(value,new Date().toISOString()).run(); return json({totalTokens:0}); }
function readOutputText(payload: OpenAIResponse): string | null { for (const item of payload.output ?? []) for (const part of item.content ?? []) if (part.type === "output_text" && typeof part.text === "string") return part.text; return null; }
async function readOpenAIResponse(response: Response): Promise<OpenAIResponse> { if (!(response.headers.get("content-type") ?? "").includes("application/json")) throw new Error("The AI service returned an unexpected response. Please try again."); return response.json() as Promise<OpenAIResponse>; }

function completedQuestionSet(payload: OpenAIResponse): Response {
  const output = readOutputText(payload);
  if (!output) return json({ error:"The generation completed without a usable question set. Please try again." }, 502);
  try {
    const questionSet = JSON.parse(output);
    const valid = typeof questionSet.title === "string" && Array.isArray(questionSet.questions) && questionSet.questions.length > 0 && questionSet.questions.every((q: Record<string, unknown>) => typeof q.question === "string" && typeof q.source === "string" && typeof q.focus === "string");
    if (!valid) return json({ error:"The generated question set was incomplete. Please try again." }, 502);
    return json({ status:"completed", questionSet });
  } catch { return json({ error:"The generated questions could not be read. Please try again." }, 502); }
}

async function startGeneration(request: Request, env: Env): Promise<Response> {
  if (!env.OPENAI_API_KEY) return json({ error:"The OpenAI API key is not configured for this site." }, 503);
  const email = user(request); if (!email) return json({ error:"Please sign in with an approved email address." }, 401);
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((value): value is File => value instanceof File);
    const config: GenerationRequest = { questionCount:Number(form.get("questionCount")), difficulty:String(form.get("difficulty")) as GenerationRequest["difficulty"] };
    if (!files.length || files.length > 10) return json({ error:"Please upload between 1 and 10 files." }, 400);
    if (!Number.isInteger(config.questionCount) || config.questionCount < 1 || config.questionCount > 10) return json({ error:"Choose between 1 and 10 questions per file." }, 400);
    if (!["easy","medium","challenging","mixed"].includes(config.difficulty)) return json({ error:"Choose a valid difficulty." }, 400);
    if (files.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024) return json({ error:"The combined file size must be 25 MB or less." }, 413);

    const fileInputs = await Promise.all(files.map(async (file) => {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (!allowedExtensions.has(ext)) throw new Error(`Unsupported file type: ${file.name}`);
      const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
      return { type:"input_file", filename:file.name, file_data:`data:${file.type || mimeByExtension[ext] || "application/octet-stream"};base64,${base64}` };
    }));
    const totalQuestions = config.questionCount * files.length;
    const schema = { type:"object", properties:{ title:{ type:"string", description:"A concise title derived from the uploaded teaching materials." }, questions:{ type:"array", minItems:totalQuestions, maxItems:totalQuestions, items:{ type:"object", properties:{ question:{ type:"string" }, source:{ type:"string", description:"The exact source filename and, when identifiable, slide, page or section." }, focus:{ type:"string", description:"A concise statement of the knowledge, argument and critical evaluation the question assesses." } }, required:["question","source","focus"], additionalProperties:false } } }, required:["title","questions"], additionalProperties:false };
    const difficultyText = config.difficulty === "mixed" ? "Within each file, use a balanced range from accessible explanation to demanding synthesis and evaluation." : `Make every question ${config.difficulty} for university students.`;
    const filenames = files.map((file) => file.name).join(", ");
    const prompt = `Create exactly ${config.questionCount} distinct short-answer questions for EACH uploaded file (${totalQuestions} questions in total). Files: ${filenames}. ${difficultyText}\n\nEvery question must be answerable from its named source file in no more than 150 words. Test accurate subject knowledge, understanding and concise explanation. Prefer clear command words such as “Describe…”, “Explain…”, “Outline…”, “Summarise…”, “Identify and explain…”, and “What are the main…”. Keep each question tightly focused on one topic or a small set of related facts. Questions should be more descriptive and factual than analytical: do not ask for critical evaluation, extended argument, broad discussion, personal opinion or essay-style comparison. Avoid yes/no questions, trivia, duplication, vague wording and claims not supported by the file. Cover each file broadly. For every question, give the exact source filename and a concise answer focus indicating the key knowledge expected. Ensure each uploaded file contributes exactly ${config.questionCount} questions.`;

    const apiResponse = await fetch("https://api.openai.com/v1/responses", { method:"POST", headers:{ authorization:`Bearer ${env.OPENAI_API_KEY}`, "content-type":"application/json" }, body:JSON.stringify({ model:"gpt-5.6-luna", store:false, background:true, max_output_tokens:Math.min(30000, 1600 + totalQuestions * 260), input:[{ role:"user", content:[...fileInputs, { type:"input_text", text:prompt }] }], text:{ format:{ type:"json_schema", name:"short_answer_question_set", strict:true, schema } } }) });
    const payload = await readOpenAIResponse(apiResponse);
    if (!apiResponse.ok) return json({ error:payload.error?.message || "OpenAI could not generate the questions." }, apiResponse.status >= 500 ? 502 : apiResponse.status);
    if (!payload.id) return json({ error:"The AI service did not return a generation reference. Please try again." }, 502);
    if (payload.status === "completed") { try { await record(env, email, payload); } catch {} return completedQuestionSet(payload); }
    if (["failed","cancelled","incomplete"].includes(payload.status ?? "")) return json({ error:payload.error?.message || payload.incomplete_details?.reason || "The question generation did not complete. Please try again." }, 502);
    return json({ jobId:payload.id, status:payload.status || "queued" }, 202);
  } catch (error) { return json({ error:error instanceof Error ? error.message : "The questions could not be generated." }, 500); }
}

async function checkGeneration(request: Request, env: Env): Promise<Response> {
  if (!env.OPENAI_API_KEY) return json({ error:"The OpenAI API key is not configured for this site." }, 503);
  const email = user(request); if (!email) return json({ error:"Please sign in with an approved email address." }, 401);
  const jobId = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^resp_[A-Za-z0-9_-]{6,200}$/.test(jobId)) return json({ error:"Invalid generation reference." }, 400);
  try {
    const apiResponse = await fetch(`https://api.openai.com/v1/responses/${encodeURIComponent(jobId)}`, { headers:{ authorization:`Bearer ${env.OPENAI_API_KEY}`, "content-type":"application/json" } });
    const payload = await readOpenAIResponse(apiResponse);
    if (!apiResponse.ok) return json({ error:payload.error?.message || "The question status could not be checked." }, apiResponse.status >= 500 ? 502 : apiResponse.status);
    if (payload.status === "completed") { try { await record(env, email, payload); } catch {} return completedQuestionSet(payload); }
    if (["failed","cancelled","incomplete"].includes(payload.status ?? "")) return json({ error:payload.error?.message || payload.incomplete_details?.reason || "The question generation did not complete. Please try again." }, 502);
    return json({ jobId, status:payload.status || "in_progress" });
  } catch (error) { return json({ error:error instanceof Error ? error.message : "The question status could not be checked." }, 500); }
}

const worker = { async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/generate" && request.method === "POST") return startGeneration(request, env);
  if (url.pathname === "/api/generate/status" && request.method === "GET") return checkGeneration(request, env);
  if (url.pathname === "/api/dashboard-token-usage" && request.method === "GET") return dashboardUsage(request, env);
  if (url.pathname === "/api/token-usage" && request.method === "GET") return usage(request, env);
  if (url.pathname === "/api/token-usage" && request.method === "POST") return resetUsage(request, env);
  if (url.pathname === "/_vinext/image") { const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES]; return handleImageOptimization(request, { fetchAsset:(path) => env.ASSETS.fetch(new Request(new URL(path, request.url))), transformImage:async (body, { width, format, quality }) => (await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality })).response() }, allowedWidths); }
  return handler.fetch(request, env, ctx);
} };
export default worker;
