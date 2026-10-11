import type { ActivityTurn, SessionInput, SourceFile } from "../core/model";

/**
 * Where parsed turns live between runs. PRD-003 ships the memory map only; PRD-004 adds
 * SqliteSessionRepository over node:sqlite with the same repository contract.
 */
export interface SessionRepository {
  /**
   * The files whose mtime or size changed since the last scan, in scan order. Files that are
   * gone from disk are dropped. The repository keeps the rest as they are.
   */
  changed(files: SourceFile[]): SourceFile[];
  /**
   * Every session held, in scan order: the order the analysis ranks ties by. With a cutoff, each
   * session keeps only the turns at or after it, so the report reads no turn the analysis skips.
   */
  all(cutoff?: Date): SessionInput[];
  /** Timestamp-only history, chronologically ordered, with positive context like report turns. */
  activity(): Iterable<ActivityTurn>;
  /** Store one parsed file, with its size: the two fields that say when to reparse it. */
  save(session: SessionInput, size: number): void;
  /** Release any persistent backing store owned by this repository. */
  close(): void;
}
