# Example: building a TODO list app with Express, across turns

A walkthrough of using kodr to scaffold a small Express TODO API, then
continuing the same conversation over several turns to extend it. It shows how
runs chain together with `--continue`, and uses `ls -l` between turns to watch
the workspace grow.

> The model's streamed output is omitted here — the point is the workflow and
> the resulting files. The `ls -l` listings are representative of a typical
> run; exact files, sizes, and ordering depend on the model.

## Setup

Pick the model once with an environment variable so the run commands below stay
terse, and work in a throwaway directory:

```bash
export KODR_MODEL=google/gemma-4-26b-a4b
mkdir -p /Users/paul/src/kodr2-testing
cd /Users/paul/src/kodr2-testing
```

`export KODR_MODEL=...` is equivalent to passing `--model google/gemma-4-26b-a4b`
on every call; `--model` would win if you set both. With the export in place,
each `kodr` invocation is just the prompt.

## Turn 1 — scaffold the app

```bash
kodr run "Create a TODO list REST API with Express. Add a package.json with an \
express dependency and a start script, and a server.js exposing GET /todos and \
POST /todos backed by an in-memory array. Include a short README.md."
```

See what the model created:

```bash
ls -l
```

```
total 24
-rw-r--r--  1 paul  staff   642 Jun 27 14:02 README.md
-rw-r--r--  1 paul  staff   281 Jun 27 14:02 package.json
-rw-r--r--  1 paul  staff  1067 Jun 27 14:02 server.js
```

The run is also recorded under `.kodr/runs/` — that transcript is what the next
turn continues from:

```bash
ls -l .kodr/runs
```

```
total 8
-rw-r--r--  1 paul  staff  4821 Jun 27 14:02 2026-06-27T14-02-09-218Z.json
```

## Turn 2 — extend it, continuing the conversation

`--continue last` resumes from the most recent run in `.kodr/runs/`, so the
model still has the full context of what it built in turn 1. No need to
re-describe the app.

```bash
kodr run "Add DELETE /todos/:id and PUT /todos/:id routes, and reject POST or \
PUT requests whose body has no non-empty title with a 400." --continue last
```

```bash
ls -l
```

```
total 24
-rw-r--r--  1 paul  staff   642 Jun 27 14:02 README.md
-rw-r--r--  1 paul  staff   324 Jun 27 14:05 package.json
-rw-r--r--  1 paul  staff  1689 Jun 27 14:05 server.js
```

`server.js` grew with the new routes and validation; a second transcript now
sits alongside the first:

```bash
ls -l .kodr/runs
```

```
total 16
-rw-r--r--  1 paul  staff  4821 Jun 27 14:02 2026-06-27T14-02-09-218Z.json
-rw-r--r--  1 paul  staff  7903 Jun 27 14:05 2026-06-27T14-05-44-031Z.json
```

## Turn 3 — add tests and verify

Install the dependency the model declared, then continue once more — this time
with `--test` so kodr runs the suite after the changes and, if it fails, heals
by feeding the failure back to the model for a few repair turns.

```bash
npm install

kodr run "Add test/todos.test.js using node:test that starts the server on an \
ephemeral port and checks GET /todos returns an empty array and POST /todos \
adds an item. Add a test script to package.json." \
  --continue last \
  --test "node --test"
```

```bash
ls -l
```

```
total 32
-rw-r--r--  1 paul  staff   642 Jun 27 14:02 README.md
drwxr-xr-x  3 paul  staff    96 Jun 27 14:09 node_modules
-rw-r--r--  1 paul  staff   361 Jun 27 14:09 package.json
-rw-r--r--  1 paul  staff   118 Jun 27 14:09 package-lock.json
-rw-r--r--  1 paul  staff  1689 Jun 27 14:09 server.js
drwxr-xr-x  3 paul  staff    96 Jun 27 14:09 test
```

```bash
ls -l test
```

```
total 8
-rw-r--r--  1 paul  staff  938 Jun 27 14:09 todos.test.js
```

## How continuation works

- Every run writes a transcript to `.kodr/runs/<timestamp>.json`.
- `--continue last` picks the newest transcript and replays its messages
  (minus the system prompt) ahead of your new prompt, so the model keeps the
  prior context.
- To branch from an earlier point instead of the latest, pass the path
  directly:

  ```bash
  kodr run "Document the API in the README." \
    --continue .kodr/runs/2026-06-27T14-05-44-031Z.json
  ```

Each turn appends a fresh transcript, so the chain is easy to inspect, replay,
or fork later.
