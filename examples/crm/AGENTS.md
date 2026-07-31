# AGENTS.md

Guidance for the agent building this CRM API. Kodr reads this file into the
system prompt of **every** run, so it stays short and only holds rules that
apply to all of them. Detail that matters for some tasks lives in a skill —
load it when it applies:

- **`sqlite-testing`** — load before writing or changing any test that touches
  the database, and before any schema change. Per-file test databases,
  idempotent migrations, parameter binding, type conversion.

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
src/router.mjs      method + path matching, params, query string
src/db.mjs          the one connection, and the schema
src/<entity>.mjs    one module per entity: queries + handlers
test/<name>.test.mjs
data/               the SQLite file — gitignored, never committed
```

One module per entity. When a file scrolls past a screen or two, split it.

## API shape

Consistency across entities matters more than any individual choice — later
phases retrofit *every* endpoint, and they can only do that reliably if the
endpoints look alike.

- **Routes** are `/<plural-entity>` and `/<plural-entity>/:id`:
  `POST /contacts`, `GET /contacts`, `GET /contacts/:id`, `PUT /contacts/:id`,
  `DELETE /contacts/:id`. Sub-resources hang off the id
  (`POST /contacts/:id/restore`).
- **JSON in, JSON out.** `Content-Type: application/json`, always a JSON body
  on both success and error. Never a bare string or an HTML error page.
- **Status codes:** `200` read/update, `201` create (returning the created
  record), `204` delete with no body, `400` validation failure, `401` missing
  or bad credentials, `404` not found *or* not visible to this caller, `409`
  conflict, `429` rate limited. Prefer `404` over `403` for a record owned by
  someone else — don't leak that it exists.
- **One error shape, everywhere:** `{ "error": "human readable message" }`.
  Say what was wrong and which field: `{ "error": "email is malformed" }`.
- **No unhandled throw ever reaches the client.** An unexpected error becomes a
  `500` with the standard error shape.
- **Validate at the edge**, before touching the database, and return the first
  clear failure.
- List endpoints return a JSON array — later phases add filtering, sorting and
  pagination to all of them at once, so give them the same shape now.

## Style

- Small functions, early returns, no clever abstractions.
- No classes unless there is genuine instance state.
- Descriptive names over comments; comment the *why* when a decision isn't
  obvious from the code (which cascade rule you picked, and why).
- Match the code that is already there. **Read a neighbouring entity module
  before adding a new one** — a new entity should be almost boringly parallel
  to the last, and that file has already solved the problems you are about to
  hit.

## Testing

- One test file per module under `test/`, using `node:test` and
  `node:assert/strict`.
- Test the **failure** cases, not just the happy path: missing fields, a
  malformed email, a bad id, an illegal state transition, someone else's
  record.
- **Adding a test file that touches the database? Load the `sqlite-testing`
  skill first.** Test files run in parallel against one shared database unless
  you set them up correctly, and getting this wrong produces failures that look
  random and are not.
- Never edit or delete an existing test to make a change pass. If a test now
  contradicts the requirement, that is a real conflict — fix the code, or say
  so plainly in your summary.

## House rules

- Don't install anything. Don't add a dependency. Don't reach for the network.
- Don't restructure earlier phases' work unless the task says to.
- When a task says "every endpoint" or "every entity", it means all of them —
  go and read the route table rather than assuming you remember it.
