//! A whole-document validator for Codex records the parser never reads.
//!
//! `validate` returns 1 only for a complete JSON object whose top-level `type`
//! is `"response_item"`, `"event_msg"` or `"compacted"` and whose `payload` is an
//! object with a string `type` that is not a tool call, command completion,
//! user message or token count. `CodexSource.parse` reads none of those
//! shapes, so accepting one only lets the caller drop a line it would have
//! parsed and discarded anyway.
//!
//! `serde_json::from_slice` rejects trailing bytes and malformed JSON, and
//! resolves duplicate keys last-wins like `JSON.parse`. Invalid UTF-8 in an
//! ignored value decodes like the caller's `toString("utf8")`, so a drop is safe.
//!
//! The exported C ABI is `alloc`/`dealloc`/`validate`; the caller owns the input
//! buffer it copies in. Compiled to wasm32-unknown-unknown and embedded as base64
//! by the TypeScript module `src/sources/ignored-output-wasm.ts`.

use serde::de::{Deserialize, Deserializer, IgnoredAny, MapAccess, Visitor};
use std::fmt;

/// The payload types `CodexSource.parse` actually reads. A record whose
/// `payload.type` is none of these is dropped by the parser, wherever it sits.
fn is_handled_payload_type(value: &str) -> bool {
    matches!(value, "function_call" | "custom_tool_call" | "item_completed" | "user_message" | "token_count")
}

/// The root record types the parser never reads as context. `session_meta` and
/// `turn_context` are read first, so they are excluded.
fn is_ignorable_root(value: &str) -> bool {
    matches!(value, "response_item" | "event_msg" | "compacted")
}

struct Target(bool);

impl<'de> Deserialize<'de> for Target {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(TopVisitor)
    }
}

struct TopVisitor;

impl<'de> Visitor<'de> for TopVisitor {
    type Value = Target;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an object")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Target, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut type_ok = false;
        let mut payload_ok = false;
        while let Some(key) = map.next_key::<&str>()? {
            match key {
                "type" => {
                    let v: &str = map.next_value()?;
                    type_ok = is_ignorable_root(v);
                }
                "payload" => {
                    payload_ok = map.next_value::<PayloadCheck>()?.0;
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(Target(type_ok && payload_ok))
    }
}

struct PayloadCheck(bool);

impl<'de> Deserialize<'de> for PayloadCheck {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(PayloadVisitor)
    }
}

struct PayloadVisitor;

impl<'de> Visitor<'de> for PayloadVisitor {
    type Value = PayloadCheck;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an object")
    }

    fn visit_map<A>(self, mut map: A) -> Result<PayloadCheck, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut target = false;
        let mut message = false;
        let mut user = false;
        while let Some(key) = map.next_key::<&str>()? {
            if key == "type" {
                let v: &str = map.next_value()?;
                target = !is_handled_payload_type(v);
                message = v == "message";
            } else if key == "role" {
                let v: &str = map.next_value()?;
                user = v == "user";
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(PayloadCheck(target && !(message && user)))
    }
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        drop(Vec::from_raw_parts(ptr, len, len));
    }
}

#[no_mangle]
pub extern "C" fn validate(ptr: *const u8, len: usize) -> i32 {
    let slice = unsafe { std::slice::from_raw_parts(ptr, len) };
    match serde_json::from_slice::<Target>(slice) {
        Ok(t) if t.0 => 1,
        _ => 0,
    }
}
