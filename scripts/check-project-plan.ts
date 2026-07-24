import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const projectRoot = resolve(import.meta.dir, "..");
const backlogPath = resolve(projectRoot, "docs/backlog.md");
const releasePlanPath = resolve(projectRoot, "docs/release-plan.md");

const backlogStatusSchema = z.enum(["done", "ready", "blocked", "research", "cancelled"]);
const backlogPrioritySchema = z.enum(["P0", "P1", "P2", "P3"]);
const backlogIdPattern = /\b[A-Z][A-Z0-9]*-\d{3}\b/g;

export type BacklogItem = Readonly<{
  id: string;
  priority: z.output<typeof backlogPrioritySchema>;
  status: z.output<typeof backlogStatusSchema>;
  dependencies: readonly string[];
  beforeLaterBoundary: boolean;
}>;

export function parseBacklog(markdown: string): readonly BacklogItem[] {
  const laterBoundary = markdown.indexOf("\n## Later");
  const items: BacklogItem[] = [];
  const rowPattern = /^\|\s*([A-Z][A-Z0-9]*-\d{3})\s*\|\s*(P[0-3])\s*\|\s*([a-z-]+)\s*\|[^|]*\|\s*([^|]*)\|/gm;

  for (const match of markdown.matchAll(rowPattern)) {
    const offset = match.index ?? 0;
    items.push({
      id: match[1],
      priority: backlogPrioritySchema.parse(match[2]),
      status: backlogStatusSchema.parse(match[3]),
      dependencies: [...new Set(match[4].match(backlogIdPattern) ?? [])],
      beforeLaterBoundary: laterBoundary === -1 || offset < laterBoundary,
    });
  }

  if (items.length === 0) {
    throw new Error("Backlog contains no machine-readable task rows");
  }
  return items;
}

export function verifyProjectPlan(
  backlogMarkdown: string,
  releasePlanMarkdown: string,
): void {
  const items = parseBacklog(backlogMarkdown);
  const byId = new Map<string, BacklogItem>();
  for (const item of items) {
    if (byId.has(item.id)) throw new Error(`Backlog repeats task ID ${item.id}`);
    byId.set(item.id, item);
  }

  for (const item of items) {
    for (const dependency of item.dependencies) {
      if (!byId.has(dependency)) {
        throw new Error(`${item.id} depends on unknown task ${dependency}`);
      }
    }

    const dependencyStatuses = item.dependencies.map((dependency) => byId.get(dependency)?.status);
    if (
      (item.status === "done" || item.status === "ready") &&
      dependencyStatuses.some((status) => status !== "done")
    ) {
      throw new Error(`${item.id} is ${item.status} while a dependency is not done`);
    }
    if (
      item.status === "blocked" &&
      item.dependencies.length > 0 &&
      dependencyStatuses.every((status) => status === "done")
    ) {
      throw new Error(`${item.id} is blocked although every dependency is done`);
    }
  }

  const plannedIds = new Set(releasePlanMarkdown.match(backlogIdPattern) ?? []);
  for (const plannedId of plannedIds) {
    if (!byId.has(plannedId)) {
      throw new Error(`Release plan references unknown task ${plannedId}`);
    }
  }

  const uncovered = items
    .filter((item) =>
      item.beforeLaterBoundary &&
      item.status !== "done" &&
      item.status !== "cancelled" &&
      !plannedIds.has(item.id)
    )
    .map((item) => item.id);
  if (uncovered.length > 0) {
    throw new Error(`Release plan does not cover active pre-1.0 tasks: ${uncovered.join(", ")}`);
  }
}

export function extractLocalMarkdownLinks(markdown: string): readonly string[] {
  const links: string[] = [];
  const pattern = /\[[^\]]*]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    const target = rawTarget.split("#", 1)[0];
    if (
      target === "" ||
      target.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(target)
    ) {
      continue;
    }
    links.push(target);
  }
  return links;
}

async function verifyLocalLinks(path: string, markdown: string): Promise<void> {
  for (const link of extractLocalMarkdownLinks(markdown)) {
    const target = resolve(dirname(path), decodeURIComponent(link));
    await access(target).catch(() => {
      throw new Error(`${path} links to missing local target ${link}`);
    });
  }
}

async function main(): Promise<void> {
  const markdownPaths = new Set([
    resolve(projectRoot, "README.md"),
    resolve(projectRoot, "SECURITY.md"),
  ]);
  for (const root of ["docs", "skills"]) {
    const glob = new Bun.Glob("**/*.md");
    for await (const relativePath of glob.scan({ cwd: resolve(projectRoot, root) })) {
      markdownPaths.add(resolve(projectRoot, root, relativePath));
    }
  }

  const orderedMarkdownPaths = [...markdownPaths].sort();
  const contents = await Promise.all(orderedMarkdownPaths.map((path) => readFile(path, "utf8")));
  const markdownByPath = new Map(orderedMarkdownPaths.map((path, index) => [path, contents[index]]));

  verifyProjectPlan(
    markdownByPath.get(backlogPath) ?? "",
    markdownByPath.get(releasePlanPath) ?? "",
  );
  await Promise.all(orderedMarkdownPaths.map((path) => verifyLocalLinks(
    path,
    markdownByPath.get(path) ?? "",
  )));

  const items = parseBacklog(markdownByPath.get(backlogPath) ?? "");
  const active = items.filter((item) =>
    item.beforeLaterBoundary &&
    item.status !== "done" &&
    item.status !== "cancelled"
  );
  process.stdout.write(
    `Project plan verified: ${items.length} backlog tasks, ${active.length} active pre-1.0 tasks, ${orderedMarkdownPaths.length} Markdown files with intact local links\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown project plan failure";
    process.stderr.write(`Project plan check failed: ${message}\n`);
    process.exit(1);
  }
}
