# Example: building a TODO API in Rust, across turns

A walkthrough of using kodr to build a small TODO API in **Rust, using only the
standard library** — no external crates. It mirrors the Express example but
swaps `npm` for `cargo`, and leans on a **`cargo build` Stop hook** so every turn
ends with a compile gate: when the build fails, kodr feeds the compiler error
back and the model heals.

> Captured from real runs using `mistralai/devstral-small-2-2512` loaded in LM
> Studio. The model's streamed output is omitted — the point is the workflow and
> the resulting code. Exactly which files the model touches, and how many heal
> turns it needs, will vary from run to run and across models.

## Why std-only

The whole API — store and HTTP server — is built on `std` alone (`Vec`,
`std::net::TcpListener`). That keeps `cargo build` fast and offline, avoids
crates.io flakiness, and matches kodr's own zero-dependency ethos. It also makes
the model do the interesting work by hand (a tiny HTTP/JSON layer) rather than
leaning on a framework.

## Setup

Pick the model once, and work in a throwaway directory:

```bash
export KODR_MODEL=mistralai/devstral-small-2-2512
mkdir -p /tmp/rust-todo && cd /tmp/rust-todo
```

Load the model in LM Studio with a **generous context window** (32k or more).
A small loaded context forces kodr to compact mid-task on multi-step turns; kodr
prints a startup note recommending a larger window when it sees a small one.

### Hooks first

Set up a couple of hooks before any code exists. A `SessionStart` hook lists the
workspace each turn (handy context), and a `Stop` hook compiles after every turn:

```json
// .kodr/hooks.json
{
  "hooks": {
    "SessionStart": [
      { "run": "echo Workspace:; ls -1 2>/dev/null | grep -v target || true", "name": "context" }
    ],
    "Stop": [
      { "run": "cargo build --quiet", "name": "build" }
    ]
  }
}
```

The `Stop` hook is the safety net: the model can't "finish" with code that
doesn't compile. If `cargo build` fails, its output is fed back and kodr heals.

## Turn 1 — scaffold the library

Build a library crate with the store and its tests:

```bash
kodr run "Create a Rust library crate for an in-memory TODO store using only the \
Rust standard library. Add a Cargo.toml (package todo_api, edition 2021) and \
src/lib.rs defining a Todo struct (id: u32, text: String, done: bool) and a \
TodoStore with new(), add(text) returning the created Todo, and all(). Include \
unit tests in src/lib.rs."
```

In this run the first build **failed** — the model returned `Todo` from `add()`
but hadn't derived `Clone`:

```
error[E0308]: ... `Todo` does not implement `Clone`
help: consider annotating `Todo` with `#[derive(Clone)]`
```

kodr fed that compiler error back through the heal loop; the model added
`#[derive(Clone)]`, the rebuild passed, and the run finished `verify pass`,
`healed true`. No human intervention — the Stop hook plus heal closed the loop.

```bash
ls -1
# Cargo.toml  src/
cargo test
# test result: ok. 2 passed; 0 failed
```

## Turn 2 — extend the store, gate on tests

Add lookups, removal, validation, and tests — this time with `--test "cargo
test"` so the Stop sequence both compiles **and** runs the suite:

```bash
kodr run "Read src/lib.rs, then extend TodoStore: add get(id), remove(id) -> bool, \
and set_done(id, done) -> bool. Change add to reject empty/whitespace text by \
returning Result<Todo, String>. Update existing tests and add tests for the new \
methods. Standard library only." \
  --test "cargo test"
```

kodr reads files fresh from disk every run, so the model just reads the existing
`src/lib.rs` and extends it — no need to `--continue` the prior conversation. The
store ends up with six methods and six passing tests:

```bash
cargo test
# test result: ok. 6 passed; 0 failed
```

```rust
// src/lib.rs (signatures)
pub fn new() -> Self
pub fn add(&mut self, text: &str) -> Result<Todo, String>   // Err on empty
pub fn all(&self) -> &[Todo]
pub fn get(&self, id: u32) -> Option<&Todo>
pub fn remove(&mut self, id: u32) -> bool
pub fn set_done(&mut self, id: u32, done: bool) -> bool
```

## Turn 3 — the HTTP layer

Add a `src/main.rs` binary: a single-threaded `std::net::TcpListener` server that
reuses the library's `TodoStore`. Build it in two small steps — GET first, then
POST — so no single file write is huge:

```bash
# 3a: GET /todos + 404
kodr run "Create a short src/main.rs: a single-threaded HTTP server using only \
std::net::TcpListener on 127.0.0.1:3000, reusing todo_api::TodoStore. GET /todos \
returns 200 with the todos as a hand-formatted JSON array; anything else 404. \
Seed one todo at startup." --test "cargo build"

# 3b: add POST /todos
kodr run "Edit src/main.rs to also handle POST /todos: parse {\"text\":\"...\"} \
from the body, call store.add(text), respond 201 with the created todo as JSON, \
or 400 on empty text. Keep GET and 404." --test "cargo build"
```

Then run it and exercise the routes:

```bash
cargo run &
curl -s localhost:3000/todos
# [{"id":1,"text":"Example task","done":false}]
curl -s -X POST -d '{"text":"buy milk"}' localhost:3000/todos
# {"id":2,"text":"buy milk","done":false}
```

## What the hooks bought you

- **A compile gate on every turn.** `cargo build` as a Stop hook means a turn
  can't end on code that doesn't compile; a failure heals automatically (turn 1's
  missing `Clone` is the clearest case).
- **Tests as the gate when they exist.** `--test "cargo test"` is just the first
  Stop hook — compile *and* run the suite, heal on red.
- **Fresh file context each turn.** Because kodr re-reads the workspace every
  run, each turn can be self-contained: the model reads what's on disk and
  extends it, which keeps the transcript small.

## A caveat worth internalizing

A build gate proves the code **compiles**, not that it **behaves**. In these runs
`cargo build` happily passed code with a stray trailing comma in the GET JSON and
an off-by-one in the POST body parser — both wrong only at runtime. If you care
about behavior, make the Stop hook a real check: a test that starts the server
and hits it, or an integration test, so the gate exercises the code instead of
just type-checking it.
