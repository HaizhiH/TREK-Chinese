/**
 * Pure helpers for the public shared-trip page (#2320). React-free, so the
 * page and its detail blocks can share them and a test can drive them
 * without rendering.
 */

/**
 * Whether a string is a link the page may render as one.
 *
 * The server already drops anything that is not http(s) (share.service.ts),
 * so this is the second gate rather than the first — the page must not become
 * the place where a `javascript:` value turns into an anchor because a future
 * payload forgot to filter it.
 */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * "45 min", "2 h", "1 h 30 min" — the planned time at a place.
 *
 * Nothing for a missing, zero or negative figure: the planner's default of an
 * hour is a default, not a plan, and the field stores what the owner typed.
 */
export function formatDurationMinutes(minutes: number | null | undefined): string | null {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return null
  const whole = Math.round(minutes)
  const h = Math.floor(whole / 60)
  const m = whole % 60
  if (h === 0) return `${m} min`
  if (m === 0) return `${h} h`
  return `${h} h ${m} min`
}

/** The hostname a booking link points at, for a label that says where it goes. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Why the share payload did not arrive (#2505).
 *
 * The share endpoint answers 404 with its JSON `{ error }` body for a token
 * that is unknown, expired or revoked, and that is the only answer that says
 * anything about the link. A 5xx while the server restarts, a rate limit, a
 * timeout or no response at all because the viewer is offline says the request
 * failed, not the link, so the page offers a retry instead of sending the
 * viewer back to the owner for a new link that would not have been needed.
 *
 * A 404 without that body is not TREK talking: a reverse proxy with no
 * upstream answers one on its own (Traefik while the container is stopped or
 * still starting, nginx with a missing location), so it counts as a failed
 * load too.
 */
export type SharedTripLoadError = 'expired' | 'unavailable'

export function sharedTripLoadError(err: unknown): SharedTripLoadError {
  const response = (err as { response?: { status?: number; data?: unknown } } | null | undefined)?.response
  if (response?.status !== 404) return 'unavailable'
  return isPlainObject(response.data) && typeof response.data.error === 'string' ? 'expired' : 'unavailable'
}

/**
 * Whether a 200 carried the share payload. An auth wall or a captive portal
 * can answer the API call with its own HTML page, which axios hands over as a
 * string; the page would crash on it, so the hook treats it as a failed load.
 */
export function isSharedTripPayload(payload: unknown): boolean {
  return isPlainObject(payload) && isPlainObject(payload.trip)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
