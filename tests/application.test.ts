import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import EmbeddedPostgres from "embedded-postgres";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationError, ConflictError, createTodoApp, migrateDatabase, NotFoundError, ValidationError } from "../src/index.js";

const directory = mkdtempSync("/tmp/odot-test-");
const dataDirectory = join(directory, "data");
const password = randomUUID();
const connection = { host: directory, user: "odot_test", password, database: "postgres", max: 10 };
const logs: string[] = [];
const cluster = new EmbeddedPostgres({
  databaseDir: dataDirectory,
  user: connection.user,
  password,
  authMethod: "scram-sha-256",
  persistent: false,
  autoRehydrateSymlinks: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  postgresFlags: ["-F", "-k", directory, "-h", ""],
  onLog: (message) => { logs.push(message); },
  onError: (message) => { logs.push(String(message)); },
});
let application: ReturnType<typeof createTodoApp>;
let app: ReturnType<ReturnType<typeof createTodoApp>["forUser"]>;
let pool: Pool;
let runtimePool: Pool;
const firstUserId = randomUUID();
const secondUserId = randomUUID();
const runtimePassword = randomUUID();
let running = false;

beforeAll(async () => {
  try {
    await cluster.initialise();
    await cluster.start();
    running = true;
    await migrateDatabase(connection);
    pool = new Pool(connection);
    await pool.query(`CREATE ROLE odot_app LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS NOINHERIT`);
    await pool.query("GRANT USAGE ON SCHEMA public TO odot_app");
    await pool.query("GRANT SELECT, INSERT, UPDATE, DELETE ON tasks, tags, task_tags TO odot_app");
    const runtimeConnection = { ...connection, user: "odot_app", password: runtimePassword, max: 2 };
    application = createTodoApp(runtimeConnection);
    app = application.forUser(firstUserId);
    runtimePool = new Pool({ ...runtimeConnection, max: 1 });
  } catch (error) {
    throw new Error(`Could not start the isolated test database. ${logs.join("\n")}`, { cause: error });
  }
}, 30_000);

beforeEach(async () => {
  await pool.query("TRUNCATE task_tags, tasks, tags");
});

afterAll(async () => {
  try {
    await application?.close();
    await runtimePool?.end();
    await pool?.end();
  } finally {
    if (running) await cluster.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function asRuntimeUser<Result>(userId: string, operation: (client: PoolClient) => Promise<Result>): Promise<Result> {
  const client = await runtimePool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("tasks", () => {
  it("starts empty with no seeded tags", async () => {
    expect(await app.tasks.list()).toEqual([]);
    expect(await app.tags.list()).toEqual([]);
  });

  it("creates defaults, trims names, and appends tasks", async () => {
    const first = await app.tasks.create({ name: "  First  " });
    const second = await app.tasks.create({ name: "Second", description: "Details" });
    expect(first).toMatchObject({ name: "First", description: null, important: false, dueDate: null, completedAt: null, tags: [] });
    expect(first.createdAt).toBeInstanceOf(Date);
    expect((await app.tasks.list()).map((task) => task.id)).toEqual([first.id, second.id]);
    expect(await app.tasks.get(second.id)).toMatchObject({ description: "Details" });
  });

  it("updates importance, name, description, and date without changing order", async () => {
    const task = await app.tasks.create({ name: "Original" });
    const updated = await app.tasks.update(task.id, { name: "Renamed", important: true, description: "Text", dueDate: "2028-02-29" });
    expect(updated).toMatchObject({ name: "Renamed", important: true, description: "Text", dueDate: "2028-02-29", orderKey: task.orderKey });
    expect(await app.tasks.update(task.id, { description: null, dueDate: null })).toMatchObject({ description: null, dueDate: null });
  });

  it("completes idempotently, filters completion, and reopens at the saved position", async () => {
    const task = await app.tasks.create({ name: "First" });
    const second = await app.tasks.create({ name: "Second" });
    const completed = await app.tasks.setCompleted(task.id, true);
    expect(completed.completedAt).toBeInstanceOf(Date);
    expect((await app.tasks.setCompleted(task.id, true)).completedAt).toEqual(completed.completedAt);
    expect((await app.tasks.list()).map((entry) => entry.id)).toEqual([second.id]);
    expect((await app.tasks.list({ status: "completed" })).map((entry) => entry.id)).toEqual([task.id]);
    expect(await app.tasks.list({ status: "all" })).toHaveLength(2);
    await app.tasks.setCompleted(task.id, false);
    expect((await app.tasks.list()).map((entry) => entry.id)).toEqual([task.id, second.id]);
  });

  it("sorts due dates with nulls last and uses manual tie-breakers without mutating order", async () => {
    const undated = await app.tasks.create({ name: "Undated" });
    const later = await app.tasks.create({ name: "Later", dueDate: "2028-02-02" });
    const earlier = await app.tasks.create({ name: "Earlier", dueDate: "2028-02-01" });
    const tied = await app.tasks.create({ name: "Tied", dueDate: "2028-02-01" });
    expect((await app.tasks.list({ sort: "due_date" })).map((task) => task.id)).toEqual([earlier.id, tied.id, later.id, undated.id]);
    expect((await app.tasks.list()).map((task) => task.id)).toEqual([undated.id, later.id, earlier.id, tied.id]);
  });

  it("sorts important first while preserving manual order within groups", async () => {
    const normal = await app.tasks.create({ name: "Normal" });
    const important = await app.tasks.create({ name: "Important", important: true });
    const another = await app.tasks.create({ name: "Another", important: true });
    expect((await app.tasks.list({ sort: "important" })).map((task) => task.id)).toEqual([important.id, another.id, normal.id]);
    expect((await app.tasks.list({ important: true })).map((task) => task.id)).toEqual([important.id, another.id]);
    expect((await app.tasks.list()).map((task) => task.id)).toEqual([normal.id, important.id, another.id]);
  });

  it("paginates in the selected order", async () => {
    await app.tasks.create({ name: "First" });
    const second = await app.tasks.create({ name: "Second" });
    await app.tasks.create({ name: "Third" });
    expect((await app.tasks.list({ limit: 1, offset: 1 })).map((task) => task.id)).toEqual([second.id]);
  });

  it("moves before, after, first, and last without touching importance or date", async () => {
    const first = await app.tasks.create({ name: "First" });
    const second = await app.tasks.create({ name: "Second" });
    const third = await app.tasks.create({ name: "Third", important: true, dueDate: "2028-01-01" });
    const ids = async () => (await app.tasks.list()).map((task) => task.id);
    await app.tasks.move(third.id, { placement: "before", targetId: second.id });
    expect(await ids()).toEqual([first.id, third.id, second.id]);
    await app.tasks.move(first.id, { placement: "after", targetId: third.id });
    expect(await ids()).toEqual([third.id, first.id, second.id]);
    await app.tasks.move(second.id, { placement: "first" });
    expect(await ids()).toEqual([second.id, third.id, first.id]);
    await app.tasks.move(third.id, { placement: "last" });
    expect(await ids()).toEqual([second.id, first.id, third.id]);
    expect(await app.tasks.get(third.id)).toMatchObject({ important: true, dueDate: "2028-01-01" });
  });

  it("can move the only task and rejects self-relative or missing targets", async () => {
    const task = await app.tasks.create({ name: "Only" });
    await app.tasks.move(task.id, { placement: "first" });
    await app.tasks.move(task.id, { placement: "last" });
    await expect(app.tasks.move(task.id, { placement: "after", targetId: task.id })).rejects.toBeInstanceOf(ValidationError);
    await expect(app.tasks.move(task.id, { placement: "before", targetId: randomUUID() })).rejects.toBeInstanceOf(NotFoundError);
    expect(await app.tasks.list()).toHaveLength(1);
  });

  it("retains exact ordering after repeatedly inserting into the same gap", async () => {
    const anchor = await app.tasks.create({ name: "Anchor" });
    const moving = await app.tasks.create({ name: "Moving" });
    for (let iteration = 0; iteration < 100; iteration++) {
      const newcomer = await app.tasks.create({ name: `Task ${iteration}` });
      await app.tasks.move(newcomer.id, { placement: "after", targetId: anchor.id });
    }
    await app.tasks.move(moving.id, { placement: "after", targetId: anchor.id });
    const result = await app.tasks.list({ limit: 500 });
    expect(result.slice(0, 3).map((task) => task.name)).toEqual(["Anchor", "Moving", "Task 99"]);
    expect(new Set(result.map((task) => task.orderKey)).size).toBe(102);
  });

  it("serializes concurrent appends and moves without losing tasks or duplicating keys", async () => {
    const created = await Promise.all(Array.from({ length: 20 }, (_, index) => app.tasks.create({ name: `Task ${index}` })));
    const target = created[0]!;
    await Promise.all(created.slice(1).map((task) => app.tasks.move(task.id, { placement: "after", targetId: target.id })));
    const listed = await app.tasks.list();
    expect(listed).toHaveLength(20);
    expect(listed[0]?.id).toBe(target.id);
    expect(new Set(listed.map((task) => task.orderKey)).size).toBe(20);
  });

  it("returns explicit not-found errors", async () => {
    const missing = randomUUID();
    await expect(app.tasks.get(missing)).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tasks.update(missing, { important: true })).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tasks.setCompleted(missing, true)).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tasks.move(missing, { placement: "first" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tasks.delete(missing)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("validates blank names, calendar dates, IDs, unknown fields, and list options", async () => {
    await expect(app.tasks.create({ name: " " })).rejects.toBeInstanceOf(ValidationError);
    await expect(app.tasks.create({ name: "Invalid", dueDate: "2027-02-29" })).rejects.toBeInstanceOf(ValidationError);
    await expect(app.tasks.get("not-an-id")).rejects.toBeInstanceOf(ValidationError);
    await expect(app.tasks.list({ limit: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(app.tasks.create({ name: "Invalid", orderKey: "a0" } as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(app.tasks.update(randomUUID(), {})).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("tags", () => {
  it("supports optional descriptions, rename, and clearing descriptions", async () => {
    const tag = await app.tags.create({ name: "  Example  ", description: "My description" });
    expect(tag).toMatchObject({ name: "Example", description: "My description" });
    expect(await app.tags.get(tag.id)).toEqual(tag);
    expect(await app.tags.update(tag.id, { name: "Renamed", description: null })).toMatchObject({ name: "Renamed", description: null });
    expect(await app.tags.list()).toHaveLength(1);
    expect(await app.tags.create({ name: "Other" })).toMatchObject({ description: null });
  });

  it("rejects case-insensitive duplicate tag names on create and update", async () => {
    await app.tags.create({ name: "Work" });
    await expect(app.tags.create({ name: " work " })).rejects.toBeInstanceOf(ConflictError);
    const other = await app.tags.create({ name: "Other" });
    await expect(app.tags.update(other.id, { name: "WORK" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("attaches multiple tags, deduplicates, and detaches idempotently", async () => {
    const first = await app.tags.create({ name: "First" });
    const second = await app.tags.create({ name: "Second" });
    const task = await app.tasks.create({ name: "Tagged", tagIds: [first.id, first.id] });
    await app.tasks.attachTag(task.id, first.id);
    await app.tasks.attachTag(task.id, second.id);
    expect((await app.tasks.get(task.id)).tags.map((tag) => tag.id)).toEqual([first.id, second.id]);
    await app.tasks.detachTag(task.id, first.id);
    await app.tasks.detachTag(task.id, first.id);
    expect((await app.tasks.get(task.id)).tags.map((tag) => tag.id)).toEqual([second.id]);
  });

  it("filters by all requested tags", async () => {
    const first = await app.tags.create({ name: "First" });
    const second = await app.tags.create({ name: "Second" });
    await app.tasks.create({ name: "One tag", tagIds: [first.id] });
    const both = await app.tasks.create({ name: "Both tags", tagIds: [first.id, second.id] });
    expect(await app.tasks.list({ tagIds: [first.id] })).toHaveLength(2);
    expect((await app.tasks.list({ tagIds: [first.id, second.id] })).map((task) => task.id)).toEqual([both.id]);
    expect(await app.tasks.list({ tagIds: [randomUUID()] })).toEqual([]);
  });

  it("rolls back creation with an unknown tag", async () => {
    await expect(app.tasks.create({ name: "Invalid", tagIds: [randomUUID()] })).rejects.toBeInstanceOf(NotFoundError);
    expect(await app.tasks.list()).toEqual([]);
  });

  it("deleting a tag preserves tasks and deleting a task preserves tags", async () => {
    const tag = await app.tags.create({ name: "Tag" });
    const task = await app.tasks.create({ name: "Task", tagIds: [tag.id] });
    await app.tags.delete(tag.id);
    expect((await app.tasks.get(task.id)).tags).toEqual([]);
    const retained = await app.tags.create({ name: "Retained" });
    await app.tasks.attachTag(task.id, retained.id);
    await app.tasks.delete(task.id);
    expect(await app.tags.get(retained.id)).toBeDefined();
    expect((await pool.query("SELECT * FROM task_tags")).rows).toEqual([]);
  });

  it("validates tag writes and missing task/tag relationships", async () => {
    await expect(app.tags.create({ name: " " })).rejects.toBeInstanceOf(ValidationError);
    await expect(app.tags.update(randomUUID(), {})).rejects.toBeInstanceOf(ValidationError);
    await expect(app.tags.get(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tags.update(randomUUID(), { name: "Missing" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tags.delete(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    const task = await app.tasks.create({ name: "Task" });
    await expect(app.tasks.attachTag(task.id, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tasks.detachTag(task.id, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keeps migrations repeatable", async () => {
    await app.tags.create({ name: "Preserved" });
    await migrateDatabase(connection);
    expect(await app.tags.list()).toHaveLength(1);
  });
});

describe("per-user isolation and RLS", () => {
  it("binds verified token subjects to the database context end to end", async () => {
    const authUrl = "https://auth.example.test/neondb/auth";
    const origin = new URL(authUrl).origin;
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    const publicJwk = { ...await exportJWK(publicKey), kid: "integration-key", alg: "EdDSA" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: [publicJwk] }))));
    const authenticated = createTodoApp({ ...connection, user: "odot_app", password: runtimePassword }, { authUrl });
    try {
      const firstToken = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "integration-key" })
        .setSubject(firstUserId).setIssuer(origin).setAudience(origin).setIssuedAt().setExpirationTime("15m").sign(privateKey);
      const secondToken = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "integration-key" })
        .setSubject(secondUserId).setIssuer(origin).setAudience(origin).setIssuedAt().setExpirationTime("15m").sign(privateKey);
      const first = await authenticated.forToken(firstToken);
      const second = await authenticated.forToken(secondToken);
      const task = await first.tasks.create({ name: "Authenticated private task" });
      expect(task.userId).toBe(firstUserId);
      expect(await second.tasks.list()).toEqual([]);
      await expect(second.tasks.get(task.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(authenticated.forToken("forged-token")).rejects.toBeInstanceOf(AuthenticationError);
    } finally {
      vi.unstubAllGlobals();
      await authenticated.close();
    }
  });

  it("isolates tasks, tags, and manual order while allowing the same tag name per user", async () => {
    const other = application.forUser(secondUserId);
    const firstTag = await app.tags.create({ name: "Work" });
    const secondTag = await other.tags.create({ name: "Work" });
    const firstTask = await app.tasks.create({ name: "Private", tagIds: [firstTag.id] });
    const secondTask = await other.tasks.create({ name: "Other private", tagIds: [secondTag.id] });
    expect(firstTask.userId).toBe(firstUserId);
    expect(secondTask.userId).toBe(secondUserId);
    expect(firstTask.orderKey).toBe(secondTask.orderKey);
    expect((await app.tasks.list()).map((task) => task.id)).toEqual([firstTask.id]);
    expect((await other.tasks.list()).map((task) => task.id)).toEqual([secondTask.id]);
    expect((await app.tags.list()).map((tag) => tag.id)).toEqual([firstTag.id]);
    expect(await app.tasks.list({ tagIds: [secondTag.id] })).toEqual([]);
  });

  it("treats another user's IDs as missing across all task and tag operations", async () => {
    const other = application.forUser(secondUserId);
    const tag = await other.tags.create({ name: "Private" });
    const task = await other.tasks.create({ name: "Private", tagIds: [tag.id] });
    const own = await app.tasks.create({ name: "Own" });
    await expect(app.tasks.get(task.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tasks.update(task.id, { name: "Stolen" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tasks.setCompleted(task.id, true)).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tasks.delete(task.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tasks.move(task.id, { placement: "first" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tasks.move(own.id, { placement: "before", targetId: task.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tags.get(tag.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tags.update(tag.id, { name: "Stolen" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tags.delete(tag.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tasks.attachTag(own.id, tag.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tasks.detachTag(own.id, tag.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tasks.attachTag(task.id, tag.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.tasks.create({ name: "Invalid", tagIds: [tag.id] })).rejects.toBeInstanceOf(NotFoundError);
    expect(await app.tasks.list()).toHaveLength(1);
    expect(await other.tasks.get(task.id)).toMatchObject({ name: "Private", completedAt: null });
  });

  it("enforces RLS even for raw SQL without application filters", async () => {
    const other = application.forUser(secondUserId);
    const own = await app.tasks.create({ name: "Own" });
    const hidden = await other.tasks.create({ name: "Hidden" });
    await asRuntimeUser(firstUserId, async (client) => {
      expect((await client.query("SELECT id FROM tasks")).rows).toEqual([{ id: own.id }]);
      expect((await client.query("UPDATE tasks SET name = 'Stolen' WHERE id = $1", [hidden.id])).rowCount).toBe(0);
      expect((await client.query("DELETE FROM tasks WHERE id = $1", [hidden.id])).rowCount).toBe(0);
    });
    await expect(asRuntimeUser(firstUserId, (client) => client.query(
      "INSERT INTO tasks (user_id, name, order_key) VALUES ($1, 'Forged', 'a1')", [secondUserId],
    ))).rejects.toMatchObject({ code: "42501" });
    await expect(asRuntimeUser(firstUserId, (client) => client.query(
      "UPDATE tasks SET user_id = $1 WHERE id = $2", [secondUserId, own.id],
    ))).rejects.toMatchObject({ code: "42501" });
  });

  it("denies access with no tenant context and resets context after commit and rollback", async () => {
    await app.tasks.create({ name: "Private" });
    await app.tags.create({ name: "Private" });
    await asRuntimeUser(firstUserId, (client) => client.query("SELECT * FROM tasks"));
    for (const table of ["tasks", "tags", "task_tags"]) {
      expect((await runtimePool.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    }
    await expect(runtimePool.query(
      "INSERT INTO tags (user_id, name) VALUES ($1, 'No context')", [firstUserId],
    )).rejects.toMatchObject({ code: "42501" });
    await expect(asRuntimeUser(firstUserId, async () => { throw new Error("rollback"); })).rejects.toThrow("rollback");
    expect((await runtimePool.query("SELECT * FROM tasks")).rows).toEqual([]);
    expect((await runtimePool.query("SELECT nullif(current_setting('app.user_id', true), '') AS user_id")).rows[0].user_id).toBeNull();
  });

  it("prevents cross-user relationships at the foreign-key level", async () => {
    const other = application.forUser(secondUserId);
    const ownTag = await app.tags.create({ name: "Own" });
    const ownTask = await app.tasks.create({ name: "Own" });
    const otherTag = await other.tags.create({ name: "Other" });
    const otherTask = await other.tasks.create({ name: "Other" });
    for (const [taskId, tagId] of [[ownTask.id, otherTag.id], [otherTask.id, ownTag.id]]) {
      await expect(asRuntimeUser(firstUserId, (client) => client.query(
        "INSERT INTO task_tags (task_id, tag_id) VALUES ($1, $2)", [taskId, tagId],
      ))).rejects.toMatchObject({ code: "23503" });
    }
  });

  it("protects tag and relationship rows with USING and WITH CHECK policies", async () => {
    const other = application.forUser(secondUserId);
    const tag = await other.tags.create({ name: "Other" });
    const task = await other.tasks.create({ name: "Other", tagIds: [tag.id] });
    await asRuntimeUser(firstUserId, async (client) => {
      expect((await client.query("SELECT * FROM tags")).rows).toEqual([]);
      expect((await client.query("SELECT * FROM task_tags")).rows).toEqual([]);
      expect((await client.query("UPDATE tags SET name = 'Stolen' WHERE id = $1", [tag.id])).rowCount).toBe(0);
      expect((await client.query("DELETE FROM task_tags WHERE task_id = $1", [task.id])).rowCount).toBe(0);
    });
    await expect(asRuntimeUser(firstUserId, (client) => client.query(
      "INSERT INTO tags (user_id, name) VALUES ($1, 'Forged')", [secondUserId],
    ))).rejects.toMatchObject({ code: "42501" });
    await expect(asRuntimeUser(firstUserId, (client) => client.query(
      "INSERT INTO task_tags (user_id, task_id, tag_id) VALUES ($1, $2, $3)", [secondUserId, task.id, tag.id],
    ))).rejects.toMatchObject({ code: "42501" });
  });

  it("does not leak tenant context when users share a small connection pool concurrently", async () => {
    const other = application.forUser(secondUserId);
    await Promise.all(Array.from({ length: 12 }, async (_, index) => {
      await Promise.all([
        app.tasks.create({ name: `First ${index}` }),
        other.tasks.create({ name: `Second ${index}` }),
      ]);
    }));
    const [first, second] = await Promise.all([app.tasks.list(), other.tasks.list()]);
    expect(first).toHaveLength(12);
    expect(second).toHaveLength(12);
    expect(first.every((task) => task.userId === firstUserId)).toBe(true);
    expect(second.every((task) => task.userId === secondUserId)).toBe(true);
    await other.tasks.move(second[11]!.id, { placement: "first" });
    expect((await app.tasks.list()).map((task) => task.id)).toEqual(first.map((task) => task.id));
  });

  it("rejects unsafe runtime credentials and ownership fields supplied as task input", async () => {
    const unsafe = createTodoApp(connection);
    try {
      await expect(unsafe.forUser(firstUserId).tasks.list()).rejects.toThrow("Unsafe runtime database role");
    } finally {
      await unsafe.close();
    }
    expect(() => application.forUser("")).toThrow(ValidationError);
    expect(() => application.forUser(" user ")).toThrow(ValidationError);
    await expect(app.tasks.create({ name: "Forged", userId: secondUserId } as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(application.forToken("invalid")).rejects.toThrow("Configure authUrl");
  });

  it("uses a non-owner runtime role without bypass privileges or access to authentication data", async () => {
    const result = await runtimePool.query("SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user");
    expect(result.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false });
    const tables = await pool.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid IN ('tasks'::regclass, 'tags'::regclass, 'task_tags'::regclass)");
    expect(tables.rows).toHaveLength(3);
    expect(tables.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    await expect(runtimePool.query("ALTER TABLE tasks DISABLE ROW LEVEL SECURITY")).rejects.toMatchObject({ code: "42501" });
    await expect(runtimePool.query("TRUNCATE tasks CASCADE")).rejects.toMatchObject({ code: "42501" });
  });
});
