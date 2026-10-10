import { appendFileSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { lines } from "../src/sources/lines";

const CHUNK = 1 << 20;
const dir = mkdtempSync(join(tmpdir(), "tf-lines-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function fixture(bytes: Buffer | string): string {
  const path = join(dir, `f${n++}.jsonl`);
  writeFileSync(path, bytes);
  return path;
}

const collect = (path: string): string[] => [...lines(path)];

describe("lines", () => {
  it("yields each line, keeping blank lines, CRLF and an unterminated tail", () => {
    const path = fixture("a\r\nb\n\nc");
    expect(collect(path)).toEqual(["a\r", "b", "", "c"]);
  });

  it("does not yield a trailing empty line after a final newline", () => {
    expect(collect(fixture("a\nb\n"))).toEqual(["a", "b"]);
  });

  it("yields one long line that crosses more than two chunks", () => {
    const big = "x".repeat(CHUNK * 2 + 100);
    expect(collect(fixture(big + "\nafter\n"))).toEqual([big, "after"]);
  });

  it("keeps a multi-byte character that straddles a chunk boundary", () => {
    const body = "a".repeat(CHUNK - 1) + "€";
    expect(collect(fixture(body + "\nbaseline\n"))).toEqual([body, "baseline"]);
  });

  it("streams a tiny file that grows while the caller is between lines", () => {
    const path = fixture("a\n");
    const gen = lines(path);
    expect(gen.next().value).toBe("a");
    appendFileSync(path, "b\nc\n"); // a tiny initial size must not cap what is later read
    expect([...gen]).toEqual(["b", "c"]);
  });

  it("replaces invalid UTF-8 with U+FFFD", () => {
    const path = fixture(Buffer.from([0x61, 0xff, 0xfe, 0x0a, 0x62, 0x0a]));
    expect(collect(path)).toEqual(["a\uFFFD\uFFFD", "b"]);
  });

  it.skipIf(!process.platform.includes("linux"))("closes the fd when the generator is closed early", () => {
    const path = fixture("one\ntwo\nthree\n");
    const real = realpathSync(path);
    const open = () =>
      readdirSync("/proc/self/fd").filter((fd) => {
        try {
          return readlinkSync(`/proc/self/fd/${fd}`) === real;
        } catch {
          return false;
        }
      }).length;
    const gen = lines(path);
    expect(gen.next().value).toBe("one");
    expect(open()).toBe(1);
    gen.return(undefined);
    expect(open()).toBe(0);
  });
});
