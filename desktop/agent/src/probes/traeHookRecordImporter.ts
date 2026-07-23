import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { AgentProbeEvent } from "@omniwork/protocol-ts";
import {
  normalizeTraeHookPayload,
  normalizeTraeProbeProvider,
  type TraeHookPayload,
} from "./traeHookNormalizer.ts";

export interface TraeHookRecordImportOptions {
  homeDir?: string;
  roots?: TraeHookRecordRoot[];
  onProbeEvent(event: AgentProbeEvent): void | Promise<void>;
}

export interface TraeHookRecordRoot {
  provider: "trae" | "trae-cn";
  recordsRoot: string;
}

export interface TraeHookRecordImportResult {
  provider: "trae" | "trae-cn";
  recordsRoot: string;
  files: number;
  imported: number;
  skipped: number;
  invalid: number;
}

interface TraeHookRecord {
  schema_version?: unknown;
  record_id?: unknown;
  provider?: unknown;
  hook_event?: unknown;
  created_at?: unknown;
  payload?: unknown;
  raw_payload?: unknown;
}

interface TraeImportIndex {
  version: 1;
  imported_record_ids: string[];
}

export async function importTraeHookRecords(
  options: TraeHookRecordImportOptions,
): Promise<TraeHookRecordImportResult[]> {
  const roots = options.roots ?? defaultTraeHookRecordRoots(options.homeDir);
  const results: TraeHookRecordImportResult[] = [];
  for (const root of roots) {
    results.push(await importTraeHookRecordRoot(root, options.onProbeEvent));
  }
  return results;
}

export function defaultTraeHookRecordRoots(
  homeDirectory = homedir(),
): TraeHookRecordRoot[] {
  return [
    {
      provider: "trae",
      recordsRoot: join(homeDirectory, ".trae", "omniwork", "records"),
    },
    {
      provider: "trae-cn",
      recordsRoot: join(homeDirectory, ".trae-cn", "omniwork", "records"),
    },
  ];
}

async function importTraeHookRecordRoot(
  root: TraeHookRecordRoot,
  onProbeEvent: (event: AgentProbeEvent) => void | Promise<void>,
): Promise<TraeHookRecordImportResult> {
  const indexPath = join(root.recordsRoot, "import-index.json");
  const index = await readImportIndex(indexPath);
  const importedIds = new Set(index.imported_record_ids);
  const files = await listJsonlFiles(join(root.recordsRoot, "sessions"));
  let imported = 0;
  let skipped = 0;
  let invalid = 0;

  for (const file of files) {
    const lines = await readJsonlLines(file);
    for (const line of lines) {
      const record = parseRecord(line);
      if (!record) {
        invalid += 1;
        continue;
      }
      const event = normalizeRecord(root.provider, record);
      if (!event) {
        invalid += 1;
        continue;
      }
      const recordId = readString(record.record_id) ?? event.id;
      if (importedIds.has(recordId)) {
        skipped += 1;
        continue;
      }
      await onProbeEvent(event);
      importedIds.add(recordId);
      imported += 1;
    }
  }

  if (files.length > 0) {
    await writeImportIndex(indexPath, importedIds);
  }
  return {
    provider: root.provider,
    recordsRoot: root.recordsRoot,
    files: files.length,
    imported,
    skipped,
    invalid,
  };
}

async function listJsonlFiles(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".jsonl") &&
          !entry.name.endsWith("-raw.jsonl"),
      )
      .map((entry) => join(path, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function readJsonlLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8"))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeRecord(
  fallbackProvider: "trae" | "trae-cn",
  record: TraeHookRecord,
): AgentProbeEvent | null {
  const provider =
    normalizeTraeProbeProvider(readString(record.provider) ?? fallbackProvider) ??
    fallbackProvider;
  const payload = readPayload(record);
  if (!payload) {
    return null;
  }
  const recordId = readString(record.record_id);
  if (recordId && typeof payload.omniwork_record_id !== "string") {
    payload.omniwork_record_id = recordId;
  }
  const hookEvent = readString(record.hook_event);
  if (hookEvent && typeof payload.hook_event_name !== "string") {
    payload.hook_event_name = hookEvent;
  }
  if (typeof payload.omniwork_hook_source !== "string") {
    payload.omniwork_hook_source = provider;
  }

  const event = normalizeTraeHookPayload(provider, payload);
  const createdAt = readString(record.created_at);
  return event && createdAt ? { ...event, created_at: createdAt } : event;
}

function readPayload(record: TraeHookRecord): TraeHookPayload | null {
  if (isRecord(record.payload)) {
    return { ...record.payload } as TraeHookPayload;
  }
  if (isRecord(record.raw_payload)) {
    return { ...record.raw_payload } as TraeHookPayload;
  }
  return null;
}

function parseRecord(line: string): TraeHookRecord | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? (parsed as TraeHookRecord) : null;
  } catch {
    return null;
  }
}

async function readImportIndex(path: string): Promise<TraeImportIndex> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.imported_record_ids)) {
      return emptyImportIndex();
    }
    return {
      version: 1,
      imported_record_ids: parsed.imported_record_ids.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
    };
  } catch {
    return emptyImportIndex();
  }
}

async function writeImportIndex(
  path: string,
  importedIds: Set<string>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        version: 1,
        imported_record_ids: [...importedIds].sort(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

function emptyImportIndex(): TraeImportIndex {
  return {
    version: 1,
    imported_record_ids: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
