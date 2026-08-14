import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import {
  readSessionTranscriptVisibleMessageDeltaCore,
  sqliteMessageEventWithSeq,
  type SessionTranscriptReadScope,
} from "../session-transcript-readers.js";

export type SessionTouchedFile = {
  path: string;
  kind: "modified" | "read";
};

type TouchedFilesCacheEntry = {
  cursor: string;
  files: Map<string, SessionTouchedFile>;
};

const TOUCHED_FILES_CACHE_LIMIT = 16;
const TOUCHED_FILES_DELTA_MAX_MESSAGES = 1_000;
const TOUCHED_FILES_DELTA_MAX_BYTES = 1_000_000;

const touchedFilesCache = new Map<string, TouchedFilesCacheEntry>();
const touchedFilesFolds = new Map<string, Promise<Map<string, SessionTouchedFile>>>();

function readTouchedFilesCache(key: string): TouchedFilesCacheEntry | undefined {
  const cached = touchedFilesCache.get(key);
  if (cached) {
    touchedFilesCache.delete(key);
    touchedFilesCache.set(key, cached);
  }
  return cached;
}

function writeTouchedFilesCache(key: string, entry: TouchedFilesCacheEntry): void {
  touchedFilesCache.delete(key);
  touchedFilesCache.set(key, entry);
  pruneMapToMaxSize(touchedFilesCache, TOUCHED_FILES_CACHE_LIMIT);
}

function readPathArg(args: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(args.path) ??
    normalizeOptionalString(args.file_path) ??
    normalizeOptionalString(args.filePath) ??
    normalizeOptionalString(args.file)
  );
}

function addTouchedFile(
  files: Map<string, SessionTouchedFile>,
  filePath: string | undefined,
  kind: SessionTouchedFile["kind"],
) {
  if (!filePath) {
    return;
  }
  const existing = files.get(filePath);
  if (existing?.kind === "modified" || (existing && kind === "read")) {
    return;
  }
  files.set(filePath, { path: filePath, kind });
}

function addRawPatchFiles(files: Map<string, SessionTouchedFile>, input: unknown) {
  if (typeof input !== "string") {
    return;
  }
  const fileLinePattern = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  for (const match of input.matchAll(fileLinePattern)) {
    addTouchedFile(files, match[1]?.trim(), "modified");
  }
  const moveLinePattern = /^\*\*\* Move to: (.+)$/gm;
  for (const match of input.matchAll(moveLinePattern)) {
    addTouchedFile(files, match[1]?.trim(), "modified");
  }
}

function addStructuredPatchFiles(files: Map<string, SessionTouchedFile>, changes: unknown) {
  if (!Array.isArray(changes)) {
    return;
  }
  for (const changeValue of changes) {
    const change = asOptionalObjectRecord(changeValue);
    addTouchedFile(files, normalizeOptionalString(change?.path), "modified");
    const kind = asOptionalObjectRecord(change?.kind);
    addTouchedFile(
      files,
      normalizeOptionalString(kind?.move_path) ?? normalizeOptionalString(kind?.movePath),
      "modified",
    );
  }
}

function addPatchFiles(files: Map<string, SessionTouchedFile>, args: Record<string, unknown>) {
  addRawPatchFiles(files, args.input);
  addStructuredPatchFiles(files, args.changes);
}

function isToolCallBlockType(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.toLowerCase().replace(/[_-]/g, "");
  return normalized === "toolcall" || normalized === "tooluse";
}

function collectTouchedFilesFromMessage(message: unknown, files: Map<string, SessionTouchedFile>) {
  const record = asOptionalObjectRecord(message);
  if (record?.role !== "assistant" || !Array.isArray(record.content)) {
    return;
  }
  for (const blockValue of record.content) {
    const block = asOptionalObjectRecord(blockValue);
    if (!block || !isToolCallBlockType(block.type)) {
      continue;
    }
    const toolName = normalizeOptionalString(block.name)?.toLowerCase();
    const args =
      asOptionalObjectRecord(block.arguments) ??
      asOptionalObjectRecord(block.input) ??
      asOptionalObjectRecord(block.args);
    if (!toolName || !args) {
      continue;
    }
    if (toolName === "read") {
      addTouchedFile(files, readPathArg(args), "read");
    } else if (toolName === "write" || toolName === "edit") {
      addTouchedFile(files, readPathArg(args), "modified");
    } else if (toolName === "apply_patch") {
      addPatchFiles(files, args);
    }
  }
}

async function foldSqliteTouchedFiles(
  scope: SessionTranscriptReadScope,
  cacheKey: string,
): Promise<Map<string, SessionTouchedFile>> {
  let cached = readTouchedFilesCache(cacheKey);
  let cursor = cached?.cursor;
  let files = cached?.files ?? new Map<string, SessionTouchedFile>();
  let maxBytes = TOUCHED_FILES_DELTA_MAX_BYTES;

  while (true) {
    const delta = readSessionTranscriptVisibleMessageDeltaCore(scope, {
      ...(cursor ? { cursor } : {}),
      maxBytes,
      maxMessages: TOUCHED_FILES_DELTA_MAX_MESSAGES,
    });
    if (delta.kind === "missing") {
      touchedFilesCache.delete(cacheKey);
      return new Map();
    }
    if (delta.kind === "reset") {
      cached = { cursor: delta.cursor, files: new Map() };
      cursor = cached.cursor;
      files = cached.files;
      writeTouchedFilesCache(cacheKey, cached);
      continue;
    }
    for (const event of delta.events) {
      const message = sqliteMessageEventWithSeq(event);
      if (message !== undefined) {
        collectTouchedFilesFromMessage(message, files);
      }
    }
    cached = { cursor: delta.cursor, files };
    cursor = cached.cursor;
    writeTouchedFilesCache(cacheKey, cached);
    if (!delta.hasMore) {
      return files;
    }
    if (delta.requiredBytes !== undefined) {
      maxBytes = delta.requiredBytes;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

export async function loadSessionTouchedFilesInline(
  scope: SessionTranscriptReadScope,
  cacheKey: string,
): Promise<SessionTouchedFile[]> {
  const inFlight = touchedFilesFolds.get(cacheKey);
  if (inFlight) {
    return [...(await inFlight).values()];
  }
  const fold = foldSqliteTouchedFiles(scope, cacheKey);
  touchedFilesFolds.set(cacheKey, fold);
  try {
    return [...(await fold).values()];
  } finally {
    touchedFilesFolds.delete(cacheKey);
  }
}
