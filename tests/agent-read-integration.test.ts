import { describe, expect, test } from "bun:test";
import { runAgentCommand } from "../src/agent-cli";
import { parseArgs } from "../src/args";
import { createClient } from "../src/sdk";

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
});
