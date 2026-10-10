import type { SessionInput, SourceFile } from "../core/model";
import type { SessionRepository } from "./session-repo";

/**
 * Turns in a Map, for tests and --no-cache. The file size rides along in the map so a file that
 * was appended to is reparsed even when its mtime is unchanged, like cached() in burn.py:516.
 */
export class MemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, { session: SessionInput; size: number }>();

  changed(files: SourceFile[]): SourceFile[] {
    const seen = new Set<string>();
    const out: SourceFile[] = [];
    for (const file of files) {
      seen.add(file.path);
      const held = this.sessions.get(file.path);
      if (held && held.session.mtimeMs === file.mtimeMs && held.size === file.size) continue;
      out.push(file);
    }
    for (const path of [...this.sessions.keys()]) if (!seen.has(path)) this.sessions.delete(path);
    return out;
  }

  all(cutoff?: Date): SessionInput[] {
    const ms = cutoff?.getTime();
    const filtered = ms !== undefined && !Number.isNaN(ms);
    return [...this.sessions.values()].map((held) =>
      filtered ? { ...held.session, turns: held.session.turns.filter((turn) => turn.when.getTime() >= ms) } : held.session,
    );
  }

  save(session: SessionInput, size: number): void {
    this.sessions.set(session.path, { session, size });
  }
}