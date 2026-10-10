import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** Chunk size for the line reader: big enough to be fast, small enough to stay cheap. */
const CHUNK = 1 << 20;

/**
 * A file's lines, one at a time. A rollout transcript reaches 300 MB, so the parser must never
 * hold the whole file or a split copy of it. burn.py iterates the same lines with `for line in fh`.
 */
export function* lines(path: string): Generator<string> {
  const fd = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(CHUNK);
  const decoder = new StringDecoder("utf8"); // a multi-byte char can straddle two chunks
  let carry = "";
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, CHUNK, null);
      if (read === 0) break;
      const parts = (carry + decoder.write(chunk.subarray(0, read))).split("\n");
      carry = parts.pop() ?? "";
      yield* parts;
    }
    carry += decoder.end();
    if (carry !== "") yield carry;
  } finally {
    closeSync(fd);
  }
}