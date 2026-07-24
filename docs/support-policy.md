# Platform support policy

Начиная со следующего release после `v0.4.0`, `asana-cli` официально поддерживает только
нативные macOS и Linux runtime. Это намеренно узкая матрица, а не обещание совместимости со
всеми операционными системами, которые полностью или частично реализуют POSIX.

## Поддерживаемые release targets

| Runtime | Architecture/libc | Artifact |
|---|---|---|
| macOS | arm64 | `asana-cli-darwin-arm64` |
| macOS | x64 | `asana-cli-darwin-x64` |
| Linux | arm64, glibc | `asana-cli-linux-arm64` |
| Linux | x64, glibc baseline | `asana-cli-linux-x64` |
| Linux | arm64, musl | `asana-cli-linux-arm64-musl` |
| Linux | x64, musl baseline | `asana-cli-linux-x64-musl` |

Native Windows, FreeBSD и другие runtime не входят в support, CI или release gates. WSL может
запускать Linux artifact как Linux-среда, но отдельная интеграция с Windows Credential Manager,
ACL или native paths не заявляется.

Production source не содержит native Windows loaders, path branches или platform-specific assets.
Runtime gate выполняется до credential, filesystem или network access.

## Исторический release

`v0.4.0` был опубликован до этого решения и содержит Windows x64 artifact. Этот immutable release
не переписывается и не удаляется, однако наличие исторического binary не означает дальнейшую
поддержку native Windows.

## Исполняемый gate

`bun run check:support-matrix` проверяет, что:

- package scripts не публикуют Windows build;
- CI не содержит native Windows gate;
- release workflow содержит ровно шесть перечисленных macOS/Linux targets;
- publish зависит от полного supported build matrix;
- cross-compile script отклоняет target вне canonical allowlist;
- собранный бинарник проходит native integration lifecycle на macOS и Linux в CI;
- каждый release target, включая musl, публикует JSON evidence полного lifecycle.
- production source tree не содержит native Windows branches, loaders или assets.

Проверка входит в `bun run check`. Изменение support matrix требует одновременного обновления
policy, verifier, tests, CI, release workflow и пользовательской документации.

## Native lifecycle evidence

`evidence/integration-lifecycle` содержит полный install/detect/status/update/uninstall roundtrip
собранного standalone binary для каждого target. Darwin arm64 выполняется нативно, Darwin x64 —
через Rosetta; Linux glibc и musl arm64/x64 выполняются в соответствующих native/emulated
containers. Каждый run использует отдельные временные HOME/project roots и проверяет, что
unrelated файлы остаются неизменными.

`bun run check:integration-lifecycle-evidence` требует ровно шесть canonical records, уникальный
binary digest для каждого target и актуальные source/bundle digests. Release workflow повторяет
тот же executable и публикует target-specific lifecycle JSON рядом с каждым artifact.
