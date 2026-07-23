# Bounded task batch reads

`asana-cli agent batch-tasks --input -` reads 1–10 explicit task GIDs through one Asana Batch API
transport request. It is a curated read: callers cannot provide an HTTP method, path, query
parameter, or arbitrary field.

## Input

```sh
printf '%s' '{
  "task_gids": ["1200", "1201"],
  "include": ["notes"],
  "max_content_bytes": 16384
}' | asana-cli agent batch-tasks --input -
```

The input is strict:

- `task_gids` contains 1–10 unique exact decimal GIDs and preserves caller order;
- `include` uses the same bounded selectors as `get-task`: `notes`, `html_notes`,
  `custom_fields`, `tags`, `parent`, and `created_at`;
- `max_content_bytes` is one shared UTF-8 budget from 0 through 65,536 bytes;
- unknown keys, duplicate GIDs/selectors, direct flags, and more than 10 tasks fail before network
  I/O.

The CLI constructs exactly one `POST /batch` request whose actions are fixed `GET /tasks/{gid}`
reads with a compile-time field allowlist. Batch input never becomes a generic request surface.

## Output and partial failure

The response preserves the requested order. Every result is one strict discriminated outcome:

- `success` contains the exact requested GID and its bounded task projection;
- `error` contains only the requested GID, a stable error code, and optional HTTP status.

Error bodies, headers, SDK objects, and messages are never projected. Individual errors use
`auth-failed`, `not-found`, `premium-required`, `conflict`, `rate-limited`, `asana-api`, or
`invalid-response`. A success response returning another task identity is `invalid-response`.
A missing, extra, paginated, or reordered-count response invalidates the whole batch because exact
correlation can no longer be proved.

`meta.request_budget` reports the fixed 10-action ceiling, used action count, and one transport
request. `meta.result_budget` reports the fixed 10-result ceiling. `content_budget` accounts for
all projected untrusted names and selected content across every successful item, so later items
cannot reset or bypass it.

Each success also reports `projection.truncated` and a stable `truncated_fields` list when a
nested project, membership, custom-field/value, or tag collection exceeds its fixed projection
cap. Nested results are never dropped silently.

The official Asana [Batch requests](https://developers.asana.com/docs/batch-requests) contract
limits a batch to 10 actions, preserves response order, and reports individual action results even
when the outer request succeeds. The endpoint is documented in
[Submit parallel requests](https://developers.asana.com/reference/createbatchrequest). Asana
counts every action against rate and concurrency limits; batching reduces transports, not API
quota.
