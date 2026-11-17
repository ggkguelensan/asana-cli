# SDK 3.4.0

Обновление `asana` с 3.3.0 до 3.4.0 добавляет возможности из
[официального релиза](https://github.com/Asana/node-asana/releases/tag/v3.4.0).

| API | Возможности |
| --- | --- |
| NotificationsApi | Получение Inbox-уведомлений, отметка прочитанными и непрочитанными |
| TablesApi | Создание, чтение, изменение, удаление таблиц и настройка custom fields |
| RecordsApi | CRUD записей, список записей таблицы и поиск по workspace |
| StoriesApi | Комментарии записей; ответы на комментарии задач через parent_comment |
| TimeTrackingEntriesApi | Фильтр assignee; прежний user объявлен устаревшим |
| TasksApi / ProjectsApi | Параметр limit в поиске |

В релизе также описаны lookup-признак custom field и связь AI Studio usage с workflow.
Они относятся к полям API, отдельные команды CLI для них не добавлены.

Новые методы доступны через `api list`, `api docs`, `api call`.
Для threaded reply в `parent_comment` нужен `comment_gid` родительского комментария,
а не его story GID. Доступность операций определяется правами Asana и scopes токена.
