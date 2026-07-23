# Curated developer context

The authenticated agent contract exposes six narrowly scoped reads for discovering exact
workspace, project, section, membership, custom-field, and user identifiers. They are intended
to remove ordinary developer workflows from the generic `api call` and `request` surfaces.

## Commands

```sh
asana-cli agent list-projects --workspace 1200
asana-cli agent list-sections --project 1201
asana-cli agent list-project-memberships --project 1201
asana-cli agent list-project-memberships --project 1201 --member 1202
asana-cli agent list-custom-fields --workspace 1200
asana-cli agent get-custom-field --field 1203
asana-cli agent get-custom-field --field 1203 --include-values --max-content-bytes 12000
asana-cli agent resolve-user --workspace 1200 --user me
```

Every collection requires an explicit workspace or project scope. The default page size is 50,
pagination is disabled, and the default result cap is 100. `--paginate` enables pagination, while
`--max-results` has a hard maximum of 200. Collection output reports both `has_more` and
`truncated`; neither is permission to pick an item implicitly.

`list-project-memberships` reports the current Asana membership resource for users or teams with
project access. It does not report task placement in a project.

## Custom fields

`list-custom-fields` and the default `get-custom-field` return metadata only. Enum and multi-enum
option names are external, potentially sensitive content and are excluded until
`--include-values` is supplied. Selected values share one UTF-8 budget: 16 KiB by default and
64 KiB maximum. At most 500 option records are accepted, and truncation is reported in
`content_budget`. Size bounding is not sanitization; every returned name and option value remains
untrusted.

## User resolution

`resolve-user` calls the exact workspace-scoped user endpoint with a decimal GID, `me`, or an email
address. The response contains only the supplied workspace GID and the resolved user's GID and
optional name. It never returns email, photo, workspace membership, or a user directory.

## Authority and trust boundary

These actions are reads, not authorization:

- they never select a task or write target;
- project membership does not grant `prepare` or `apply`;
- returned Asana names and values are `external-untrusted`;
- fixed SDK methods and explicit projections are used; arbitrary endpoints and fields are not;
- prepare/apply still revalidate the live task, authenticated owner, membership, concurrency
  guard, and host write policy.

The endpoint semantics follow Asana's official API references for
[projects](https://developers.asana.com/reference/getprojects),
[sections](https://developers.asana.com/reference/getsectionsforproject),
[memberships](https://developers.asana.com/reference/getmemberships),
[workspace custom fields](https://developers.asana.com/reference/getcustomfieldsforworkspace),
[one custom field](https://developers.asana.com/reference/getcustomfield), and
[workspace-scoped user lookup](https://developers.asana.com/reference/getuserforworkspace).
