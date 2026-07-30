# AGENTS.md

Guidance for the agent building this CRM API. Kodr reads this file into the
system prompt of every run, so keep it short enough to stay read.

## Stack

- **Node.js 22+, ESM (`.mjs`), zero dependencies.** `package.json` must have no
  `dependencies` and no `devDependencies`, ever. No Express, no better-sqlite3,
  no test framework, no CSV library. If you want one, hand-roll the small part
  you actually need.
- **`node:http`** for the server, **`node:sqlite`** for storage, **`node:test`**
  for tests. All built in.
- `npm test` must stay wired to `node --test` and must stay green. It is the
  gate that decides whether a phase is committed or thrown away.

## Layout

```
src/server.mjs      createServer + the route table, nothing else
src/router.mjs      method + path matching, params, JSON body parsing
src/db.mjs          the connection and schema/migrations
src/<entity>.mjs    one module per entity: queries + handlers
test/<name>.test.mjs
data/               the SQLite file — gitignored, never committed
```

One module per entity. When a file scrolls past a screen or two, split it.

## SQLite patterns

These matter most — the schema is the thing every later phase builds on.

- **Open once.** One `DatabaseSync` instance exported from `src/db.mjs`; every
  module imports it. Don't open a second connection per request or per module.
- **`mkdirSync` the `data/` directory before opening the file.** It is
  gitignored and will not exist on a fresh clone or after a reset, and
  `DatabaseSync` will not create it for you.
- **Migrations are idempotent and additive.** `CREATE TABLE IF NOT EXISTS`, and
  for a new column on an existing table, check `PRAGMA table_info(...)` before
  `ALTER TABLE ... ADD COLUMN`. Every run of the app must be able to execute
  the whole schema module from scratch *and* against an existing database
  without throwing. Never `DROP TABLE` to fix a schema problem.
- **Always bind parameters.** `db.prepare('SELECT * FROM x WHERE id = ?').get(id)`.
  Never build SQL by string concatenation or template literal with a value in
  it — not for `WHERE`, and especially not for a sort column coming from a
  query string (validate that against an allow-list of column names instead).
- **`PRAGMA foreign_keys = ON`** right after opening, and declare real
  `REFERENCES` on the foreign keys. Let the database enforce what it can.
- **Store timestamps as ISO-8601 text** (`new Date().toISOString()`) and
  booleans as `0`/`1` integers. Be consistent; convert at the module boundary
  so handlers deal in JS types.
- Keep prepared statements next to the function that uses them.

## API shape

Consistency across entities matters more than any individual choice — later
phases retrofit *every* endpoint, and they can only do that reliably if the
endpoints look alike.

- **Routes** are `/<plural-entity>` and `/<plural-entity>/:id`:
  `POST /contacts`, `GET /contacts`, `GET /contacts/:id`, `PUT /contacts/:id`,
  `DELETE /contacts/:id`. Sub-resources hang off the id
  (`POST /contacts/:id/restore`).
- **JSON in, JSON out.** `Content-Type: application/json`, always a JSON body
  on both success and error. Never return a bare string or an HTML error page.
- **Status codes:** `200` read/update, `201` create (with the created record as
  the body), `204` delete with no body, `400` validation failure, `401` missing
  or bad credentials, `404` not found *or* not visible to this caller, `409`
  conflict, `429` rate limited. Prefer `404` over `403` for a record owned by
  someone else — don't leak that it exists.
- **One error shape, everywhere:** `{ "error": "human readable message" }`. Say
  what was wrong and which field, e.g. `{ "error": "email is malformed" }`.
- **No unhandled throw ever reaches the client.** Wrap the request handler so
  an unexpected error becomes a `500` with the standard error shape, and log it
  server-side.
- **Validate at the edge.** Check required fields and formats before touching
  the database, and return the first clear failure.
- List endpoints return a JSON array (later phases add filtering, sorting, and
  pagination to all of them at once — so give them the same shape now).

## Style

- Small functions, early returns, no clever abstractions.
- No classes unless there is genuine instance state.
- Descriptive names over comments; comment the *why* when a decision isn't
  obvious from the code (which cascade rule you picked, and why).
- Match the code that is already there. Read a neighbouring entity module
  before adding a new one — a new entity should be almost boringly parallel to
  the last.

## Testing

- One test file per module under `test/`, using `node:test` and
  `node:assert/strict`.
- Test the **failure** cases, not just the happy path: missing fields, a
  malformed email, a bad id, an illegal state transition, someone else's
  record.
- Tests must be independent and repeatable — use a temp or in-memory database
  per test file rather than the real `data/` file, and never depend on the
  order tests run in.
- Never edit or delete an existing test to make a change pass. If a test now
  contradicts the requirement, that is a real conflict — fix the code, or say
  so plainly in your summary.

## House rules

- Don't install anything. Don't add a dependency. Don't reach for the network.
- Don't restructure earlier phases' work unless the task says to.
- When a task says "every endpoint" or "every entity", it means all of them —
  go and read the route table rather than assuming you remember it.
