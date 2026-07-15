import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  projectComments,
  selectedTaskProjection,
} from "../src/agent-projections";
import { ContentBudget } from "../src/content-budget";
import { taskSchema } from "../src/schemas";

const encoder = new TextEncoder();

describe("agent UTF-8 content budgets", () => {
  test("never splits a Unicode code point or exceeds the shared byte limit", () => {
    const budget = new ContentBudget(7);
    expect(budget.take("😀😀", "first")).toBe("😀");
    expect(budget.take("€x", "second")).toBe("€");
    expect(budget.metadata()).toEqual({
      max_bytes: 7,
      emitted_bytes: 7,
      truncated: true,
      truncated_values: 2,
      truncated_paths: ["first", "second"],
    });
  });

  test("keeps CJK truncation valid and reports deterministic metadata", () => {
    const first = new ContentBudget(7);
    const second = new ContentBudget(7);
    expect(first.take("漢字語", "notes")).toBe("漢字");
    expect(second.take("漢字語", "notes")).toBe("漢字");
    expect(first.metadata()).toEqual(second.metadata());
    expect(first.metadata().emitted_bytes).toBe(6);
  });

  test("is exact at an ASCII boundary and leaves unknown secret-like text unchanged", () => {
    const unknown = "unknown_secret_like_value";
    const budget = new ContentBudget(unknown.length);
    expect(budget.take(unknown, "value")).toBe(unknown);
    expect(budget.metadata()).toEqual({
      max_bytes: unknown.length,
      emitted_bytes: unknown.length,
      truncated: false,
      truncated_values: 0,
      truncated_paths: [],
    });
  });

  test("shares one budget across a paginated result and caps path metadata", () => {
    const comments = projectComments({
      data: Array.from({ length: 140 }, (_, index) => ({
        gid: String(index + 1),
        type: "comment",
        text: `😀-${index}`,
        unknown_sdk_key: "must be dropped",
      })),
      next_page: { uri: "https://attacker.invalid/page" },
      meta: { count: 140, task_gid: "123", all_stories: false },
    }, 31);
    const emitted = comments.data.reduce((total, story) =>
      total + encoder.encode(z.string().parse(story.text)).byteLength, 0);
    expect(emitted).toBeLessThanOrEqual(31);
    expect(comments.content_budget.emitted_bytes).toBe(emitted);
    expect(comments.content_budget.truncated).toBe(true);
    expect(comments.content_budget.truncated_values).toBeGreaterThan(100);
    expect(comments.content_budget.truncated_paths).toHaveLength(100);
    expect(comments.next_page).toEqual({ available: true });
    expect(comments.data[0]).not.toHaveProperty("unknown_sdk_key");
  });

  test("budgets selected nested custom-field values and drops unknown task keys", () => {
    const task = taskSchema.parse({
      gid: "123",
      name: "Task",
      notes: "😀😀",
      custom_fields: [{
        gid: "456",
        name: "Git",
        display_value: ["repo#1", "😀😀"],
        unknown_sdk_key: "drop",
      }, { gid: "789", name: "Nested", display_value: { nested: ["bypass"] } }],
      unknown_sdk_key: "drop",
    });
    const budget = new ContentBudget(11);
    const projected = selectedTaskProjection(task, ["notes", "custom_fields"], budget);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("unknown_sdk_key");
    expect(serialized).not.toContain("bypass");
    expect(z.string().parse(projected.notes)).toBe("😀😀");
    expect(budget.metadata().emitted_bytes).toBeLessThanOrEqual(11);
    expect(budget.metadata().truncated).toBe(true);
  });

  test("a zero budget preserves selected structure and identifiers", () => {
    const task = taskSchema.parse({
      gid: "123",
      name: "Task metadata",
      notes: "content",
      tags: [{ gid: "456", name: "tag name" }],
      parent: { gid: "789", name: "parent name" },
      custom_fields: [{ gid: "999", name: "Git", display_value: "repo#1" }],
    });
    const budget = new ContentBudget(0);
    const projected = selectedTaskProjection(
      task,
      ["notes", "tags", "parent", "custom_fields"],
      budget,
    );
    expect(projected).toMatchObject({
      gid: "123",
      name: "Task metadata",
      notes: "",
      tags: [{ gid: "456", name: "" }],
      parent: { gid: "789", name: "" },
      custom_fields: [{ gid: "999", name: "", display_value: "" }],
    });
    expect(budget.metadata().emitted_bytes).toBe(0);
    expect(budget.metadata().truncated).toBe(true);
  });
});
