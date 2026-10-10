# ignored-output

A small Rust `cdylib` compiled to `wasm32-unknown-unknown`. It answers one
question for the Codex parser: is this complete JSONL line an ignorable root
record (`response_item`, `event_msg` or `compacted`) whose `payload.type` is
none of the shapes the parser reads (`function_call`, `custom_tool_call`,
`item_completed`, `user_message`, `token_count`, or `message` with role `user`)?

`CodexSource.parse` reads none of those records, so it can drop a large one
before it decodes the line to UTF-8 and runs `JSON.parse`. The validator
returns `1` only for a whole, valid, target document. Any other result means
"not sure", and the caller falls back to its normal path. `serde_json` rejects
trailing bytes and malformed JSON, and resolves duplicate keys last-wins like
`JSON.parse`. Bytes that are invalid UTF-8 decode as `Buffer.toString("utf8")`
decodes them, so a dropped line is still one the ordinary path would discard.

## Build

Requires the `wasm32-unknown-unknown` target and the crates pinned in
`Cargo.lock` (fetched on first build). Run from the repository root and build
into a task-specific target directory, so no `target/` appears in the tree:

```sh
cargo build --locked --release --target wasm32-unknown-unknown \
  --manifest-path native/ignored-output/Cargo.toml \
  --target-dir /tmp/tf-ignored-output-target
```

Regenerate the embedded module from the compiled wasm. The command writes the
whole TypeScript file and prints the wasm SHA-256:

```sh
node -e '
const fs = require("node:fs");
const crypto = require("node:crypto");
const wasm = fs.readFileSync("/tmp/tf-ignored-output-target/wasm32-unknown-unknown/release/tf_ignored_output.wasm");
const sha = crypto.createHash("sha256").update(wasm).digest("hex");
const b64 = wasm.toString("base64");
const header = [
  "// Generated file. Do not edit by hand.",
  "// Source: native/ignored-output (Rust, serde + serde_json).",
  "// Rebuild: native/ignored-output/README.md",
  "// sha256 of the embedded wasm: " + sha,
  "// The wasm module exports alloc/dealloc/validate; see src/sources/ignored-output.ts.",
];
fs.writeFileSync("src/sources/ignored-output-wasm.ts", header.concat([`export const WASM_BASE64 = "${b64}";`, ""]).join("\n"));
console.log(sha);
'
```

Confirm the printed SHA-256 against the `sha256 of the embedded wasm` line in
`src/sources/ignored-output-wasm.ts`.

`src/sources/ignored-output-wasm.ts` holds the result as `WASM_BASE64`. At
runtime the app only decodes that base64 and instantiates the module; it does
not run Cargo, Rust, Python or `jq`. Reproduction is a developer-only step.

## License notices

The third-party license and copyright notices for this crate's dependencies are
reproduced in full in `references/ignored-output-licenses.txt` (packaged with
the distribution). That file is the source of truth; the crates are not all
MIT or Apache-2.0, so no single generic notice applies.
