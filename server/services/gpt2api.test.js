import assert from 'node:assert/strict';
import test from 'node:test';

import { generateGpt2apiImage } from './gpt2api.js';

function jsonResponse(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
    });
}

test('uses Airelvo nested task data and its status/result URLs', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET' });
        if (calls.length === 1) {
            return jsonResponse({
                data: {
                    id: 'task-1',
                    status: 'queued',
                    status_url: 'https://airelvo.cc/v1/async/images/task-1',
                    result_url: null,
                },
            }, 201);
        }
        if (calls.length === 2) {
            return jsonResponse({
                data: {
                    id: 'task-1',
                    status: 'succeeded',
                    status_url: 'https://airelvo.cc/v1/async/images/task-1',
                    result_url: 'https://airelvo.cc/v1/async/images/task-1/result',
                },
            });
        }
        if (calls.length === 3) {
            return jsonResponse({ data: [{ url: 'https://cdn.example/task-1.png' }] });
        }
        return new Response(Uint8Array.from([1, 2, 3]), { status: 200 });
    };

    try {
        const result = await generateGpt2apiImage({
            prompt: 'test',
            imageBase64Array: [],
            aspectRatio: '1:1',
            resolution: '1K',
            model: 'gpt-image-2',
            baseUrl: 'https://airelvo.cc/v1/async',
            apiKey: 'test-key',
        });

        assert.deepEqual(calls, [
            { url: 'https://airelvo.cc/v1/async/images/generations', method: 'POST' },
            { url: 'https://airelvo.cc/v1/async/images/task-1', method: 'GET' },
            { url: 'https://airelvo.cc/v1/async/images/task-1/result', method: 'GET' },
            { url: 'https://cdn.example/task-1.png', method: 'GET' },
        ]);
        assert.deepEqual([...result.buffer], [1, 2, 3]);
        assert.equal(result.format, 'png');
    } finally {
        global.fetch = originalFetch;
    }
});

test('surfaces a nested Airelvo task failure', async () => {
    const originalFetch = global.fetch;
    global.fetch = async (_url, options = {}) => {
        if (options.method === 'POST') {
            return jsonResponse({
                data: {
                    id: 'task-failed',
                    status: 'queued',
                    status_url: 'https://airelvo.cc/v1/async/images/task-failed',
                },
            }, 201);
        }
        return jsonResponse({
            data: {
                id: 'task-failed',
                status: 'failed',
                error: { message: 'upstream rejected image' },
            },
        });
    };

    try {
        await assert.rejects(
            generateGpt2apiImage({
                prompt: 'test',
                imageBase64Array: [],
                aspectRatio: '1:1',
                resolution: '1K',
                model: 'gpt-image-2',
                baseUrl: 'https://airelvo.cc/v1/async',
                apiKey: 'test-key',
            }),
            /upstream rejected image/,
        );
    } finally {
        global.fetch = originalFetch;
    }
});
test('preserves legacy top-level task_id polling', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET' });
        if (calls.length === 1) return jsonResponse({ task_id: 'legacy-1' }, 200);
        if (calls.length === 2) {
            return jsonResponse({
                status: 'succeeded',
                result: { data: [{ url: 'https://cdn.example/legacy-1.png' }] },
            });
        }
        return new Response(Uint8Array.from([4, 5, 6]), { status: 200 });
    };

    try {
        const result = await generateGpt2apiImage({
            prompt: 'legacy test',
            imageBase64Array: [],
            aspectRatio: '1:1',
            resolution: '1K',
            model: 'gpt-image-2',
            baseUrl: 'https://gateway.example/v1',
            apiKey: 'test-key',
        });

        assert.deepEqual(calls, [
            { url: 'https://gateway.example/v1/images/generations', method: 'POST' },
            { url: 'https://gateway.example/v1/images/generations/legacy-1', method: 'GET' },
            { url: 'https://cdn.example/legacy-1.png', method: 'GET' },
        ]);
        assert.deepEqual([...result.buffer], [4, 5, 6]);
    } finally {
        global.fetch = originalFetch;
    }
});
