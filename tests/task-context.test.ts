import { describe, expect, test } from "bun:test";
import { runAgentCommand } from "../src/agent-cli";
import { parseArgs } from "../src/args";
import { MemoryOperationRepository } from "../src/operations/memory-repository";
import { createClient } from "../src/sdk";

describe("compact task context", () => {
  test("links task structure, bounded relations, and attachment metadata without URLs", async () => {
    const requests: URL[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(url);
        if (url.pathname === "/api/1.0/tasks/5000") {
          return Response.json({
            data: {
              gid: "5000",
              name: "Implement resolver",
              completed: false,
              modified_at: "2026-07-23T10:00:00.000Z",
              num_subtasks: 2,
              workspace: { gid: "1000", name: "Engineering" },
              assignee: { gid: "1100", name: "Developer" },
              memberships: [{
                project: { gid: "2000", name: "Platform" },
                section: { gid: "2100", name: "In progress" },
              }],
              custom_fields: [{
                gid: "3000",
                name: "Release",
                resource_subtype: "text",
                representation_type: "text",
                display_value: "SECRET_FIELD_VALUE",
              }],
              notes: "SECRET_TASK_NOTES",
            },
          });
        }
        if (url.pathname === "/api/1.0/tasks/5000/subtasks") {
          return Response.json({
            data: [{
              gid: "5100",
              name: "Add parser",
              completed: true,
              parent: { gid: "5000" },
            }],
            next_page: { offset: "more-subtasks" },
          });
        }
        if (url.pathname === "/api/1.0/tasks/5000/dependencies") {
          return Response.json({
            data: [{ gid: "5200", name: "API contract", completed: true }],
            next_page: null,
          });
        }
        if (url.pathname === "/api/1.0/tasks/5000/dependents") {
          return Response.json({ data: [], next_page: null });
        }
        if (url.pathname === "/api/1.0/attachments") {
          return Response.json({
            data: [{
              gid: "5300",
              name: "design.pdf",
              resource_subtype: "asana",
              created_at: "2026-07-22T10:00:00.000Z",
              size: 1234,
              parent: { gid: "5000" },
              download_url: "https://secret.invalid/download",
              permanent_url: "https://app.asana.com/private",
              view_url: "https://secret.invalid/view",
            }],
            next_page: null,
          });
        }
        return Response.json({ errors: [{ message: "unexpected" }] }, { status: 404 });
      },
    });

    try {
      const client = createClient("TASK_CONTEXT_TOKEN");
      client.basePath = new URL("/api/1.0", server.url).toString().replace(/\/$/, "");
      const runtime = { operations: new MemoryOperationRepository() };
      const metadata = await runAgentCommand(client, parseArgs([
        "agent",
        "context",
        "--task",
        "5000",
        "--max-related-results",
        "2",
      ]), runtime);
      expect(metadata).toMatchObject({
        operation: "task.context.get",
        data: {
          task: {
            gid: "5000",
            name: "Implement resolver",
            workspace: { gid: "1000", name: "Engineering" },
            memberships: [{
              project: { gid: "2000", name: "Platform" },
              section: { gid: "2100", name: "In progress" },
            }],
            custom_fields: [{
              gid: "3000",
              name: "Release",
              resource_subtype: "text",
            }],
          },
          subtasks: [{ gid: "5100", name: "Add parser", completed: true }],
          dependencies: [{ gid: "5200", name: "API contract", completed: true }],
          dependents: [],
          attachments: [{
            gid: "5300",
            name: "design.pdf",
            resource_subtype: "asana",
            size: 1234,
          }],
          content_profile: "metadata",
          meta: {
            task_gid: "5000",
            max_related_results: 2,
            related_count: 3,
            truncated: true,
            partial: false,
            sources: {
              subtasks: { count: 1, has_more: true, truncated: true, status: "ok" },
              dependencies: { count: 1, has_more: false, truncated: false, status: "ok" },
              dependents: { count: 0, has_more: false, truncated: false, status: "ok" },
              attachments: { count: 1, has_more: false, truncated: false, status: "ok" },
            },
          },
        },
      });
      const serialized = JSON.stringify(metadata);
      expect(serialized).not.toContain("SECRET_FIELD_VALUE");
      expect(serialized).not.toContain("SECRET_TASK_NOTES");
      expect(serialized).not.toContain("secret.invalid");
      expect(serialized).not.toContain("download_url");
      expect(serialized).not.toContain("permanent_url");
      expect(serialized).not.toContain("view_url");

      const taskRequests = requests.filter((url) => url.pathname.endsWith("/tasks/5000"));
      expect(taskRequests).toHaveLength(1);
      const defaultFields = taskRequests[0]?.searchParams.get("opt_fields") ?? "";
      expect(defaultFields).not.toContain("display_value");
      expect(defaultFields.split(",")).not.toContain("notes");
      const attachmentRequest = requests.find((url) => url.pathname.endsWith("/attachments"));
      expect(attachmentRequest?.searchParams.get("parent")).toBe("5000");
      expect(attachmentRequest?.searchParams.get("opt_fields")).not.toContain("url");
    } finally {
      server.stop(true);
    }
  });

  test("returns selected notes and field values under one UTF-8 budget", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/1.0/tasks/5000") {
          return Response.json({
            data: {
              gid: "5000",
              name: "Task",
              workspace: { gid: "1000" },
              memberships: [],
              custom_fields: [{
                gid: "3000",
                name: "F",
                display_value: "12345",
              }],
              notes: "abcdef",
            },
          });
        }
        return Response.json({ data: [], next_page: null });
      },
    });
    try {
      const client = createClient("TASK_CONTEXT_BUDGET_TOKEN");
      client.basePath = new URL("/api/1.0", server.url).toString().replace(/\/$/, "");
      const result = await runAgentCommand(client, parseArgs([
        "agent",
        "context",
        "--task",
        "5000",
        "--include",
        "field-values",
        "--include",
        "notes",
        "--max-content-bytes",
        "10",
      ]), { operations: new MemoryOperationRepository() });
      expect(result).toMatchObject({
        data: {
          task: {
            gid: "5000",
            name: "Task",
            custom_fields: [{ gid: "3000", name: "F", display_value: "12345" }],
            notes: "",
          },
          content_profile: "selected-untrusted",
          content_budget: {
            max_bytes: 10,
            emitted_bytes: 10,
            truncated: true,
            truncated_values: 1,
            truncated_paths: ["task.notes"],
          },
        },
      });
    } finally {
      server.stop(true);
    }
  });

  test("reports premium-only relation sources without hiding other failures", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/1.0/tasks/5000") {
          return Response.json({
            data: {
              gid: "5000",
              workspace: { gid: "1000" },
              memberships: [],
              custom_fields: [],
            },
          });
        }
        if (url.pathname.endsWith("/dependencies")) {
          return Response.json(
            { errors: [{ message: "Premium required" }] },
            { status: 402 },
          );
        }
        return Response.json({ data: [], next_page: null });
      },
    });
    try {
      const client = createClient("TASK_CONTEXT_PARTIAL_TOKEN");
      client.basePath = new URL("/api/1.0", server.url).toString().replace(/\/$/, "");
      const result = await runAgentCommand(client, parseArgs([
        "agent",
        "context",
        "--task",
        "5000",
      ]), { operations: new MemoryOperationRepository() });
      expect(result).toMatchObject({
        data: {
          dependencies: [],
          meta: {
            partial: true,
            truncated: true,
            sources: {
              dependencies: {
                status: "premium-required",
                count: 0,
                truncated: true,
                has_more: false,
              },
            },
          },
        },
      });
    } finally {
      server.stop(true);
    }
  });
});
