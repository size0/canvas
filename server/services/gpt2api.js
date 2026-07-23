import { randomUUID } from 'node:crypto';

/**
 * GPT2API OpenAI-compatible adapter.
 *
 * Contract source: https://www.gpt2api.com/docs
 * Base URL example: https://www.gpt2api.com/v1
 */

export const GPT2API_IMAGE_MODELS = [
    'nano-banana-pro',
    'nano-banana-v2',
    'nano-banana',
    'gpt-image-2',
];

export const GPT2API_VIDEO_MODELS = [
    'grok-imagine-video',
    'xai/grok-imagine-video',
    'sora',
    'sora2',
    'sora2-pro',
    'veo3.1',
    'veo3.1-flash',
    'veo3.1-lite',
    'veo3.1-fast',
    'veo3.1-ref',
];

export const GPT2API_VIDEO_DURATIONS_BY_MODEL = {
    'grok-imagine-video': [6, 10, 20, 30],
    // The official xAI route documents a minimum-cost 3s mode; the gateway
    // also exposes the public 6/10/20/30s tiers for this model ID.
    'xai/grok-imagine-video': [3, 6, 10, 20, 30],
    sora: [4, 8, 12],
    sora2: [4, 8, 12],
    'sora2-pro': [4, 8, 12],
    'veo3.1': [4, 6, 8],
    'veo3.1-flash': [4, 6, 8],
    'veo3.1-lite': [4, 6, 8],
    'veo3.1-fast': [4, 6, 8],
    'veo3.1-ref': [4, 6, 8],
};

export const isGpt2apiImageModel = (id) => GPT2API_IMAGE_MODELS.includes(id);
export const isGpt2apiVideoModel = (id) => GPT2API_VIDEO_MODELS.includes(id);

export function resolveGpt2apiVideoModel(requestedModel, configuredModel) {
    const requested = String(requestedModel || '').trim();
    const configured = String(configuredModel || '').trim();
    if (isGpt2apiVideoModel(requested)) return requested;
    if (isGpt2apiVideoModel(configured)) return configured;
    return 'xai/grok-imagine-video';
}

export function normalizeGpt2apiVideoDuration(duration, model) {
    const supported = GPT2API_VIDEO_DURATIONS_BY_MODEL[model]
        || GPT2API_VIDEO_DURATIONS_BY_MODEL['grok-imagine-video'];
    const requested = Number(duration);
    if (!Number.isFinite(requested)) return supported[0];
    return supported.reduce((best, value) => (
        Math.abs(value - requested) < Math.abs(best - requested) ? value : best
    ), supported[0]);
}

const RATIO_TO_SIZE = {
    Auto: '1024x1024',
    '1:1': '1024x1024',
    '3:2': '1264x848',
    '2:3': '848x1264',
    '4:3': '1152x864',
    '3:4': '864x1152',
    '5:4': '1152x928',
    '4:5': '928x1152',
    '16:9': '1376x768',
    '9:16': '768x1376',
    '21:9': '1584x672',
};

const RES_TO_IMAGE_QUALITY = { '1K': '1k', '2K': '2k', '4K': '4k' };
const RES_TO_OPENAI_IMAGE_QUALITY = { '1K': 'low', '2K': 'medium', '4K': 'high', Auto: 'auto' };
const RES_TO_VIDEO_QUALITY = { '720p': 'hd', '1080p': 'fullhd' };
const VIDEO_RESOLUTIONS = new Set(['480p', '720p', '1080p']);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function usesSub2apiImageContract(base) {
    try {
        return new URL(base).hostname.toLowerCase() === 'api.airelvo.cc';
    } catch {
        return false;
    }
}

function toImageInput(value) {
    if (!value) return null;
    if (value.startsWith('http://') || value.startsWith('https://')) return value;
    if (value.startsWith('data:')) return value;
    return `data:image/png;base64,${value}`;
}

function authHeaders(apiKey, { idempotencyKey } = {}) {
    const headers = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream, */*',
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return headers;
}

async function readApiResponse(res) {
    const raw = await res.text();
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        return { _raw: raw.slice(0, 500) };
    }
}

function apiError(data, fallback) {
    return data?.error?.message
        || data?.error
        || data?.message
        || data?._raw
        || fallback;
}

function nestedPayload(data) {
    return data?.data && !Array.isArray(data.data) && typeof data.data === 'object'
        ? data.data
        : data;
}

function extractResultItem(data) {
    const payload = nestedPayload(data);
    const arrays = [
        data?.result?.data,
        Array.isArray(data?.data) ? data.data : null,
        payload?.result?.data,
        Array.isArray(payload?.data) ? payload.data : null,
    ];
    for (const items of arrays) {
        const item = items?.[0];
        if (item && (item.url || item.b64_json)) return item;
    }
    for (const item of [data?.result, payload?.result, data, payload]) {
        if (item && (item.url || item.b64_json)) return item;
    }
    return null;
}

function extractTaskInfo(data, base, fallbackPath) {
    const payload = nestedPayload(data);
    const taskId = data?.task_id || data?.id || data?.request_id
        || payload?.task_id || payload?.id || payload?.request_id || null;
    const rawStatusUrl = data?.status_url || data?.poll_url
        || payload?.status_url || payload?.poll_url || null;
    let statusUrl = null;
    if (rawStatusUrl) {
        try {
            statusUrl = new URL(rawStatusUrl, `${base}/`).toString();
        } catch {
            statusUrl = rawStatusUrl;
        }
    } else if (taskId) {
        statusUrl = `${base}${fallbackPath}/${taskId}`;
    }
    return { taskId, statusUrl };
}

/** Poll an async task and honor retry_after / Retry-After. */
async function pollTask(pollUrl, apiKey, { timeoutMs = 600000 } = {}) {
    const startedAt = Date.now();
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 6;

    while (Date.now() - startedAt <= timeoutMs) {
        let res;
        let data;
        try {
            res = await fetch(pollUrl, { headers: authHeaders(apiKey) });
            data = await readApiResponse(res);
        } catch (error) {
            consecutiveErrors += 1;
            if (consecutiveErrors >= maxConsecutiveErrors) {
                throw new Error(`轮询请求连续失败：${error.message || error}`);
            }
            await sleep(4000);
            continue;
        }

        if (!res.ok) {
            consecutiveErrors += 1;
            if (consecutiveErrors >= maxConsecutiveErrors) {
                throw new Error(apiError(data, `轮询失败 (HTTP ${res.status})`));
            }
            await sleep(4000);
            continue;
        }
        consecutiveErrors = 0;

        const payload = nestedPayload(data);
        const status = String(payload?.status || data?.status || '').toLowerCase();
        if (['succeeded', 'completed', 'success', 'done'].includes(status)) {
            const item = extractResultItem(data);
            if (!item) throw new Error('gpt2api 返回成功状态，但结果缺少 url/b64_json');
            return item;
        }
        if (['failed', 'refunded', 'cancelled', 'canceled', 'expired'].includes(status)) {
            throw new Error(apiError(payload, apiError(data, 'gpt2api 任务失败')));
        }

        const retryHeader = Number.parseFloat(res.headers.get('Retry-After') || '');
        const retryJson = Number(payload?.retry_after ?? data?.retry_after);
        const seconds = Number.isFinite(retryHeader)
            ? retryHeader
            : (Number.isFinite(retryJson) ? retryJson : 3);
        await sleep(Math.max(1000, seconds * 1000));
    }

    throw new Error('gpt2api 任务超时');
}

async function downloadToBuffer(url, { retries = 3 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`下载生成结果失败 (HTTP ${res.status})`);
            return Buffer.from(await res.arrayBuffer());
        } catch (error) {
            lastError = error;
            if (attempt < retries) await sleep(2000 * (attempt + 1));
        }
    }
    throw lastError;
}

async function postGenerationWithAlias({ base, primaryPath, aliasPath, body, apiKey, idempotencyKey }) {
    const request = async (path) => {
        const res = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: authHeaders(apiKey, { idempotencyKey }),
            body: JSON.stringify(body),
        });
        return { res, data: await readApiResponse(res), path };
    };

    let result = await request(primaryPath);
    if (!result.res.ok && aliasPath && [404, 405].includes(result.res.status)) {
        result = await request(aliasPath);
    }
    return result;
}

/** Image generation / editing. Returns { buffer, format }. */
export async function generateGpt2apiImage({ prompt, imageBase64Array, aspectRatio, resolution, model, baseUrl, apiKey }) {
    if (!apiKey) throw new Error('未配置 gpt2api API Key（请在「设置」中填写）');
    const base = (baseUrl || 'https://www.gpt2api.com/v1').replace(/\/+$/, '');
    const useSub2apiContract = usesSub2apiImageContract(base);
    const refs = (imageBase64Array || []).map(toImageInput).filter(Boolean);
    const hasReference = refs.length > 0;
    const body = {
        model,
        prompt: prompt || '',
        n: 1,
        size: RATIO_TO_SIZE[aspectRatio] || '1024x1024',
        quality: useSub2apiContract
            ? (RES_TO_OPENAI_IMAGE_QUALITY[resolution] || 'auto')
            : (RES_TO_IMAGE_QUALITY[resolution] || '1k'),
        async: true,
    };
    if (useSub2apiContract && refs.length > 0) {
        body.images = refs.map(imageUrl => ({ image_url: imageUrl }));
    } else if (refs.length === 1) {
        body.image = refs[0];
    } else if (refs.length > 1) {
        body.images = refs;
    }

    const path = hasReference ? '/images/edits' : '/images/generations';
    const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: authHeaders(apiKey, { idempotencyKey: `img-${randomUUID()}` }),
        body: JSON.stringify(body),
    });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(apiError(data, `图像请求失败 (HTTP ${res.status})`));

    let item = extractResultItem(data);
    if (!item) {
        const task = extractTaskInfo(data, base, '/images/generations');
        if (!task.statusUrl) throw new Error('图像接口未返回结果或 task_id');
        item = await pollTask(task.statusUrl, apiKey, { timeoutMs: 600000 });
    }

    if (item.url) {
        const buffer = await downloadToBuffer(item.url);
        const format = /\.jpe?g(?:$|\?)/i.test(item.url) ? 'jpg' : 'png';
        return { buffer, format };
    }
    return { buffer: Buffer.from(item.b64_json, 'base64'), format: 'png' };
}

/** Video generation. Returns Buffer(mp4). */
export async function generateGpt2apiVideo({ prompt, imageBase64, lastFrameBase64, referenceImages, aspectRatio, resolution, duration, model, baseUrl, apiKey }) {
    if (!apiKey) throw new Error('未配置 gpt2api API Key（请在「设置」中填写）');
    const base = (baseUrl || 'https://www.gpt2api.com/v1').replace(/\/+$/, '');
    const resolvedModel = resolveGpt2apiVideoModel(model, null);
    const resolvedDuration = normalizeGpt2apiVideoDuration(duration, resolvedModel);
    const resolvedResolution = VIDEO_RESOLUTIONS.has(resolution) ? resolution : '720p';
    const refs = Array.from(new Set([
        ...(Array.isArray(referenceImages) ? referenceImages : []),
        imageBase64,
        lastFrameBase64,
    ].map(toImageInput).filter(Boolean))).slice(0, 8);

    const body = {
        model: resolvedModel,
        prompt: prompt || '',
        duration: resolvedDuration,
        async: true,
    };

    if (resolvedModel === 'xai/grok-imagine-video') {
        if (aspectRatio && aspectRatio !== 'Auto') body.aspect_ratio = aspectRatio;
        body.resolution = resolvedResolution;
        if (refs.length === 1) {
            body.image = { url: refs[0] };
        } else if (refs.length > 1) {
            body.operation = 'reference-to-video';
            body.reference_images = refs.map(url => ({ url }));
        }
    } else {
        if (aspectRatio && aspectRatio !== 'Auto') body.ratio = aspectRatio;
        if (RES_TO_VIDEO_QUALITY[resolvedResolution]) {
            body.quality = RES_TO_VIDEO_QUALITY[resolvedResolution];
        } else if (resolvedResolution === '480p') {
            body.resolution = '480p';
        }
        if (refs.length === 1) body.image = refs[0];
        else if (refs.length > 1 && ['grok-imagine-video', 'veo3.1-ref'].includes(resolvedModel)) body.images = refs;
        else if (refs.length > 1) body.image = refs[0];
    }

    const idempotencyKey = `vid-${randomUUID()}`;
    const usesOfficialXaiRoute = resolvedModel === 'xai/grok-imagine-video';
    const { res, data, path: requestPath } = await postGenerationWithAlias({
        base,
        primaryPath: usesOfficialXaiRoute ? '/videos/generations' : '/video/generations',
        aliasPath: usesOfficialXaiRoute ? '/video/generations' : '/videos/generations',
        body,
        apiKey,
        idempotencyKey,
    });
    if (!res.ok) throw new Error(apiError(data, `视频请求失败 (HTTP ${res.status})`));

    let item = extractResultItem(data);
    const task = extractTaskInfo(data, base, requestPath);
    if (!item) {
        if (!task.statusUrl) throw new Error('视频接口未返回结果或 task_id');
        item = await pollTask(task.statusUrl, apiKey, { timeoutMs: 900000 });
    }

    const origin = base.replace(/\/v\d+$/, '');
    const proxyUrl = task.taskId ? `${origin}/api/v1/gen/assets/${task.taskId}/0.mp4` : null;
    const preferProxy = String(item.url || '').includes('assets.grok.com');
    const candidates = preferProxy
        ? [proxyUrl, item.url].filter(Boolean)
        : [item.url, proxyUrl].filter(Boolean);

    let lastError;
    for (const url of candidates) {
        try {
            return await downloadToBuffer(url, { retries: 1 });
        } catch (error) {
            lastError = error;
            console.warn(`[gpt2api] 视频下载失败 (${url})，尝试备用地址:`, error.message);
        }
    }
    throw lastError || new Error('视频下载失败');
}

/** OpenAI-compatible streamed chat. */
export async function gpt2apiChat({ messages, model, baseUrl, apiKey, temperature = 0.7, maxTokens, onDelta }) {
    if (!apiKey) throw new Error('未配置 gpt2api API Key（请在「设置」中填写）');
    const base = (baseUrl || 'https://www.gpt2api.com/v1').replace(/\/+$/, '');
    const body = { model, messages, temperature, stream: true };
    if (maxTokens) body.max_tokens = maxTokens;

    const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const data = await readApiResponse(res);
        throw new Error(apiError(data, `gpt2api 文本请求失败 (HTTP ${res.status})`));
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        const data = await readApiResponse(res);
        if (data?.error) throw new Error(apiError(data, 'gpt2api 文本请求失败'));
        return data?.choices?.[0]?.message?.content || '';
    }

    let full = '';
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
                const json = JSON.parse(payload);
                if (json?.error) throw new Error(apiError(json, 'gpt2api 文本请求失败'));
                const delta = json?.choices?.[0]?.delta?.content;
                if (delta) {
                    full += delta;
                    try { onDelta?.(delta, full.length); } catch { /* progress is best effort */ }
                }
            } catch (error) {
                if (error instanceof SyntaxError) continue;
                throw error;
            }
        }
    }
    return full;
}
