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


test('normalizes video duration using each model contract', () => {
    assert.equal(normalizeGpt2apiVideoDuration(15, 'xai/grok-imagine-video'), 10);
    assert.equal(normalizeGpt2apiVideoDuration(20, 'grok-imagine-video'), 20);
    assert.equal(normalizeGpt2apiVideoDuration(10, 'sora'), 8);
    assert.equal(normalizeGpt2apiVideoDuration(12, 'sora'), 12);
    assert.equal(normalizeGpt2apiVideoDuration(7, 'veo3.1'), 6);
    assert.equal(normalizeGpt2apiVideoDuration(8, 'veo3.1-flash'), 8);
    assert.equal(normalizeGpt2apiVideoDuration(31, 'xai/grok-imagine-video'), 30);
    assert.equal(normalizeGpt2apiVideoDuration('invalid', 'sora'), 4);
    assert.equal(normalizeGpt2apiVideoDuration(), 6);
});

test('resolves stale configured video models to a supported fallback', () => {
    assert.equal(resolveGpt2apiVideoModel('sora', 'veo3.1'), 'sora');
    // 保留 xai/ 前缀，走官方 xAI 参数格式
    assert.equal(resolveGpt2apiVideoModel('xai/grok-imagine-video', null), 'xai/grok-imagine-video');
    assert.equal(resolveGpt2apiVideoModel('unknown-model', 'veo3.1'), 'veo3.1');
    assert.equal(
        resolveGpt2apiVideoModel(null, 'grok-imagine-video-1.5-fast'),
        'grok-imagine-video',
    );
    assert.equal(resolveGpt2apiVideoModel(null, 'xai/grok-imagine-video'), 'xai/grok-imagine-video');
});

test('sends a normalized duration to the current GPT2API video endpoint', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        calls.push({
            url: String(url),
            method: options.method || 'GET',
            body: options.body ? JSON.parse(options.body) : null,
            headers: options.headers || {},
        });
        if (calls.length === 1) return jsonResponse({ task_id: 'video-1' });
        if (calls.length === 2) {
            return jsonResponse({
                status: 'succeeded',
                result: { data: [{ url: 'https://cdn.example/video-1.mp4' }] },
            });
        }
        return new Response(Uint8Array.from([20, 21, 22]), {
            status: 200,
            headers: { 'Content-Type': 'video/mp4' },
        });
    };

    try {
        const result = await generateGpt2apiVideo({
            prompt: 'animate the product',
            duration: 15,
            resolution: '720p',
            aspectRatio: '16:9',
            model: 'grok-imagine-video',
            baseUrl: 'https://gateway.example/v1',
            apiKey: 'test-key',
        });

        assert.equal(calls[0].url, 'https://gateway.example/v1/video/generations');
        // 15s 向下对齐到 Grok 分档 10s（合法：6/10/20/30）
        assert.equal(calls[0].body.duration, 10);
        assert.equal(calls[0].body.async, true);
        assert.equal(calls[0].body.quality, 'hd');
        assert.equal(calls[0].body.ratio, '16:9');
        assert.ok(calls[0].headers['Idempotency-Key']);
        assert.equal(calls[1].url, 'https://gateway.example/v1/video/generations/video-1');
        assert.equal(calls[2].url, 'https://cdn.example/video-1.mp4');
        assert.deepEqual([...result], [20, 21, 22]);
    } finally {
        global.fetch = originalFetch;
    }
});

test('sends official xAI params for xai/grok-imagine-video', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    // 1x1 png — letterbox 可识别，且比例接近 1:1 不会改写
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    global.fetch = async (url, options = {}) => {
        calls.push({
            url: String(url),
            method: options.method || 'GET',
            body: options.body ? JSON.parse(options.body) : null,
        });
        if (String(url).includes('/generations') && (options.method || 'GET') === 'POST') {
            return jsonResponse({ task_id: 'xai-vid-1' });
        }
        if (String(url).includes('xai-vid-1')) {
            return jsonResponse({
                status: 'succeeded',
                // 单段最长 15s（官方上限）
                result: { data: [{ url: 'https://cdn.example/xai-1.mp4', duration_ms: 15000 }] },
            });
        }
        // extensions 提交
        if (String(url).includes('/extensions') && options.method === 'POST') {
            return jsonResponse({ task_id: 'xai-ext-1' });
        }
        if (String(url).includes('xai-ext-1')) {
            return jsonResponse({
                status: 'succeeded',
                result: { data: [{ url: 'https://cdn.example/xai-ext.mp4', duration_ms: 30000 }] },
            });
        }
        return new Response(Uint8Array.from([1, 2, 3]), {
            status: 200,
            headers: { 'Content-Type': 'video/mp4' },
        });
    };

    try {
        await generateGpt2apiVideo({
            prompt: 'Camera dolly-in',
            duration: 30,
            resolution: '480p',
            aspectRatio: '16:9',
            imageBase64: tinyPng,
            model: 'xai/grok-imagine-video',
            baseUrl: 'https://www.gpt2api.com/v1',
            apiKey: 'test-key',
        });

        const genPost = calls.find(c => c.method === 'POST' && String(c.url).includes('/generations'));
        // 首包被 cap 到 15s，不会傻传 30 给上游
        assert.ok(genPost);
        assert.equal(genPost.body.model, 'xai/grok-imagine-video');
        assert.equal(genPost.body.duration, 15);
        assert.equal(genPost.body.aspect_ratio, '16:9');
        assert.equal(genPost.body.resolution, '480p');
        assert.equal(genPost.body.ratio, undefined);
        assert.equal(genPost.body.quality, undefined);
        assert.ok(genPost.body.image?.url);

        // 随后应调用 extensions 续写到 30s（剩余 15s 一次追加 15s）
        const extendPost = calls.find(c => c.method === 'POST' && String(c.url).includes('/extensions'));
        assert.ok(extendPost, 'should POST /videos/extensions for long Grok video');
        assert.equal(extendPost.body.duration, 15);
        assert.deepEqual(extendPost.body.video, { url: 'https://cdn.example/xai-1.mp4' });
    } finally {
        global.fetch = originalFetch;
    }
});

test('extends grok-imagine-video when first shot is shorter than 30s', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        const u = String(url);
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url: u, method, body });

        if (u.includes('.mp4')) {
            return new Response(Uint8Array.from([9, 8, 7]), {
                status: 200,
                headers: { 'Content-Type': 'video/mp4' },
            });
        }
        if (method === 'POST' && u.includes('/generations')) {
            return jsonResponse({ task_id: 'g1' });
        }
        if (method === 'GET' && /\/g1$/.test(u)) {
            return jsonResponse({
                status: 'succeeded',
                result: { data: [{ url: 'https://cdn.example/g1.mp4', duration_ms: 15000 }] },
            });
        }
        if (method === 'POST' && u.includes('/extensions')) {
            return jsonResponse({ task_id: 'e1' });
        }
        if (method === 'GET' && /\/e1$/.test(u)) {
            return jsonResponse({
                status: 'succeeded',
                result: { data: [{ url: 'https://cdn.example/e1.mp4', duration_ms: 30000 }] },
            });
        }
        return jsonResponse({ error: 'unexpected ' + method + ' ' + u }, 500);
    };

    try {
        const result = await generateGpt2apiVideo({
            prompt: 'drone flight',
            duration: 30,
            resolution: '720p',
            model: 'grok-imagine-video',
            baseUrl: 'https://gateway.example/v1',
            apiKey: 'test-key',
        });

        assert.equal(calls[0].body.duration, 15); // 首段 cap 15
        const extendPosts = calls.filter(c => c.method === 'POST' && c.url.includes('/extensions'));
        assert.ok(extendPosts.length >= 1);
        assert.equal(extendPosts[0].body.duration, 15); // 再追 15s → 共 30s
        assert.deepEqual([...result], [9, 8, 7]);
    } finally {
        global.fetch = originalFetch;
    }
});
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
