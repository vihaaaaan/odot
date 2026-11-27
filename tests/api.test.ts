import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTodoApp, migrateDatabase } from "../src/index.js";
import { createApi } from "../src/api/index.js";

const directory = mkdtempSync(join(tmpdir(), "odot-api-"));
const password = randomUUID();
const connection = { host: directory, user: "odot_test", password, database: "postgres" };
const logs: string[] = [];
const cluster = new EmbeddedPostgres({
  databaseDir: join(directory, "data"), user: connection.user, password,
  authMethod: "scram-sha-256", persistent: false, autoRehydrateSymlinks: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: ["-F", "-k", directory, "-h", ""],
  onLog: (message) => { logs.push(message); },
  onError: (message) => { logs.push(String(message)); },
});
let running = false;
let pool: Pool;
let application: ReturnType<typeof createTodoApp>;
let api: ReturnType<typeof createApi>;
let firstToken: string;
let secondToken: string;
const origin = "https://api-auth.example.test";

beforeAll(async () => {
  await cluster.initialise();
  await cluster.start();
  running = true;
  await migrateDatabase(connection);
  pool = new Pool(connection);
  const runtimePassword = randomUUID();
  await pool.query(`CREATE ROLE odot_app LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS NOINHERIT`);
  await pool.query("GRANT USAGE ON SCHEMA public TO odot_app");
  await pool.query("GRANT SELECT, INSERT, UPDATE, DELETE ON tasks, tags, task_tags TO odot_app");
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const jwk = { ...await exportJWK(publicKey), kid: "api-key", alg: "EdDSA", use: "sig" };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }))));
  const token = (subject: string) => new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "api-key" })
    .setSubject(subject).setIssuer(origin).setAudience(origin).setIssuedAt().setExpirationTime("15m").sign(privateKey);
  firstToken = await token("first-api-user");
  secondToken = await token("second-api-user");
  application = createTodoApp({ ...connection, user: "odot_app", password: runtimePassword, max: 2 }, { authUrl: `${origin}/auth` });
  api = createApi(application, { allowedOrigins: ["https://extension.example.test"] });
}, 30_000);

beforeEach(async () => { await pool.query("TRUNCATE task_tags, tasks, tags"); });

afterAll(async () => {
  vi.unstubAllGlobals();
  try {
    await application?.close();
    await pool?.end();
  } finally {
    if (running) await cluster.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

function request(path: string, method = "GET", body?: unknown, token = firstToken) {
  return api.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createTask(fields: Record<string, unknown> = {}) {
  const response = await request("/v1/tasks", "POST", { name: "Task", ...fields });
  expect(response.status).toBe(201);
  return response.json();
}

async function createTag(name = "Tag") {
  const response = await request("/v1/tags", "POST", { name, description: "Optional description" });
  expect(response.status).toBe(201);
  return response.json();
}

describe("HTTP API", () => {
  it("publishes health and OpenAPI without authentication, but never public user data", async () => {
    expect(await (await api.request("/health")).json()).toEqual({ status: "ok" });
    const response = await api.request("/openapi.json");
    expect(response.status).toBe(200);
    const document = await response.json();
    expect(document.openapi).toBe("3.1.0");
    expect(Object.values(document.paths).flatMap((operations) => Object.values(operations as object))).toHaveLength(14);
    expect(document.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    expect(document.paths["/v1/tasks"].post.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths["/v1/tasks"].post.requestBody.required).toBe(true);
    expect(document.paths["/v1/tasks"].post.responses[201].content["application/json"].schema).toBeDefined();
    expect(document.paths["/v1/tasks/{id}/move"].post.requestBody.content["application/json"].schema).toBeDefined();
  });

  it("requires bearer authentication before reading or validating user requests", async () => {
    for (const authorization of [undefined, "", "Basic token", "Bearer forged", `Bearer ${firstToken}, ${secondToken}`]) {
      const response = await api.request("/v1/tasks", { headers: authorization === undefined ? {} : { Authorization: authorization } });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
    }
    expect((await api.request("/v1/tasks", { method: "POST", body: "invalid" })).status).toBe(401);
    expect((await api.request("/v1/tasks", { headers: { Authorization: `bearer ${firstToken}` } })).status).toBe(200);
  });

  it("creates, reads, updates, completes, reopens, and deletes tasks", async () => {
    const response = await request("/v1/tasks", "POST", { name: "  Task  ", dueDate: "2026-12-01" });
    expect(response.status).toBe(201);
    const task = await response.json();
    expect(response.headers.get("location")).toBe(`/v1/tasks/${task.id}`);
    expect(task).toMatchObject({ name: "Task", dueDate: "2026-12-01", important: false, description: null, tags: [] });
    expect(task.userId).toBeUndefined();
    expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
    expect(await (await request(`/v1/tasks/${task.id}`)).json()).toEqual(task);
    expect(await (await request(`/v1/tasks/${task.id}`, "PATCH", { important: true, description: "Details", dueDate: null })).json())
      .toMatchObject({ important: true, description: "Details", dueDate: null });
    const completed = await (await request(`/v1/tasks/${task.id}/completion`, "PUT", { completed: true })).json();
    expect(completed.completedAt).not.toBeNull();
    expect(completed.orderKey).toBe(task.orderKey);
    expect(await (await request("/v1/tasks")).json()).toEqual([]);
    expect(await (await request(`/v1/tasks/${task.id}/completion`, "PUT", { completed: false })).json()).toMatchObject({ completedAt: null });
    expect((await request(`/v1/tasks/${task.id}`, "DELETE")).status).toBe(204);
    expect((await request(`/v1/tasks/${task.id}`)).status).toBe(404);
  });

  it("manages tags and task assignments, including idempotent attachment and cascade cleanup", async () => {
    const tag = await createTag();
    expect(tag.userId).toBeUndefined();
    expect(await (await request(`/v1/tags/${tag.id}`)).json()).toEqual(tag);
    expect(await (await request("/v1/tags")).json()).toEqual([tag]);
    const task = await createTask({ tagIds: [tag.id] });
    expect(task.tags).toEqual([tag]);
    expect((await request(`/v1/tasks/${task.id}/tags/${tag.id}`, "DELETE")).status).toBe(204);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(`/v1/tasks/${task.id}/tags/${tag.id}`, "PUT");
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    }
    expect((await (await request(`/v1/tasks/${task.id}`)).json()).tags).toHaveLength(1);
    const update = await request(`/v1/tags/${tag.id}`, "PATCH", { name: "Renamed", description: null });
    expect(await update.json()).toMatchObject({ name: "Renamed", description: null });
    expect((await request(`/v1/tags/${tag.id}`, "DELETE")).status).toBe(204);
    expect((await (await request(`/v1/tasks/${task.id}`)).json()).tags).toEqual([]);
    expect((await request(`/v1/tags/${tag.id}`)).status).toBe(404);
  });

  it("supports manual movement and independent due-date/importance sorting", async () => {
    const first = await createTask({ name: "Undated" });
    const second = await createTask({ name: "Later", dueDate: "2026-12-20", important: true });
    const third = await createTask({ name: "Sooner", dueDate: "2026-12-01" });
    const ids = async (query = "") => (await (await request(`/v1/tasks${query}`)).json()).map((task: { id: string }) => task.id);
    expect(await ids("?sort=due_date")).toEqual([third.id, second.id, first.id]);
    expect(await ids("?sort=important")).toEqual([second.id, first.id, third.id]);
    expect(await ids()).toEqual([first.id, second.id, third.id]);
    for (const [placement, targetId, expected] of [
      ["first", undefined, [third.id, first.id, second.id]],
      ["last", undefined, [first.id, second.id, third.id]],
      ["before", second.id, [first.id, third.id, second.id]],
      ["after", second.id, [first.id, second.id, third.id]],
    ] as const) {
      expect((await request(`/v1/tasks/${third.id}/move`, "POST", { placement, ...(targetId ? { targetId } : {}) })).status).toBe(200);
      expect(await ids()).toEqual(expected);
    }
  });

  it("parses HTTP filters without truthy false strings, and accepts one or multiple tagIds", async () => {
    const firstTag = await createTag("First");
    const secondTag = await createTag("Second");
    const first = await createTask({ important: false, tagIds: [firstTag.id, secondTag.id] });
    const second = await createTask({ important: true, tagIds: [firstTag.id] });
    await request(`/v1/tasks/${second.id}/completion`, "PUT", { completed: true });
    for (const query of ["important=false", `tagIds=${firstTag.id}&tagIds=${secondTag.id}`, `tagIds=${secondTag.id}`]) {
      expect((await (await request(`/v1/tasks?${query}`)).json()).map((task: { id: string }) => task.id)).toEqual([first.id]);
    }
    expect((await (await request("/v1/tasks?status=completed&important=true")).json()).map((task: { id: string }) => task.id)).toEqual([second.id]);
    expect((await (await request("/v1/tasks?status=all&limit=1&offset=1")).json()).map((task: { id: string }) => task.id)).toEqual([second.id]);
  });

  it("rejects bad fields, query strings, IDs, dates, and owner spoofing", async () => {
    for (const body of [{ name: "" }, { name: "Bad", dueDate: "2026-02-30" }, { name: "Spoof", userId: "second-api-user" }]) {
      const response = await request("/v1/tasks", "POST", body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatchObject({ code: "VALIDATION_ERROR", details: expect.any(Array) });
    }
    for (const query of ["important=no", "limit=0", "limit=501", "limit=1.5", "limit=1e2", "offset=-1", "sort=unknown", "unknown=1", "tagIds=bad"]) {
      expect((await request(`/v1/tasks?${query}`)).status, query).toBe(400);
    }
    expect((await request("/v1/tasks/not-a-uuid")).status).toBe(400);
    const task = await createTask();
    expect((await request(`/v1/tasks/${task.id}`, "PATCH", {})).status).toBe(400);
    expect((await request(`/v1/tasks/${task.id}`, "PATCH", { orderKey: "forged" })).status).toBe(400);
    expect((await request(`/v1/tasks/${task.id}/completion`, "PUT", { completed: "false" })).status).toBe(400);
    expect((await request(`/v1/tasks/${task.id}/move`, "POST", { placement: "before", targetId: task.id })).status).toBe(400);
  });

  it("returns consistent malformed JSON, media type, oversized body, and conflict errors", async () => {
    const send = (body: string, contentType: string) => api.request("/v1/tasks", {
      method: "POST", headers: { Authorization: `Bearer ${firstToken}`, "Content-Type": contentType }, body,
    });
    const malformed = await send("{", "application/json");
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("BAD_REQUEST");
    expect((await send("{}", "text/plain")).status).toBe(415);
    expect((await send(JSON.stringify({ name: "Large", description: "x".repeat(256 * 1024) }), "application/json")).status).toBe(413);
    await createTag("Unique");
    const conflict = await request("/v1/tags", "POST", { name: "unique" });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("CONFLICT");
  });

  it("isolates authenticated users across HTTP reads, writes, relationships, and reordering", async () => {
    const tag = await createTag("Private");
    const task = await createTask({ tagIds: [tag.id] });
    const other = await (await request("/v1/tasks", "POST", { name: "Other" }, secondToken)).json();
    expect(await (await request("/v1/tags", "GET", undefined, secondToken)).json()).toEqual([]);
    expect((await (await request("/v1/tasks", "GET", undefined, secondToken)).json()).map((entry: { id: string }) => entry.id)).toEqual([other.id]);
    for (const [path, method, body] of [
      [`/v1/tasks/${task.id}`, "GET", undefined],
      [`/v1/tasks/${task.id}`, "PATCH", { name: "Stolen" }],
      [`/v1/tasks/${task.id}`, "DELETE", undefined],
      [`/v1/tasks/${task.id}/completion`, "PUT", { completed: true }],
      [`/v1/tasks/${other.id}/move`, "POST", { placement: "before", targetId: task.id }],
      [`/v1/tasks/${other.id}/tags/${tag.id}`, "PUT", undefined],
      [`/v1/tags/${tag.id}`, "GET", undefined],
      [`/v1/tags/${tag.id}`, "PATCH", { name: "Stolen" }],
      [`/v1/tags/${tag.id}`, "DELETE", undefined],
    ] as const) expect((await request(path, method, body, secondToken)).status).toBe(404);
    expect((await (await request(`/v1/tasks/${task.id}`)).json()).name).toBe("Task");
  });

  it("permits only configured browser origins without treating CORS as authentication", async () => {
    const preflight = (originHeader: string) => api.request("/v1/tasks", {
      method: "OPTIONS", headers: { Origin: originHeader, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
    });
    const allowed = await preflight("https://extension.example.test");
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://extension.example.test");
    expect((await preflight("https://other.example.test")).headers.get("access-control-allow-origin")).toBeNull();
    expect((await api.request("/v1/tasks", { headers: { Origin: "https://extension.example.test" } })).status).toBe(401);
    expect((await createApi(application).request("/v1/tasks", { method: "OPTIONS" })).status).toBe(401);
    expect(() => createApi(application, { allowedOrigins: ["*"] })).toThrow("explicit allowed origins");
  });

  it("hides unexpected errors and returns JSON for unknown routes", async () => {
    const onUnexpectedError = vi.fn();
    const broken = createApi({ forToken: async () => { throw new Error("secret database details"); } }, { onUnexpectedError });
    const response = await broken.request("/v1/tasks", { headers: { Authorization: "Bearer token" } });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
    expect(onUnexpectedError).toHaveBeenCalledOnce();
    const missing = await request("/v1/unknown");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("NOT_FOUND");
  });
});
