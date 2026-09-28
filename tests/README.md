# Tests

Real HTTP integration tests against a real running server — no mocking, no
framework, just `fetch` (Node 18+, same as the app itself). Zero extra
dependencies for the default suite.

## Running

```
npm test
```

This starts `server.js` itself on a scratch port (`3987` by default) with
`WW_FAST_TIMERS=1`, runs every `tests/*.test.js` file against it, tears the
server down, and prints one overall pass/fail summary.

To run a single file against a server you're already running (e.g. one you
started by hand for manual testing), point `BASE_URL` at it:

```
BASE_URL=http://localhost:3000 node tests/core.test.js
```

Note: a server started without `WW_FAST_TIMERS=1` enforces the normal 5-second
timer floor, so a file run this way will be much slower (but still correct)
than under `npm test`.

## Why WW_FAST_TIMERS

The game's timers have a 5-second floor by design — a real vote shouldn't be
able to be configured down to nothing. But that same floor means a naive
integration test that plays out several phases of a real game (campaign
nomination → speeches → election vote → night → discussion → day vote) racks
up real wall-clock minutes just waiting out timers, across every test file,
every run.

`WW_FAST_TIMERS=1` (read once at server startup, in `server.js`) drops that
floor to 0.2s and the fixed 10s "get ready to vote" countdown to 0.5s. Nothing
about game *logic* changes — only what's allowed as a minimum. `run-all.js`
always sets it when it spawns the server; it is never set on Render, so
production behavior is untouched.

## Adding a new test file

Any `tests/*.test.js` file is picked up automatically by `run-all.js`. Use
`tests/lib.js`'s helpers (`api`, `state`, `pollUntil`, `setupRoom`,
`configureAndStart`, `findRoles`, `Tally`) instead of reinventing them —
see any existing `*.test.js` for the pattern. End the file by calling
`t.finish()`, which prints the summary and exits non-zero on any failure
(that's what `run-all.js` checks).

## Browser tests (optional, needs Playwright)

`browser.test.js` and `browser-seer.test.js` drive the actual UI in a real
browser via Playwright, catching things the HTTP-level tests can't (button
wiring, whether text actually renders where a user would see it, console
errors). They're excluded from the default `npm test` run because Playwright
is a real dependency the app itself doesn't need.

To enable them once:

```
npm install --no-save playwright
npx playwright install chromium   # skip if a Chromium build is already available;
                                   # point PW_CHROMIUM_PATH at it instead if so
npm test -- --include-browser
```

If you're running somewhere with a preinstalled Chromium at a nonstandard
path (like this project's own dev sandbox), set `PW_CHROMIUM_PATH` to that
binary instead of downloading a fresh one.
