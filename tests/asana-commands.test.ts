import { describe, expect, test } from "bun:test";
import { getTask, getTaskComments, getMyTasks, searchTasks, updateTask, addTaskComment } from "../src/asana-commands";
import { createClient, invokeApiMethod, normalizeSdkResult } from "../src/sdk";

describe("Asana operations with SDK 3.4.0", () => {
  test("preserves task reads, filters and writes across the HTTP boundary", async () => {
    const requests: Array<{ method: string; path: string; query: Record<string, string>; body: unknown }> = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const body: unknown = request.method === "POST" || request.method === "PUT" ? await request.json() : null;
        requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
        if (url.pathname.endsWith("/stories") && request.method === "GET") {
          return Response.json({ data: [{ gid: "s1", type: "comment", text: "Comment" }, { gid: "s2", type: "system" }], next_page: null });
        }
        if (url.pathname.endsWith("/tasks") || url.pathname.endsWith("/search")) {
          return Response.json({ data: [{ gid: "123", name: "Task", completed: false }], next_page: null });
        }
        return Response.json({ data: { gid: "123", name: "Task" } });
      },
    });
    try {
      const client = createClient("LOCAL_HTTP_TEST_TOKEN");
      client.basePath = new URL("api/1.0", server.url).toString();
      expect(await getTask(client, "123", "gid,name")).toMatchObject({ data: { gid: "123" } });
      expect(await getMyTasks(client, { workspace: "42", all: true, maxResults: 10, completed: "false", limit: 10, fields: "gid,name" })).toMatchObject({ data: [{ gid: "123" }] });
      expect(await getTaskComments(client, "123", { all: true, maxResults: 10, limit: 10, fields: "gid,type,text", allStories: false })).toMatchObject({ data: [{ gid: "s1" }] });
      await searchTasks(client, "release", { workspace: "42", all: false, maxResults: 10, fields: "gid", mine: true, completed: false });
      await updateTask(client, "123", { completed: true }, "gid");
      await addTaskComment(client, "123", { text: "Ready" }, "gid,text");
      expect(requests[1]?.query).toMatchObject({ workspace: "42", assignee: "me", completed_since: "now" });
      expect(requests[3]?.query).toMatchObject({ text: "release", "assignee.any": "me", completed: "false" });
      expect(requests[4]).toMatchObject({ method: "PUT", path: "/api/1.0/tasks/123", body: { data: { completed: true } } });
      expect(requests[5]).toMatchObject({ method: "POST", path: "/api/1.0/tasks/123/stories", body: { data: { text: "Ready" } } });
    } finally { server.stop(true); }
  });
  test("dispatches new notification and table methods with SDK argument order", async () => {
    const paths: string[] = [];
    const bodies: unknown[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        paths.push(new URL(request.url).pathname);
        if (request.method === "POST") bodies.push(await request.json());
        return Response.json({ data: request.method === "GET" ? [{ gid: "1" }] : { gid: "2" }, next_page: null });
      },
    });
    try {
      const client = createClient("LOCAL_NEW_API_TEST_TOKEN");
      client.basePath = new URL("api/1.0", server.url).toString();
      const notifications = await invokeApiMethod(client, "NotificationsApi", "getNotificationsForUser", ["me", "42", { limit: 20 }]);
      expect(normalizeSdkResult(notifications)).toMatchObject({ data: [{ gid: "1" }] });
      await invokeApiMethod(client, "TablesApi", "getTablesForWorkspace", ["42", { limit: 10 }]);
      await invokeApiMethod(client, "RecordsApi", "createRecord", [{ data: { name: "Record" } }]);
      expect(paths).toEqual(["/api/1.0/users/me/notifications", "/api/1.0/workspaces/42/tables", "/api/1.0/records"]);
      expect(bodies).toEqual([{ data: { name: "Record" } }]);
    } finally { server.stop(true); }
  });
});
