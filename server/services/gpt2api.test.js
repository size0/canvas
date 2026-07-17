import assert from 'node:assert/strict';
import test from 'node:test';

import { generateGpt2apiImage } from './gpt2api.js';

function jsonResponse(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
    });
}


test('keeps light Airelvo requests on the configured sync endpoint', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        calls.push({
            url: String(url),
            method: options.method || 'GET',
            body: options.body ? JSON.parse(options.body) : null,
        });
        if (calls.length === 1) {
            return jsonResponse({ data: [{ url: 'https://cdn.example/light.png' }] });
        }
        return new Response(Uint8Array.from([7, 8, 9]), {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
        });
    };

    try {
        const result = await generateGpt2apiImage({
            prompt: 'a small product photo',
            imageBase64Array: [],
            aspectRatio: '1:1',
            resolution: '1K',
            model: 'gpt-image-2',
            baseUrl: 'https://airelvo.cc/v1',
            apiKey: 'test-key',
        });

        assert.equal(calls[0].url, 'https://airelvo.cc/v1/images/generations');
        assert.equal(calls[0].body.async, false);
        assert.equal(calls[1].url, 'https://cdn.example/light.png');
        assert.deepEqual([...result.buffer], [7, 8, 9]);
    } finally {
        global.fetch = originalFetch;
    }
});

test('routes heavy Airelvo sync requests through its async queue', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        calls.push({
            url: String(url),
            method: options.method || 'GET',
            body: options.body ? JSON.parse(options.body) : null,
        });
        if (calls.length === 1) {
            return new Response(Uint8Array.from([1, 2, 3]), {
                status: 200,
                headers: { 'Content-Type': 'image/jpeg' },
            });
        }
        if (calls.length === 2) {
            return jsonResponse({
                data: {
                    id: 'heavy-1',
                    status: 'queued',
                    status_url: 'https://airelvo.cc/v1/async/images/heavy-1',
                },
            }, 201);
        }
        if (calls.length === 3) {
            return jsonResponse({
                data: {
                    id: 'heavy-1',
                    status: 'succeeded',
                    status_url: 'https://airelvo.cc/v1/async/images/heavy-1',
                    result_url: 'https://airelvo.cc/v1/async/images/heavy-1/result',
                },
            });
        }
        if (calls.length === 4) {
            return new Response(Uint8Array.from([10, 11, 12]), {
                status: 200,
                headers: { 'Content-Type': 'image/png' },
            });
        }
        throw new Error(`unexpected request: ${url}`);
    };

    try {
        const result = await generateGpt2apiImage({
            prompt: 'a detailed product storyboard',
            imageBase64Array: ['https://img.example/reference.jpg'],
            aspectRatio: '9:16',
            resolution: '4K',
            model: 'gpt-image-2',
            baseUrl: 'https://airelvo.cc/v1',
            apiKey: 'test-key',
            resolveDns: async () => [{ address: '93.184.216.34', family: 4 }],
        });

        assert.equal(calls[0].url, 'https://img.example/reference.jpg');
        assert.equal(calls[0].method, 'GET');
        assert.equal(calls[1].url, 'https://airelvo.cc/v1/async/images/edits');
        assert.equal(calls[1].body.async, true);
        assert.equal(calls[1].body.reference_image, 'data:image/jpeg;base64,AQID');
        assert.equal(calls[1].body.image, undefined);
        assert.equal(calls[1].body.images, undefined);
        assert.equal(calls[2].url, 'https://airelvo.cc/v1/async/images/heavy-1');
        assert.equal(calls[3].url, 'https://airelvo.cc/v1/async/images/heavy-1/result');
        assert.deepEqual([...result.buffer], [10, 11, 12]);
    } finally {
        global.fetch = originalFetch;
    }
});

test('rejects private-network reference image URLs before fetching them', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => {
        throw new Error('fetch should not be called');
    };

    try {
        await assert.rejects(
            generateGpt2apiImage({
                prompt: 'private URL check',
                imageBase64Array: ['http://127.0.0.1/internal.png'],
                aspectRatio: '1:1',
                resolution: '1K',
                model: 'gpt-image-2',
                baseUrl: 'https://airelvo.cc/v1/async',
                apiKey: 'test-key',
            }),
            /private or unsafe network address/,
        );
    } finally {
        global.fetch = originalFetch;
    }
});

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
