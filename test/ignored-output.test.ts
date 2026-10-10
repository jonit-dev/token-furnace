import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CodexSource } from "../src/sources/codex";
import { isIgnoredOutput } from "../src/sources/ignored-output";
import { lines } from "../src/sources/lines";

const dir = mkdtempSync(join(tmpdir(), "tf-ignored-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CHUNK = 1 << 20;
let n = 0;
function fixture(text: string | Buffer): string {
  const path = join(dir, `f${n++}.jsonl`);
  writeFileSync(path, text);
  return path;
}

const asBytes = (text: string | Buffer): Buffer => (Buffer.isBuffer(text) ? text : Buffer.from(text));
const skipLine = (text: string | Buffer): boolean => {
  const b = asBytes(text);
  return isIgnoredOutput(b, 0, b.length);
};
const collect = (path: string): string[] => [...lines(path, isIgnoredOutput)];

/** Keeps every generated line over the 4 KiB fast-path threshold. */
const PAD = "x".repeat(8 * 1024);

/** Root types `CodexSource.parse` never reads as context. */
const ROOTS = ["response_item", "event_msg", "compacted"];
/** Root types the parser reads first, whatever the payload. */
const CONTEXT_ROOTS = ["session_meta", "turn_context"];
/** Payload types the parser reads. */
const HANDLED = ["function_call", "custom_tool_call", "item_completed", "user_message", "token_count"];

/** A valid ignored root line padded to exactly `totalBytes`. */
function targetLine(totalBytes: number): string {
  const empty = JSON.stringify({ type: "response_item", payload: { type: "message", output: "" } });
  const fill = totalBytes - Buffer.byteLength(empty);
  return JSON.stringify({ type: "response_item", payload: { type: "message", output: "x".repeat(fill) } });
}

/** The independent oracle: the routing `CodexSource.parse` applies after a normal JSON.parse. */
function routingIgnores(record: any): boolean {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
  if (record.type === "session_meta" || record.type === "turn_context") return false;
  const payload = record.payload || {};
  return !HANDLED.includes(payload.type) && !(payload.type === "message" && payload.role === "user");
}
function jsTarget(line: string): boolean {
  try {
    return routingIgnores(JSON.parse(line));
  } catch {
    return false;
  }
}
/** The one invariant that matters: never skip a line the parser would have read. */
function safe(text: string | Buffer): boolean {
  const b = asBytes(text);
  return !isIgnoredOutput(b, 0, b.length) || jsTarget(b.toString("utf8"));
}

describe("ignored-output routing", () => {
  it("preserves user response messages with reordered and duplicate role fields", () => {
    for (const fields of [
      '"role":"user","type":"message"',
      '"type":"message","role":"assistant","role":"user"',
    ]) {
      expect(skipLine(`{"type":"response_item","payload":{${fields},"content":"${PAD}"}}`)).toBe(false);
    }
    expect(skipLine(`{"type":"response_item","payload":{"type":"message","role":"user","role":"assistant","content":"${PAD}"}}`)).toBe(true);
  });

  it("skips event_msg agent_message and compacted records", () => {
    const rows = [
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: PAD } }),
      JSON.stringify({ type: "compacted", payload: { type: "compacted", history: PAD } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", output: PAD } }),
    ];
    for (const line of rows) {
      expect(jsTarget(line)).toBe(true);
      expect(skipLine(line)).toBe(true);
      expect(collect(fixture(line + "\n"))).toEqual([]);
    }
  });

  it("never skips a meaningful payload type under any root", () => {
    for (const root of [...ROOTS, ...CONTEXT_ROOTS, "other", ""]) {
      for (const type of HANDLED) {
        const line = JSON.stringify({ type: root, payload: { type, output: PAD } });
        expect(jsTarget(line)).toBe(false);
        expect(skipLine(line)).toBe(false);
      }
    }
    for (const root of CONTEXT_ROOTS) {
      const line = JSON.stringify({ type: root, payload: { type: "message", output: PAD } });
      expect(jsTarget(line)).toBe(false);
      expect(skipLine(line)).toBe(false);
    }
  });

  it("leaves a small valid target line to the ordinary parser", () => {
    const line = JSON.stringify({ type: "response_item", payload: { type: "message", output: "small" } });
    expect(skipLine(line)).toBe(false);
    expect(collect(fixture(line + "\n"))).toEqual([line]);
  });

  it("falls back on trailing bytes and malformed JSON, and matches JS decode for escaped keys and invalid UTF-8", () => {
    const valid = JSON.stringify({ type: "response_item", payload: { type: "message", output: PAD } });
    expect(skipLine(valid)).toBe(true);

    const trailing = valid + " trailing";
    expect(jsTarget(trailing)).toBe(false);
    expect(skipLine(trailing)).toBe(false);

    const malformed = valid.slice(0, valid.length - 3);
    expect(skipLine(malformed)).toBe(false);

    const escaped = `{"typ\\u0065":"response_item","payload":{"type":"message","output":"${PAD}"}}`;
    expect(jsTarget(escaped)).toBe(true);
    expect(skipLine(escaped)).toBe(false); // safe false negative

    const raw = Buffer.concat([
      Buffer.from(`{"type":"response_item","payload":{"type":"message","output":"`),
      Buffer.from([0xed, 0xa0, 0x80]), // a lone surrogate, invalid UTF-8
      Buffer.from(`${PAD}"}}`),
    ]);
    expect(isIgnoredOutput(raw, 0, raw.length)).toBe(jsTarget(raw.toString("utf8")));
    expect(safe(raw)).toBe(true);
  });

  it("routes duplicate root, payload-object and payload-type keys last-wins, like JSON.parse", () => {
    const typeLast = `{"type":"other","type":"response_item","payload":{"type":"message","output":"${PAD}"}}`;
    expect(jsTarget(typeLast)).toBe(true);
    expect(skipLine(typeLast)).toBe(true);

    const payloadObjLast = `{"type":"response_item","payload":{"type":"message","output":"${PAD}"},"payload":{"type":"function_call"}}`;
    expect(jsTarget(payloadObjLast)).toBe(false);
    expect(skipLine(payloadObjLast)).toBe(false);

    const payloadTypeLast = `{"type":"response_item","payload":{"type":"function_call","type":"message","output":"${PAD}"}}`;
    expect(jsTarget(payloadTypeLast)).toBe(true);
    expect(skipLine(payloadTypeLast)).toBe(true);
  });

  it("survives adversarial nesting without throwing or a false positive", () => {
    const nested = `{"type":"response_item","payload":{"type":"message","output":${"[".repeat(20_000)}1${"]".repeat(20_000)}}}`;
    expect(() => skipLine(nested)).not.toThrow();
    expect(safe(nested)).toBe(true);
  });

  it("never skips a document over the 64 MiB cap", () => {
    const over = Buffer.concat([
      Buffer.from(`{"type":"response_item","payload":{"type":"message","output":"`),
      Buffer.alloc(64 * 1024 * 1024 + 1, 0x78),
      Buffer.from(`"}}`),
    ]);
    expect(over.length).toBeGreaterThan(64 * 1024 * 1024);
    expect(isIgnoredOutput(over, 0, over.length)).toBe(false);
  });
});

describe("4 KiB threshold", () => {
  it("activates at 4 KiB and falls back below", () => {
    const at = targetLine(4096);
    const below = targetLine(4095);
    expect(at.length).toBe(4096);
    expect(below.length).toBe(4095);
    expect(skipLine(at)).toBe(true);
    expect(skipLine(below)).toBe(false);
    expect(collect(fixture(at + "\n"))).toEqual([]);
    expect(collect(fixture(below + "\n"))).toEqual([below]);
  });
});

describe("lines offsets", () => {
  it("skips a large ignored line that crosses a chunk and keeps later lines", () => {
    const big = JSON.stringify({ type: "response_item", payload: { type: "message", output: "y".repeat(CHUNK + 100) } });
    const path = fixture(big + "\nafter\n");
    expect([...lines(path)]).toEqual([big, "after"]);
    expect(collect(path)).toEqual(["after"]);
  });

  it("skips a large ignored line that ends at EOF without a newline", () => {
    const big = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: PAD } });
    expect(collect(fixture(big))).toEqual([]);
    expect([...lines(fixture(big))]).toEqual([big]);
  });

  it("keeps short and empty lines on the normal path", () => {
    expect(collect(fixture("a\nb\n"))).toEqual(["a", "b"]);
    expect(collect(fixture(""))).toEqual([]);
  });
});

describe("CodexSource integration", () => {
  it("never discards a meaningful function_call, user_message or token_count record", () => {
    const rows = [
      `{"timestamp":"2026-10-01T09:00:20+00:00","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\\"command\\":\\"cd /x && sed -n 1,9p ${PAD}\\"}"}}`,
      `{"timestamp":"2026-10-01T09:00:25+00:00","type":"event_msg","payload":{"type":"user_message","message":"do the thing ${PAD}"}}`,
      `{"timestamp":"2026-10-01T09:00:30+00:00","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":200,"reasoning_output_tokens":100}}}}`,
    ];
    for (const row of rows) {
      expect(jsTarget(row)).toBe(false);
      expect(skipLine(row)).toBe(false);
    }
    const parsed = new CodexSource({ CODEX_HOME: dir }).parse(fixture(rows.join("\n") + "\n"));
    expect(parsed.badLines).toBe(0);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].tools).toEqual(["shell"]);
    expect(parsed.turns[0].reads).toBe(1);
    expect(parsed.turns[0].wakes).toEqual(["human"]);
    expect(parsed.turns[0].baseIn).toBe(600);
    expect(parsed.turns[0].output).toBe(200);
  });

  it("keeps turns and badLines unchanged when large ignored lines are present", () => {
    const ignored = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: PAD } });
    const compacted = JSON.stringify({ type: "compacted", payload: { type: "compacted", history: PAD } });
    const badLarge = JSON.stringify({ type: "response_item", payload: { type: "message", output: PAD } }) + " trailing";
    const rows = [
      `{"timestamp":"2026-10-01T09:00:00+00:00","type":"session_meta","payload":{"id":"0a1b2c3d4e5f","cwd":"/home/dev/work/api"}}`,
      `{"timestamp":"2026-10-01T09:00:05+00:00","type":"turn_context","payload":{"model":"gpt-5.5"}}`,
      `{"timestamp":"2026-10-01T09:00:20+00:00","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\\"command\\":\\"cd /x && sed -n 1,9p f\\"}"}}`,
      ignored,
      compacted,
      badLarge,
      `{"timestamp":"2026-10-01T09:00:30+00:00","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":200,"reasoning_output_tokens":100}}}}`,
      `not json at all`,
    ];
    const parsed = new CodexSource({ CODEX_HOME: dir }).parse(fixture(rows.join("\n") + "\n"));
    expect(parsed.badLines).toBe(2);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].tools).toEqual(["shell"]);
    expect(parsed.turns[0].reads).toBe(1);
    expect(parsed.turns[0].project).toBe("api");
    expect(parsed.turns[0].session).toBe("0a1b2c3d");
    expect(parsed.turns[0].model).toBe("gpt-5.5");
    expect(parsed.turns[0].baseIn).toBe(600);
    expect(parsed.turns[0].output).toBe(200);
  });
});

describe("seeded fuzz", () => {
  it("agrees with the JSON.parse routing oracle beyond 4 KiB", () => {
    const ROOT_OTHER = ["", "Response_Item", "response_item ", "mesg", "custom"];
    const PAY_OTHER = [
      "custom_tool_call_output",
      "function_call_output",
      "message",
      "reasoning",
      "agent_message",
      "custom_tool_call",
      "local_shell_call",
      "web_search_call",
      "other",
      "",
    ];
    const JUNK = ["", `,"x":{"a":[1,2,3],"b":"c"}`, `,"z":null`, `,"n":-0.5e10`, `,"dup":1,"dup":2`];
    const j = (s: string) => JSON.stringify(s);
    const payloadObj = (typeLit: string, extra: string) => `{"type":${typeLit},"body":"${PAD}"${extra}}`;
    const top = (typeLit: string, payloadLit: string, extra = "") =>
      `{"timestamp":"2026-01-01T00:00:00Z","type":${typeLit},"payload":${payloadLit}${extra},"pad":"${PAD}"}`;

    let st = 0x9e3779b9 >>> 0;
    const rnd = () => {
      st ^= st << 13;
      st >>>= 0;
      st ^= st >>> 17;
      st ^= st << 5;
      st >>>= 0;
      return st;
    };
    const pick = <T>(a: T[]): T => a[rnd() % a.length];
    const ri = (m: number) => rnd() % m;

    const gen = (k: number): string | Buffer => {
      switch (k % 12) {
        case 0:
          return top(j(pick(ROOTS)), payloadObj(j(pick(PAY_OTHER)), pick(JUNK)));
        case 1:
          return top(j(pick(CONTEXT_ROOTS)), payloadObj(j(pick(PAY_OTHER)), ""));
        case 2:
          return top(j(pick([...ROOTS, ...ROOT_OTHER])), payloadObj(j(pick(HANDLED)), ""));
        case 3: {
          const a = j(pick([...ROOTS, ...CONTEXT_ROOTS, ...ROOT_OTHER]));
          const b = j(pick([...ROOTS, ...CONTEXT_ROOTS, ...ROOT_OTHER]));
          return `{"type":${a},"type":${b},"payload":${payloadObj(j(pick(PAY_OTHER)), "")},"pad":"${PAD}"}`;
        }
        case 4: {
          const a = j(pick([...PAY_OTHER, ...HANDLED]));
          const b = j(pick([...PAY_OTHER, ...HANDLED]));
          return top(j(pick(ROOTS)), `{"type":${a},"type":${b},"k":1}`);
        }
        case 5: {
          const lit = pick([`123`, `null`, `true`, `{"a":1}`, `["x"]`, `undefined`, `"x\\u0000y"`]);
          const which = ri(3);
          if (which === 0) return `{"type":${lit},"payload":${payloadObj(j(pick(PAY_OTHER)), "")},"pad":"${PAD}"}`;
          if (which === 1) return top(j(pick(ROOTS)), `{"type":${lit},"k":1}`);
          return top(j(pick(ROOTS)), `{"k":1}`);
        }
        case 6:
          return `{"t\\u0079pe":${j(pick(ROOTS))},"pay\\u006coad":{"\\u0074ype":${j(pick(PAY_OTHER))},"body":"${PAD}"}}`;
        case 7: {
          const s = top(j(pick(ROOTS)), payloadObj(j(pick(PAY_OTHER)), ""));
          const b = Buffer.from(s);
          const pos = ri(b.length);
          return Buffer.concat([b.subarray(0, pos), Buffer.from([0xff, 0xfe]), b.subarray(pos)]);
        }
        case 8: {
          const num = pick(["01", "1.", "+1", "NaN", "Infinity", ".5", "1e", "-", "0x1"]);
          const tail = pick(["]", "}", "null", "\u0001", "x", "  \t\n"]);
          return top(j(pick(ROOTS)), `{"type":${j(pick(PAY_OTHER))},"n":${num}}`) + tail;
        }
        case 9: {
          const d = ri(200);
          return top(j(pick(ROOTS)), `{"type":${j(pick(PAY_OTHER))},"d":${"[".repeat(d)}1${"]".repeat(d)}}`);
        }
        case 10: {
          const lit = pick([`"str"`, `123`, `[1,2]`, `null`, `true`]);
          return top(j(pick(ROOTS)), lit);
        }
        default: {
          const lit = pick([`{"type":${j(pick(PAY_OTHER))}}`, `{}`, `{"\u00e9":"\u00e9","type":${j(pick(PAY_OTHER))}}`]);
          return top(j(pick(ROOTS)), lit);
        }
      }
    };

    for (let i = 0; i < 3000; i++) {
      const b = asBytes(gen(i));
      expect(b.length).toBeGreaterThan(4096);
      expect(safe(b)).toBe(true);
    }
  });
});

describe("sticky fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("disables the fast path when WebAssembly is absent", async () => {
    vi.resetModules();
    vi.stubGlobal("WebAssembly", undefined);
    const mod = await import("../src/sources/ignored-output");
    const b = asBytes(JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: PAD } }));
    expect(mod.isIgnoredOutput(b, 0, b.length)).toBe(false);
    expect(mod.isIgnoredOutput(b, 0, b.length)).toBe(false); // sticky: no retry
  });

  it("disables the fast path when instantiation throws", async () => {
    vi.resetModules();
    vi.stubGlobal("WebAssembly", {
      Module: class {
        constructor() {
          throw new Error("trap");
        }
      },
      Instance: class {},
    });
    const mod = await import("../src/sources/ignored-output");
    const b = asBytes(JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: PAD } }));
    expect(() => mod.isIgnoredOutput(b, 0, b.length)).not.toThrow();
    expect(mod.isIgnoredOutput(b, 0, b.length)).toBe(false);
  });

  it("disables the fast path when validate traps and releases the arena once", async () => {
    vi.resetModules();
    const alloc = vi.fn(() => 0);
    const dealloc = vi.fn();
    const validate = vi.fn(() => {
      throw new Error("trap");
    });
    vi.stubGlobal("WebAssembly", {
      Module: class {},
      Instance: class {
        exports = { alloc, dealloc, validate, memory: { buffer: new ArrayBuffer(1 << 16) } };
      },
    });
    const mod = await import("../src/sources/ignored-output");
    const b = asBytes(JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: PAD } }));
    expect(mod.isIgnoredOutput(b, 0, b.length)).toBe(false);
    expect(mod.isIgnoredOutput(b, 0, b.length)).toBe(false); // sticky: no retry
    expect(alloc).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(dealloc).toHaveBeenCalledTimes(1);
  });
});
