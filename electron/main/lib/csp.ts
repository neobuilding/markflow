// Configure CSP: permissive in dev (allows Vite HMR + React Refresh inline scripts),
// strict in production (only self-origin resources allowed).
import { session } from 'electron'

export function setupCSP(devServerUrl: string): void {
  const isDev = !!devServerUrl
  let policy: string
  if (isDev && devServerUrl) {
    // Derive the origin from VITE_DEV_SERVER_URL (e.g. http://localhost:5174)
    let origin = 'http://localhost:5174'
    let wsIp: string | undefined
    try {
      const u = new URL(devServerUrl)
      origin = `${u.protocol}//${u.host}`
      // Electron sometimes uses 127.0.0.1 instead of localhost for the HMR connection;
      // allow both so we don't miss it. Computed from the already-parsed URL object so
      // there is no second, redundant parse (and no unreachable error branch).
      if (u.hostname === 'localhost') wsIp = `ws://127.0.0.1:${u.port}`
    } catch {
      // Keep the default origin (http://localhost:5174); wsIp stays undefined.
    }
    const wsOrigin = origin.replace(/^http/, 'ws')
    policy = [
      `default-src 'self' ${origin}`,
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${origin}`,
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: ${origin} https: appdoc:`,
      "font-src 'self' data:",
      `connect-src 'self' ${origin} ${wsOrigin}${wsIp ? ' ' + wsIp : ''}`,
    ].join('; ')
  } else {
    policy = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https: appdoc:",
      "font-src 'self' data:",
      "connect-src 'self'",
    ].join('; ')
  }

  // Critical fix: do not apply our CSP to Electron's DevTools / chrome internal pages.
  // Otherwise the DevTools frontend can't connect to its CDP WebSocket (e.g.
  // ws://127.0.0.1:<debug-port>), producing a cascade of errors in the DevTools console
  // like "Refused to connect ... CSP connect-src", "Autofill.enable wasn't found",
  // and Failed to fetch.
  const isInternalChromeUrl = (url: string): boolean =>
    /^(devtools|chrome-devtools|chrome|chrome-extension):\/\//.test(url)

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (isInternalChromeUrl(details.url)) {
      // Let internal pages through as-is, without injecting CSP
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    })
  })
}
