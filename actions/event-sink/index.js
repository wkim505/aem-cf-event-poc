const { Core } = require('@adobe/aio-sdk')
const stateLib = require('@adobe/aio-lib-state')

const RECEIVED_TTL_SECONDS = 86400

/**
 * Stands in for the downstream system the content fragment content is pushed
 * to. It exists because public request bins (webhook.site and similar) are
 * unreachable from I/O Runtime egress; swap this out for the real destination.
 */
async function main (params) {
  const logger = Core.Logger('event-sink', { level: params.LOG_LEVEL || 'info' })

  // Runtime injects its own params alongside the POSTed body.
  const envelope = { ...params }
  delete envelope.LOG_LEVEL
  delete envelope.__ow_method
  delete envelope.__ow_headers
  delete envelope.__ow_path
  delete envelope.__ow_body
  delete envelope.__ow_query

  logger.info(`Received ${envelope.operation} for fragment ${envelope.fragment && envelope.fragment.id}`)
  logger.info(JSON.stringify(envelope, null, 2))

  // Persisted because activations for web actions do not show up in
  // `aio rt activation list`, leaving no other way to inspect a live delivery.
  try {
    const state = await stateLib.init()
    const record = JSON.stringify({ receivedAt: new Date().toISOString(), envelope })
    await state.put('last-received', record, { ttl: RECEIVED_TTL_SECONDS })
    if (envelope.operation) {
      await state.put(`last-received-${envelope.operation}`, record, { ttl: RECEIVED_TTL_SECONDS })
    }
  } catch (e) {
    logger.warn(`Could not persist received envelope: ${e.message}`)
  }

  return {
    statusCode: 200,
    body: {
      received: true,
      operation: envelope.operation || null,
      eventId: envelope.eventId || null,
      fragmentPath: envelope.fragment ? envelope.fragment.path : null,
      hasContent: Boolean(envelope.content)
    }
  }
}

exports.main = main
