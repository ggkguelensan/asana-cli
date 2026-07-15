import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAgentCommand } from "../src/agent-cli";
import { parseArgs } from "../src/args";
import { createClient } from "../src/sdk";
import { secureAgentEnvelope } from "../src/security";

async function withAgentStdin<Result>(
  input: unknown,
  action: () => Promise<Result>,
): Promise<Result> {
  const runtime = Bun as unknown as { stdin: { text(): Promise<string> } };
  const original = runtime.stdin;
  runtime.stdin = { text: async () => JSON.stringify(input) };
  try {
    return await action();
  } finally {
    runtime.stdin = original;
  }
}

describe("agent read integration", () => {
  test("direct flags and stdin share one budget across two comment pages", async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(`${url.pathname}?${url.searchParams.toString()}`);
        const secondPage = url.searchParams.get("offset") === "second";
        return Response.json({
          data: [{
            gid: secondPage ? "2" : "1",
            type: "comment",
            resource_subtype: "comment_added",
            text: "😀😀",
            unknown_sdk_key: "drop",
          }],
          next_page: secondPage ? null : { offset: "second" },
        });
      },
    });
    try {
      const client = createClient("TWO_PAGE_CONTENT_BUDGET_TOKEN");
      client.basePath = new URL("/api/1.0", server.url).toString().replace(/\/$/, "");
      const direct = await runAgentCommand(client, parseArgs([
        "agent",
        "list-comments",
        "--task",
        "123",
        "--limit",
        "1",
        "--paginate",
        "--max-results",
        "2",
        "--max-content-bytes",
        "9",
      ]));
      const stdin = await withAgentStdin({
        task_gid: "123",
        limit: 1,
        paginate: true,
        max_results: 2,
        max_content_bytes: 9,
      }, () => runAgentCommand(client, parseArgs([
        "agent",
        "list-comments",
        "--input",
        "-",
      ])));
      expect(direct).toEqual(stdin);
      expect(direct).toMatchObject({
        operation: "task.comments",
        data: {
          data: [{ gid: "1", text: "😀😀" }, { gid: "2", text: "" }],
          content_budget: {
            max_bytes: 9,
            emitted_bytes: 8,
            truncated: true,
            truncated_values: 1,
            truncated_paths: ["data[1].text"],
          },
        },
      });
      expect(requests).toHaveLength(4);
      expect(requests.filter((request) => request.includes("offset=second"))).toHaveLength(2);
    } finally {
      server.stop(true);
    }
  });

  test("get/search/find flags equal stdin and two find sources obey one result cap", async () => {
    const requests: URL[] = [];
    const longNotes = "x".repeat(9_001);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(url);
        if (url.pathname === "/api/1.0/tasks/123") {
          return Response.json({
            data: {
              gid: "123",
              name: "PR-1 task",
              notes: longNotes,
              custom_fields: [{
                gid: "999",
                name: "Git reference",
                display_value: "PR-1",
                text_value: "PR-1",
              }],
              unknown_sdk_key: "drop",
            },
          });
        }
        if (url.pathname === "/api/1.0/workspaces/1200/tasks/search") {
          const customFieldSearch = [...url.searchParams.keys()]
            .some((key) => key.startsWith("custom_fields."));
          const base = customFieldSearch ? 20 : 10;
          return Response.json({
            data: [0, 1].map((offset) => ({
              gid: String(base + offset),
              name: `PR-1 task ${base + offset}`,
              notes: `PR-1 source ${customFieldSearch ? "field" : "text"}`,
            })),
            next_page: null,
          });
        }
        return Response.json({ errors: [{ message: "unexpected endpoint" }] }, { status: 404 });
      },
    });
    try {
      const client = createClient("READ_EQUIVALENCE_TOKEN");
      client.basePath = new URL("/api/1.0", server.url).toString().replace(/\/$/, "");

      const directTask = await runAgentCommand(client, parseArgs([
        "agent",
        "get-task",
        "--task",
        "123",
        "--include",
        "notes",
        "--include",
        "custom_fields",
        "--max-content-bytes",
        "12000",
      ]));
      const stdinTask = await withAgentStdin({
        task_gid: "123",
        include: ["notes", "custom_fields"],
        max_content_bytes: 12_000,
      }, () => runAgentCommand(client, parseArgs(["agent", "get-task", "--input", "-"])));
      expect(directTask).toEqual(stdinTask);

      const taskRequests = requests.filter((url) => url.pathname.endsWith("/tasks/123"));
      expect(taskRequests).toHaveLength(2);
      for (const request of taskRequests) {
        const selectedFields = request.searchParams.get("opt_fields") ?? "";
        expect(selectedFields).toContain("custom_fields.text_value");
        expect(selectedFields).toContain("notes");
      }

      const secured = z.looseObject({
        result: z.looseObject({
          data: z.looseObject({ task: z.looseObject({ notes: z.string() }) }),
        }),
        _meta: z.looseObject({
          security: z.looseObject({ values_truncated: z.number().int() }),
        }),
      }).parse(secureAgentEnvelope(directTask));
      expect(secured.result.data.task.notes).toHaveLength(9_001);
      expect(secured._meta.security.values_truncated).toBe(0);

      const directSearch = await runAgentCommand(client, parseArgs([
        "agent",
        "search-tasks",
        "--query",
        "PR-1",
        "--workspace",
        "1200",
        "--max-results",
        "2",
      ]));
      const stdinSearch = await withAgentStdin({
        query: "PR-1",
        workspace_gid: "1200",
        max_results: 2,
      }, () => runAgentCommand(client, parseArgs(["agent", "search-tasks", "--input", "-"])));
      expect(directSearch).toEqual(stdinSearch);

      const directFind = await runAgentCommand(client, parseArgs([
        "agent",
        "find-git",
        "--query",
        "PR-1",
        "--workspace",
        "1200",
        "--field",
        "999",
        "--max-results",
        "2",
      ]));
      const stdinFind = await withAgentStdin({
        query: "PR-1",
        workspace_gid: "1200",
        field_gid: "999",
        max_results: 2,
      }, () => runAgentCommand(client, parseArgs(["agent", "find-git", "--input", "-"])));
      expect(directFind).toEqual(stdinFind);
      const findResult = z.looseObject({
        data: z.looseObject({
          data: z.array(z.looseObject({ gid: z.string() })),
          meta: z.looseObject({
            count: z.number().int(),
            truncated: z.boolean(),
          }),
        }),
      }).parse(directFind);
      expect(findResult.data.data.map((task) => task.gid)).toEqual(["10", "11"]);
      expect(findResult.data.meta).toMatchObject({ count: 2, truncated: true });
      const fieldSearches = requests.filter((url) => [...url.searchParams.keys()]
        .some((key) => key.startsWith("custom_fields.")));
      expect(fieldSearches).toHaveLength(2);
    } finally {
      server.stop(true);
    }
  });
});
