import { pool } from "@/lib/db";
import { refundTransaction } from "@/lib/paystack";
import { generateJson, generate } from "@/lib/vertex";
import { generateReport } from "@/reports/generate";
import { runBursaryVerify, type BursaryCheckResult } from "./bursary-verify";
import { runCourseSync, type ExtractedProgramme, type ProspectusDiscovery } from "./course-sync";
import { runSupport, type TriageResult } from "./support";

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.text();
}

// HTML pages easily exceed a useful prompt budget; a truncated page still
// carries enough signal for discovery/extraction, and staying well under
// the model's context window keeps cost_events honest per call.
const MAX_HTML_CHARS = 25_000;

async function discoverProspectusUrlViaGemini(
  institutionName: string,
  homepageUrl: string,
): Promise<ProspectusDiscovery> {
  const html = await fetchText(homepageUrl);
  return generateJson<ProspectusDiscovery>(
    `Given the homepage HTML of ${institutionName} below, find the URL of the page listing undergraduate programme admission requirements (a "prospectus" or "faculty requirements" page). Respond as JSON: {"url": string, "confidence": number between 0 and 1, "rationale": string}.\n\nHomepage URL: ${homepageUrl}\n\nHTML:\n${html.slice(0, MAX_HTML_CHARS)}`,
    { source: "course-sync" },
  );
}

async function extractProgrammesViaGemini(
  institutionName: string,
  prospectusUrl: string,
): Promise<ExtractedProgramme[]> {
  const html = await fetchText(prospectusUrl);
  return generateJson<ExtractedProgramme[]>(
    `Extract every undergraduate programme listed for ${institutionName} from the HTML below. Respond as a JSON array; each item: {"faculty": string, "name": string, "qualification": string, "pointsRequirement": number, "subjectRequirements": [{"subject": string, "minLevel": number}], "confidence": number between 0 and 1, "rationale": string}. Only include programmes with explicit admission requirements on the page.\n\nHTML:\n${html.slice(0, MAX_HTML_CHARS * 2)}`,
    { source: "course-sync" },
  );
}

async function checkBursaryPageViaGemini(url: string): Promise<BursaryCheckResult> {
  const html = await fetchText(url);
  return generateJson<BursaryCheckResult>(
    `Read the bursary page HTML below and determine whether applications are currently open. Respond as JSON: {"isOpen": boolean, "confidence": number between 0 and 1, "rationale": string}.\n\nHTML:\n${html.slice(0, MAX_HTML_CHARS)}`,
    { source: "bursary-verify" },
  );
}

async function triageTicketViaGemini(ticket: {
  subject: string;
  body: string;
}): Promise<TriageResult> {
  return generateJson<TriageResult>(
    `Triage this support ticket for uniFind, a paid (R79) university admissions matching report service. Respond as JSON: {"action": "regenerate_report" | "refund" | "resolve" | "escalate_to_human", "confidence": number between 0 and 1, "rationale": string, "refundAmountCents": number (only when action is "refund")}.\n\nSubject: ${ticket.subject}\nBody: ${ticket.body}`,
    { source: "support" },
  );
}

// Cloud Run Jobs invokes this entrypoint with an AGENT env var selecting
// which agent runs -- the same container image backs the web service and
// every scheduled job (course-sync nightly, bursary-verify weekly, support
// hourly), each Cloud Scheduler trigger just sets a different AGENT value.
async function main(): Promise<void> {
  const agentName = process.env.AGENT;

  switch (agentName) {
    case "course-sync":
      await runCourseSync({
        db: pool,
        discoverProspectusUrl: discoverProspectusUrlViaGemini,
        extractProgrammes: extractProgrammesViaGemini,
      });
      return;
    case "bursary-verify":
      await runBursaryVerify({ db: pool, checkBursaryPage: checkBursaryPageViaGemini });
      return;
    case "support":
      await runSupport({
        db: pool,
        triageTicket: triageTicketViaGemini,
        generateReport: (reportId) => generateReport({ db: pool, generate }, reportId),
        refundTransaction,
      });
      return;
    default:
      throw new Error(
        `Unknown AGENT env var: ${String(agentName)}. Expected one of course-sync, bursary-verify, support.`,
      );
  }
}

// A Cloud Run Job runs once and exits -- without closing the pool
// explicitly, the process would hang on the open connections.
main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
