import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { renderReportMarkdown } from "@/reports/renderMarkdown";
import styles from "./page.module.css";

interface ReportRow {
  status: string;
  content: string | null;
}

async function getReport(token: string): Promise<ReportRow | null> {
  const { rows } = await getPool().query<ReportRow>(
    `select status, content from reports where token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

interface PageProps {
  params: Promise<{ token: string }>;
}

// A plain async Server Component: no client component anywhere on this
// route, no next/font, no next/image. The reader is on a mid-range Android
// paying for their own data, so this page is just text.
export default async function ReportPage({ params }: PageProps): Promise<React.JSX.Element> {
  const { token } = await params;
  const report = await getReport(token);

  if (!report) {
    notFound();
  }

  if (report.status !== "completed" || !report.content) {
    return (
      <main className={styles.report}>
        <p>Your report is still being generated. Check back in a minute.</p>
      </main>
    );
  }

  // renderReportMarkdown HTML-escapes the content before interpreting any
  // markdown syntax, so this is safe even though the report echoes the
  // learner's own free-text "interests" field.
  const html = renderReportMarkdown(report.content);

  return (
    <main className={styles.report}>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </main>
  );
}
