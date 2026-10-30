import type { ProviderId, SessionInput, SourceFile } from "../core/model";
import type { SessionRepository } from "./session-repo";
import { activityTurns } from "../core/analyze/agent-activity";

/**
 * Turns in a Map, for tests and --no-cache. The file size rides along in the map so a file that
 * was appended to is reparsed even when its mtime is unchanged, like cached() in burn.py:516.
 */
export class MemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, { session: SessionInput; size: number }>();

  changed(files: SourceFile[], sources?: ProviderId[]): SourceFile[] {
    const seen = new Set<string>();
    const out: SourceFile[] = [];
    for (const file of files) {
      seen.add(file.path);
      const held = this.sessions.get(file.path);
      if (held && (!file.source || held.session.source === file.source) && held.session.mtimeMs === file.mtimeMs && held.size === file.size) continue;
      out.push(file);
    }
    const scoped = sources && new Set(sources);
    for (const [path, held] of this.sessions) {
      if (!seen.has(path) && (!scoped || scoped.has(held.session.source))) this.sessions.delete(path);
    }
    return out;
  }

  all(cutoff?: Date): SessionInput[] {
    const ms = cutoff?.getTime();
    const filtered = ms !== undefined && !Number.isNaN(ms);
    return [...this.sessions.values()].map((held) =>
      filtered ? { ...held.session, turns: held.session.turns.filter((turn) => turn.when.getTime() >= ms) } : held.session,
    );
  }

  activity() {
    return activityTurns(this.all());
  }

  save(session: SessionInput, size: number): void {
    this.sessions.set(session.path, { session, size });
  }
}
