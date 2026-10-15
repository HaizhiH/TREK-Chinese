import { describe, it, expect } from 'vitest'
import { AxiosError, AxiosHeaders } from 'axios'
import { formatDurationMinutes, isHttpUrl, isSharedTripPayload, linkHost, sharedTripLoadError } from './sharedTripModel'

describe('sharedTripModel (#2320)', () => {
  it('accepts http and https and nothing else', () => {
    expect(isHttpUrl('https://a.example/x')).toBe(true)
    expect(isHttpUrl(' http://a.example ')).toBe(true)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('data:text/html,hi')).toBe(false)
    expect(isHttpUrl('ftp://a.example')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
    expect(isHttpUrl('')).toBe(false)
    expect(isHttpUrl(null)).toBe(false)
    expect(isHttpUrl(42)).toBe(false)
  })

  it('writes a planned stay as minutes, hours, or both', () => {
    expect(formatDurationMinutes(45)).toBe('45 min')
    expect(formatDurationMinutes(60)).toBe('1 h')
    expect(formatDurationMinutes(150)).toBe('2 h 30 min')
    expect(formatDurationMinutes(89.6)).toBe('1 h 30 min')
  })

  it('writes nothing for a missing, zero or nonsense figure', () => {
    expect(formatDurationMinutes(null)).toBeNull()
    expect(formatDurationMinutes(undefined)).toBeNull()
    expect(formatDurationMinutes(0)).toBeNull()
    expect(formatDurationMinutes(-5)).toBeNull()
    expect(formatDurationMinutes(Number.NaN)).toBeNull()
  })

  it('labels a link by its host, without the www', () => {
    expect(linkHost('https://www.bahn.example/booking/abc')).toBe('bahn.example')
    expect(linkHost('https://booking.example')).toBe('booking.example')
    expect(linkHost('nonsense')).toBe('nonsense')
  })
})

describe('sharedTripLoadError (#2505)', () => {
  // What the share endpoint sends for an unknown, expired or revoked token.
  const ENDPOINT_404 = { error: 'Invalid or expired link' }

  const answered = (status: number, data: unknown = ENDPOINT_404) =>
    new AxiosError('Request failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
      status,
      statusText: '',
      data,
      headers: {},
      config: { headers: new AxiosHeaders() },
    })

  it('calls only the endpoint 404 an expired link', () => {
    expect(sharedTripLoadError(answered(404))).toBe('expired')
  })

  it('treats every other answer as a failed load', () => {
    for (const status of [400, 401, 403, 408, 429, 500, 502, 503, 504]) {
      expect(sharedTripLoadError(answered(status))).toBe('unavailable')
    }
  })

  it('does not take a 404 without the TREK error body for an expired link', () => {
    // Traefik with the container stopped or still starting, nginx, an empty
    // answer: a 404 from something in front of TREK says nothing about the token.
    expect(sharedTripLoadError(answered(404, '404 page not found\n'))).toBe('unavailable')
    expect(sharedTripLoadError(answered(404, '<html><body><h1>404 Not Found</h1></body></html>'))).toBe('unavailable')
    expect(sharedTripLoadError(answered(404, ''))).toBe('unavailable')
    expect(sharedTripLoadError(answered(404, null))).toBe('unavailable')
    expect(sharedTripLoadError(answered(404, {}))).toBe('unavailable')
    expect(sharedTripLoadError(answered(404, [{ error: 'x' }]))).toBe('unavailable')
    expect(sharedTripLoadError(answered(404, { error: 404 }))).toBe('unavailable')
  })

  it('treats a request without any answer as a failed load', () => {
    expect(sharedTripLoadError(new AxiosError('Network Error', AxiosError.ERR_NETWORK))).toBe('unavailable')
    expect(sharedTripLoadError(new AxiosError('timeout of 8000ms exceeded', AxiosError.ECONNABORTED))).toBe('unavailable')
    expect(sharedTripLoadError(new TypeError('Failed to fetch'))).toBe('unavailable')
    expect(sharedTripLoadError(undefined)).toBe('unavailable')
    expect(sharedTripLoadError(null)).toBe('unavailable')
  })
})

describe('isSharedTripPayload (#2505)', () => {
  it('accepts what the share endpoint sends', () => {
    expect(isSharedTripPayload({ trip: { id: 1, title: 'Lisbon' }, days: [], permissions: {} })).toBe(true)
  })

  it('rejects a 200 that is not the share payload', () => {
    // An auth wall or a captive portal answering the API call with its own page.
    expect(isSharedTripPayload('<!doctype html><html><body>Sign in</body></html>')).toBe(false)
    expect(isSharedTripPayload('')).toBe(false)
    expect(isSharedTripPayload(null)).toBe(false)
    expect(isSharedTripPayload(undefined)).toBe(false)
    expect(isSharedTripPayload([])).toBe(false)
    expect(isSharedTripPayload({})).toBe(false)
    expect(isSharedTripPayload({ trip: null })).toBe(false)
    expect(isSharedTripPayload({ trip: 'Lisbon' })).toBe(false)
  })
})
