import { describe, expect, test } from "bun:test";
import {
  extractLocalMarkdownLinks,
  parseBacklog,
  verifyProjectPlan,
} from "../scripts/check-project-plan";

const validBacklog = [
  "# Backlog",
  "",
  "| ID | P | Статус | Задача | Зависит от | Acceptance criteria |",
  "|---|---|---|---|---|---|",
  "| AP-001 | P0 | done | Base | — | Complete |",
  "| DEV-001 | P1 | ready | Ready | AP-001 | Complete |",
  "| DEV-002 | P1 | blocked | Blocked | DEV-001 | Complete |",
  "| REL-001 | P2 | cancelled | Removed | — | Out of scope |",
  "",
  "## Later",
  "",
  "| ID | P | Статус | Задача | Зависит от | Acceptance criteria |",
  "|---|---|---|---|---|---|",
  "| LTR-001 | P3 | research | Later | — | Research |",
  "",
].join("\n");

describe("project plan verifier", () => {
  test("parses task dependencies and the pre-1.0 boundary", () => {
    expect(parseBacklog(validBacklog)).toEqual([
      {
        id: "AP-001",
        priority: "P0",
        status: "done",
        dependencies: [],
        beforeLaterBoundary: true,
      },
      {
        id: "DEV-001",
        priority: "P1",
        status: "ready",
        dependencies: ["AP-001"],
        beforeLaterBoundary: true,
      },
      {
        id: "DEV-002",
        priority: "P1",
        status: "blocked",
        dependencies: ["DEV-001"],
        beforeLaterBoundary: true,
      },
      {
        id: "REL-001",
        priority: "P2",
        status: "cancelled",
        dependencies: [],
        beforeLaterBoundary: true,
      },
      {
        id: "LTR-001",
        priority: "P3",
        status: "research",
        dependencies: [],
        beforeLaterBoundary: false,
      },
    ]);
  });

  test("requires every active pre-1.0 task in the release plan", () => {
    expect(() => verifyProjectPlan(
      validBacklog,
      "v0.5 scope: DEV-001, DEV-002",
    )).not.toThrow();
    expect(() => verifyProjectPlan(
      validBacklog,
      "v0.5 scope: DEV-001",
    )).toThrow("DEV-002");
  });

  test("rejects impossible status and dependency combinations", () => {
    expect(() => verifyProjectPlan(
      validBacklog.replace(
        "| DEV-002 | P1 | blocked |",
        "| DEV-002 | P1 | ready |",
      ),
      "DEV-001 DEV-002",
    )).toThrow("DEV-002 is ready while a dependency is not done");
    expect(() => verifyProjectPlan(
      validBacklog.replace(
        "| DEV-001 | P1 | ready |",
        "| DEV-001 | P1 | done |",
      ),
      "DEV-002",
    )).toThrow("DEV-002 is blocked although every dependency is done");
  });

  test("extracts only local Markdown file targets", () => {
    expect(extractLocalMarkdownLinks([
      "[local](roadmap.md#v05)",
      "[root](../README.md)",
      "[anchor](#section)",
      "[web](https://example.com)",
    ].join("\n"))).toEqual(["roadmap.md", "../README.md"]);
  });
});
