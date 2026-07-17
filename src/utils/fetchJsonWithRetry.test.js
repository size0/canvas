import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchJsonWithRetry } from './fetchJsonWithRetry.js';

function response(body, status = 200, contentType = 'application/json') {
    return new Response(body, {
        status,
        headers: { 'Content-Type': contentType },
    });
}

test('retries a temporary non-JSON response and returns the next JSON payload', async () => {
    let calls = 0;
    const data = await fetchJsonWithRetry('/api/settings', undefined, {
        attempts: 3,
        retryDelayMs: 0,
        fetchImpl: async () => {
            calls++;
            if (calls === 1) return response('An error occurred with your deployment', 500, 'text/plain');
            return response(JSON.stringify({ settings: { GEN_CONCURRENCY: '3' } }));
        },
    });

    assert.equal(calls, 2);
    assert.equal(data.settings.GEN_CONCURRENCY, '3');
});

test('reports a safe error after repeated non-JSON responses', async () => {
    await assert.rejects(
        fetchJsonWithRetry('/api/settings', undefined, {
            attempts: 2,
            retryDelayMs: 0,
            fetchImpl: async () => response('An error occurred with secret diagnostic text', 500, 'text/plain'),
        }),
        (error) => {
            assert.match(error.message, /HTTP 500/);
            assert.doesNotMatch(error.message, /secret diagnostic text/);
            return true;
        },
    );
});

test('preserves a JSON API error message', async () => {
    await assert.rejects(
        fetchJsonWithRetry('/api/settings', undefined, {
            attempts: 1,
            retryDelayMs: 0,
            fetchImpl: async () => response(JSON.stringify({ error: 'settings unavailable' }), 503),
        }),
        /settings unavailable/,
    );
});
