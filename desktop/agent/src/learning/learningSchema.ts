import type { DatabaseSync } from "node:sqlite";

export const LEARNING_SCHEMA_VERSION = 1;

interface SchemaVersionRow {
  version: number;
}

const CURRENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agent_observations (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    observation_key TEXT NOT NULL UNIQUE,
    correlation_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    project_id TEXT,
    session_id TEXT NOT NULL,
    surface_id TEXT,
    provider TEXT NOT NULL,
    event_type TEXT NOT NULL,
    source_kind TEXT,
    workspace_path TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_agent_observations_project
  ON agent_observations(project_id, cursor);

  CREATE INDEX IF NOT EXISTS idx_agent_observations_session
  ON agent_observations(session_id, cursor);

  CREATE INDEX IF NOT EXISTS idx_agent_observations_correlation
  ON agent_observations(correlation_key);

  CREATE TABLE IF NOT EXISTS delivery_episodes (
    episode_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    project_id TEXT,
    session_id TEXT NOT NULL,
    surface_id TEXT,
    provider TEXT,
    status TEXT NOT NULL,
    outcome TEXT,
    outcome_source TEXT,
    outcome_note TEXT,
    objective TEXT,
    final_response TEXT,
    started_at TEXT NOT NULL,
    delivered_at TEXT,
    outcome_at TEXT,
    updated_at TEXT NOT NULL,
    observation_count INTEGER NOT NULL DEFAULT 0,
    last_observation_cursor INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_delivery_episodes_scope
  ON delivery_episodes(scope_key, started_at DESC);

  CREATE INDEX IF NOT EXISTS idx_delivery_episodes_project
  ON delivery_episodes(project_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS delivery_episode_observations (
    episode_id TEXT NOT NULL,
    observation_key TEXT NOT NULL UNIQUE,
    observation_cursor INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (episode_id, observation_key),
    FOREIGN KEY (episode_id) REFERENCES delivery_episodes(episode_id)
  );

  CREATE TABLE IF NOT EXISTS delivery_episode_outcomes (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    client_action_id TEXT NOT NULL UNIQUE,
    episode_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user',
    note TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (episode_id) REFERENCES delivery_episodes(episode_id)
  );

  CREATE INDEX IF NOT EXISTS idx_delivery_episode_outcomes_episode
  ON delivery_episode_outcomes(episode_id, cursor);

  CREATE TABLE IF NOT EXISTS delivery_episode_signals (
    signal_id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    observation_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    FOREIGN KEY (episode_id) REFERENCES delivery_episodes(episode_id)
  );

  CREATE INDEX IF NOT EXISTS idx_delivery_episode_signals_episode
  ON delivery_episode_signals(episode_id, created_at, signal_id);

  CREATE TABLE IF NOT EXISTS experience_candidates (
    candidate_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    trigger_text TEXT NOT NULL,
    guidance_text TEXT NOT NULL,
    status TEXT NOT NULL,
    support_count INTEGER NOT NULL DEFAULT 0,
    contradiction_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reviewed_at TEXT,
    review_note TEXT,
    lifecycle_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_experience_candidates_project
  ON experience_candidates(project_id, status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS experience_candidate_evidence (
    candidate_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_fingerprint TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (candidate_id, episode_id, source_kind),
    FOREIGN KEY (candidate_id) REFERENCES experience_candidates(candidate_id),
    FOREIGN KEY (episode_id) REFERENCES delivery_episodes(episode_id)
  );

  CREATE INDEX IF NOT EXISTS idx_experience_evidence_episode
  ON experience_candidate_evidence(episode_id);

  CREATE TABLE IF NOT EXISTS experience_candidate_reviews (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    client_action_id TEXT NOT NULL UNIQUE,
    candidate_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    trigger_text TEXT NOT NULL,
    guidance_text TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (candidate_id) REFERENCES experience_candidates(candidate_id)
  );

  CREATE TABLE IF NOT EXISTS experience_candidate_lifecycle_actions (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    client_action_id TEXT NOT NULL UNIQUE,
    candidate_id TEXT NOT NULL,
    action TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (candidate_id) REFERENCES experience_candidates(candidate_id)
  );

  CREATE TABLE IF NOT EXISTS experience_shadow_runs (
    run_id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    surface_id TEXT,
    prompt_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (episode_id) REFERENCES delivery_episodes(episode_id)
  );

  CREATE INDEX IF NOT EXISTS idx_experience_shadow_runs_session
  ON experience_shadow_runs(session_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS experience_shadow_matches (
    run_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    rank INTEGER NOT NULL,
    score REAL NOT NULL,
    reason TEXT NOT NULL,
    trigger_snapshot TEXT NOT NULL,
    guidance_snapshot TEXT NOT NULL,
    feedback TEXT,
    feedback_at TEXT,
    PRIMARY KEY (run_id, candidate_id),
    FOREIGN KEY (run_id) REFERENCES experience_shadow_runs(run_id),
    FOREIGN KEY (candidate_id) REFERENCES experience_candidates(candidate_id)
  );

  CREATE TABLE IF NOT EXISTS experience_shadow_feedbacks (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    client_action_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    feedback TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES experience_shadow_runs(run_id)
  );

  CREATE TABLE IF NOT EXISTS experience_activation_settings (
    project_id TEXT PRIMARY KEY,
    requested_enabled INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS experience_activation_actions (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    client_action_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS experience_applications (
    application_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    episode_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    candidate_ids TEXT NOT NULL,
    original_prompt_hash TEXT NOT NULL,
    injected_prompt_hash TEXT NOT NULL,
    injected_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES experience_shadow_runs(run_id),
    FOREIGN KEY (episode_id) REFERENCES delivery_episodes(episode_id)
  );

  CREATE INDEX IF NOT EXISTS idx_experience_applications_project
  ON experience_applications(project_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS experience_application_evaluations (
    evaluation_id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL UNIQUE,
    episode_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    candidate_ids TEXT NOT NULL,
    outcome TEXT NOT NULL,
    effect TEXT NOT NULL,
    evaluated_at TEXT NOT NULL,
    FOREIGN KEY (application_id) REFERENCES experience_applications(application_id),
    FOREIGN KEY (episode_id) REFERENCES delivery_episodes(episode_id)
  );

  CREATE INDEX IF NOT EXISTS idx_experience_evaluations_project
  ON experience_application_evaluations(project_id, evaluated_at DESC);

  CREATE TABLE IF NOT EXISTS experience_application_evaluation_events (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    source_action_id TEXT NOT NULL UNIQUE,
    application_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (application_id) REFERENCES experience_applications(application_id)
  );
`;

export function initializeLearningSchema(db: DatabaseSync): void {
  if (!hasVersionTable(db)) {
    if (hasLearningTables(db)) {
      throw new Error("Unversioned learning schema is unsupported.");
    }
    inTransaction(db, () => {
      createVersionTable(db);
      db.exec(CURRENT_SCHEMA_SQL);
      writeVersion(db, new Date().toISOString());
    });
    return;
  }
  const version = readVersion(db);
  if (version === undefined) {
    throw new Error("Learning schema version record is missing.");
  }
  if (version !== LEARNING_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported learning schema version ${version}; expected ${LEARNING_SCHEMA_VERSION}.`,
    );
  }
}

function createVersionTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS omniwork_learning_schema (
      schema_id INTEGER PRIMARY KEY CHECK (schema_id = 1),
      version INTEGER NOT NULL,
      migrated_at TEXT NOT NULL
    )
  `);
}

function readVersion(db: DatabaseSync): number | undefined {
  const row = db
    .prepare(
      "SELECT version FROM omniwork_learning_schema WHERE schema_id = 1",
    )
    .get() as unknown as SchemaVersionRow | undefined;
  return row?.version;
}

function writeVersion(db: DatabaseSync, migratedAt: string): void {
  db.prepare(
    `
      INSERT INTO omniwork_learning_schema (schema_id, version, migrated_at)
      VALUES (1, ?, ?)
    `,
  ).run(LEARNING_SCHEMA_VERSION, migratedAt);
}

function hasVersionTable(db: DatabaseSync): boolean {
  return Boolean(
    db
      .prepare(
        `
          SELECT 1
          FROM sqlite_master
          WHERE type = 'table' AND name = 'omniwork_learning_schema'
        `,
      )
      .get(),
  );
}

function hasLearningTables(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table'
          AND (
            name = 'agent_observations'
            OR name LIKE 'delivery_episode%'
            OR name LIKE 'experience_%'
          )
      `,
    )
    .get() as unknown as { count: number };
  return row.count > 0;
}

function inTransaction(db: DatabaseSync, task: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    task();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
