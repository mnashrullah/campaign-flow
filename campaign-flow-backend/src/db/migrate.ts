import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "./client.js";

/**
 * Minimal migration runner: executes the idempotent schema.sql. For a take-home
 * this is deliberately simpler than a full migration framework — the DDL uses
 * IF NOT EXISTS / duplicate_object guards so it is safe to run on every boot.
 */
async function migrate() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(join(here, "schema.sql"), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("[migrate] schema applied");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[migrate] failed", err);
    throw err;
  } finally {
    client.release();
  }
}

migrate()
  .then(() => pool.end())
  .catch((err) => {
    console.error("[migrate] error", err);
    process.exitCode = 1;
    return pool.end();
  });

