# Code health

Fallow 3.4.2 is the repository-wide structural health gate. The version itself has completed the
project's 14-day dependency quarantine. TypeScript correctness still belongs to `tsc`, tests to Bun,
and security verification to the project security workflow.

## Required indicators

| Indicator | Required value | Enforcement |
|---|---:|---|
| Fallow health score | at least 80 (grade B) | `bun run check:fallow-score` |
| Duplication | at most 5% | `bun run check:fallow-dupes` |
| Structural findings | no finding absent from the committed baseline | `bun run check:fallow-regression` |
| New PR audit findings | 0 | Fallow `audit`, `new-only` gate in GitHub Actions |
| Cyclomatic complexity | at most 20 for new or changed functions | Fallow config and PR audit |
| Cognitive complexity | at most 15 for new or changed functions | Fallow config and PR audit |
| CRAP score | at most 30 for new or changed functions | Fallow config and PR audit |
| Function size | at most 60 lines for new or changed functions | Fallow config and PR audit |
| Circular dependencies and unresolved imports | 0 new findings | Fallow config and PR audit |

The whole-codebase score and duplication ceilings are absolute. The structural baseline stores
finding identities so replacement findings cannot hide behind an unchanged count. It exists only to
make adoption incremental: it may shrink, never grow. A finding is not suppressed merely to make a
gate green. Suppressions require a reason and are reviewed like code.

## Dependency quarantine

`bunfig.toml` rejects direct and transitive npm releases younger than 14 days during new resolution.
Existing versions in `bun.lock` remain reproducible. Dependabot applies the same 14-day cooldown to
Bun packages and GitHub Actions; GitHub security updates are intentionally not delayed.

An urgent direct security fix may bypass the Bun age gate only in a dedicated pull request:

```sh
bun add --exact PACKAGE@FIXED_VERSION --minimum-release-age 0
```

For a transitive fix, add an exact `overrides` entry to `package.json`, then resolve it with
`bun install --lockfile-only --minimum-release-age 0`. The pull request must link the advisory,
explain why waiting is riskier, keep the version exact, and pass the full quality gate. Do not add
permanent `minimumReleaseAgeExcludes`.

Current exception: `brace-expansion` is pinned to fixed version `5.0.8` because
[GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) affects every older release
and the production dependency audit treats it as high severity. This override may be removed after
the Asana SDK dependency tree no longer resolves the vulnerable legacy line.

## Workflow

During implementation:

```sh
bun run check:fallow
```

Before a commit or pull request:

```sh
bunx fallow audit --base origin/main
bun run check:fast
```

To choose refactoring work:

```sh
bunx fallow health --score --hotspots --targets
bunx fallow dupes --top 20
```

Fallow exit code `1` can mean findings or a failed configured gate; exit code `2` means the analyzer
itself failed. CI uses the typed `audit` verdict rather than treating every advisory finding as a
failure.

## Baseline changes

After a verified cleanup, update the committed identity baseline and prove the remaining finding set
did not grow:

```sh
bunx fallow dead-code --save-baseline .fallow-dead-code-baseline.json
bun run check:fallow-regression
```

Commit a lower baseline together with the cleanup. Raising a baseline or threshold requires an
explicit rationale in the pull request.
