import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  initializeLearningSchema,
  LEARNING_SCHEMA_VERSION,
} from "../src/learning/learningSchema.ts";

test("initializeLearningSchema creates and reopens the current schema", async () => {
  const db = await database();
  initializeLearningSchema(db);
  initializeLearningSchema(db);

  assert.equal(readVersion(db), LEARNING_SCHEMA_VERSION);
  const tables = db
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND (
            name = 'agent_observations'
            OR name LIKE 'delivery_episode%'
            OR name LIKE 'experience_%'
          )
        ORDER BY name
      `,
    )
    .all() as unknown as Array<{ name: string }>;
  assert.equal(tables.length, 17);
});

test("initializeLearningSchema refuses an unversioned existing schema", async () => {
  const db = await database();
  db.exec("CREATE TABLE agent_observations (cursor INTEGER PRIMARY KEY)");

  assert.throws(
    () => initializeLearningSchema(db),
    /Unversioned learning schema/u,
  );
});

test("initializeLearningSchema refuses unsupported versions", async () => {
  const db = await database();
  db.exec(`
    CREATE TABLE omniwork_learning_schema (
      schema_id INTEGER PRIMARY KEY,
      version INTEGER NOT NULL,
      migrated_at TEXT NOT NULL
    );
    INSERT INTO omniwork_learning_schema
    VALUES (1, 0, '2026-08-17T00:00:00.000Z');
  `);

  assert.throws(
    () => initializeLearningSchema(db),
    /Unsupported learning schema version 0/u,
  );
});

async function database(): Promise<DatabaseSync> {
  const directory = await mkdtemp(join(tmpdir(), "omniwork-learning-schema-"));
  return new DatabaseSync(join(directory, "sessions.sqlite"));
}

function readVersion(db: DatabaseSync): number | undefined {
  return (
    db
      .prepare(
        "SELECT version FROM omniwork_learning_schema WHERE schema_id = 1",
      )
      .get() as unknown as { version: number } | undefined
  )?.version;
}
