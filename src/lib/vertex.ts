import { GoogleGenAI } from "@google/genai";
import { env } from "./env";
import { pool } from "./db";

const client = new GoogleGenAI({
  vertexai: true,
  project: env.googleCloudProject,
  location: env.googleCloudLocation,
});

// USD per million tokens. This is what turns a real token count into the
// cost_usd column cost_events queries read for P&L -- update it when Vertex
// pricing changes, or the P&L quietly drifts from the actual bill.
const PRICING_PER_MILLION_TOKENS: Record<
  string,
  { input: number; output: number }
> = {
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
};

function estimateCostUsd(
  modelName: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing = PRICING_PER_MILLION_TOKENS[modelName];
  if (!pricing) return 0;
  return (
    (promptTokens / 1_000_000) * pricing.input +
    (completionTokens / 1_000_000) * pricing.output
  );
}

export interface GenerateOptions {
  // Which caller made the call, e.g. 'report_generation', 'course-sync',
  // 'bursary-verify', 'support'. Required so cost_events can be broken down
  // by feature in the P&L.
  source: string;
  reportId?: string;
  systemInstruction?: string;
  model?: string;
}

export interface GenerateResult {
  text: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
}

async function logCost(
  result: GenerateResult,
  source: string,
  reportId: string | undefined,
): Promise<void> {
  try {
    await pool.query(
      `insert into cost_events
         (report_id, source, model_name, prompt_tokens, completion_tokens, cost_usd)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        reportId ?? null,
        source,
        result.modelName,
        result.promptTokens,
        result.completionTokens,
        estimateCostUsd(result.modelName, result.promptTokens, result.completionTokens),
      ],
    );
  } catch (err) {
    // A cost-logging failure must never take down a paid report -- swallow
    // and move on. A broken cost_events insert is a P&L gap to notice
    // later, not a customer-facing 500.
    console.error("cost_events insert failed", err);
  }
}

// The one place any Gemini call is allowed to happen. Every caller --
// report generation, every agent -- goes through generate() or
// generateJson() so every call is logged, with no way to call the model
// and skip the ledger.
async function callModel(
  prompt: string,
  opts: GenerateOptions,
  responseMimeType?: "application/json",
): Promise<GenerateResult> {
  const modelName = opts.model ?? env.vertexModel;
  const response = await client.models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      systemInstruction: opts.systemInstruction,
      responseMimeType,
    },
  });

  const result: GenerateResult = {
    text: response.text ?? "",
    modelName,
    promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
  };

  await logCost(result, opts.source, opts.reportId);
  return result;
}

export async function generate(
  prompt: string,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  return callModel(prompt, opts);
}

export async function generateJson<T>(
  prompt: string,
  opts: GenerateOptions,
): Promise<T> {
  const result = await callModel(prompt, opts, "application/json");
  return JSON.parse(result.text) as T;
}
