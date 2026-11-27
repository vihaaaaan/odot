# odot

A small todo application layer and authenticated REST API with private per-user data, Postgres row-level security (RLS), and Neon Auth token verification. No frontend, MCP server, interactive login flow, or seed data.

## Stack and structure

- TypeScript on Node.js for callable service functions and shared types for future adapters.
- Postgres for persistence, using `pg` and Drizzle for connections, queries, and migrations. Works with Neon or a local Postgres instance.
- Zod for runtime input validation, including calls from untyped clients.
- Neon Auth for managed Google sign-in and `jose` for verifying signed access tokens.
- String fractional-indexing keys for manual ordering, without floating-point precision loss. Database comparisons explicitly use the `C` collation to match the key generator.
- Hono for the HTTP adapter and Node server; Zod OpenAPI generates the API contract from the route schemas.

The code is organized by feature, with separate input contracts, services, and database queries. `src/index.ts` is the application entry point; `src/api/index.ts` is the HTTP adapter. HTTP routes call the existing services, and future CLI commands or MCP tools can do the same. This package is server-side only: never ship database credentials or this database client in a Chrome extension.

## Code map

```text
src/
  index.ts                  Public API: connects the database and feature services
  api/
    index.ts                HTTP factory, authentication, limits, CORS, errors, OpenAPI
    server.ts               Loads environment, starts Node HTTP server, graceful shutdown
    contracts.ts            HTTP response schemas, parameters, and JSON serialization
    tasks.ts                Task routes and HTTP query-string conversion
    tags.ts                 Tag routes
  auth/
    neon.ts                 Verifies Neon Auth JWTs and returns the signed user ID
  db/
    connection.ts           Postgres connection pool and Drizzle handle
    tenant.ts               User-scoped transactions, local context, role/RLS checks
    schema.ts               Definitions of the three tables and their row types
    migrate.ts              Applies committed SQL migrations
  tasks/
    inputs.ts               Accepted task inputs, defaults, and input types
    service.ts              Task operations and transaction boundaries
    queries.ts              Task/tag-assignment queries, filters, sorting, and locks
    ordering.ts             Calculates saved order keys for append/move operations
  tags/
    inputs.ts               Accepted tag inputs and input types
    service.ts              Tag operations
    queries.ts              Tag queries and duplicate-name error translation
  shared/
    validation.ts           Common entity/user ID, name, and description rules
    errors.ts               Authentication, not-found, and conflict errors
```

These are ordinary functions, not a framework or a collection of abstract base classes. Each feature lives together, but its rules and SQL have distinct homes. Services may use another feature's queries when one operation needs a single transaction across tables. There is no separate repository interface or database-independent domain model at this scale. Assigning tags belongs to tasks; the `task_tags` table does not need its own feature folder.

Other project files:

| Location | Purpose |
| --- | --- |
| `tests/application.test.ts` | Integration tests for tasks, tags, relationships, ordering, and migrations against temporary Postgres |
| `tests/auth.test.ts` | Signed JWT acceptance/rejection tests with a local mocked JWKS response |
| `tests/api.test.ts` | HTTP requests through real signed JWT verification, services, and isolated Postgres RLS |
| `migrations/` | SQL changes and Drizzle migration metadata; committed together |
| `scripts/migrate.ts` | Migration command; reads `.env` and calls the migration function |
| `drizzle.config.ts` | Schema and migration paths for migration-generation tooling |
| `package.json` | Dependencies, scripts, and the package's public entry point |
| `tsconfig.json` | Strict TypeScript checks and compilation from `src/` into `dist/` |
| `tsconfig.test.json` | Type-checking configuration for tests, scripts, and tooling |
| `.env.example` | Connection-string template; not an actual credential |
| `dist/` | Generated JavaScript and type declarations; build output, not source to edit |

## Architecture and ownership

```text
HTTP adapter / script / future MCP adapter
                 |
                 v
       index.ts: createTodoApp
                 |
                 v
       forToken(jwt) / trusted forUser(id)
                 |
                 v
       tasks/service or tags/service
         |         |          |
         v         v          v
       inputs   ordering    queries
                   |          |
                   +--------->|
                              v
                    User-scoped transaction
                              |
                              v
                       Drizzle + pg
                              |
                              v
                         Postgres RLS
```

- **Public entry point:** `index.ts` creates the database handle. `await application.forToken(jwt)` verifies identity and returns `app.tasks` and `app.tags`. `application.forUser(id)` is a trusted-server-only method for already verified identities and tests, not authentication.
- **Tenant boundary:** `db/tenant.ts` wraps every operation in a transaction, checks for unsafe runtime credentials/missing RLS enforcement, and sets `app.user_id` with transaction-local `set_config`. Context resets on commit or rollback, including when connections are pooled. Services cannot perform an unscoped query through this wrapper.
- **Input contracts:** `inputs.ts` defines runtime Zod schemas and derives TypeScript input types from them. TypeScript helps checked callers during development; parsing also validates actual values at runtime. Shared field rules live in `shared/validation.ts`.
- **Application operations:** `service.ts` validates inputs and coordinates the steps that must succeed together. It owns transaction boundaries. It does not know about HTTP requests, MCP tool responses, or extension UI state.
- **Persistence:** `queries.ts` contains Drizzle reads and writes, including joins, filters, SQL sorting, and database locks. It accepts either the database handle or a transaction handle, as appropriate. It does not call services.
- **Manual ordering:** `tasks/ordering.ts` reads neighboring keys through task queries and calculates a new key. It is a database-aware helper, not a separate server or a purely database-independent algorithm. The service owns its transaction and lock.
- **Cross-feature work:** the task service can call tag queries to check/lock referenced tags within its transaction. Task queries own relationship inserts/deletes and loading attached tags. Tag deletion relies on the database's cascading relationship cleanup.
- **Infrastructure:** `db/` handles storage setup and table definitions, not task workflows. `shared/` stays limited to code actually shared by features, not miscellaneous helpers.

This is a feature-first application library with a small internal service/query split, not microservices or a full Clean Architecture implementation. The services deliberately depend on Drizzle transactions and the exported row types come from the database schema. Adding another database implementation would require changes; we have not added interfaces for a hypothetical replacement.

### Where to make a change

| Requested change | Start here |
| --- | --- |
| Change accepted task fields, defaults, or validation | `src/tasks/inputs.ts` |
| Change the steps for creating, completing, or tagging a task | `src/tasks/service.ts` |
| Change due-date sorting, importance sorting, filters, or pagination queries | `src/tasks/queries.ts` |
| Change how manual positions are calculated | `src/tasks/ordering.ts` |
| Change tag validation or tag operations | `src/tags/inputs.ts` or `src/tags/service.ts` |
| Change duplicate-tag error handling or tag SQL | `src/tags/queries.ts` |
| Add a persisted field or constraint | `src/db/schema.ts`, then generate/review a migration and update the relevant feature |
| Change the supported package exports | `src/index.ts` |
| Change HTTP routes or query-string parsing | `src/api/tasks.ts` or `src/api/tags.ts` |
| Change HTTP authentication, errors, CORS, or request limits | `src/api/index.ts` |
| Change HTTP response shapes or JSON serialization | `src/api/contracts.ts` |
| Understand or verify observable application behavior | `tests/application.test.ts` |

Add a feature folder for a meaningful application area, not automatically for every table. Add a separate helper file when it owns a named behavior worth finding independently, as ordering does. There is no requirement for every feature to have the same number of files.

## Walkthrough: creating a task

Start with this call from a script or a future adapter:

```ts
const task = await app.tasks.create({
  name: "Finish the draft",
  important: true,
  dueDate: "2028-03-15",
});
```

Follow these files in order:

1. **`src/index.ts`: wiring.** `createTodoApp(connection, { authUrl })` creates the shared database pool and token verifier. `forToken(jwt)` verifies the signed identity, then creates task and tag services bound to that user's transaction wrapper. A service factory returns functions that remember this wrapper without using a mutable global user ID.
2. **`src/tasks/inputs.ts`: input contract.** `createTaskInput.parse(input)` checks the actual runtime input: the name must be a nonblank string, the date must be a real calendar date, importance must be boolean, and unknown fields are rejected. TypeScript helps while writing code; this check still protects calls from JavaScript or future external adapters. The database has additional constraints as a final safeguard.
3. **`src/tasks/service.ts`: operation rules.** The service opens a transaction, locks ordering, checks any requested tags, obtains a position at the end of the list, inserts the task, inserts its tag associations, and returns the result. A transaction makes those writes succeed together or roll back together. An invalid tag must not leave behind a half-created task.
4. **`src/tasks/ordering.ts`: saved-position calculation.** `getAppendOrderKey` asks task queries for the last key and generates one after it. `getMovedOrderKey` finds the appropriate neighbors for first/last/before/after moves. Keys are internal strings, not priority scores, due dates, or numbers the caller manages. The service holds the ordering lock until the transaction finishes so another request cannot allocate a conflicting position in the meantime.
5. **`src/tasks/queries.ts`: persistence.** `insertTask` expresses the insert using Drizzle; the Postgres driver sends the query to Postgres. The database generates the ID/default timestamps and returns the inserted row. This is a file of ordinary database-query functions, not another product or server.
6. **Related data, also in `src/tasks/queries.ts`.** `insertTaskTags` inserts relationship rows and `withTags` loads the tags attached to returned tasks. A task can have several tags without storing a separate copy of each tag inside the task row. The service passes its transaction into these calls, so they all use the same transaction rather than independent connections.

If the call succeeds, it returns a task object with an ID, timestamps, and a `tags` array. If validation or a database operation fails, the promise rejects. The service itself does not print a UI message or return an HTTP status; the HTTP adapter translates the result or error for network clients.

## Walkthrough: moving and sorting

```ts
await app.tasks.move(task.id, { placement: "first" });
const byDeadline = await app.tasks.list({ sort: "due_date" });
```

These deliberately take different paths:

- **Move:** task input validation → task service → transaction/order lock → ordering calculation → task queries update `order_key`. This changes the saved manual order, not importance or deadlines.
- **List by date:** task input validation → task service → task queries select rows with a due-date `ORDER BY` and load attached tags. It writes nothing, so switching back to manual sorting returns your saved order.

Marking a task important is an ordinary field update through `app.tasks.update(id, { important: true })`; there is no separate automatic prioritization engine.

## Walkthrough: tags and shared infrastructure

- **Tag operations:** `src/tags/service.ts` validates create/get/list/update/delete calls and delegates their queries to `src/tags/queries.ts`. A duplicate name is translated from a database-specific error into `ConflictError`. Optional tag descriptions follow the same path as task descriptions. Nothing creates tags on startup.
- **Tag attachment:** `src/tasks/service.ts` checks IDs, locks/checks the task and tag, changes the relationship row through task queries, and updates the task's modification timestamp. These functions are exposed under `app.tasks.attachTag` and `detachTag`; a relationship table does not need a separate service.
- **Database connection:** `src/db/connection.ts` supplies a connection pool, a Drizzle handle, and `close()`. A transaction handle is scoped to one transaction; query functions accept that handle so related queries stay together.
- **Schema versus migrations:** `src/db/schema.ts` describes the intended table structure in TypeScript. SQL files under `migrations/` actually create/change tables when `src/db/migrate.ts` applies them. Importing a schema does not create tables, and opening the app does not automatically run migrations.
- **Shared validation:** `src/shared/validation.ts` holds only rules used by both tasks and tags, such as nonblank names and valid IDs. Task-specific fields stay under `tasks/`; tag-specific inputs stay under `tags/`.
- **Shared errors:** `src/shared/errors.ts` defines `NotFoundError` and `ConflictError`. Validation failures use the exported Zod `ValidationError`; connection and other unexpected database failures propagate rather than being mislabeled as user mistakes.

For reading the code, start at `index.ts`, follow `tasks/service.ts` for one operation, then open only the input/query/ordering functions it calls. The integration tests in `tests/application.test.ts` are executable examples of the public API, including sorting, completion, tag behavior, and concurrent moves. They remain one integration suite because tasks and tags are exercised together against the same isolated database.

## Setup

Requires Node.js 20.19+ and a Postgres database.

```sh
npm install
cp .env.example .env
# Set DATABASE_URL to the restricted runtime role's connection string.
# Set MIGRATION_DATABASE_URL to the separate database owner's connection string.
# Set NEON_AUTH_BASE_URL to the branch's managed Auth URL.
npm run db:migrate
npm run build
```

For Neon, use the connection strings supplied by the project, including TLS parameters. Do not commit credentials. The library accepts a connection string or a `pg` PoolConfig; it does not read `.env` itself. The migration script loads `.env` and uses only `MIGRATION_DATABASE_URL`. Migrations are explicit, not automatically applied when opening the app. Never use the owner connection for runtime queries; the application rejects owners, superusers, and roles with `BYPASSRLS`.

For another Postgres database, apply migrations as the owner and provision a separate non-owner login with `NOSUPERUSER NOBYPASSRLS NOCREATEROLE`. Grant it `USAGE ON SCHEMA public` and `SELECT, INSERT, UPDATE, DELETE ON public.tasks, public.tags, public.task_tags`. Do not grant ownership, DDL, `TRUNCATE`, privileged role membership, or access to `neon_auth`.

The per-user migration intentionally refuses a populated legacy database. Existing single-user rows have no known verified owner; do not guess one or silently expose them to a new user. Back them up and write a reviewed ownership backfill migration before upgrading a populated installation. The new Neon project starts empty.

## Usage

```ts
import { createTodoApp } from "./dist/index.js";

const application = createTodoApp(process.env.DATABASE_URL!, {
  authUrl: process.env.NEON_AUTH_BASE_URL!,
});

try {
  const app = await application.forToken(neonAccessToken);
  const task = await app.tasks.create({ name: "A task you chose" });
  const another = await app.tasks.create({ name: "Another task" });

  await app.tasks.update(task.id, {
    important: true,
    dueDate: "2028-03-15",
  });
  await app.tasks.move(task.id, { placement: "after", targetId: another.id });

  const upcoming = await app.tasks.list({ sort: "due_date" });
  console.log(upcoming);
} finally {
  await application.close();
}
```

Tags are entirely user-created. `app.tags.create({ name, description? })` supports an optional description. Add tags during task creation with `tagIds`, or later through `app.tasks.attachTag(taskId, tagId)` and `detachTag(taskId, tagId)`.

`neonAccessToken` above is the raw JWT obtained after a real Neon Auth sign-in; it is not a Google access token, an email, or an arbitrary user ID. The HTTP adapter extracts the bearer token and calls `forToken` for each request. Create the application/pool once per backend process and close it on shutdown, not after each request. Do not reuse a user-scoped object as an indefinitely authenticated session.

For a trusted script that has independently established identity, use `application.forUser(verifiedUserId)`. This method intentionally skips token verification. Never expose it to untrusted request parameters or put database credentials in the extension. There are no root-level `application.tasks` or `application.tags` methods: a user context is always required.

## Data model

| Table | Fields |
| --- | --- |
| `tasks` | UUID `id`, required `user_id`, required `name`, nullable `description`, `important` (default false), nullable `due_date`, internal `order_key`, nullable `completed_at`, `created_at`, `updated_at` |
| `tags` | UUID `id`, required `user_id`, required case-insensitively unique-per-user `name`, nullable `description` |
| `task_tags` | `user_id`, `task_id`, `tag_id`; composite primary key and owner-aware cascading foreign keys |

`user_id` is the verified Neon Auth token's `sub`, stored as text rather than an email. Ownership defaults to the transaction's context and cannot be submitted through task/tag input objects. Composite foreign keys require a task and all assigned tags to have the same owner, even if a caller bypasses the application helpers. There is no extra users/workspaces table and no team sharing. Auth owns account data; application tables deliberately do not depend on Neon Auth's internal schema. Deleting an auth account does not automatically delete its application data; account-data deletion is a separate future operation.

Due dates are date-only `YYYY-MM-DD` strings, with no timezone conversion or time of day. Timestamps are timezone-aware and returned as JavaScript Dates. Names are trimmed and must be nonblank (maximum 500 characters); descriptions may be null or up to 50,000 characters. Explicit null clears an optional field; omission leaves it unchanged. Unknown input fields are rejected.

## Behavior and operations

- `tasks.create`, `get`, `update`, `delete`, `list`, `move`, `setCompleted`, `attachTag`, `detachTag`.
- `tags.create`, `get`, `update`, `delete`, `list`.
- New tasks append to the saved list. `move` accepts `first`, `last`, `before`, or `after`; relative moves require `targetId`.
- One saved order per user, not separate orders per tag or filtered view. Completed tasks retain their positions, so reopening restores their place. Relative moves refer to the user's full order even if a caller is viewing a sorted/filtered subset.
- Sort `manual` (default), `due_date` (earliest first, undated last), or `important` (important first). The latter two use manual order to break ties and never rewrite it. No automatic urgency scores or deadline-driven reprioritization.
- List status is `incomplete` by default, or `completed` / `all`. When listing `all`, completion does not add a separate sort grouping.
- Optional `important` and `tagIds` filters. A task must have **all** requested tags. An unknown filter tag matches no tasks.
- List pagination uses `limit` (default 100, maximum 500) and `offset` (default 0). Pagination is not a snapshot across separate requests; concurrent edits can shift later pages.
- Creating a task with tags is atomic. Duplicate tag attachments are harmless; detaching an existing but unattached tag is harmless. Missing entities produce `NotFoundError`.
- Tag names are case-insensitively unique within each user, and duplicates produce `ConflictError`. Different users can choose the same names. Validation failures produce the exported `ValidationError` (ZodError).
- Deleting tags removes associations, not tasks; deleting tasks removes associations, not tags.
- Ordering mutations use a user-scoped transaction advisory lock, so concurrent creates, moves, and deletes for the same user cannot allocate conflicting keys. Other field updates use last-write-wins behavior. A hash collision could serialize unrelated users but cannot mix their data.

## RLS and authentication

All three application tables have `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`. Policies enforce `user_id = nullif(current_setting('app.user_id', true), '')` for both visible rows (`USING`) and written rows (`WITH CHECK`). With no context, reads see no application rows and writes fail. Another user's IDs behave as missing entities. The owner-aware foreign keys add a separate guarantee against mixed-user relationships.

The database trusts the backend to set a verified user ID. A holder of runtime database credentials can set the context themselves; RLS is defense against missing filters and accidental cross-user queries, not authentication of arbitrary SQL clients. Keep credentials server-side, use parameterized queries, and never provide a raw-SQL endpoint. Owner/migration credentials remain administrative and can bypass RLS.

`auth/neon.ts` validates the JWT's signature against the configured branch's HTTPS JWKS, restricts the signing algorithm to EdDSA, checks issuer and audience against the Auth URL's origin, requires subject/issue-time/expiry, and limits token age to 15 minutes. Invalid tokens and key-service failures fail closed with `AuthenticationError`. A `banned: true` claim is rejected. JWT verification does not perform live session introspection: logout, account deletion, or banning after issuance may not invalidate a previously issued token until expiry. Immediate revocation is not implemented.

### Connected Neon environment

- Project: `odot` (`damp-term-13907893`), AWS US East Ohio, Postgres 18.
- Branch: `main` (`br-twilight-sun-bdycgq74`), database: `neondb`.
- Runtime role: `odot_app`, non-owner and without `BYPASSRLS`; separate owner connection for migrations.
- Connection strings and `NEON_AUTH_BASE_URL` are in ignored `.env`, not tracked source. The runtime role has no access to the Auth schema.
- This account does not permit changing suspend timeout; the project uses the account's default compute settings.

### Google sign-in setup

Neon Auth (managed Better Auth) is enabled on `main`. Google is configured with Neon's shared **development** OAuth credentials. Email/password and organization support are disabled, keeping this application Google-only and individual. No accounts or tags are seeded.

When implementing the extension/front end, use the Neon Auth client to call `signIn.social({ provider: "google", callbackURL })`, then obtain the JWT from `getSession()` for separate-backend requests. The extension's browser-auth/callback handling is deliberately not built yet. Do not assume an extension origin behaves like a regular web origin; choose the extension sign-in handoff and register its actual trusted callback when that layer exists. Localhost is currently allowed for development; there is no production trusted-domain entry yet.

Before production, supply your own Google OAuth client ID/secret through Neon, configure Google's callback as `${NEON_AUTH_BASE_URL}/callback/google`, register your real application callback origin in Neon's trusted domains, and disable localhost. Do not put the Google client secret in the extension or source control. The configured provider and JWT verification are ready, but a complete interactive Google login has not been tested without a UI and a real user.

The HTTP adapter is implemented locally; it is not deployed. There is no MCP endpoint. Before exposing the API publicly, configure HTTPS hosting and deployment-level rate limiting as well as production OAuth settings. No rate limiter or interactive sign-in flow is implemented here.

## REST API

Start the development server with `npm run dev`, or run `npm run build && npm start` for compiled JavaScript. The server loads `.env`, requires `DATABASE_URL` and `NEON_AUTH_BASE_URL`, and defaults to `HOST=127.0.0.1` and `PORT=3000`. Set `HOST=0.0.0.0` when your deployment requires external binding. It does not run migrations automatically. SIGINT/SIGTERM stop accepting requests, drain active requests, and close the database pool, with a ten-second shutdown deadline.

`GET /health` is public process liveness, not a database readiness check. `GET /openapi.json` is the public OpenAPI 3.1 contract, generated from the same route definitions used for validation. These endpoints do not expose user records. Every `/v1/*` data request requires `Authorization: Bearer <Neon Auth JWT>`. There is no user-ID parameter or authentication bypass route.

| Method | Path | Operation |
| --- | --- | --- |
| GET, POST | `/v1/tasks` | List or create tasks |
| GET, PATCH, DELETE | `/v1/tasks/{id}` | Read, update, or delete a task |
| PUT | `/v1/tasks/{id}/completion` | Complete or reopen using `{ "completed": true }` or `false` |
| POST | `/v1/tasks/{id}/move` | Move first/last or before/after a target task |
| PUT, DELETE | `/v1/tasks/{id}/tags/{tagId}` | Attach or detach a tag, with no request body |
| GET, POST | `/v1/tags` | List or create user-owned tags |
| GET, PATCH, DELETE | `/v1/tags/{id}` | Read, update, or delete a tag |

JSON bodies reuse `tasks/inputs.ts` and `tags/inputs.ts`; unknown fields are rejected. PATCH requires at least one supported field. Omit a field to keep its value; set `description` or `dueDate` to `null` to clear it. Tag assignment and task completion have their own routes rather than expanding PATCH to accept every operation.

Task list query parameters are `status` (`incomplete`, `completed`, `all`), `sort` (`manual`, `due_date`, `important`), `important` (`true` or `false`), repeated `tagIds`, `limit` (1–500), and `offset` (0 or greater). Defaults remain incomplete tasks, manual sort, limit 100, offset 0. All requested tags must match. For example: `/v1/tasks?sort=due_date&important=false&tagIds=UUID&tagIds=UUID`. Sorting never rewrites saved order. List responses are JSON arrays; task pagination is offset-based, without a total-count query.

```sh
export ODOT_TOKEN='your-neon-auth-jwt'
curl http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer $ODOT_TOKEN"
curl http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer $ODOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Review API","important":true,"dueDate":"2026-12-01"}'
```

Create returns 201 and a `Location` header. Reads and updates return 200; deletes and tag assignment return 204 with no body. Create/get/list task responses include `tags`; update/completion/move responses return task fields only. Responses omit internal `userId` fields, serialize timestamps as UTC ISO strings, and preserve date-only due dates as `YYYY-MM-DD`. Treat `orderKey` as opaque and change order only through the move operation.

Errors use `{ "error": { "code": "...", "message": "...", "details": [{ "path": "name", "message": "..." }] } }`; `details` appears only on validation errors. Status codes are 400 for invalid inputs or malformed JSON, 401 for authentication, 404 for missing resources (including other users' IDs), 409 for conflicts, 413 for bodies over 256 KiB, 415 for unsupported content types, and 500 for unexpected errors. Internal errors are logged server-side but not returned to clients. Responses are non-cacheable and include security headers. CORS is disabled by default; set `CORS_ORIGINS` to a comma-separated explicit origin allowlist when the extension/web client exists. CORS permits browser access but never replaces bearer authentication; preflight requests do not require a token when CORS is configured. Wildcard and `null` origins are not allowed. No cookie authentication is used.

For another server host or tests, import `createApi` from `odot/api` and pass the existing `application`. It exposes a Fetch-compatible `api.fetch` and an in-process `api.request` test helper without opening a network port. The separate `server.ts` is the executable entry point. Do not import it into tests or other adapters because importing it starts a listener.

The dependency direction remains `HTTP routes → application services → database`, never the reverse. A future co-located MCP adapter can call the same application entry point; it does not need an HTTP round trip or its own task business logic.

## Development and verification

```sh
npm run typecheck
npm test
npm run build
```

Integration tests use the development-only `embedded-postgres` package to start a real, isolated temporary Postgres cluster on a Unix socket. No separately installed Postgres server is required. Run them on macOS or Linux as a non-root user. They apply migrations as an administrator, then exercise services and raw SQL with a separate non-owner `NOBYPASSRLS` runtime login. Tests cover multiple users, guessed IDs, forged ownership, mixed-user foreign keys, no-context access, rollback/commit cleanup, and concurrent pooled requests. They stop/remove the cluster afterward and do not use `.env`, your application database, or Neon. Auth tests sign real local Ed25519 JWTs and mock only the JWKS HTTP response, not persistence or signature verification.

The API suite uses its own temporary Postgres cluster, a restricted runtime login, and locally signed Ed25519 JWTs. Only JWKS fetching is mocked. It exercises all 14 data operations through HTTP request/response handling, including tenant isolation, query conversion, sorting/movement, validation, errors, CORS, and the generated OpenAPI contract.

`npm audit` currently reports four moderate development-only findings from Drizzle Kit's legacy esbuild loader. Production dependencies pass `npm audit --omit=dev`. The loader is only used by local schema-generation tooling; this project does not run an esbuild development server.

After changing `src/db/schema.ts`, run `npm run db:generate`, review the generated SQL under `migrations/`, then apply it with `npm run db:migrate`. The committed migration metadata must stay alongside the SQL.

Migration `0001` includes manually reviewed SQL for refusing unowned legacy data and forcing RLS. Drizzle represents enabled RLS/policies in its schema, but the force setting lives in the SQL migration. Review generated dependency order (columns/unique constraints before composite foreign keys); never apply generated SQL without inspection.
