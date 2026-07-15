import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fetchJsonWithRetry } from '../src/utils/fetchJsonWithRetry.js';

const noWait = async () => {};

describe('fetchJsonWithRetry', () => {
  it('returns JSON from a successful response', async () => {
    const value = [{ id: 'builtin-general-commerce' }];
    const fetchImpl = async () => new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    assert.deepEqual(
      await fetchJsonWithRetry('/api/product-templates', {}, { fetchImpl, wait: noWait }),
      value,
    );
  });

  it('retries a Vercel plain-text error and returns the next JSON response', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('An error occurred with this application', {
          status: 502,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      return new Response(JSON.stringify([{ id: 'recovered' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const result = await fetchJsonWithRetry('/api/product-templates', {}, { fetchImpl, wait: noWait });

    assert.equal(calls, 2);
    assert.deepEqual(result, [{ id: 'recovered' }]);
  });

  it('retries network failures', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('fetch failed');
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    assert.deepEqual(
      await fetchJsonWithRetry('/api/product-templates', {}, { fetchImpl, wait: noWait }),
      { ok: true },
    );
    assert.equal(calls, 3);
  });

  it('does not retry a valid JSON client error', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response('{"error":"参数错误"}', {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await assert.rejects(
      fetchJsonWithRetry('/api/product-templates', {}, { fetchImpl, wait: noWait }),
      /参数错误/,
    );
    assert.equal(calls, 1);
  });

  it('reports a readable error after repeated non-JSON responses', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response('An error occurred with this application', {
        status: 502,
        headers: { 'Content-Type': 'text/plain' },
      });
    };

    await assert.rejects(
      fetchJsonWithRetry('/api/product-templates', {}, { fetchImpl, wait: noWait }),
      /服务暂时不可用，请稍后重试/,
    );
    assert.equal(calls, 3);
  });
});
