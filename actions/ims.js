const stateLib = require('@adobe/aio-lib-state')

const IMS_TOKEN_ENDPOINT = 'https://ims-na1.adobelogin.com/ims/token/v3'
const STATE_KEY = 'ims-access-token'

// Refresh early so a token can't expire mid-delivery.
const EXPIRY_SAFETY_MARGIN_SECONDS = 120

function normaliseScopes (scopes) {
  if (Array.isArray(scopes)) return scopes.join(',')
  if (typeof scopes !== 'string') return ''
  const trimmed = scopes.trim()
  if (trimmed.startsWith('[')) return JSON.parse(trimmed).join(',')
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean).join(',')
}

async function requestToken (clientId, clientSecret, scopes) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: normaliseScopes(scopes)
  })

  const res = await fetch(IMS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`IMS token request failed with ${res.status}: ${detail}`)
  }

  return res.json()
}

/**
 * Returns an OAuth Server-to-Server access token, cached in App Builder State
 * so a burst of events doesn't trigger a token exchange each time.
 */
async function getImsToken (params, logger) {
  let state
  try {
    state = await stateLib.init()
    const cached = await state.get(STATE_KEY)
    if (cached && cached.value) {
      logger.debug('Using cached IMS token')
      return cached.value
    }
  } catch (e) {
    // State is a cache, not a dependency: a failure here costs latency, not correctness.
    logger.warn(`State unavailable, falling back to a fresh token: ${e.message}`)
  }

  logger.debug('Requesting new IMS token')
  const token = await requestToken(params.IMS_CLIENT_ID, params.IMS_CLIENT_SECRET, params.IMS_SCOPES)

  if (state) {
    const ttl = Math.max(60, Number(token.expires_in) - EXPIRY_SAFETY_MARGIN_SECONDS)
    try {
      await state.put(STATE_KEY, token.access_token, { ttl })
    } catch (e) {
      logger.warn(`Could not cache IMS token: ${e.message}`)
    }
  }

  return token.access_token
}

/**
 * Drops the cached token so the next call re-exchanges. Without this, a token
 * that stops being accepted (for example after a client secret rotation) would
 * keep being served from cache until its TTL expired.
 */
async function clearImsToken (logger) {
  try {
    const state = await stateLib.init()
    await state.delete(STATE_KEY)
    logger.info('Cleared cached IMS token')
  } catch (e) {
    logger.warn(`Could not clear cached IMS token: ${e.message}`)
  }
}

module.exports = { getImsToken, clearImsToken, normaliseScopes }
