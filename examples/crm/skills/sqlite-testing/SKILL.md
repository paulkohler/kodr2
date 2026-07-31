---
name: sqlite-testing
description: Working patterns for node:sqlite storage and its tests in this project — per-file test databases, idempotent migrations, parameter binding, type conversion. Load this BEFORE writing or changing any test that touches the database, and before any schema change (new table, new column, new entity).
---

# SQLite and its tests

Everything here is about one project: a zero-dependency `node:sqlite` API tested
with `node:test`. Follow it exactly — these are not preferences, they are the
things that have actually broken builds here.

## 1. Every test file needs its own database

**This is the one that bites.** `node --test` runs test *files* in parallel,
one process each. They all import the same `src/db.mjs`, which opens the same
`data/crm.db`. So a test file that clears state — `DELETE FROM contacts` — is
deleting rows another file is in the middle of asserting on. The failures look
random: a record that was just created is suddenly missing, a list endpoint
returns a count that changes between runs, one file passes alone and fails in
the suite.

It only appears once a *second* database-touching test file exists. Adding one
is exactly when you must do this.

`src/db.mjs` reads `CRM_DB_PATH` and falls back to `data/crm.db`. Point each
test file at its own:

```js
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Set the env var BEFORE importing anything that opens a database, then import
// dynamically. A static `import` is hoisted and would run db.mjs first, which
// reads CRM_DB_PATH at module-evaluation time — too late.
const DB_PATH = join(tmpdir(), `crm-note-test-${process.pid}.db`);
process.env.CRM_DB_PATH = DB_PATH;

const { router } = await import('../src/server.mjs');

after(() => {
  rmSync(DB_PATH, { force: true });
});
```

The `await import(...)` is load-bearing. If you write
`import { router } from '../src/server.mjs'` at the top instead, JavaScript
hoists it above the `process.env` assignment and the file silently uses the
shared database again.

Because each file has its own database, **you do not need `DELETE FROM`
cleanup between tests** — but you do need each test to create the rows it
depends on. Write a small `seedContact()`-style helper and call it per test
rather than relying on a row an earlier test created.

Do not "fix" a contamination failure by adding more `DELETE FROM` statements,
by making tests run serially, or by having one test depend on another's rows.
Give the file its own database.

## 2. Migrations are idempotent and additive

`initSchema()` runs on every single import, against both a fresh file and one
that already has data. It must never throw in either case.

```js
// New table — always IF NOT EXISTS.
db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
    deal_id TEXT REFERENCES deals(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    CHECK ((contact_id IS NULL) <> (deal_id IS NULL))
  )
`);

// New column on an existing table — SQLite has no ADD COLUMN IF NOT EXISTS,
// so check first. Running this twice must be a no-op, not an error.
const columns = db.prepare('PRAGMA table_info(contacts)').all();
if (!columns.some((c) => c.name === 'owner_id')) {
  db.exec('ALTER TABLE contacts ADD COLUMN owner_id TEXT');
}
```

Never `DROP TABLE` to resolve a schema problem, and never delete `data/crm.db`
to make a migration work — the real database has rows in it, and a migration
that only works on an empty file is broken.

Adding a `NOT NULL` column to a populated table fails unless you give it a
`DEFAULT`. Add it nullable, or add it with a default, then backfill.

## 3. Always bind parameters

```js
// Right
db.prepare('SELECT * FROM deals WHERE stage = ?').all(stage);
db.prepare('INSERT INTO notes (id, body) VALUES (?, ?)').run(id, body);

// Wrong — injection, and it breaks on any value containing a quote
db.prepare(`SELECT * FROM deals WHERE stage = '${stage}'`).all();
```

A column *name* can't be bound as a parameter, so when a sort field arrives
from a query string, validate it against an allow-list and interpolate only the
matched literal:

```js
const SORTABLE = ['id', 'name', 'created_at', 'value'];
if (!SORTABLE.includes(sort)) {
  return { error: `sort must be one of: ${SORTABLE.join(', ')}`, status: 400 };
}
const order = dir === 'desc' ? 'DESC' : 'ASC';
db.prepare(`SELECT * FROM deals ORDER BY ${sort} ${order}`).all();
```

An invalid sort field is a `400` with a clear message, never a raw SQL error
reaching the client.

## 4. Convert types at the module boundary

SQLite has no boolean and no date type. Store booleans as `0`/`1` integers and
timestamps as ISO-8601 text (`new Date().toISOString()`, which sorts correctly
as a string). Convert once, in the entity module, so handlers and tests only
ever see JS types:

```js
function toApi(row) {
  return { ...row, done: row.done === 1 };
}
```

Returning `done: 1` from an endpoint is a bug — the API contract says boolean.

## 5. Foreign keys and constraints

`PRAGMA foreign_keys = ON` is already set in `db.mjs`. Declare real
`REFERENCES` on every foreign key and let the database enforce what it can. A
foreign-key violation surfaces as a thrown error containing
`FOREIGN KEY constraint failed`; catch it and return a `400` naming the missing
parent, rather than letting a `500` reach the client:

```js
} catch (err) {
  if (err.message.includes('FOREIGN KEY constraint failed')) {
    return { error: 'referenced contact or deal does not exist', status: 400 };
  }
  return { error: err.message, status: 500 };
}
```

For "exactly one of these two columns", a `CHECK` constraint states the rule in
the schema, alongside the validation that produces the readable message:

```sql
CHECK ((contact_id IS NULL) <> (deal_id IS NULL))
```

## 6. One connection

`src/db.mjs` exports a single `DatabaseSync` instance. Import it. Never open a
second connection in an entity module, a handler, or a test — two connections
to one file will deadlock or see stale data.

`db.mjs` creates the `data/` directory before opening, because it is gitignored
and will not exist on a fresh clone. If you add another path that opens a file,
create its directory too.

## Before you say a storage change is done

- Does `npm test` pass when run **twice in a row**? A contamination bug often
  passes once and fails on the repeat.
- Does every test file that touches the database set `CRM_DB_PATH` and import
  dynamically?
- Does `initSchema()` run clean against both an empty file and the existing
  `data/crm.db`?
- Is every value bound as a parameter, and every sort column allow-listed?
- Do booleans come back as `true`/`false` and timestamps as ISO strings?
