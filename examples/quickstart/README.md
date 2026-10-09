# Fix your first bug with Kodr

This is an intentionally broken demo, with no dependencies to install.
`slugify.mjs` should turn ASCII titles into URL slugs: lowercase the letters,
replace each run of characters outside `a-z` and `0-9` with one hyphen,
and remove leading and trailing hyphens. The six tests define the behavior.

With a tool-capable model loaded and LM Studio's API server running on port
1234, run these commands **from the Kodr repository root**:

```bash
node bin/kodr.mjs doctor
node bin/kodr.mjs "Fix the bug in slugify.mjs without changing the tests" --cwd examples/quickstart --test "node --test"
git diff -- examples/quickstart
```

The `--cwd` option selects this small demo as Kodr's workspace. A successful
run changes the function, leaves the tests unchanged, and passes all six tests.
Kodr streams its work and attempts up to three repair turns if verification
fails. Results and speed depend on the model and your hardware.

Run the tests before or after the task to see the difference:

```bash
node --test examples/quickstart/slugify.test.mjs
```

Before the fix, four tests fail; afterward, all six should pass. These
deliberately failing demo tests are separate from Kodr's own `npm test` suite.
Run transcripts are saved in this demo's ignored `.kodr/runs/` directory.

To try again, discard only the demo function's changes from the repository root:

```bash
git restore -- examples/quickstart/slugify.mjs
```

For your own project, see [the main README](../../README.md#use-it-on-your-project).
