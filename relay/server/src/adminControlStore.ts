import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type AdminControlRuleKind = "agent_instance_disable" | "ip_ban";

export interface AdminControlRuleRecord {
  kind: AdminControlRuleKind;
  target: string;
  rule: {
    id: string;
    reason?: string;
    createdAt: number;
    expiresAt?: number;
  };
}

interface AdminControlRuleRow {
  kind: AdminControlRuleKind;
  target: string;
  rule_id: string;
  reason: string | null;
  created_at: number;
  expires_at: number | null;
}

export class AdminControlStore {
  private readonly path: string;
  private db: DatabaseSync | null = null;

  constructor(path: string) {
    this.path = path;
  }

  load(): AdminControlRuleRecord[] {
    const db = this.open();
    const rows = db
      .prepare(
        `
          SELECT kind, target, rule_id, reason, created_at, expires_at
          FROM admin_control_rules
          ORDER BY created_at ASC, kind ASC, target ASC
        `,
      )
      .all() as unknown as AdminControlRuleRow[];

    return rows.map((row) => ({
      kind: row.kind,
      target: row.target,
      rule: {
        id: row.rule_id,
        reason: row.reason ?? undefined,
        createdAt: row.created_at,
        expiresAt: row.expires_at ?? undefined,
      },
    }));
  }

  upsert(record: AdminControlRuleRecord): void {
    const db = this.open();
    db.prepare(
      `
        INSERT INTO admin_control_rules (
          kind,
          target,
          rule_id,
          reason,
          created_at,
          expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(kind, target) DO UPDATE SET
          rule_id = excluded.rule_id,
          reason = excluded.reason,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at
      `,
    ).run(
      record.kind,
      record.target,
      record.rule.id,
      record.rule.reason ?? null,
      record.rule.createdAt,
      record.rule.expiresAt ?? null,
    );
  }

  delete(kind: AdminControlRuleKind, target: string): void {
    this.open()
      .prepare("DELETE FROM admin_control_rules WHERE kind = ? AND target = ?")
      .run(kind, target);
  }

  private open(): DatabaseSync {
    if (this.db) {
      return this.db;
    }

    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_control_rules (
        kind TEXT NOT NULL,
        target TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (kind, target)
      )
    `);
    this.db = db;
    return db;
  }
}
