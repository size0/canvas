const defaultWait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function requestError(message, retryable) {
  const error = new Error(message);
  error.retryable = retryable;
  return error;
}

/**
 * Fetch JSON with short retries for transient proxy and network failures.
 * Intended for idempotent reads only.
 */
export async function fetchJsonWithRetry(input, init = {}, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 3);
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs) || 300);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const wait = options.wait || defaultWait;
  let lastError = requestError('服务暂时不可用，请稍后重试', true);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(input, { cache: 'no-store', ...init });
      const text = await response.text();
      let data;

      try {
        data = JSON.parse(text);
      } catch {
        throw requestError(
          response.ok ? '服务返回内容格式异常，请稍后重试' : '服务暂时不可用，请稍后重试',
          true,
        );
      }

      if (!response.ok) {
        throw requestError(
          data?.error || (response.status >= 500 ? '服务暂时不可用，请稍后重试' : `请求失败 (${response.status})`),
          response.status >= 500,
        );
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
