# Изоляция отдельным POSIX user или container

Этот guide относится только к поддерживаемым macOS/Linux системам. Отдельный user/container
уменьшает доступ агента к секретам и файлам основной учётной записи, но не превращает
`asana-cli` в security sandbox и не защищает от администратора host/container runtime.

## Границы

Рекомендуемая изолированная identity получает только:

- отдельный Asana account/PAT с минимальным workspace/project membership;
- проверенный `asana-cli` binary;
- dedicated writable state directory;
- read-only доступ только к нужному checkout, если Git context действительно нужен;
- исходящее TLS-соединение к `app.asana.com` и необходимые DNS/CA services.

Не передавайте SSH agent sockets, cloud credentials, browser profiles, основной `$HOME`, Docker
socket, password stores или произвольные host directories. Не запускайте agent как root.

CLI не настраивает firewall, namespaces, seccomp, MAC policy или container runtime. Он не может
запретить unrestricted same-user shell прочитать environment/state или вызвать сеть в обход CLI.
Host root и Docker daemon operator также остаются вне этой границы.

## Credential

На interactive macOS/Linux desktop предпочтителен:

```sh
asana-cli auth pat set
asana-cli auth pat status
```

Credential store должен принадлежать именно isolated user. Не копируйте store основной учётной
записи и после запуска агента удалите `ASANA_ACCESS_TOKEN`/`ASANA_PAT` из его parent environment.

В headless user/container OS credential store часто недоступен. Передавайте
`ASANA_ACCESS_TOKEN` из host secret manager только выбранному процессу. Не помещайте PAT в argv,
image, Dockerfile, Compose YAML, shell history, checkout, `.env`, logs или model context.
`docker inspect`, host root и container runtime administrator всё равно могут видеть environment;
для них переменная не является secret boundary.

## Filesystem

Write operations требуют сохранения journal между `prepare-*`, внешним approval и `apply`:

| State | macOS | Linux |
|---|---|---|
| Operations | `$HOME/Library/Application Support/asana-cli/operations` | `${XDG_STATE_HOME:-$HOME/.local/state}/asana-cli/operations` |
| Metadata audit | `$HOME/Library/Application Support/asana-cli/audit` | `${XDG_STATE_HOME:-$HOME/.local/state}/asana-cli/audit` |
| Human context | `$HOME/Library/Application Support/asana-cli/context` | `${XDG_STATE_HOME:-$HOME/.local/state}/asana-cli/context` |

State directories должны принадлежать isolated user и не быть group/other-readable. Operation
journal может содержать task/comment payload; audit содержит только metadata, но это не делает
journal безопасным для logs, repository или model context. Не используйте ephemeral state между
prepare и apply: потеря record исключает безопасное применение operation.

Host write policy и repository mapping — отдельные root-administered boundaries:

- macOS: `/private/etc/asana-cli/scoped-write-policy.json` и
  `/private/etc/asana-cli/repository-asana-mapping.json`;
- Linux: `/etc/asana-cli/scoped-write-policy.json` и
  `/etc/asana-cli/repository-asana-mapping.json`.

Не bind-mount repository-controlled replacements на эти пути. Отсутствующая policy оставляет
agent writes запрещёнными; mapping сам по себе никогда не разрешает write.

## Отдельный OS user

Создайте non-admin account средствами вашей ОС. Его home и state не должны быть доступны другим
непривилегированным users. Установите проверенный executable root-owned и read-only для isolated
user, затем запускайте agent/session от этой identity с очищенным environment:

```sh
env -i \
  HOME=/home/asana-agent \
  XDG_STATE_HOME=/home/asana-agent/.local/state \
  PATH=/usr/local/bin:/usr/bin:/bin \
  ASANA_ACCESS_TOKEN="$ASANA_ACCESS_TOKEN" \
  asana-cli integrations doctor --client codex
```

Путь home показан для Linux; на macOS используйте реальный home созданного account. `env -i`
удаляет случайно унаследованные variables, но явно переданный PAT остаётся доступен процессу и
тому же OS user.

Если checkout нужен только для `--git-current`/repository context, монтируйте или выдавайте
read-only доступ. Human `context` mutation и integration installation требуют отдельных writable
paths; не расширяйте права checkout ради них.

## Container pattern

Официальный container image не заявлен. Ниже — runtime pattern для уже проверенного Linux
artifact. Dedicated `/state` volume должен сохраняться между prepare/apply:

```sh
docker run --rm \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --mount type=bind,src=/verified/asana-cli-linux-x64,dst=/usr/local/bin/asana-cli,readonly \
  --mount type=volume,src=asana-cli-state,dst=/state \
  --env HOME=/home/asana-agent \
  --env XDG_STATE_HOME=/state \
  --env ASANA_ACCESS_TOKEN \
  <minimal-linux-image> \
  asana-cli agent status
```

Добавляйте checkout только отдельным read-only bind mount. Root filesystem `--read-only`,
`no-new-privileges` и dropped capabilities ограничивают часть последствий, но не ограничивают
outbound network. Создайте runtime-specific egress policy отдельно; она должна разрешать
`app.asana.com:443` и необходимые DNS/CA paths. Не монтируйте Docker socket.

Musl image требует `asana-cli-linux-*-musl`, glibc image — соответствующий non-musl artifact.
Architecture контейнера и binary должны совпадать.

## Проверка перед выдачей агенту

1. Проверьте artifact, provenance и SBOM по
   [release verification guide](release-verification.md).
2. Выполните `asana-cli integrations doctor --client CLIENT`; inherited credential names
   допустимы только если это сознательно выбранный headless flow.
3. Выведите `asana-cli integrations policy CLIENT` и перенесите только exact read/prepare rules.
4. Оставьте `agent apply --operation-id ...` за внешним approval.
5. Убедитесь, что `api`, `request`, `auth`, installation/self-update и broad shell не auto-allowed.
6. Проверьте, что hostile task/comment content остаётся данными, а `unknown` operation не
   повторяется автоматически.

При подозрении на exposure остановите session, отзовите PAT в Asana Developer Console, сохраните
metadata audit для расследования и не повторяйте operation со статусом `unknown`.

