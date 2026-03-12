/**
 * content_jwt_capture.js — MAIN world
 * Stripchat APIリクエストからJWTを傍受し、content scriptに転送する。
 * manifest.json で world: "MAIN" として登録。
 */
(function() {
  'use strict';

  const LOG = '[LS-JWT]';
  let lastCapturedJwt = null;

  // ============================================================
  // 1. XMLHttpRequest monkey-patch
  // ============================================================
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (name === 'Authorization' && typeof value === 'string' && value.startsWith('Bearer ')) {
      const token = value.slice(7);
      if (token !== lastCapturedJwt && token.length > 50) {
        lastCapturedJwt = token;
        console.log(LOG, 'JWT captured from XHR');
        window.postMessage({
          type: 'LS_JWT_CAPTURED',
          jwt: token,
          source: 'xhr',
          timestamp: Date.now(),
        }, '*');
      }
    }
    return origSetRequestHeader.call(this, name, value);
  };

  // ============================================================
  // 2. fetch monkey-patch
  // ============================================================
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      const headers = init?.headers;
      if (headers) {
        let authValue = null;
        if (headers instanceof Headers) {
          authValue = headers.get('Authorization');
        } else if (typeof headers === 'object') {
          // Could be plain object or array of [key, value] pairs
          if (Array.isArray(headers)) {
            const found = headers.find(([k]) => k === 'Authorization' || k === 'authorization');
            if (found) authValue = found[1];
          } else {
            authValue = headers['Authorization'] || headers['authorization'];
          }
        }

        if (authValue && typeof authValue === 'string' && authValue.startsWith('Bearer ')) {
          const token = authValue.slice(7);
          if (token !== lastCapturedJwt && token.length > 50) {
            lastCapturedJwt = token;
            console.log(LOG, 'JWT captured from fetch');
            window.postMessage({
              type: 'LS_JWT_CAPTURED',
              jwt: token,
              source: 'fetch',
              timestamp: Date.now(),
            }, '*');
          }
        }
      }
    } catch (e) {
      // Don't break fetch
    }
    return origFetch.apply(this, arguments);
  };

  // ============================================================
  // 3. CSRF extraction from window.__logger
  // ============================================================
  const CSRF_LOG = '[LS-CSRF]';
  let lastCsrfToken = null;

  function extractCsrf() {
    try {
      const params = window.__logger?.kibanaLogger?.api?.csrfParams;
      if (params?.csrfToken && params.csrfToken !== lastCsrfToken) {
        lastCsrfToken = params.csrfToken;
        console.log(CSRF_LOG, 'CSRF captured from __logger');
        window.postMessage({
          type: 'LS_CSRF_CAPTURED',
          csrfToken: params.csrfToken,
          csrfTimestamp: params.csrfTimestamp || null,
          csrfNotifyTimestamp: params.csrfNotifyTimestamp || null,
          timestamp: Date.now(),
        }, '*');
        return true;
      }
    } catch {}
    return false;
  }

  // Try immediately, then retry with delays (JS may not be loaded yet)
  if (!extractCsrf()) {
    const delays = [1000, 3000, 5000, 10000];
    delays.forEach(d => setTimeout(extractCsrf, d));
  }

  console.log(LOG, 'JWT + CSRF capture initialized (MAIN world)');
})();
