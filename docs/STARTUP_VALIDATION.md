# FastWrite startup and recovery checks

The production build keeps Monaco, PDF rendering, and the browser TeX engine out
of the home/project-list static dependency graph. `onlyExplicitManualChunks`
prevents Rollup from collecting shared dependencies into an editor-only chunk.
The `fastwrite-startup-assets` build plugin checks the emitted entry and project
list chunks recursively and fails the build if an editor dependency leaks back
into either startup path. The generated `dist/startup-assets.json` records the
checked startup files and the independent editor chunks.

Build for the intended deployment path, including its trailing slash:

```sh
FASTWRITE_BASE_PATH=/write/ bun run --cwd apps/web build
```

The build creates `.gz` siblings for HTML, JavaScript, CSS, SVG and JSON assets.
Keep these siblings in the deployed `apps/web/dist` directory. The application
static handler negotiates gzip using `Accept-Encoding`, emits `Vary`, revalidates
HTML/service workers, and marks fingerprinted assets immutable. It leaves TeX
`.data.gz` archives as their original application bytes and uses the original
representation for range requests. The reverse proxy must preserve these
response headers and forward `Accept-Encoding`.

The HTML contains a visible loading state before the app bundle executes. The
independent `boot.js` offers reload after an entry bundle failure or a long wait;
the React route boundary offers the same recovery for lazy chunk failures.
Service worker navigation uses the network first, and only failed document
navigations receive the offline HTML shell. API/authenticated requests bypass
the public cache, and missing scripts remain failed script requests.

Run the focused protocol regressions and an actual Edge startup check against a
built preview/application:

```sh
bun test apps/server/src/web-static.test.ts apps/server/src/app-web-static.test.ts apps/web/src/services/serviceWorker.test.ts
FASTWRITE_E2E_URL=http://127.0.0.1:3712/write node scripts/e2e-startup.mjs
```

The Edge script verifies the home and a mocked authenticated project list make
no editor/compiler resource requests. It holds the entry scripts to verify the
HTML shell, then injects entry/lazy chunk failures and checks reload recovery.
It writes screenshots and `results.json` to `../startup-validation` by default
(override `FASTWRITE_E2E_OUTPUT`). Its local timings measure only that local
server and network; they are not production latency claims. The application
HTTP test separately checks gzip negotiation through the actual server handler.
