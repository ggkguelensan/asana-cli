import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAgentCommand } from "../src/agent-cli";
import { parseArgs } from "../src/args";
import { CliError } from "../src/errors";
import { MemoryOperationRepository } from "../src/operations/memory-repository";
import { createClient } from "../src/sdk";

const agentRuntime = { operations: new MemoryOperationRepository() };

async function errorCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return "none";
  } catch (error: unknown) {
    return z.instanceof(CliError).parse(error).code;
  }
}

describe("curated developer context reads", () => {
  test("projects, sections, memberships, fields, and users stay scoped and minimal", async () => {
    const requests: URL[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(url);
        if (url.pathname === "/api/1.0/projects") {
          const secondPage = url.searchParams.get("offset") === "next";
          return Response.json({
            data: [{
              gid: secondPage ? "2202" : "2201",
              name: secondPage ? "Second project" : "First project",
              archived: false,
              workspace: { gid: "1200", name: "drop workspace name" },
              notes: "drop project notes",
              custom_fields: [{ gid: "secret", display_value: "drop" }],
            }],
            next_page: secondPage ? null : { offset: "next" },
          });
        }
        if (url.pathname === "/api/1.0/projects/2201/sections") {
          return Response.json({
            data: [{
              gid: "3301",
              name: "Backlog",
              project: { gid: "2201", name: "drop project name" },
              created_at: "drop",
            }],
            next_page: { offset: "not-followed" },
          });
        }
        if (url.pathname === "/api/1.0/memberships") {
          return Response.json({
            data: [{
              gid: "5501",
              resource_subtype: "project_membership",
              parent: { gid: "2201", resource_type: "project", name: "drop parent name" },
              member: { gid: "4401", resource_type: "user", name: "Developer" },
              access_level: "editor",
              email: "drop@example.com",
            }],
            next_page: null,
          });
        }
        if (url.pathname === "/api/1.0/workspaces/1200/custom_fields") {
          return Response.json({
            data: [{
              gid: "6601",
              name: "Release train",
              resource_subtype: "enum",
              representation_type: "enum",
              is_global_to_workspace: true,
              enum_options: [{ gid: "7701", name: "must not appear by default" }],
              description: "drop description",
            }],
            next_page: null,
          });
        }
        if (url.pathname === "/api/1.0/custom_fields/6601") {
          return Response.json({
            data: {
              gid: "6601",
              name: "Release train",
              resource_subtype: "enum",
              representation_type: "enum",
              enum_options: [
                { gid: "7701", name: "Alpha", enabled: true, color: "green" },
                { gid: "7702", name: "😀😀", enabled: true, color: "blue" },
              ],
              description: "drop description",
            },
          });
        }
        if (
          url.pathname === "/api/1.0/workspaces/1200/users/developer%40example.com" ||
          url.pathname === "/api/1.0/workspaces/1200/users/developer@example.com"
        ) {
          return Response.json({
            data: {
              gid: "4401",
              resource_type: "user",
              name: "Developer",
              email: "developer@example.com",
              photo: { image_128x128: "https://example.invalid/private" },
              workspaces: [{ gid: "1200", name: "drop" }],
            },
          });
        }
        return Response.json({ errors: [{ message: "unexpected endpoint" }] }, { status: 404 });
      },
    });

    try {
      const client = createClient("CURATED_DEVELOPER_CONTEXT_TOKEN");
      client.basePath = new URL("/api/1.0", server.url).toString().replace(/\/$/, "");

      const projects = await runAgentCommand(client, parseArgs([
        "agent", "list-projects",
        "--workspace", "1200",
        "--limit", "1",
        "--paginate",
        "--max-results", "2",
      ]), agentRuntime);
      expect(projects).toMatchObject({
        operation: "projects.list",
        data: {
          data: [
            { gid: "2201", name: "First project", archived: false },
            { gid: "2202", name: "Second project", archived: false },
          ],
          meta: {
            workspace_gid: "1200",
            archived: false,
            count: 2,
            max_results: 2,
            truncated: false,
            has_more: false,
          },
        },
      });
      expect(JSON.stringify(projects)).not.toContain("drop project notes");
      expect(JSON.stringify(projects)).not.toContain("custom_fields");

      const sections = await runAgentCommand(client, parseArgs([
        "agent", "list-sections",
        "--project", "2201",
      ]), agentRuntime);
      expect(sections).toMatchObject({
        operation: "sections.list",
        data: {
          data: [{ gid: "3301", name: "Backlog" }],
          meta: {
            project_gid: "2201",
            count: 1,
            truncated: true,
            has_more: true,
          },
        },
      });

      const memberships = await runAgentCommand(client, parseArgs([
        "agent", "list-project-memberships",
        "--project", "2201",
        "--member", "4401",
      ]), agentRuntime);
      expect(memberships).toMatchObject({
        operation: "project-memberships.list",
        data: {
          data: [{
            gid: "5501",
            member: { gid: "4401", name: "Developer", resource_type: "user" },
            access_level: "editor",
          }],
          meta: { project_gid: "2201", member_gid: "4401", count: 1 },
        },
      });
      expect(JSON.stringify(memberships)).not.toContain("drop@example.com");

      const fields = await runAgentCommand(client, parseArgs([
        "agent", "list-custom-fields",
        "--workspace", "1200",
      ]), agentRuntime);
      expect(fields).toMatchObject({
        operation: "custom-fields.list",
        data: {
          data: [{
            gid: "6601",
            name: "Release train",
            resource_subtype: "enum",
          }],
          meta: { workspace_gid: "1200", values_included: false },
        },
      });
      expect(JSON.stringify(fields)).not.toContain("must not appear by default");
      expect(JSON.stringify(fields)).not.toContain("description");

      const fieldMetadata = await runAgentCommand(client, parseArgs([
        "agent", "get-custom-field",
        "--field", "6601",
      ]), agentRuntime);
      expect(fieldMetadata).toMatchObject({
        operation: "custom-field.get",
        data: {
          custom_field: { gid: "6601", name: "Release train" },
          values_profile: "metadata",
          content_budget: { emitted_bytes: 0, truncated: false },
        },
      });
      expect(JSON.stringify(fieldMetadata)).not.toContain("Alpha");

      const fieldValues = await runAgentCommand(client, parseArgs([
        "agent", "get-custom-field",
        "--field", "6601",
        "--include-values",
        "--max-content-bytes", "5",
      ]), agentRuntime);
      expect(fieldValues).toMatchObject({
        operation: "custom-field.get",
        data: {
          custom_field: {
            gid: "6601",
            enum_options: [
              { gid: "7701", name: "Alpha", enabled: true, color: "green" },
              { gid: "7702", name: "", enabled: true, color: "blue" },
            ],
          },
          values_profile: "selected-untrusted",
          content_budget: {
            max_bytes: 5,
            emitted_bytes: 5,
            truncated: true,
            truncated_values: 1,
          },
        },
      });

      const user = await runAgentCommand(client, parseArgs([
        "agent", "resolve-user",
        "--workspace", "1200",
        "--user", "developer@example.com",
      ]), agentRuntime);
      expect(user).toMatchObject({
        operation: "user.resolve",
        data: {
          workspace_gid: "1200",
          user: { gid: "4401", name: "Developer" },
        },
      });
      const userSerialized = JSON.stringify(user);
      expect(userSerialized).not.toContain("developer@example.com");
      expect(userSerialized).not.toContain("example.invalid");
      expect(userSerialized).not.toContain("workspaces");

      const projectRequests = requests.filter((url) => url.pathname.endsWith("/projects"));
      expect(projectRequests).toHaveLength(2);
      expect(projectRequests.every((url) => url.searchParams.get("workspace") === "1200")).toBe(true);
      expect(projectRequests.every((url) => url.searchParams.get("archived") === "false")).toBe(true);
      const membershipRequest = requests.find((url) => url.pathname.endsWith("/memberships"));
      expect(membershipRequest?.searchParams.get("parent")).toBe("2201");
      expect(membershipRequest?.searchParams.get("member")).toBe("4401");
      expect(membershipRequest?.searchParams.get("resource_subtype"))
        .toBe("project_membership");

      const fieldRequests = requests.filter((url) => url.pathname.endsWith("/custom_fields/6601"));
      expect(fieldRequests).toHaveLength(2);
      expect(fieldRequests[0]?.searchParams.get("opt_fields")).not.toContain("enum_options");
      expect(fieldRequests[1]?.searchParams.get("opt_fields")).toContain("enum_options");
    } finally {
      server.stop(true);
    }
  });

  test("fails closed when a scoped collection returns a different parent", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({
          data: [{
            gid: "3301",
            name: "Wrong scope",
            project: { gid: "9999" },
          }],
          next_page: null,
        });
      },
    });
    try {
      const client = createClient("CURATED_SCOPE_MISMATCH_TOKEN");
      client.basePath = new URL("/api/1.0", server.url).toString().replace(/\/$/, "");
      expect(await errorCode(() => runAgentCommand(client, parseArgs([
        "agent", "list-sections", "--project", "2201",
      ]), agentRuntime))).toBe("internal");
    } finally {
      server.stop(true);
    }
  });
});
