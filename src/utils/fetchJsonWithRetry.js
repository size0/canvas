const defaultWait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const TEMP_UNAVAILABLE = '\u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5';
const INVALID_RESPONSE = '\u670d\u52a1\u8fd4\u56de\u5185\u5bb9\u683c\u5f0f\u5f02\u5e38\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5';
const REQUEST_FAILED = '\u8bf7\u6c42\u5931\u8d25';

function requestError(message, retryable) {
  const error = new Error(message);
  error.retryable = retryable;
  return error;
}

function apiErrorMessage(data, status) {
  const error = data?.error;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error.message === 'string' && error.message) return error.message;
  return status >= 500
    ? `${TEMP_UNAVAILABLE} (HTTP ${status})`
    : `${REQUEST_FAILED} (HTTP ${status})`;
}

/**
 * Fetch JSON with short retries for transient proxy and network failures.
 * Intended for idempotent reads only.
 */
export async function fetchJsonWithRetry(input, init = {}, options = {}) {
  const parsedAttempts = Number(options.attempts);
  const attempts = Math.max(1, Number.isFinite(parsedAttempts) ? parsedAttempts : 3);
  const parsedDelay = Number(options.retryDelayMs);
  const retryDelayMs = Math.max(0, Number.isFinite(parsedDelay) ? parsedDelay : 300);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const wait = options.wait || defaultWait;
  let lastError = requestError(TEMP_UNAVAILABLE, true);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(input, { cache: 'no-store', ...init });
      const text = await response.text();
      let data;

      try {
        data = JSON.parse(text);
      } catch {
        const message = response.ok
          ? INVALID_RESPONSE
          : `${TEMP_UNAVAILABLE} (HTTP ${response.status})`;
        throw requestError(message, response.ok || response.status >= 500);
      }

      if (!response.ok) {
        throw requestError(apiErrorMessage(data, response.status), response.status >= 500);
      }

      return data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const retryable = lastError.retryable !== false;
      if (!retryable || attempt === attempts - 1) throw lastError;
      await wait(retryDelayMs * (attempt + 1));
    }
  }

  throw lastError;
}
