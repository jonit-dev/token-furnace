import { closeSync, openSync, readSync } from "node:fs";

/** Chunk size for the line reader: big enough to be fast, small enough to stay cheap. */
const CHUNK = 1 << 20;
const LF = 0x0a;

/**
 * A file's lines, one at a time. A rollout transcript reaches 300 MB, so the parser must never
 * hold the whole file or a split copy of it. burn.py iterates the same lines with `for line in fh`.
 *
 * The reader scans raw bytes for `\n` and decodes each complete line once. The buffer is reused,
 * so bytes of a line that crosses a chunk are copied into `pending` and joined at the newline.
 */
export function* lines(path: string): Generator<string> {
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(CHUNK);
    let pending: Buffer[] = [];
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      const view = chunk.subarray(0, read);
      let start = 0;
      for (;;) {
        const nl = view.indexOf(LF, start);
        if (nl === -1) break;
        if (pending.length === 0) {
          yield view.toString("utf8", start, nl);
        } else {
          pending.push(view.subarray(start, nl));
          yield Buffer.concat(pending).toString("utf8");
          pending = [];
        }
        start = nl + 1;
      }
      if (start < read) pending.push(Buffer.from(view.subarray(start, read)));
    }
    if (pending.length > 0) yield Buffer.concat(pending).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
