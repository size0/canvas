import assert from 'node:assert/strict';
import test from 'node:test';

import {
    generateGpt2apiImage,
    generateGpt2apiVideo,
    normalizeGpt2apiVideoDuration,
    resolveGpt2apiVideoModel,
} from './gpt2api.js';

function jsonResponse(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
    });
}

function mediaResponse(fill = 1) {
    return new Response(new Uint8Array(64).fill(fill), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
    });
}

test('resolves stale models and normalizes documented duration tiers', () => {
    assert.equal(resolveGpt2apiVideoModel(null, 'grok-imagine-video-1.5-fast'), 'xai/grok-imagine-video');
    assert.equal(resolveGpt2apiVideoModel('grok-imagine-video', 'xai/grok-imagine-video'), 'grok-imagine-video');
    assert.equal(normalizeGpt2apiVideoDuration(3, 'xai/grok-imagine-video'), 6);
    assert.equal(normalizeGpt2apiVideoDuration(15, 'xai/grok-imagine-video'), 10);
    assert.equal(normalizeGpt2apiVideoDuration(30, 'grok-imagine-video'), 30);
    assert.equal(normalizeGpt2apiVideoDuration(15, 'grok-imagine-video'), 10);
    assert.equal(normalizeGpt2apiVideoDuration(7, 'veo3.1'), 6);
});

test('uses the official async image edit contract and polling path', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        calls.push({
            url: String(url),
            method: options.method || 'GET',
            headers: options.headers || {},
            body: options.body ? JSON.parse(options.body) : null,
        });
        if (calls.length === 1) return jsonResponse({ task_id: 'img-1', retry_after: 2 }, 201);
        if (calls.length === 2) {
            return jsonResponse({
                status: 'succeeded',
                result: { data: [{ url: 'https://cdn.example/img-1.png' }] },
            });
        }
        return mediaResponse(2);
    };

    try {
        const result = await generateGpt2apiImage({
            prompt: 'keep the product',
            imageBase64Array: ['https://img.example/product.jpg'],
            aspectRatio: '9:16',
            resolution: '2K',
            model: 'nano-banana-pro',
            baseUrl: 'https://www.gpt2api.com/v1',
            apiKey: 'test-key',
        });

        assert.equal(calls[0].url, 'https://www.gpt2api.com/v1/images/edits');
        assert.equal(calls[0].body.image, 'https://img.example/product.jpg');
        assert.equal(calls[0].body.async, true);
        assert.ok(calls[0].headers['Idempotency-Key']);
        assert.equal(calls[1].url, 'https://www.gpt2api.com/v1/images/generations/img-1');
        assert.equal(result.buffer.length, 64);
    } finally {
        global.fetch = originalFetch;
    }
});

test('uses Sub2API native fields for multi-image edits', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        calls.push({
            url: String(url),
            method: options.method || 'GET',
            body: options.body ? JSON.parse(options.body) : null,
        });
        return jsonResponse({
            data: [{ b64_json: Buffer.from('edited-image').toString('base64') }],
        });
    };

    try {
        const result = await generateGpt2apiImage({
            prompt: 'keep both people consistent',
            imageBase64Array: [
                'data:image/png;base64,AAAA',
                'https://img.example/reference.png',
            ],
            aspectRatio: '9:16',
            resolution: '2K',
            model: 'gpt-image-2',
            baseUrl: 'https://api.airelvo.cc/v1',
            apiKey: 'test-key',
        });

        assert.equal(calls[0].url, 'https://api.airelvo.cc/v1/images/edits');
        assert.deepEqual(calls[0].body.images, [
            { image_url: 'data:image/png;base64,AAAA' },
            { image_url: 'https://img.example/reference.png' },
        ]);
        assert.equal(calls[0].body.image, undefined);
        assert.equal(calls[0].body.quality, 'medium');
        assert.equal(result.buffer.toString(), 'edited-image');
    } finally {
        global.fetch = originalFetch;
    }
});

test('uses official xAI field names and response-provided status_url', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        calls.push({
            url: String(url),
            method: options.method || 'GET',
            headers: options.headers || {},
            body: options.body ? JSON.parse(options.body) : null,
        });
        if (calls.length === 1) {
            return jsonResponse({
                data: {
                    id: 'xai-1',
                    status: 'queued',
                    status_url: '/v1/video/generations/xai-1',
                },
            }, 201);
        }
        if (calls.length === 2) {
            return jsonResponse({
                data: {
                    status: 'succeeded',
                    result: { data: [{ url: 'https://cdn.example/xai-1.mp4' }] },
                },
            });
        }
        return mediaResponse(3);
    };

    try {
        const result = await generateGpt2apiVideo({
            prompt: 'slow dolly in',
            imageBase64: 'https://img.example/start.jpg',
            aspectRatio: '9:16',
            resolution: '480p',
            duration: 20,
            model: 'xai/grok-imagine-video',
            baseUrl: 'https://www.gpt2api.com/v1',
            apiKey: 'test-key',
        });

        assert.equal(calls[0].url, 'https://www.gpt2api.com/v1/video/generations');
        assert.equal(calls[0].body.aspect_ratio, '9:16');
        assert.equal(calls[0].body.resolution, '480p');
        assert.equal(calls[0].body.duration, 20);
        assert.deepEqual(calls[0].body.image, { url: 'https://img.example/start.jpg' });
        assert.equal(calls[0].body.ratio, undefined);
        assert.equal(calls[0].body.quality, undefined);
        assert.ok(calls[0].headers['Idempotency-Key']);
        assert.equal(calls[1].url, 'https://www.gpt2api.com/v1/video/generations/xai-1');
        assert.equal(result.length, 64);
    } finally {
        global.fetch = originalFetch;
    }
});

test('uses unified Grok fields for 20/30 second auto-extended videos', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        calls.push({
            url: String(url),
            method: options.method || 'GET',
            body: options.body ? JSON.parse(options.body) : null,
        });
        if (calls.length === 1) {
            return jsonResponse({
                status: 'succeeded',
                result: { data: [{ url: 'https://cdn.example/grok-30.mp4' }] },
            });
        }
        return mediaResponse(4);
    };

    try {
        const result = await generateGpt2apiVideo({
            prompt: 'a 30 second product film',
            referenceImages: ['https://img.example/a.jpg', 'https://img.example/b.jpg'],
            aspectRatio: '16:9',
            resolution: '720p',
            duration: 30,
            model: 'grok-imagine-video',
            baseUrl: 'https://www.gpt2api.com/v1',
            apiKey: 'test-key',
        });

        assert.equal(calls[0].body.duration, 30);
        assert.equal(calls[0].body.ratio, '16:9');
        assert.equal(calls[0].body.quality, 'hd');
        assert.deepEqual(calls[0].body.images, [
            'https://img.example/a.jpg',
            'https://img.example/b.jpg',
        ]);
        assert.equal(calls[0].body.aspect_ratio, undefined);
        assert.equal(calls[0].body.reference_images, undefined);
        assert.equal(result.length, 64);
    } finally {
        global.fetch = originalFetch;
    }
});

test('reuses one idempotency key when falling back to the plural video alias', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        calls.push({
            url: String(url),
            method: options.method || 'GET',
            headers: options.headers || {},
            body: options.body ? JSON.parse(options.body) : null,
        });
        if (calls.length === 1) return jsonResponse({ error: 'route not found' }, 404);
        if (calls.length === 2) return jsonResponse({ task_id: 'alias-1' }, 201);
        if (calls.length === 3) {
            return jsonResponse({
                status: 'succeeded',
                result: { data: [{ url: 'https://cdn.example/alias-1.mp4' }] },
            });
        }
        return mediaResponse(5);
    };

    try {
        await generateGpt2apiVideo({
            prompt: 'alias fallback',
            duration: 6,
            model: 'grok-imagine-video',
            baseUrl: 'https://gateway.example/v1',
            apiKey: 'test-key',
        });

        assert.equal(calls[0].url, 'https://gateway.example/v1/video/generations');
        assert.equal(calls[1].url, 'https://gateway.example/v1/videos/generations');
        assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
        assert.equal(calls[2].url, 'https://gateway.example/v1/video/generations/alias-1');
    } finally {
        global.fetch = originalFetch;
    }
});
