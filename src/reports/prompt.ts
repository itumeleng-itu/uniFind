import type { AssembledInput } from "./generate";

// Every fact the model can use lives in this string, pulled straight from
// assembleInput's output. The model selects and explains from these rows;
// it never recalls an institution, bursary, or points requirement from
// training, because none of that is available to it here.
export function buildReportPrompt(input: AssembledInput): string {
  const { student, qualifiesFor, narrowlyMissed, alreadyClosed, bursaries } = input;

  return `You are writing a personalised university admissions report for a South African matric learner who paid for this report. Ground every claim strictly in the data given below -- never invent an institution, programme, bursary, deadline, or points requirement that isn't listed here.

Learner: ${student.name}
APS score: ${student.apsScore ?? "not provided"}
Subjects: ${JSON.stringify(student.subjects)}
Stated interests: ${student.interests ?? "none given"}

IMPORTANT: each programme below has a scoringSystem field. Only 'aps'
institutions select on the learner's APS score directly. Institutions with
scoringSystem 'uct_fps', 'stellenbosch', 'rhodes', or 'nbt_composite'
calculate their own composite score from the underlying results -- for
these, treat the learner's APS as indicative only, and say so explicitly
when you discuss them, rather than presenting the pointsRequirement
comparison as a determination of fit.

Programmes the learner qualifies for (ordered by closing date, most urgent first):
${JSON.stringify(qualifiesFor, null, 2)}

Programmes the learner narrowly missed (ordered by closing date):
${JSON.stringify(narrowlyMissed, null, 2)}

Programmes the learner would have qualified for, but the application window has already closed (context only -- do not recommend applying):
${JSON.stringify(alreadyClosed, null, 2)}

Bursaries currently open to apply for:
${JSON.stringify(bursaries, null, 2)}

Write the report in plain markdown, in a warm and direct tone for a young reader on a limited data budget. Structure it as: a short summary, then the qualifying programmes with why each fits, then narrow misses with what would close the gap, then a bursaries section, then a brief closed-programmes note for context. Do not list a programme or bursary that is not in the data above.`;
}
