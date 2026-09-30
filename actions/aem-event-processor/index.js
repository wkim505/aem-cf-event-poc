const { Core } = require('@adobe/aio-sdk')
const { getImsToken, clearImsToken } = require('../ims')
const { toEnvelope, OPERATION_BY_EVENT_TYPE } = require('../envelope')

// Fail fast rather than burning the 60s I/O Events delivery window on a hang.
const OUTBOUND_TIMEOUT_MS = 8000

function isTruthy (value) {
  return value === true || value === 'true'
}

/**
 * Adobe I/O Events retries on 429 and 5xx, and does not retry anything else.
 * A registration with >=10 attempts and >=80% failures in 24h goes Unstable and
 * then Disabled, so 5xx is reserved for failures a retry could actually fix.
 */
function retryable (message) {
  return { statusCode: 500, body: { error: message } }
}

function permanent (message) {
  return { statusCode: 400, body: { error: message } }
}

async function fetchFragment (authorHost, fragmentId, token) {
  const url = `${authorHost}/adobe/sites/cf/fragments/${fragmentId}?references=direct-hydrated`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS)
  })
  return { status: res.status, ok: res.ok, body: res.ok ? await res.json() : await res.text() }
}

async function main (params) {
  const logger = Core.Logger('aem-event-processor', { level: params.LOG_LEVEL || 'info' })

  // I/O Events validates a registration by probing the action with a challenge.
  if (params.challenge) {
    logger.info('Responding to challenge probe')
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { challenge: params.challenge }
    }
  }

  const headers = params.__adobe_headers || {}
  const eventId = headers['x-adobe-event-id'] || params.eventid || params.event_id
  const retryCount = headers['x-adobe-retry-count'] ? Number(headers['x-adobe-retry-count']) : 0
  const maxRetries = Number(params.MAX_RETRIES || 3)

  if (retryCount >= maxRetries) {
    logger.warn(`Abandoning event ${eventId} after ${retryCount} retries`)
    return permanent(`Exceeded ${maxRetries} retry attempts`)
  }

  const eventType = params.type
  const operation = OPERATION_BY_EVENT_TYPE[eventType]
  if (!operation) {
    logger.warn(`Ignoring unrecognised event type: ${eventType}`)
    return permanent(`Unsupported event type: ${eventType}`)
  }

  const fragmentId = params.data && params.data.id
  if (!fragmentId) {
    return permanent('Event payload has no data.id')
  }

  logger.info(`Processing ${operation} for fragment ${fragmentId} (event ${eventId}, attempt ${retryCount})`)

  let content = null
  let contentUnavailableReason = null

  if (operation === 'delete') {
    contentUnavailableReason = 'fragment deleted, content unavailable'
  } else {
    let token
    try {
      token = await getImsToken(params, logger)
    } catch (e) {
      logger.error(`IMS token exchange failed: ${e.message}`)
      return retryable('Could not obtain an IMS access token')
    }

    let result
    try {
      result = await fetchFragment(params.AEM_AUTHOR_HOST, fragmentId, token)
    } catch (e) {
      // A hibernated sandbox surfaces here as a connection failure rather than an HTTP status.
      logger.error(`Could not reach AEM author: ${e.cause ? e.cause.code || e.cause.message : e.message}`)
      return retryable('AEM author unreachable')
    }

    if (result.ok) {
      content = result.body
    } else if (result.status === 404) {
      // Deleting a fragment also emits a variation event ~1ms earlier, so a
      // variation event routinely arrives for a fragment that is already gone.
      // Nothing to retry toward; forward the tombstone instead.
      logger.warn(`Fragment ${fragmentId} not found; forwarding without content`)
      contentUnavailableReason = 'fragment not found at fetch time, likely already deleted'
    } else {
      logger.error(`AEM returned ${result.status}: ${result.body}`)
      if (result.status === 401 || result.status === 403) {
        await clearImsToken(logger)
      }
      return retryable(`AEM Content Fragment API returned ${result.status}`)
    }
  }

  const envelope = toEnvelope({
    event: params,
    content,
    contentUnavailableReason,
    authorHost: params.AEM_AUTHOR_HOST,
    retryCount,
    includeRawEvent: isTruthy(params.INCLUDE_RAW_EVENT)
  })

  logger.debug(`Envelope: ${JSON.stringify(envelope)}`)

  let delivery
  try {
    delivery = await fetch(params.DESTINATION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS)
    })
  } catch (e) {
    // Connection-level failures (DNS, timeout) surface as TypeError, not a response.
    logger.error(`Could not reach destination: ${e.cause ? e.cause.code || e.cause.message : e.message}`)
    return retryable('Destination unreachable')
  }

  if (!delivery.ok) {
    logger.error(`Destination returned ${delivery.status}`)
    return retryable(`Destination returned ${delivery.status}`)
  }

  logger.info(`Delivered ${operation} for fragment ${fragmentId}`)
  return {
    statusCode: 200,
    body: { message: 'Event processed', operation, eventId, fragmentId }
  }
}

exports.main = main
