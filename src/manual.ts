import type { ParsedArgs } from "./args";
import { CliError } from "./errors";
import { AUTH_HELP } from "./help";

const manuals: Record<string, string> = {
  start: `Первый запуск
  bun install --frozen-lockfile
  bun run build
  ./dist/asana-cli doctor --offline
  ./dist/asana-cli auth pat set
  ./dist/asana-cli me
  ./dist/asana-cli workspaces --all
  ./dist/asana-cli tasks mine --all --max-results 100
Перед изменением: asana-cli task update GID --completed=true --dry-run`,
  glossary: `Workspace — организация и граница доступа.
Project — проект; задача может входить в несколько проектов.
Section — секция проекта.
Task — задача с исполнителем, сроками, полями и комментариями.
Subtask — задача с родителем.
Story — событие истории задачи, включая комментарии.
Custom field — структурированное поле; используйте GID поля и значения.
GID — стабильный идентификатор Asana.
PAT — Personal Access Token; передавайте через окружение или хранилище ОС.`,
  examples: `asana-cli task get TASK_GID
asana-cli task search "release" --workspace WORKSPACE_GID --all-assignees
asana-cli task update TASK_GID --notes-file notes.txt --dry-run
asana-cli task comment TASK_GID --file comment.txt
asana-cli api list NotificationsApi
asana-cli api call NotificationsApi getNotificationsForUser --args '["me","WORKSPACE_GID",{"limit":20}]'
asana-cli request GET /tasks/TASK_GID --query '{"opt_fields":"name,completed"}'
Все методы SDK доступны через api call; аргументы соответствуют порядку в api docs.
Для JSON используйте @file.json или - для stdin.`,
  auth: AUTH_HELP,
};

export function runManualCommand(args: ParsedArgs): string {
  if (args.positionals.length > 2) throw new CliError("usage", "Usage: asana-cli man [TOPIC]");
  const topic = args.positionals[1];
  if (!topic) return `asana-cli man — ${Object.keys(manuals).join(", ")}`;
  const manual = Object.hasOwn(manuals, topic) ? manuals[topic] : undefined;
  if (!manual) throw new CliError("usage", `Unknown manual topic: ${topic}`);
  return manual;
}
