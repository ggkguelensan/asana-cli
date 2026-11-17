# Переход на самостоятельный CLI

Удалены команды `agent`, `agent-setup`, `integrations`, `context`, `insights`, `update`,
флаги `--agent` и `--agents`, а также `task find-git` / `task search-git`.
Переменные ASANA_CLI_AGENT и ASANA_CLI_AGENT_POLICY больше не влияют на поведение CLI.
Вместо агентского envelope возвращается обычный JSON результата или `{ "error": ... }`.

Используйте `task get/search/update/comment`, `tasks mine`, `api call` и `request`.
Для сложных операций, ранее доступных через агентский протокол, используйте методы SDK
через `api list`, `api docs` и `api call`.

Удалите hooks, вызывающие `context bind/deactivate`, из собственных настроек Worktrunk.
Установленные прежней версией навыки и локальные state-файлы автоматически не удаляются:
новый CLI не читает и не изменяет эти файлы. Их очистка выполняется владельцем отдельно.

Защита от отправки известных процессу секретов перенесена в общий SDK/REST boundary;
она действует для обычных команд без отдельного клиентского протокола.
