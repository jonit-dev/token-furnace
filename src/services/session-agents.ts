import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ActiveSession, SessionAgent, SessionInput } from "../core/model";
import { ACTIVE_MINUTES } from "../core/analyze/flags";
import { jsonParse, type AgentSource } from "../sources/agent-source";
import { lines } from "../sources/lines";

type Identity = { id: string; parentId: string | null; name?: string; known: boolean };
type Usage = { model: string | null; lastSeen: string | null };

/** Native metadata only: prompts and tool results are never included in the report. */
export class SessionAgents {
  private headers = new Map<string, Identity>();
  private children = new Map<string, { stamp: string; usage: Usage; partial: boolean }>();

  enrich(active: ActiveSession[], sessions: SessionInput[], sources: AgentSource[], now: Date): void {
    const codex = sessions.filter(s => s.source === "codex" && s.turns.length && active.some(row => row.source === "codex")).map(s => ({ session: s, identity: this.identity(s) }));
    for (const row of active) {
      const session = sessions.find(s => s.source === row.source && s.path === row.path);
      if (!session) continue;
      const identity = this.identity(session);
      const root = this.member(identity, this.usage(session), now);
      const members = [root];
      let complete = identity.known;
      if (row.source === "codex") {
        const seen = new Set([root.id]);
        for (let i = 0; i < members.length; i++) {
          for (const child of codex) {
            if (child.identity.parentId !== members[i].id || seen.has(child.identity.id)) continue;
            seen.add(child.identity.id);
            members.push(this.member(child.identity, this.usage(child.session), now));
          }
        }
        complete &&= codex.every(c => c.identity.known);
      } else if (row.source === "claude") {
        const source = sources.find(s => s.name === row.source);
        const directory = join(session.path.slice(0, -6), "subagents");
        let files: string[] = [];
        try { files = readdirSync(directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") complete = false; }
        for (const file of files) {
          if (!file.endsWith(".jsonl") || !source) continue;
          const path = join(directory, file);
          try {
            const stat = statSync(path);
            const stamp = `${stat.mtimeMs}:${stat.size}`;
            let cached = this.children.get(path);
            if (!cached || cached.stamp !== stamp) {
              const parsed = source.parse(path);
              cached = { stamp, usage: this.usage(parsed), partial: parsed.badLines > 0 };
              this.children.set(path, cached);
            }
            if (cached.partial) complete = false;
            members.push(this.member({ id: file.slice(0, -6).replace(/^agent-/, ""), parentId: root.id, known: true }, cached.usage, now));
          } catch {
            complete = false;
          }
        }
      } else {
        complete = false;
      }
      row.agents = { members, activeCount: members.filter(a => a.active).length, complete };
    }
  }

  private member(identity: Identity, usage: Usage, now: Date): SessionAgent {
    const at = usage.lastSeen ? Date.parse(usage.lastSeen) : NaN;
    return { ...usage, id: identity.id, parentId: identity.parentId, name: identity.name,
      role: !identity.known ? "unknown" : identity.parentId ? "subagent" : "parent",
      active: at <= +now && at >= +now - ACTIVE_MINUTES * 60_000 };
  }

  private usage(session: Pick<SessionInput, "turns">): Usage {
    const last = session.turns.filter(t => t.baseIn + t.cacheRead + t.cacheWrite > 0).at(-1);
    return { model: last?.model || null, lastSeen: last?.when.toISOString() ?? null };
  }

  private identity(session: SessionInput): Identity {
    if (session.source === "claude") return { id: session.turns[0]?.session ?? session.path, parentId: null, known: true };
    const cached = this.headers.get(session.path);
    if (cached) return cached;
    const unknown: Identity = { id: session.turns[0]?.session ?? session.path, parentId: null, known: false };
    if (session.source !== "codex") return unknown;
    try {
      const fd = openSync(session.path, "r");
      let text: string;
      try {
        const buffer = Buffer.alloc(4096);
        const length = readSync(fd, buffer, 0, buffer.length, 0);
        const newline = buffer.subarray(0, length).indexOf(10);
        if (newline >= 0) text = buffer.toString("utf8", 0, newline);
        else {
          const reader = lines(session.path);
          try { text = reader.next().value ?? ""; } finally { reader.return(undefined); }
        }
      } finally { closeSync(fd); }
      const record = jsonParse(text);
      const meta = record?.type === "session_meta" ? record.payload : null;
      if (typeof meta?.id !== "string") return unknown;
      const spawn = meta.source?.subagent?.thread_spawn;
      const parentId = typeof spawn?.parent_thread_id === "string" ? spawn.parent_thread_id : null;
      // Other native subagent kinds do not supply a parent thread; keep their role unknown.
      const known = typeof meta.source === "string" || parentId !== null;
      const identity = { id: meta.id, parentId, known, name: typeof meta.agent_nickname === "string" ? meta.agent_nickname : undefined };
      this.headers.set(session.path, identity);
      return identity;
    } catch { return unknown; }
  }
}
