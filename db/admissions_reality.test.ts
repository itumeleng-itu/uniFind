import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate";

async function createTestDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await applyMigrations(db);
  return db;
}

describe("phase 2: admissions reality", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("accepts every documented scoring_system value", async () => {
    for (const system of [
      "aps",
      "uct_fps",
      "stellenbosch",
      "rhodes",
      "nbt_composite",
      "open",
    ]) {
      await db.query(
        `insert into institutions (name, slug, homepage_url, scoring_system)
         values ($1, $2, 'https://example.ac.za', $3)`,
        [`Institution ${system}`, `inst-${system}`, system],
      );
    }
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from institutions`);
    expect(rows[0].n).toBe(6);
  });

  it("excludes a closed programme and returns an open one via open_programmes", async () => {
    const { rows: instRows } = await db.query<{ id: string }>(
      `insert into institutions (name, slug, homepage_url, application_deadline)
       values ('Test University', 'test-university', 'https://test.ac.za', '2020-01-01')
       returning id`,
    );
    const institutionId = instRows[0].id;

    // Closed: relies on the institution-wide deadline, which is in the past.
    await db.query(
      `insert into programmes (institution_id, faculty, name, qualification, points_requirement, status)
       values ($1, 'Humanities', 'BA Closed', 'BA', 30, 'verified')`,
      [institutionId],
    );

    // Open: a faculty-level deadline overrides the (also past) institution
    // deadline with a date in the future.
    const { rows: openProgRows } = await db.query<{ id: string }>(
      `insert into programmes (institution_id, faculty, name, qualification, points_requirement, status)
       values ($1, 'Science', 'BSc Open', 'BSc', 32, 'verified')
       returning id`,
      [institutionId],
    );
    await db.query(
      `insert into faculty_deadlines (institution_id, faculty, deadline)
       values ($1, 'Science', '2099-01-01')`,
      [institutionId],
    );

    const { rows } = await db.query<{ id: string; name: string }>(
      `select id, name from open_programmes where institution_id = $1`,
      [institutionId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(openProgRows[0].id);
    expect(rows[0].name).toBe("BSc Open");
  });

  it("treats a programme with no deadline anywhere as open", async () => {
    const { rows: instRows } = await db.query<{ id: string }>(
      `insert into institutions (name, slug, homepage_url)
       values ('No Deadline University', 'no-deadline-university', 'https://nodeadline.ac.za')
       returning id`,
    );
    const institutionId = instRows[0].id;

    await db.query(
      `insert into programmes (institution_id, faculty, name, qualification, points_requirement, status)
       values ($1, 'Law', 'LLB', 'LLB', 34, 'verified')`,
      [institutionId],
    );

    const { rows } = await db.query(
      `select 1 from open_programmes where institution_id = $1`,
      [institutionId],
    );
    expect(rows).toHaveLength(1);
  });
});
