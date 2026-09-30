# Playbook: AEM event to a Runtime action that acts on it

Step-by-step build of the integration described in `FINDINGS.md`, starting from nothing
installed. Content fragments are the worked example; the same steps apply to other AEM
event types.

Read `FINDINGS.md` first if you want to know *why* any given step is the way it is.

**Time**: roughly half a day, most of it waiting on Cloud Manager and Admin Console.

## Values you will collect

Fill these in as you go. Example values shown.

| Value | Example | Collected in |
|---|---|---|
| Program / environment | `p12345` / `e67890` | Prerequisites |
| Environment type | `dev` | Step 5 |
| Console org id | `11111` | Step 2 |
| Console project id | `4566206088345738718` | Step 2 |
| Stage workspace id | `4566206088345780902` | Step 2 |
| Runtime namespace | `11111-myproject-stage` | Step 2 |
| OAuth client id | `abcdef0123456789abcdef0123456789` | Step 3 |
| OAuth client secret | (secret) | Step 3 |
| Scope string | `AdobeID,openid,...,aem.fragments.management` | Step 3 |
| Author host | `https://author-p12345-e67890.adobeaemcloud.com` | Prerequisites |

## Prerequisites

- **AEM as a Cloud Service.** Eventing is not available on 6.5 or Managed Services.
- **App Builder entitlement.** Verify before anything else (step 2). Without it, stop —
  you would need a self-hosted webhook receiver instead.
- **Admin rights** on an AEM product profile for the target environment, and Cloud Manager
  rights to create and run a pipeline.
- A **destination** the action can reach. Not a public request bin — see step 8.

---

## Step 1 — Install the CLI on an even-numbered Node LTS

```bash
nvm install 22 && nvm use 22 && nvm alias default 22
npm install -g @adobe/aio-cli
aio login
```

Verify, in a **new** terminal:

```bash
node --version    # v22.x
which aio         # must be under the v22 path
aio console org list
```

> If `aio` disappears after switching Node versions, reinstall it. It lives in a specific
> version's bin directory. Avoid odd-numbered Node releases.

## Step 2 — Confirm entitlement, then create the Console project

Entitlement check — a workspace must have a Runtime namespace:

```bash
aio console org list
aio console project list --orgId 11111
aio console ws list --orgId 11111 --projectId <existing-project-id> -j
```

Look for `"runtime_enabled": true` with a non-empty `"runtime_namespace"`. That is the only
reliable signal. If every workspace lacks it, the org has no App Builder entitlement.

Create the project (**alphanumeric name only**):

```bash
aio console org select 11111
aio console project create -n myproject --title "My Project" -j
aio console ws list --orgId 11111 --projectId <new-project-id> -j
```

You should see Production and Stage, each with a namespace. Select Stage:

```bash
aio console project select <project-id>
aio console ws select <stage-workspace-id>
```

> Use Stage and keep Production free. Each workspace has its **own** client id, and that id
> goes into the AEM allowlist — promoting later means adding a second entry.

## Step 3 — Add services and collect credentials

`aio console project create` creates no credential, so this part is Console-only.

In [Developer Console](https://developer.adobe.com/console), open the project, select the
**Stage** workspace, then:

1. **Add Service → API → I/O Management API**, choosing **OAuth Server-to-Server**. This
   creates the workspace credential everything else hangs off.
2. **Add Service → API → AEM CS Sites Content Management**, attaching the **author** product
   profile for your environment. This one card covers content fragments and folders.
3. From the credential page, copy the **Client ID** and the complete **Scopes** string.

Copy the scope string verbatim. Adobe publishes no scopes table.

> If Server-to-Server is not offered, you are not a **Developer** on the product profile.
> Fix that in Admin Console first.

Verify:

```bash
aio console ws select <stage-workspace-id>   # re-select to pull credentials down
aio event provider list
```

An error saying the workspace has no OAuth credential means step 3 did not take.

## Step 4 — Enable your role for AEM eventing

In [Admin Console](https://adminconsole.adobe.com): **Products → Adobe Experience Manager as
a Cloud Service →** select your environment **→** open a product profile where you are an
admin.

Without this the environment will not appear in the event wizard in step 7.

## Step 5 — Allowlist the client id on AEM

Required for the action to call any AEM API. Clone the **Cloud Manager–managed** repo
(`git.cloudmanager.adobe.com/<org-slug>/<repo>`), not your front-end repo.

> Confirm the repo belongs to the right program in Cloud Manager under Program Settings →
> Git. The URL encodes the organisation slug, not the program id.

Create `config/api.yaml`:

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

- Literal client id. Environment variables and secret references are not supported.
- `envTypes` must match the environment type, or it deploys and silently does not load.

Commit and push, then in Cloud Manager: **Add Pipeline → Deployment Pipeline →** Source Code
tab **→ "I am using Targeted deployment" →** Include: **Config**, branch and code location
`/config`. Run it.

> Full-stack and web-tier pipelines will **not** deploy this file.

Verify before writing any code:

```bash
TOKEN=$(curl -s -X POST https://ims-na1.adobelogin.com/ims/token/v3 \
  -d grant_type=client_credentials \
  -d client_id=abcdef0123456789abcdef0123456789 \
  -d client_secret="$CLIENT_SECRET" \
  -d 'scope=<paste scope string>' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

curl -s -o /dev/null -w '%{http_code}\n' \
  "https://author-p12345-e67890.adobeaemcloud.com/adobe/sites/cf/fragments?path=/content/dam/example" \
  -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json'
```

`200` means the allowlist landed. `403` means it did not — check the pipeline ran and used a
targeted deployment. `404` is fine: authentication worked, the path just has nothing in it.

## Step 6 — Scaffold the app

```bash
mkdir myproject-events && cd myproject-events && git init
aio app init . -o 11111 -p myproject -w Stage -t @adobe/generator-app-events-generic -y --linter basic
```

The template will prompt for an action name even with `-y`. Let it finish or interrupt it —
you are going to write `app.config.yaml` and the action by hand anyway, which is faster than
fighting the generator and gives you the correct annotations directly.

Confirm `.gitignore` covers `.env*` and `.aio`. Both contain secrets.

Add dependencies:

```bash
npm install @adobe/aio-sdk @adobe/aio-lib-state
```

`app.config.yaml`:

```yaml
application:
  actions: actions
  runtimeManifest:
    packages:
      my-events:
        license: Apache-2.0
        actions:
          event-processor:
            function: actions/event-processor/index.js
            web: 'no'                  # required for Runtime action delivery
            runtime: nodejs:22
            inputs:
              LOG_LEVEL: debug
              AEM_AUTHOR_HOST: $AEM_AUTHOR_HOST
              DESTINATION_URL: $DESTINATION_URL
              IMS_CLIENT_ID: $IMS_OAUTH_S2S_CLIENT_ID
              IMS_CLIENT_SECRET: $IMS_OAUTH_S2S_CLIENT_SECRET
              IMS_SCOPES: $IMS_OAUTH_S2S_SCOPES
              MAX_RETRIES: 3
            annotations:
              require-adobe-auth: false
              final: true
```

Append to `.env`:

```
AEM_AUTHOR_HOST=https://author-p12345-e67890.adobeaemcloud.com
DESTINATION_URL=<see step 8>
```

## Step 7 — Capture real event payloads before writing logic

Do this first. It proves entitlement and event flow with zero code, and it gives you fixtures.

In Console, **Add Service → Event → Experience Cloud → AEM Sites**, select your environment,
subscribe to **all** available event types, accept the pre-selected OAuth Server-to-Server
card, and set delivery to **Webhook** pointing at a request bin.

> A request bin works here because Adobe's *event* infrastructure reaches it — that is a
> different egress path from your action. Your action will not be able to reach it (step 8).

Verify:

```bash
aio event registration list       # WEBHOOK_STATUS should reach "verified"
```

If it sits at `verification_pending`, the bin returned 200 without echoing the `challenge`
query parameter. Adobe then posts a one-time validation URL to the bin; open it within
**five minutes**. Re-save the registration in Console to trigger a fresh one.

Now perform each operation in AEM against throwaway content in a dedicated folder such as
`/content/dam/events-poc/`. Save each payload as a fixture in `test/fixtures/`.

Do the destructive operation last, and record the exact event type strings you observe —
they do not always match the documentation.

## Step 8 — Choose a destination the action can actually reach

Public request bins (`webhook.site`, RequestBin, ngrok, pipedream, postman-echo) time out
from Runtime with `ETIMEDOUT`. See `FINDINGS.md` §7.

For a POC, deploy a second **web** action as the sink and point `DESTINATION_URL` at
`https://<namespace>.adobeioruntime.net/api/v1/web/my-events/event-sink`.

Because web-action activations do not appear in `aio rt activation list`, have the sink
persist what it receives:

```javascript
const state = await stateLib.init()
await state.put('last-received',
  JSON.stringify({ receivedAt: new Date().toISOString(), envelope }), { ttl: 86400 })
```

If your real destination is external, get its owner to allowlist Runtime's egress ranges:

```bash
aio runtime ip-list get     # requires accepting terms and a contact email on first use
```

## Step 9 — Write the action

Shape, with the non-obvious parts marked:

```javascript
const { Core } = require('@adobe/aio-sdk')

async function main (params) {
  const logger = Core.Logger('event-processor', { level: params.LOG_LEVEL || 'info' })

  // 1. Challenge probe — must echo, as JSON, with 200.
  if (params.challenge) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
             body: { challenge: params.challenge } }
  }

  // 2. Delivery metadata. x-adobe-retry-count is absent on the first attempt.
  const headers = params.__adobe_headers || {}
  const eventId = headers['x-adobe-event-id']
  const retryCount = Number(headers['x-adobe-retry-count'] || 0)
  if (retryCount >= Number(params.MAX_RETRIES || 3)) {
    return { statusCode: 400, body: { error: 'retry budget exhausted' } }   // stop, don't 500
  }

  // 3. Map event type to your own operation vocabulary; tolerate unknown types.
  const operation = OPERATION_BY_EVENT_TYPE[params.type]
  if (!operation) return { statusCode: 400, body: { error: `unsupported type ${params.type}` } }

  // 4. Enrich, unless the resource is gone by definition.
  let content = null, reason = null
  if (operation === 'delete') {
    reason = 'resource deleted, content unavailable'
  } else {
    const token = await getImsToken(params, logger)          // cached in State
    // Host comes from config. NEVER from data.sourceUrl — it points at publish for
    // publish/unpublish events, where the management API is disabled.
    const res = await fetch(
      `${params.AEM_AUTHOR_HOST}/adobe/sites/cf/fragments/${params.data.id}?references=direct-hydrated`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000) })

    if (res.ok) content = await res.json()
    else if (res.status === 404) reason = 'not found at fetch time, likely already deleted'
    else {
      if (res.status === 401 || res.status === 403) await clearImsToken(logger)  // or it re-fails all day
      return { statusCode: 500, body: { error: `AEM returned ${res.status}` } }  // retryable
    }
  }

  // 5. Build ONE envelope shape for every operation. Never serialise `params` —
  //    it contains your secrets.
  const envelope = toEnvelope({ event: params, content, contentUnavailableReason: reason,
                                authorHost: params.AEM_AUTHOR_HOST, retryCount })

  // 6. Wrap outbound calls: connection failures throw, they do not return a response.
  try {
    const delivery = await fetch(params.DESTINATION_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope), signal: AbortSignal.timeout(8000) })
    if (!delivery.ok) return { statusCode: 500, body: { error: `destination ${delivery.status}` } }
  } catch (e) {
    return { statusCode: 500, body: { error: 'destination unreachable' } }
  }

  return { statusCode: 200, body: { message: 'processed', operation, eventId } }
}

exports.main = main
```

Status code discipline is what keeps your registration alive — see `FINDINGS.md` §13.

## Step 10 — Deploy and test against fixtures

```bash
npm run lint
aio app deploy --no-publish

aio rt action invoke my-events/event-processor --param-file test/fixtures/challenge.json --result
aio rt action invoke my-events/event-processor --param-file test/fixtures/created.json --result
```

> Do not combine `--param-file` with `--param`. It fails with "reserved properties" and looks
> like nothing ran.

Expect `{"challenge": "..."}` for the probe and `statusCode: 200` for the others. Read logs
with `aio rt activation logs <id>`; get ids via `aio rt activation list`.

Before going live, grep one envelope for your client secret. If it is there, you serialised
`params` — fix it and **rotate the credential**.

## Step 11 — Cut over to Runtime action delivery

In Console, edit the registration, choose **Runtime action** under *How to receive events*,
select your action, and Save.

> An empty dropdown means the action is web, is deployed to a different workspace, or the
> page needs a refresh. Only non-web actions are listed.

Verify with `aio event registration get <registration-id> -j` and look at **`runtime_action`**:

```json
{ "delivery_type": "webhook",
  "runtime_action": "my-events/event-processor",
  "webhook_url": "https://runtime.adobe.io/api/v1/web/.../acp/sync_event_handler_XXXX?sync=true&id=XXXX" }
```

`delivery_type` stays `webhook` — that is correct and expected. Console's registration detail
should read "Event Delivery Method: Runtime action".

## Step 12 — Verify with a live event

Clear the sink's state key so any new entry is unambiguous:

```bash
aio app state list
aio app state delete last-received
```

Make a real change in AEM, wait a few seconds, then:

```bash
aio app state list
aio app state get last-received
```

You should see your change reflected in `content`. Expect roughly 5 seconds end to end.

**Do not** use `aio rt activation list` as your evidence. Events delivered through Adobe's
handler do not appear there, and it will look like total failure while everything works.

If nothing arrives, check the **Debug Tracing** tab on the registration in Console. That is
Adobe's own record of delivery attempts and distinguishes "AEM never emitted" from "delivery
attempted and the handler errored".

---

## Before calling it production-ready

| Gap | What to do |
|---|---|
| Duplicate deliveries | Deduplicate on `x-adobe-event-id`, stable across retries |
| Missed events | Poll the Journaling API (7-day retention). There is no SLA |
| Sink is publicly invocable | Add authentication, or make it non-web and invoke via the `openwhisk` module |
| Secrets in `.env` | Move to a managed secret store; confirm `.env*` is gitignored |
| Production workspace | Its client id differs — add it to `allowedClientIDs` |
| Point-in-time accuracy | Fetches return current state; add versioning if that matters |
| Sandbox hibernation | Eight hours idle. De-hibernate before demos |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Runtime action dropdown is empty | Action is `web: 'yes'`, wrong workspace, or page needs refresh |
| `403` from AEM | Client id not allowlisted, or config pipeline was not a targeted deployment |
| `404` from AEM | Authentication is fine; resource genuinely missing |
| `ETIMEDOUT` on the destination | Destination is filtered from Runtime egress. Use a reachable sink |
| Registration stuck `verification_pending` | Challenge not echoed. Open the async validation URL within 5 minutes |
| `no oAuth Server-to-Server credential` | Services not added to the workspace |
| `An AUTH key must be specified` | No workspace selected locally, or no credential yet |
| No activations after a live event | Expected. Web-invoked activations are not listed — check State or Debug Tracing |
| Registration Disabled | Too many failures in 24h. Fix, then re-save the registration to re-enable |
| Config deployed but no effect | `metadata.envTypes` does not match the environment type |
