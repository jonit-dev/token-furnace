import { WASM_BASE64 } from "./ignored-output-wasm";

/**
 * Lines at least this long are worth a wasm check; shorter ones cost more to route through the
 * module than to parse in JavaScript, so they always fall back.
 */
const MIN_LINE = 4 * 1024;

/** A single JSONL line is one document. Beyond this the caller parses it the ordinary way. */
const MAX_DOC = 64 * 1024 * 1024;

/**
 * The root record types `CodexSource.parse` never reads as context. A line is only worth a wasm
 * check when its head contains one; keep in lockstep with `is_ignorable_root` in the Rust crate.
 */
const NEEDLE_ROOTS = ["response_item", "event_msg", "compacted"];

/** The prefix of a line that is scanned for a root needle; it appears early in a real rollout. */
const HEAD = 1024;

interface Exports {
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  validate(ptr: number, len: number): number;
  memory: { buffer: ArrayBuffer };
}

/** The slice of the WebAssembly global this file uses. `lib` has no DOM, so declare it here. */
interface Wasm {
  Module: new (bytes: Uint8Array) => object;
  Instance: new (module: object, imports: object) => { exports: unknown };
}

const WEB_ASSEMBLY = (globalThis as unknown as { WebAssembly?: Wasm }).WebAssembly;

let disabled = false;
let exports: Exports | null = null;

/**
 * Instantiate the embedded validator on first use. A build/runtime that cannot compile wasm
 * disables the fast path for good and every caller falls back to the normal JSON parse.
 */
function instance(): Exports | null {
  if (disabled) return null;
  if (exports) return exports;
  if (!WEB_ASSEMBLY) {
    disabled = true;
    return null;
  }
  try {
    const module = new WEB_ASSEMBLY.Module(Buffer.from(WASM_BASE64, "base64"));
    exports = new WEB_ASSEMBLY.Instance(module, {}).exports as Exports;
    return exports;
  } catch {
    disabled = true;
    return null;
  }
}

/**
 * True only for a whole line that is an ignorable root record (`response_item`, `event_msg` or
 * `compacted`) whose `payload.type` is none of the shapes `CodexSource.parse` reads. Any doubt — a
 * short line, a head without the needles, a malformed or non-target document, a wasm trap —
 * returns false, so the caller keeps its normal decode and JSON parse.
 *
 * `start` and `end` bound the line inside `bytes`, so the reader can test a line without copying it
 * out of its chunk first. The wasm module checks the whole document, including ignored values and
 * trailing bytes, before accepting it. It is not a byte-for-byte reimplementation of `JSON.parse`:
 * escaped keys and unsupported shapes fall back; invalid UTF-8 decodes like `toString("utf8")`.
 */
export function isIgnoredOutput(bytes: Buffer, start: number, end: number): boolean {
  const n = end - start;
  if (n < MIN_LINE || n > MAX_DOC) return false;
  const head = bytes.toString("latin1", start, start + (HEAD < n ? HEAD : n));
  let hit = false;
  for (const root of NEEDLE_ROOTS) {
    if (head.indexOf(root) !== -1) {
      hit = true;
      break;
    }
  }
  if (!hit) return false;
  const wasm = instance();
  if (!wasm) return false;
  try {
    const ptr = wasm.alloc(n);
    try {
      const doc = start === 0 && n === bytes.length ? bytes : bytes.subarray(start, end);
      new Uint8Array(wasm.memory.buffer, ptr, n).set(doc);
      return wasm.validate(ptr, n) === 1;
    } finally {
      wasm.dealloc(ptr, n);
    }
  } catch {
    disabled = true;
    return false;
  }
}
