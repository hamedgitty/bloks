# Temporary engine and model restrictions

A pause restricts admission to matching Bloks invocations until an absolute
deadline. It does not rewrite an agent's preferred model, backup, effort or
account settings. Expiry respects edits made while the restriction was active.
Overlapping records apply together; cancelling one cannot release another.

An authenticated ordinary agent can create a workspace restriction and read its
status. Cancellation belongs to that record's creator, or explicitly to the
owner. Shared members cannot manage these restrictions. This capability does
not grant access to other interrupt, configuration or secret routes.

## CLI and HTTP

```sh
bloks engine-pause --family claude --agents all \
  --until "$PAUSE_DEADLINE" --timezone "$PAUSE_TIMEZONE" --id "$PAUSE_OPERATION_ID"
bloks engine-pauses
bloks engine-unpause "$PAUSE_OPERATION_ID"
```

The deadline must contain an explicit UTC offset or `Z`. The time zone is an
IANA name. Select by `--family`, `--driver`, `--instance` or `--model`; combined
selectors constrain the same route. `--agents all` includes future agents;
otherwise supply comma-separated agent ids. Unknown route metadata is not an
allowed alternative during an applicable restriction.

The corresponding API is `GET/POST /api/engine-pauses` and
`DELETE /api/engine-pauses/:id`. A POST supplies `id`, `agents` (`"all"` or an
array), `selector`, `until` (epoch milliseconds) and `timeZone`. The server
derives the creator from authentication. The same creator, id and normalized
request reconcile one operation. A changed request conflicts; replay cannot
resurrect a cancelled or expired record. Keep the id when a receipt is lost,
especially when the caller pauses its own running engine.

Status reads do not probe providers. They expose the durable restriction,
activation state, invocation cancellation/residual facts, source-owned lane
holds and explicit coverage limits. They do not expose helper prompts, output,
capabilities or account credentials.

## Admission, cancellation and pending work

The durable restriction becomes effective before cancellation is enumerated.
Current policy, invocation registration and the actual process/request boundary
are ordered together. A prior selection or lease is not a future call's grant.
Native approval, question and timeout replies are rechecked at their write
boundary too; denial does not create a provider retry or replay.
Existing configured, proven permitted alternatives may be used, including a
different model on the same API instance. Preferences remain intact.

Cancellation targets the registered invocation, not every agent sharing its
instance. A sent interrupt or local process close does not establish remote
completion. Local group escalation survives its leader closing; an observed
absent or replaced group is retired, rather than reused through a later lane.
Escaped descendants and remote work remain unconfirmed. Ungrouped readiness
and auth probes support child-only cancellation and retain uncertainty when
cancelled. Unconfirmed work remains residual across expiry and restart. A
turn cancelled by a pause and then cut off by a crash is not replayed after
expiry; its existing continuation control provides a reconciliation point.

Never-started messages retain their source ids and current edits in the
existing queue. Delivery is committed at invocation. Scheduled slots remain
unconsumed until dispatch and keep their existing usefulness/grace boundary;
obsolete work and held manual attempts do not acquire automatic replay.
Watchers retain their frontier until work has a durable source owner. Room
member deliveries, jobs and workflow steps retain their existing owners.

## Fixed native helper profile and coverage

The `claude.review` profile owns auth/model process creation on the native
host. A narrowly scoped descriptor is issued from effective trusted turn/check
permissions. It cannot select an executable, forge an origin or grant ordinary
workspace API access. The profile requires compatible full-access, same-host
scope and canonical authorized roots; shared, guest, rehearsal, remote and
otherwise constrained contexts do not inherit that profile from saved agent
preferences. Broad workspace credentials do not pass into check shells or
helper children. Auth, model, session and configuration generations remain
bound; unavailable admission leaves the helper pending without a direct-launch
or provider-failure fallback. Native Codex history comes only from the trusted
origin launch HOME/CODEX_HOME and its existing canonical sessions and
archived_sessions collections. A separate project folder is supported. This
does not grant all HOME, credential siblings or caller-selected history roots;
a changed parent-home generation or unsupported provenance remains pending.

Pause enforced for the verified registered native paths reported by status.
Protection is incomplete: unintegrated external launch adapters, external MCP
services, unsupported native drivers, unresolved routes and unconfirmed running
work remain explicit dependencies. Native Claude/Codex and custom gateway provenance
can remain unknown; a model label alone does not prove a permitted backend.
This is not a whole-workspace or quota-protected claim.

Independent owner clients are not intercepted. No account shutdown, global CLI
replacement, preference restoration snapshot or general shell policing is used.
