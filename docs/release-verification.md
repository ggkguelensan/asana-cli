# Проверка release artifacts

Новые macOS/Linux releases публикуют для каждого executable:

- `<artifact>` — standalone binary;
- `<artifact>.lifecycle.json` — install/update/uninstall evidence;
- `<artifact>.spdx.json` — deterministic SPDX 2.3 SBOM;
- `<artifact>.reproducibility.json` — second-build byte identity evidence;
- `<artifact>.provenance.sigstore.json` — Sigstore bundle с SLSA provenance;
- `<artifact>.sbom.sigstore.json` — Sigstore bundle с подписанным SPDX predicate.

Release также содержит `asana-cli.rb`, `SHA256SUMS` и
`SHA256SUMS.sigstore.json`. `SHA256SUMS` перечисляет точный canonical payload set; файл подписи
не входит сам в себя.

## Онлайн-проверка

Скачайте нужный binary, его sidecars, `SHA256SUMS` и checksum bundle из одного release. Не
исполняйте binary до завершения проверки. Подставьте tag, artifact и полный commit:

```sh
TAG=vX.Y.Z
ARTIFACT=asana-cli-darwin-arm64
SOURCE_COMMIT=<full-tag-commit>
REPOSITORY=ggkguelensan/asana-cli
WORKFLOW=ggkguelensan/asana-cli/.github/workflows/release.yml
```

Сначала проверьте подпись checksum manifest и привязку к release workflow/tag commit:

```sh
gh attestation verify SHA256SUMS \
  --repo "$REPOSITORY" \
  --signer-workflow "$WORKFLOW" \
  --source-digest "$SOURCE_COMMIT" \
  --source-ref "refs/tags/$TAG" \
  --deny-self-hosted-runners
```

После этого проверьте строку выбранного artifact:

```sh
grep "  $ARTIFACT$" SHA256SUMS | shasum -a 256 -c -
```

И отдельно проверьте build provenance и SBOM attestation самого binary:

```sh
gh attestation verify "$ARTIFACT" \
  --repo "$REPOSITORY" \
  --signer-workflow "$WORKFLOW" \
  --source-digest "$SOURCE_COMMIT" \
  --source-ref "refs/tags/$TAG" \
  --deny-self-hosted-runners

gh attestation verify "$ARTIFACT" \
  --repo "$REPOSITORY" \
  --signer-workflow "$WORKFLOW" \
  --source-digest "$SOURCE_COMMIT" \
  --source-ref "refs/tags/$TAG" \
  --deny-self-hosted-runners \
  --predicate-type https://spdx.dev/Document/v2.3
```

Успешный checksum без attestation подтверждает только целостность относительно скачанного
`SHA256SUMS`. Attestation дополнительно подтверждает signer repository/workflow, source tag и
commit. Ни один из этих шагов сам по себе не доказывает отсутствие уязвимостей.

## Проверка сохранённых bundles

При доступе к сети `gh` сам получает trusted roots. Сохранённые sidecars можно передать через
`--bundle`:

```sh
gh attestation verify "$ARTIFACT" \
  --repo "$REPOSITORY" \
  --bundle "$ARTIFACT.provenance.sigstore.json"

gh attestation verify "$ARTIFACT" \
  --repo "$REPOSITORY" \
  --bundle "$ARTIFACT.sbom.sigstore.json" \
  --predicate-type https://spdx.dev/Document/v2.3

gh attestation verify SHA256SUMS \
  --repo "$REPOSITORY" \
  --bundle SHA256SUMS.sigstore.json
```

Для полностью offline-проверки заранее получите актуальный trusted root командой
`gh attestation trusted-root > trusted_root.jsonl`, перенесите его отдельным доверенным каналом и
добавьте `--custom-trusted-root trusted_root.jsonl`. Старый trusted root не сообщает о последующей
ротации или отзыве ключевого материала.

## Что содержит SBOM

SPDX связывает:

- SHA-256 конкретного target binary;
- source commit и canonical target;
- Bun version из `packageManager`;
- SHA-256 `bun.lock`;
- полный production dependency closure из lockfile с npm SHA-512 integrity.

`bun run check:release-assets -- DIRECTORY TAG COMMIT SOURCE_DATE_EPOCH` заново строит ожидаемый
SBOM из выбранных binary/source/lockfile, сверяет lifecycle evidence, checksum manifest,
Homebrew formula и subjects сохранённых Sigstore bundles. Криптографическая проверка сертификата
и transparency/timestamp material выполняется `gh attestation verify`.

Каждый matrix job независимо компилирует тот же target второй раз с одинаковым source commit,
lockfile, Bun 1.3.14 и `SOURCE_DATE_EPOCH`. Release разрешён только при полном byte-for-byte
совпадении. Нормализованное evidence не содержит runner/temp paths и допускает только
`comparison: "byte-identical"` с пустым `normalized_differences`; любое реальное различие
останавливает release, а не маскируется как воспроизводимое.

## Homebrew

`asana-cli.rb` — release-specific Formula, а не автоматически доверенный tap. После проверки
подписи `SHA256SUMS` и строки самой Formula:

```sh
grep "  asana-cli.rb$" SHA256SUMS | shasum -a 256 -c -
brew install --formula ./asana-cli.rb
```

Formula выбирает один macOS/Linux glibc artifact по OS/architecture, проверяет его SHA-256 и
устанавливает только `asana-cli`. Musl artifacts устанавливаются вручную и Formula их не выбирает.
