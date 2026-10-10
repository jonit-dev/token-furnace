import { closeSync, openSync, readSync } from "node:fs";

/** Chunk size for the line reader: big enough to be fast, small enough to stay cheap. */
const CHUNK = 1 << 20;
const LF = 0x0a;

/**
 * Tests one complete line, bounded by `start` and `end` inside `bytes`, before the reader decodes
 * it. A true result drops the line. The bytes are the reader's own chunk, so the test must not
 * keep or mutate them.
 */
export type Skip = (bytes: Buffer, start: number, end: number) => boolean;

/**
 * A file's lines, one at a time. A rollout transcript reaches 300 MB, so the parser must never
 * hold the whole file or a split copy of it. burn.py iterates the same lines with `for line in fh`.
 *
 * The reader scans raw bytes for `\n` and decodes each complete line once. The buffer is reused,
 * so bytes of a line that crosses a chunk are copied into `pending` and joined at the newline.
 *
 * When `skip` is given it sees each whole line as raw bytes before the decode; a line it accepts is
 * never decoded. Lines that cross a chunk are joined first, so `skip` always sees one whole line.
 */
export function* lines(path: string, skip?: Skip): Generator<string> {
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
          if (!skip || !skip(view, start, nl)) yield view.toString("utf8", start, nl);
        } else {
          pending.push(view.subarray(start, nl));
          const bytes = Buffer.concat(pending);
          pending = [];
          if (!skip || !skip(bytes, 0, bytes.length)) yield bytes.toString("utf8");
        }
        start = nl + 1;
      }
      if (start < read) pending.push(Buffer.from(view.subarray(start, read)));
    }
    if (pending.length > 0) {
      const bytes = Buffer.concat(pending);
      if (!skip || !skip(bytes, 0, bytes.length)) yield bytes.toString("utf8");
    }
  } finally {
    closeSync(fd);
  }
}
