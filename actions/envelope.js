const OPERATION_BY_EVENT_TYPE = {
  'aem.sites.contentFragment.created': 'create',
  'aem.sites.contentFragment.modified': 'update',
  'aem.sites.contentFragment.deleted': 'delete',
  'aem.sites.contentFragment.published': 'publish',
  'aem.sites.contentFragment.unpublished': 'unpublish',
  'aem.sites.contentFragment.variation': 'variation'
}

const AEM_SOURCE_PATTERN = /^acct:aem(?:-cmstg)?-p(\d+)-e(\d+)@adobe\.com$/

// Runtime merges action inputs (including secrets) into `params`, so the raw
// event must be rebuilt from known CloudEvent fields rather than copied wholesale.
const CLOUD_EVENT_FIELDS = [
  'specversion',
  'id',
  'source',
  'type',
  'datacontenttype',
  'dataschema',
  'time',
  'eventid',
  'event_id',
  'recipientclientid',
  'recipient_client_id',
  'data'
]

function pickCloudEvent (event) {
  const picked = {}
  for (const field of CLOUD_EVENT_FIELDS) {
    if (event[field] !== undefined) picked[field] = event[field]
  }
  return picked
}

function parseSource (source) {
  const match = AEM_SOURCE_PATTERN.exec(source || '')
  if (!match) return { program: null, environment: null }
  return { program: match[1], environment: match[2] }
}

/**
 * The unpublish event's actor is the internal `workflow-process-service`, which
 * carries neither an imsUserId nor a displayName, so every field is optional.
 */
function buildActor (user) {
  if (!user) return null
  return {
    principalId: user.principalId || null,
    displayName: user.displayName || null,
    imsUserId: user.imsUserId || null
  }
}

/**
 * Normalises an AEM content fragment CloudEvent into a single downstream-facing
 * shape that is identical across all six event types.
 */
function toEnvelope ({ event, content, contentUnavailableReason, authorHost, retryCount, includeRawEvent }) {
  const data = event.data || {}
  const { program, environment } = parseSource(event.source)

  const envelope = {
    operation: OPERATION_BY_EVENT_TYPE[event.type] || 'unknown',
    eventType: event.type,
    eventId: event.eventid || event.event_id || event.id,
    occurredAt: event.time,
    source: {
      program,
      environment,
      // Publish and unpublish events report the publish host in sourceUrl, so
      // the authoritative host for API calls comes from configuration only.
      tier: data.tier || 'author',
      host: authorHost,
      eventSourceUrl: data.sourceUrl || null
    },
    fragment: {
      id: data.id || null,
      path: data.path || null,
      model: data.model || null,
      tags: data.tags || []
    },
    changedProperties: data.properties || null,
    variation: data.variationName
      ? { name: data.variationName, changeSubType: data.changeSubType || null }
      : null,
    content: content || null,
    contentUnavailableReason: contentUnavailableReason || null,
    actor: buildActor(data.user),
    deliveryAttempt: retryCount
  }

  if (includeRawEvent) {
    envelope._rawEvent = pickCloudEvent(event)
  }

  return envelope
}

module.exports = { toEnvelope, OPERATION_BY_EVENT_TYPE, parseSource }
