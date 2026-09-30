# Findings: AEM I/O Events into an Adobe I/O Runtime action

What this covers: an AEM as a Cloud Service event (content fragment created, modified,
deleted, published, unpublished, variation) is delivered to an App Builder Runtime action.
The action enriches the event by calling back into AEM for the actual content, then pushes
a normalised payload to a downstream system.

Content fragments are the worked example, but almost everything below applies to any
"AEM event triggers a Runtime action that does something" integration.

Example values are used throughout. Substitute your own:

| Placeholder | Example | Where it comes from |
|---|---|---|
| Program / environment | `p12345` / `e67890` | Cloud Manager |
| Console org id | `11111` | `aio console org list` |
| OAuth client id | `abcdef0123456789abcdef0123456789` | Developer Console credential |
| Runtime namespace | `11111-myproject-stage` | Console workspace |
| Author host | `https://author-p12345-e67890.adobeaemcloud.com` | Cloud Manager |

---

## 1. The event tells you *what* changed, never the new values

This is the single most important thing to understand before designing anything. An AEM
event payload is a CloudEvent containing references and identifiers only:

```json
{
  "type": "aem.sites.contentFragment.modified",
  "time": "2026-01-01T00:00:00.000Z",
  "eventid": "...",
  "data": {
    "id": "d587a8d9-733c-4b6b-9357-2f044c2e186c",
    "path": "/content/dam/example/my-fragment",
    "model": { "id": "...", "path": "/conf/example/settings/dam/cfm/models/textitem" },
    "sourceUrl": "https://author-p12345-e67890.adobeaemcloud.com",
    "tags": [],
    "user": { "imsUserId": "...", "principalId": "...", "displayName": "..." },
    "properties": [ { "name": "content", "changeType": "modified" } ]
  }
}
```

`properties` names the changed fields and how they changed. It does **not** contain their
values. Any integration that needs actual content has to call back into AEM, and that
callback is where the real cost of the integration lives: credentials, API enablement, and
a Cloud Manager config pipeline.

Budget accordingly. Receiving events is easy. Enriching them is not.

## 2. You get current state, not state at event time

When you fetch the fragment after receiving an event, you get whatever it looks like *now*.
In this POC an event timestamped `03:27:25` returned content whose `modified.at` was
`03:31:06` — nearly four minutes newer than the event that triggered the fetch.

Combined with Adobe's explicit lack of ordering guarantees, this means:

- A burst of rapid edits can deliver several events that all carry identical latest content.
- An older event can arrive after a newer one and push stale-looking (actually newer) data.

For "keep a downstream copy in sync" this is usually fine and arguably desirable. For
anything needing point-in-time fidelity or a change audit trail, the event stream alone is
insufficient.

## 3. The action must be a non-web action

Counter-intuitive, and it will silently cost you an afternoon. From Adobe's docs:

> You must create a `non-web` action for that to be used in the `Runtime Action` option.
> For web actions you should use the `Webhook` option on the Developer Console.

So the manifest needs `web: 'no'` **and** `require-adobe-auth: false`:

```yaml
actions:
  my-event-processor:
    function: actions/my-event-processor/index.js
    web: 'no'
    runtime: nodejs:22
    annotations:
      require-adobe-auth: false
      final: true
```

`require-adobe-auth: false` is safe here because I/O Events places a signature-validator
action in a sequence in front of yours; your action only runs after a signature verifies.

The failure mode if you get this wrong is not an error message. The Runtime action dropdown
in Developer Console is simply **empty**, because only non-web actions are listed there.

## 4. `delivery_type` still reads `webhook` after switching to a Runtime action

Do not use `delivery_type` to confirm the cutover. After selecting a Runtime action, the
registration reports:

```json
{
  "delivery_type": "webhook",
  "runtime_action": "my-package/my-event-processor",
  "webhook_url": "https://runtime.adobe.io/api/v1/web/11111-myproject-stage/acp/sync_event_handler_XXXX?sync=true&id=XXXX"
}
```

Runtime action delivery is *implemented* as a webhook to an Adobe-generated handler, which
is that signature-validator sequence. The authoritative field is **`runtime_action`**.
Checking `delivery_type` will convince you the save failed when it succeeded.

## 5. Activations for web-invoked actions do not appear in `aio rt activation list`

Events delivered through Adobe's handler produced **no** entries in `aio rt activation list`,
and neither did direct HTTPS calls to a web action — despite both provably executing and
returning correct responses. Filtering by action name returned zero rows.

This makes activations useless as evidence of live delivery, and it looks exactly like
"nothing is happening" when everything is working.

Use a durable side effect instead. Persisting the received payload to App Builder State
made deliveries observable:

```javascript
const state = await stateLib.init()
await state.put('last-received', JSON.stringify({ receivedAt: new Date().toISOString(), envelope }), { ttl: 86400 })
```

Then `aio app state get last-received`. Clear the key first so a new entry is unambiguous.

## 6. `params` contains your action inputs, including secrets

Runtime merges action inputs into `params` alongside the event. So this innocent-looking
line exfiltrates every secret you configured:

```javascript
envelope._rawEvent = params   // leaks IMS_CLIENT_SECRET to the destination and the logs
```

In this POC that shipped the OAuth client secret to the destination and wrote it into
activation logs before it was caught. Always rebuild from an explicit field list:

```javascript
const CLOUD_EVENT_FIELDS = ['specversion','id','source','type','datacontenttype',
  'dataschema','time','eventid','event_id','recipientclientid','recipient_client_id','data']

function pickCloudEvent (event) {
  const picked = {}
  for (const f of CLOUD_EVENT_FIELDS) if (event[f] !== undefined) picked[f] = event[f]
  return picked
}
```

The same hazard applies to `logger.info(JSON.stringify(params))`, which is a very natural
thing to write while debugging. If it happens, rotate the credential.

## 7. Public request bins are unreachable from Runtime egress

`webhook.site` times out from a Runtime action:

```
TypeError: fetch failed
  [cause]: AggregateError [ETIMEDOUT] at internalConnectMultiple (node:net)
```

Four sub-errors, matching webhook.site's four published addresses (two IPv4, two IPv6).
This is **not** a general egress problem — AEM was reachable from the same action — and it
is **not** a rate limit, because webhook.site limits return HTTP 410 or 429, which requires
a completed TCP handshake.

Adobe documents that actions have "full access to the internet" and that port 443 is
allowed, so nothing official explains it. The likely cause is reputation-based filtering:
webhook.site is named in MITRE ATT&CK T1567.004 as an exfiltration channel and appears on
commercial egress denylists alongside RequestBin, ngrok, pipedream and postman-echo. A DROP
rule yields `ETIMEDOUT`; a REJECT would yield `ECONNREFUSED`. webhook.site itself ships an
"Alternate Domain" toggle because being blocked is routine — but it is subscriber-only, and
the free `<token>.webhook.site` subdomain form is a CNAME to the same addresses, so it
changes nothing.

Notably, Adobe's own tutorials never use a third-party request bin; the generated sample
action calls `https://adobeioruntime.net/api/v1/api-docs`.

Practical consequences:

- Do not design a demo around a public request bin.
- A second Runtime web action makes a reliable stand-in sink.
- Adobe's *event* infrastructure reaches webhook.site fine, so a plain webhook registration
  works even when your action cannot reach the same host. These are different egress paths.
- `aio runtime ip-list get` returns Runtime's egress ranges if a destination needs an
  allowlist. It requires accepting terms and providing a contact email on first use.

## 8. Authentication is OAuth Server-to-Server, and the tutorials are wrong

JWT service credentials reached end of life on 30 June 2025. All server-to-server
integrations must use OAuth Server-to-Server (client credentials against
`https://ims-na1.adobelogin.com/ims/token/v3`).

Adobe's own AEM Eventing tutorials still show `require('@adobe/jwt-auth')` with
`AEM_SERVICECREDENTIALS_PRIVATEKEY` and `metaScopes`, despite recent "last updated" stamps.
Do not follow them.

Adobe does not publish a scopes table. Copy the scope string verbatim from the Developer
Console credential page rather than assembling it by hand.

## 9. Calling AEM APIs requires a Cloud Manager config pipeline

Correct scopes and product profile membership are not enough. The client id must be
allowlisted **on the AEM environment** via a config file in the Cloud Manager git repo:

```yaml
kind: "API"
version: "1"
metadata:
  envTypes: ["dev"]
data:
  allowedClientIDs:
    author:
      - "abcdef0123456789abcdef0123456789"
```

Four things reliably go wrong here:

1. It must be deployed by a **targeted deployment** pipeline with Include: Config. Full-stack
   and web-tier pipelines do not deploy it.
2. The client id must be a **literal string**. Adobe states that environment variables and
   secret references are not supported for this configuration.
3. `metadata.envTypes` must match the environment type. A mismatch deploys successfully and
   then silently does not load.
4. It goes in the **Cloud Manager–managed** repo (`git.cloudmanager.adobe.com/...`), not
   your front-end repo. Confirm the repo belongs to the right program — the git URL encodes
   the organisation slug, not the program id.

Diagnostic worth knowing: an un-allowlisted client gets **403** from the auth proxy. If you
get **404** for a missing resource, the allowlist is working.

There is also an ordering dependency. The client id does not exist until the Console project
and credential exist, so create those first, then write the config, then run the pipeline.

## 10. Verify the event catalogue empirically

Documentation and reality diverged in both directions:

- Adobe's spec lists a `moved` event. The Console wizard offered only six types; `moved` was
  not among them.
- Adobe's spec page for the unpublished event shows its `type` as
  `aem.sites.contentFragment.published` — a documentation bug. The real value is
  `aem.sites.contentFragment.unpublished`.

Subscribe to everything available, log unrecognised types rather than rejecting them, and
confirm the actual strings against live events before matching on them.

## 11. Deleting a fragment emits two events microseconds apart

Deleting a fragment that has variations emits a `variation` event with
`changeSubType: "variation.deleted"` and then the `deleted` event — observed 1.5 ms apart.
Since ordering is not guaranteed, the `variation` event can arrive *after* the fragment is
gone, and its content fetch will 404.

Treat this as normal, not as an error. Forward a tombstone.

## 12. Publish and unpublish events differ in two ways that will break naive code

For `published` and `unpublished`, `data.sourceUrl` points at the **publish** host, while
create/modify/delete report author. If you derive your API host from `sourceUrl`, publish
events will hit the publish tier, where the Content Fragment Management API is disabled by
default. Always take the host from configuration.

Also, `unpublished` events are raised by an internal service, so the actor is degenerate:

```json
"user": { "principalId": "workflow-process-service" }
```

No `imsUserId`, no `displayName`. Treat every actor field as optional.

## 13. Return codes decide whether your registration survives

I/O Events retries on 429 and 5xx (except 505) for up to 24 hours, and does not retry
anything else. A registration with at least 10 delivery attempts in 24 hours of which 80%
fail moves to **Unstable**, then **Disabled**, and recovery requires manually editing the
registration in Developer Console.

So status codes are a health decision, not just an error report:

| Situation | Return | Why |
|---|---|---|
| Processed successfully | 200 | — |
| AEM 5xx, IMS failure, destination unreachable | 500 | A retry can fix it |
| Resource genuinely gone (404) but handled | 200 | Tombstone forwarded; nothing to retry |
| Malformed payload, unknown event type | 400 | Will never succeed |
| Retry budget exhausted | 400 | Stop before the registration degrades |

The trap: returning 400 or 500 for a routinely-missing fragment. An overnight-hibernating
sandbox plus 500s is exactly the recipe for finding your registration Disabled in the
morning.

Cap retries using the delivery headers, which arrive in `params.__adobe_headers`:

```javascript
const headers = params.__adobe_headers || {}
const eventId = headers['x-adobe-event-id']          // stable across retries; use for dedup
const retryCount = Number(headers['x-adobe-retry-count'] || 0)  // absent on first attempt
```

## 14. Handle the challenge probe

Registrations are validated by a probe. The action must echo it:

```javascript
if (params.challenge) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
           body: { challenge: params.challenge } }
}
```

If a destination cannot echo the challenge — a plain webhook receiver, for instance — Adobe
falls back to asynchronous validation and posts a one-time validation URL that must be
opened within **five minutes**. This is why validating against a request bin is fiddly and
against a Runtime action is not.

## 15. Cache the IMS token, and invalidate it on 401/403

Token exchange on every event wastes time against the 60-second delivery timeout. App
Builder State is available to actions with no setup:

```javascript
const state = await stateLib.init()
const cached = await state.get('ims-access-token')
```

Cache with a TTL slightly under `expires_in`. Critically, **delete the cached token on 401
or 403**. Without that, a token that stops being accepted (after a secret rotation, say)
keeps being served from cache until TTL expiry, and every retry fails identically while the
action looks broken for no visible reason.

Treat State as a cache, not a dependency: if it is unavailable, fall back to a fresh token.

## 16. Wrap every outbound call

`fetch` connection failures raise `TypeError`, they do not return a response. An unwrapped
call turns a transient network problem into an uncontrolled action error instead of your
chosen status code. Add explicit timeouts too, so a hang fails fast rather than consuming
the delivery window:

```javascript
signal: AbortSignal.timeout(8000)
```

## 17. Sandbox environments hibernate after 8 hours

Sandbox programs hibernate after eight hours of inactivity, and a hibernated author cannot
serve API calls. Deployments still succeed while hibernated but take effect only after
de-hibernation. Sandboxes also have no technical support.

Adobe does not document whether events are emitted during hibernation; mechanically,
authoring cannot occur, so assume the stream simply stops.

## 18. Tooling gotchas

- **Node**: install the `aio` CLI on an even-numbered LTS (20, 22, 24). On Node 25 the CLI
  emits `TimeoutNaNWarning` from its oclif dependency stack. Because `aio` installs into a
  specific Node version's bin directory, switching versions removes it from `PATH` and it
  must be reinstalled.
- **`aio console project create` does not attach services.** It creates the project and
  Runtime-enabled workspaces, but no credential, so `aio runtime` and `aio event` fail with
  "no oAuth Server-to-Server or JWT credential associated" until you add services in Console.
- **Project names must be alphanumeric.** Hyphens are rejected.
- **`aio rt action invoke` rejects `--param-file` combined with `--param`** with "request
  defines parameters that are not allowed (e.g., reserved properties)". It fails quietly
  enough to look like stale activations.
- **App Builder entitlement** is confirmed by a workspace having `runtime_enabled: true` and
  a non-empty `runtime_namespace`. The CLI installs and lists App Builder templates
  regardless of entitlement, so neither proves anything.
- **Generator templates prompt interactively** even with `-y`. Writing `app.config.yaml` and
  the action by hand is faster and gives you the correct non-web annotations directly.

## 19. Reliability gaps to design for

Adobe states plainly that AEM Eventing has **no SLA** and does not guarantee completeness,
and that events may be duplicated and delivered out of order. If completeness matters:

- Deduplicate on `x-adobe-event-id`, which is stable across retries.
- Use the Journaling API (7-day retention) to backfill gaps after an outage. It is available
  on every registration regardless of delivery method.
- Note that Subscriber Defined Filtering is destructive — filtered events are absent from
  the journal too.

## Normalised envelope

Emitting one shape for every event type, rather than forwarding raw events, keeps AEM's
schema from leaking into every downstream consumer. Deletes stay structurally identical to
creates, with `content: null` and an explicit reason:

```json
{
  "operation": "update",
  "eventType": "aem.sites.contentFragment.modified",
  "eventId": "...",
  "occurredAt": "2026-01-01T00:00:00.000Z",
  "source": { "program": "12345", "environment": "67890", "tier": "author",
              "host": "https://author-p12345-e67890.adobeaemcloud.com",
              "eventSourceUrl": "..." },
  "fragment": { "id": "...", "path": "...", "model": {}, "tags": [] },
  "changedProperties": [ { "name": "content", "changeType": "modified" } ],
  "variation": null,
  "content": { },
  "contentUnavailableReason": null,
  "actor": { "principalId": "...", "displayName": null, "imsUserId": null },
  "deliveryAttempt": 0
}
```

Making a delete structurally different from an update is the mistake to avoid: consumers
should parse every message with one schema and branch on `operation`.

## Observed performance

End to end, from saving an edit in AEM to the enriched payload arriving downstream:
**about 5.5 seconds**, on the first delivery attempt, with a warm action and a cached token.
