import net from 'node:net';
import { lookup as lookupDns } from 'node:dns/promises';
import sharp from 'sharp';
import { getKey } from '../config.js';

/**
 * gpt2api.js
 *
 * gpt2api.com（OpenAI 兼容下游接口）服务封装。
 * 统一支持文本 / 图像 / 视频；图像与视频走异步任务 + 轮询。
 *
 * 接入地址形如 https://www.gpt2api.com/v1
 * 鉴权：Authorization: Bearer sk-xxx
 */

// —— 出站并发槽：前端可同时点多个「生成」，但打向上游的请求有上限 ——
// gpt2api 多并发时经常只跑 1 个，其余 i/o timeout；这里排队而不是一窝蜂冲。
let outboundInFlight = 0;
const outboundWaiters = [];

function getOutboundLimit() {
    const v = parseInt(getKey('GEN_CONCURRENCY'), 10);
    // 至少 1；最多 3 路打向上游（再高 gpt-image-2 很容易超时）
    if (!Number.isFinite(v) || v < 1) return 2;
    return Math.min(3, Math.max(1, v));
}

async function withOutboundSlot(fn, label = 'job') {
    const limit = getOutboundLimit();
    while (outboundInFlight >= limit) {
        await new Promise((resolve) => outboundWaiters.push(resolve));
    }
    outboundInFlight += 1;
    console.log(`[gpt2api] 出站占用 ${label}: ${outboundInFlight}/${limit}（排队等待 ${outboundWaiters.length}）`);
    try {
        return await fn();
    } finally {
        outboundInFlight = Math.max(0, outboundInFlight - 1);
        const next = outboundWaiters.shift();
        if (next) next();
        console.log(`[gpt2api] 出站释放 ${label}: 剩余占用 ${outboundInFlight}/${getOutboundLimit()}`);
    }
}

// gpt2api 提供的模型 ID（用于在生成路由里判断走哪个提供商）
export const GPT2API_IMAGE_MODELS = ['nano-banana-pro', 'nano-banana-v2', 'nano-banana', 'gpt-image-2'];
export const GPT2API_VIDEO_MODELS = ['xai/grok-imagine-video', 'grok-imagine-video', 'sora', 'veo3.1', 'veo3.1-flash', 'veo3.1-lite'];

export const GPT2API_VIDEO_DURATIONS = [6, 10, 20, 30];
export const GPT2API_VIDEO_DURATIONS_BY_MODEL = {
    'xai/grok-imagine-video': GPT2API_VIDEO_DURATIONS,
    'grok-imagine-video': GPT2API_VIDEO_DURATIONS,
    'sora': [4, 8, 12],
    'veo3.1': [4, 6, 8],
    'veo3.1-flash': [4, 6, 8],
    'veo3.1-lite': [4, 6, 8],
};

export const isGpt2apiImageModel = (id) => GPT2API_IMAGE_MODELS.includes(id);
export const isGpt2apiVideoModel = (id) => GPT2API_VIDEO_MODELS.includes(id);

export function normalizeGpt2apiVideoDuration(duration, model) {
    const supported = GPT2API_VIDEO_DURATIONS_BY_MODEL[model] || GPT2API_VIDEO_DURATIONS;
    const requested = Number(duration);
    if (!Number.isFinite(requested)) return supported[0];

    return [...supported]
        .reverse()
        .find(value => value <= requested)
        || supported[0];
}

export function resolveGpt2apiVideoModel(requestedModel, configuredModel) {
    // 保留 xai/grok-imagine-video 与 grok-imagine-video 两个 ID：
    // 前者走官方 xAI 参数格式，后者走 gpt2api 统一下游格式。
    const requested = String(requestedModel || '').trim();
    const configured = String(configuredModel || '').trim();
    if (isGpt2apiVideoModel(requested)) return requested;
    if (isGpt2apiVideoModel(configured)) return configured;
    return 'grok-imagine-video';
}

export function isOfficialXaiVideoModel(model) {
    return String(model || '').startsWith('xai/');
}

// 宽高比 → 基准像素尺寸（gpt2api 会按 quality 档自动放大到精确尺寸）
const RATIO_TO_SIZE = {
    'Auto': '1024x1024',
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

// 图像分辨率档 → quality
const RES_TO_IMAGE_QUALITY = { '1K': '1k', '2K': '2k', '4K': '4k' };
// 统一下游视频分辨率 → quality（hd=720p / fullhd=1080p）
const RES_TO_VIDEO_QUALITY = { '720p': 'hd', '1080p': 'fullhd' };
// 官方 xAI / 统一接口均接受的 resolution 字面值
const VIDEO_RESOLUTIONS = new Set(['480p', '720p', '1080p']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 中转站 Docker 内部偶发 i/o timeout / 网关断开，可重试 */
function isRetryableUpstreamError(err) {
    const msg = String(err?.message || err || '');
    return /i\/o timeout|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|fetch failed|network|超时|gateway|502|503|504/i.test(msg);
}

async function withUpstreamRetry(fn, { retries = 2, label = 'gpt2api' } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn(attempt);
        } catch (e) {
            lastErr = e;
            if (attempt >= retries || !isRetryableUpstreamError(e)) throw e;
            const waitMs = 1500 * (attempt + 1);
            console.warn(`[${label}] 上游瞬时失败，${waitMs}ms 后重试 (${attempt + 1}/${retries}):`, e.message || e);
            await sleep(waitMs);
        }
    }
    throw lastErr;
}

function makeIdempotencyKey(prefix = 'gen') {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `${prefix}-${crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 确保为 data URL（gpt2api 接受 data:image/...;base64,... 或公网 URL） */
function toImageInput(value) {
    if (!value) return null;
    if (value.startsWith('http://') || value.startsWith('https://')) return value;
    if (value.startsWith('data:')) return value;
    return `data:image/png;base64,${value}`;
}

/** 画幅字符串 → 宽/高 */
const VIDEO_ASPECT_VALUE = {
    '1:1': 1,
    '16:9': 16 / 9,
    '9:16': 9 / 16,
    '4:3': 4 / 3,
    '3:4': 3 / 4,
    '3:2': 3 / 2,
    '2:3': 2 / 3,
};

/**
 * 把参考图等比缩放到目标画幅画布内（letterbox，不拉伸）。
 * 图生视频若强制 9:16 但参考图是 3:4，上游常会非等比拉伸 → 人物被拉高。
 */
export async function letterboxImageToAspect(imageInput, aspectLabel, {
    maxLongSide = 1280,
    background = { r: 0, g: 0, b: 0, alpha: 1 },
} = {}) {
    const input = toImageInput(imageInput);
    if (!input) return null;
    const targetRatio = VIDEO_ASPECT_VALUE[aspectLabel];
    if (!targetRatio) return input;

    let buffer;
    if (input.startsWith('data:')) {
        const m = input.match(/^data:[^;]+;base64,(.+)$/);
        if (!m) return input;
        buffer = Buffer.from(m[1], 'base64');
    } else if (input.startsWith('http://') || input.startsWith('https://')) {
        const res = await fetch(input, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MagicalCanvas/1.0)' },
        });
        if (!res.ok) {
            console.warn(`[gpt2api] letterbox: 下载参考图失败 HTTP ${res.status}，跳过适配`);
            return input;
        }
        buffer = Buffer.from(await res.arrayBuffer());
    } else {
        return input;
    }

    const meta = await sharp(buffer).metadata();
    const srcW = meta.width || 0;
    const srcH = meta.height || 0;
    if (!srcW || !srcH) return input;

    const srcRatio = srcW / srcH;
    // 与目标接近则不处理（避免无意义重编码）
    if (Math.abs(srcRatio - targetRatio) / targetRatio < 0.03) {
        return input;
    }

    // 输出画布：长边不超过 maxLongSide，且贴合目标比例
    let outW;
    let outH;
    if (targetRatio >= 1) {
        outW = maxLongSide;
        outH = Math.round(outW / targetRatio);
    } else {
        outH = maxLongSide;
        outW = Math.round(outH * targetRatio);
    }
    // 16 对齐，部分视频管线更稳
    outW = Math.max(16, Math.round(outW / 16) * 16);
    outH = Math.max(16, Math.round(outH / 16) * 16);

    console.warn(
        `[gpt2api] 参考图 ${srcW}x${srcH}(≈${srcRatio.toFixed(3)}) → letterbox ${outW}x${outH}(${aspectLabel})，避免非等比拉伸`,
    );

    const fitted = await sharp(buffer)
        .resize(outW, outH, {
            fit: 'contain',
            background,
            withoutEnlargement: false,
        })
        .png()
        .toBuffer();

    return `data:image/png;base64,${fitted.toString('base64')}`;
}

async function letterboxRefsForVideo(refs, aspectRatio) {
    if (!refs?.length) return refs;
    if (!aspectRatio || aspectRatio === 'Auto' || !VIDEO_ASPECT_VALUE[aspectRatio]) return refs;
    const out = [];
    for (const ref of refs) {
        try {
            out.push(await letterboxImageToAspect(ref, aspectRatio));
        } catch (e) {
            console.warn('[gpt2api] letterbox 失败，使用原图:', e.message || e);
            out.push(ref);
        }
    }
    return out;
}

function authHeaders(apiKey, { idempotencyKey } = {}) {
    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
    };
    // 图片/视频建议带 Idempotency-Key，避免网络重试导致重复扣费
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return headers;
}

function normalizeVideoResolution(resolution) {
    const normalized = String(resolution || '').toLowerCase();
    if (VIDEO_RESOLUTIONS.has(normalized)) return normalized;
    return '720p';
}

/** 轮询一个异步任务直到完成，返回 result.data[0]（含绝对 url） */
function isAirelvoSyncBase(base) {
    try {
        const url = new URL(base);
        return url.hostname.toLowerCase() === 'airelvo.cc' && url.pathname.replace(/\/+$/, '') === '/v1';
    } catch {
        return false;
    }
}

function shouldUseAirelvoAsync({ prompt, hasRef, resolution }) {
    return hasRef || resolution === '4K' || String(prompt || '').length > 4000;
}

function toAirelvoAsyncBase(base) {
    return base.replace(/\/+$/, '') + '/async';
}

function isAirelvoAsyncBase(base) {
    try {
        const url = new URL(base);
        return url.hostname.toLowerCase() === 'airelvo.cc' && url.pathname.replace(/\/+$/, '') === '/v1/async';
    } catch {
        return false;
    }
}

function isPrivateOrUnsafeAddress(address) {
    const normalized = String(address || '').toLowerCase().split('%')[0];
    const family = net.isIP(normalized);

    if (family === 4) {
        const parts = normalized.split('.').map(Number);
        const [a, b] = parts;
        return a === 0
            || a === 10
            || a === 127
            || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 0)
            || (a === 192 && b === 168)
            || (a === 198 && (b === 18 || b === 19))
            || a >= 224;
    }

    if (family === 6) {
        if (normalized.startsWith('::ffff:')) {
            return isPrivateOrUnsafeAddress(normalized.slice('::ffff:'.length));
        }
        return normalized === '::'
            || normalized === '::1'
            || normalized.startsWith('fc')
            || normalized.startsWith('fd')
            || normalized.startsWith('fe8')
            || normalized.startsWith('fe9')
            || normalized.startsWith('fea')
            || normalized.startsWith('feb')
            || normalized.startsWith('ff')
            || normalized.startsWith('2001:db8:');
    }

    return true;
}

async function assertSafeRemoteImageUrl(value, resolveDns) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Reference image URL is invalid');
    }

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Reference image URL must use HTTP or HTTPS');
    }

    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
        throw new Error('Reference image URL points to a private or unsafe network address');
    }

    let addresses;
    if (net.isIP(hostname)) {
        addresses = [{ address: hostname }];
    } else {
        try {
            addresses = await resolveDns(hostname, { all: true, verbatim: true });
        } catch {
            throw new Error('Failed to resolve reference image host');
        }
    }

    if (!Array.isArray(addresses)) addresses = [addresses];
    if (addresses.length === 0 || addresses.some(item => isPrivateOrUnsafeAddress(item?.address))) {
        throw new Error('Reference image URL points to a private or unsafe network address');
    }

    return url;
}

async function remoteImageToDataUrl(value, resolveDns, { maxBytes = 20 * 1024 * 1024 } = {}) {
    let current = await assertSafeRemoteImageUrl(value, resolveDns);

    for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
        const response = await fetch(current, {
            redirect: 'manual',
            headers: {
                'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                'User-Agent': 'Mozilla/5.0 (compatible; MagicalCanvas/1.0)',
            },
        });

        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (!location || redirectCount === 3) throw new Error('Reference image redirected too many times');
            current = await assertSafeRemoteImageUrl(new URL(location, current).toString(), resolveDns);
            continue;
        }

        if (!response.ok) throw new Error(`Failed to download reference image (HTTP ${response.status})`);
        const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!contentType.startsWith('image/')) throw new Error('Reference image URL did not return an image');

        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            throw new Error('Reference image is too large');
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) throw new Error('Reference image is too large');
        return `data:${contentType};base64,${buffer.toString('base64')}`;
    }

    throw new Error('Failed to download reference image');
}

async function toAirelvoReferenceImage(value, resolveDns) {
    const input = toImageInput(value);
    if (!input) throw new Error('Airelvo async image edit requires a reference image');
    if (input.startsWith('data:image/')) return input;
    if (input.startsWith('data:')) throw new Error('Airelvo reference_image must be an image data URL');
    return remoteImageToDataUrl(input, resolveDns);
}

async function pollTask(pollUrl, apiKey, { timeoutMs = 600000 } = {}) {
    const start = Date.now();
    let interval = 3000;
    // 中转站偶发返回 403/permission_denied 或 5xx（限流/网关抖动），任务在上游其实仍在跑。
    // 单次轮询失败不能直接判死刑，连续多次失败才视为真失败，
    // 否则会出现「任务实际生成成功、前端却报权限错误」。
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 6;

    while (true) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('gpt2api 任务超时');
        }

        let res, data;
        try {
            res = await fetch(pollUrl, { headers: authHeaders(apiKey) });
            data = await res.json().catch(() => ({}));
        } catch (e) {
            consecutiveErrors++;
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                throw new Error(`轮询请求连续失败：${e.message || e}`);
            }
            await sleep(4000);
            continue;
        }

        if (!res.ok) {
            consecutiveErrors++;
            console.warn(`[gpt2api] 轮询返回 HTTP ${res.status}（第 ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS} 次），稍后重试:`, data?.error?.message || data?.error || '');
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                throw new Error(data?.error?.message || data?.error || `轮询失败 (HTTP ${res.status})`);
            }
            await sleep(4000);
            continue;
        }
        consecutiveErrors = 0;

        const retryHeader = parseInt(res.headers.get('Retry-After') || '', 10);
        const status = data.status;
        if (status === 'succeeded') {
            const item = data?.result?.data?.[0];
            if (!item || !item.url) throw new Error('gpt2api 返回结果缺少 url');
            return item;
        }
        if (status === 'failed' || status === 'refunded') {
            throw new Error(data?.error?.message || data?.error || 'gpt2api 任务失败');
        }

        // queued / running：按 retry_after 间隔继续
        const retryAfter = Number.isFinite(retryHeader) ? retryHeader
            : (Number.isFinite(data.retry_after) ? data.retry_after : 3);
        interval = Math.max(2000, retryAfter * 1000);
        await sleep(interval);
    }
}

async function downloadToBuffer(url, { retries = 3, apiKey } = {}) {
    let lastErr;
    const headers = {};
    // gpt2api 结果 CDN 偶发需要鉴权；带上 KEY 更稳
    if (apiKey && /gpt2api\.com/i.test(String(url))) {
        headers.Authorization = `Bearer ${apiKey}`;
    }
    for (let i = 0; i <= retries; i++) {
        try {
            const resp = await fetch(url, { headers });
            if (!resp.ok) throw new Error(`下载生成结果失败 (HTTP ${resp.status})`);
            const buf = Buffer.from(await resp.arrayBuffer());
            if (buf.length < 32) throw new Error('下载生成结果过小，可能不是有效图片/视频');
            return buf;
        } catch (e) {
            lastErr = e;
            if (i < retries) await sleep(2000 * (i + 1));
        }
    }
    throw lastErr;
}

/** 尝试从一次性（同步）响应里直接取出结果项；取不到返回 null */
function extractSyncItem(data) {
    const arr = data?.result?.data || data?.data;
    if (Array.isArray(arr) && arr.length > 0) {
        const it = arr[0];
        if (it && (it.url || it.b64_json)) return it;
    }
    return null;
}
function extractNestedAsyncTask(data, base) {
    const task = data?.data;
    if (!task || Array.isArray(task) || typeof task !== 'object') return null;
    const id = task.task_id || task.id;
    const statusUrl = task.status_url;
    if (!id && !statusUrl) return null;

    const absoluteUrl = (value) => {
        if (!value) return null;
        try {
            return new URL(value, base + '/').toString();
        } catch {
            return value;
        }
    };

    return {
        id,
        status: String(task.status || '').toLowerCase(),
        statusUrl: absoluteUrl(statusUrl || (id ? `${base}/images/${id}` : null)),
        resultUrl: absoluteUrl(task.result_url),
        error: task.error,
    };
}

function asyncTaskErrorMessage(error, fallback) {
    if (!error) return fallback;
    if (typeof error === 'string') return error;
    return error.message || error.code || fallback;
}

async function fetchNestedAsyncImageResult(resultUrl, apiKey) {
    const res = await fetch(resultUrl, { headers: authHeaders(apiKey) });
    const contentType = res.headers.get('content-type') || '';
    if (contentType.startsWith('image/')) {
        if (!res.ok) throw new Error(`Failed to download async image result (HTTP ${res.status})`);
        const subtype = contentType.split('/')[1]?.split(';')[0]?.toLowerCase();
        const format = subtype === 'jpeg' ? 'jpg' : (subtype || 'png');
        return { buffer: Buffer.from(await res.arrayBuffer()), format };
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data?.error?.message || data?.error || `Async image result request failed (HTTP ${res.status})`);
    }
    const item = extractSyncItem(data) || extractSyncItem(data?.data);
    if (!item) throw new Error('Async image task completed without an image');
    return item;
}

async function pollNestedAsyncImageTask(initialTask, base, apiKey, { timeoutMs = 300000 } = {}) {
    const start = Date.now();
    let task = initialTask;

    while (true) {
        if (Date.now() - start > timeoutMs) throw new Error('Async image task timed out');

        if (['succeeded', 'completed', 'success', 'done'].includes(task.status)) {
            if (!task.resultUrl) throw new Error('Async image task completed without result_url');
            return fetchNestedAsyncImageResult(task.resultUrl, apiKey);
        }
        if (['failed', 'cancelled', 'canceled', 'expired', 'refunded'].includes(task.status)) {
            throw new Error(asyncTaskErrorMessage(task.error, 'Async image task failed'));
        }

        const res = await fetch(task.statusUrl, { headers: authHeaders(apiKey) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data?.error?.message || data?.error || `Async image task status request failed (HTTP ${res.status})`);
        }
        const nextTask = extractNestedAsyncTask(data, base);
        if (!nextTask) throw new Error('Async image task status response is missing data.id');
        task = nextTask;

        if (!['succeeded', 'completed', 'success', 'done', 'failed', 'cancelled', 'canceled', 'expired', 'refunded'].includes(task.status)) {
            const retryAfter = parseInt(res.headers.get('Retry-After') || '', 10);
            await sleep((Number.isFinite(retryAfter) ? Math.max(1, retryAfter) : 3) * 1000);
        }
    }
}

/**
 * 图像生成（文生图 / 图生图）。返回 { buffer, format }。
 */
export async function generateGpt2apiImage({ prompt, imageBase64Array, aspectRatio, resolution, model, baseUrl, apiKey, resolveDns = lookupDns }) {
    if (!apiKey) throw new Error('未配置 gpt2api API Key（请在「设置」中填写）');
    // 多个节点同时点生成时，在这里排队，避免上游只跑 1 个、其余超时
    return withOutboundSlot(() => generateGpt2apiImageInner({
        prompt, imageBase64Array, aspectRatio, resolution, model, baseUrl, apiKey, resolveDns,
    }), 'image');
}

async function generateGpt2apiImageInner({ prompt, imageBase64Array, aspectRatio, resolution, model, baseUrl, apiKey, resolveDns = lookupDns }) {
    const base = (baseUrl || 'https://www.gpt2api.com/v1').replace(/\/+$/, '');

    const refs = (imageBase64Array || []).map(toImageInput).filter(Boolean);
    const hasRef = refs.length > 0;

    const airelvoSync = isAirelvoSyncBase(base);
    const routeThroughAsync = airelvoSync && shouldUseAirelvoAsync({ prompt, hasRef, resolution });
    const requestBase = routeThroughAsync ? toAirelvoAsyncBase(base) : base;
    const useAsyncRequest = routeThroughAsync || !airelvoSync;
    const airelvoAsync = isAirelvoAsyncBase(requestBase);
    if (routeThroughAsync) {
        console.log('[gpt2api] Routing heavy Airelvo request through async queue');
    }

    const body = {
        model,
        prompt: prompt || '',
        n: 1,
        size: RATIO_TO_SIZE[aspectRatio] || '1024x1024',
        quality: RES_TO_IMAGE_QUALITY[resolution] || '1k',
        async: useAsyncRequest,
    };
    if (hasRef && airelvoAsync) {
        body.reference_image = await toAirelvoReferenceImage(refs[0], resolveDns);
    } else if (hasRef) {
        if (refs.length === 1) body.image = refs[0];
        else body.images = refs;
    }

    // 有参考图用 /images/edits，否则 /images/generations
    const endpoint = hasRef ? `${requestBase}/images/edits` : `${requestBase}/images/generations`;
    // 同一请求全程复用幂等键，避免超时重试时上游重复出图却丢结果
    const idempotencyKey = makeIdempotencyKey('img');

    return withUpstreamRetry(async () => {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: authHeaders(apiKey, { idempotencyKey }),
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = data?.error?.message || data?.error || `图像请求失败 (HTTP ${res.status})`;
            throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        }

        // 同步返回：直接取结果
        let item = extractSyncItem(data);
        const taskId = data.task_id || data.id;
        if (!item) {
            const nestedTask = extractNestedAsyncTask(data, requestBase);
            if (nestedTask) {
                console.log('[gpt2api] Async image task created:', nestedTask.id || nestedTask.statusUrl);
                item = await pollNestedAsyncImageTask(nestedTask, requestBase, apiKey, { timeoutMs: 600000 });
            } else {
                // Keep compatibility with legacy top-level task_id responses.
                if (!taskId) throw new Error('Image API returned neither a result nor task_id');
                item = await pollTask(`${requestBase}/images/generations/${taskId}`, apiKey, { timeoutMs: 600000 });
            }
        }

        if (item.buffer) return { buffer: item.buffer, format: item.format || 'png' };
        if (item.url) {
            // 结果 URL 形如 https://www.gpt2api.com/api/v1/m/xxx.png —— 带 KEY 下载更稳
            const candidates = [item.url];
            if (taskId) {
                const origin = requestBase.replace(/\/v\d+.*$/, '').replace(/\/+$/, '');
                candidates.push(`${origin}/api/v1/gen/assets/${taskId}/0.png`);
                candidates.push(`${origin}/api/v1/gen/cached/generated/${taskId}_0.png`);
            }
            let lastDlErr;
            for (const url of [...new Set(candidates.filter(Boolean))]) {
                try {
                    const buffer = await downloadToBuffer(url, { retries: 2, apiKey });
                    const format = /\.jpe?g(\?|$)/i.test(url) ? 'jpg' : 'png';
                    console.log(`[gpt2api] 图像结果已下载: ${url.slice(0, 80)}… (${buffer.length} bytes)`);
                    return { buffer, format };
                } catch (e) {
                    lastDlErr = e;
                    console.warn(`[gpt2api] 图像下载失败 (${url}):`, e.message || e);
                }
            }
            throw lastDlErr || new Error('图像结果下载失败');
        }
        // 兼容 b64_json 形式
        if (item.b64_json) return { buffer: Buffer.from(item.b64_json, 'base64'), format: 'png' };
        throw new Error('gpt2api 图像结果既无 url 也无 b64_json');
    }, { retries: 2, label: 'gpt2api-image' });
}

/** 从任务结果项解析秒数（兼容 duration_ms / duration） */
function itemDurationSeconds(item) {
    if (!item || typeof item !== 'object') return null;
    if (Number.isFinite(item.duration_ms) && item.duration_ms > 0) return item.duration_ms / 1000;
    if (Number.isFinite(item.duration) && item.duration > 0) {
        // 部分上游把秒写成 15，部分写成 15000
        return item.duration > 1000 ? item.duration / 1000 : item.duration;
    }
    return null;
}

/** 官方 xAI 单段生成上限 15 秒；超过部分必须走 extensions 续写 */
const GROK_NATIVE_MAX_SECONDS = 15;
const GROK_EXTEND_MAX_SECONDS = 15;

function isGrokImagineVideoModel(model) {
    return /(?:^|\/)grok-imagine-video$/i.test(String(model || ''));
}

/**
 * 提交异步视频任务并轮询到完成，返回 { item, taskId }。
 * endpoint 形如 /video/generations 或 /videos/extensions。
 */
async function submitAndPollVideoTask(base, apiKey, endpoint, body, { timeoutMs = 900000 } = {}) {
    const paths = endpoint.startsWith('/') ? [endpoint] : ['/' + endpoint];
    // 单复数路径兼容
    if (paths[0].includes('/video/') && !paths[0].includes('/videos/')) {
        paths.push(paths[0].replace('/video/', '/videos/'));
    } else if (paths[0].includes('/videos/')) {
        paths.push(paths[0].replace('/videos/', '/video/'));
    }

    let lastError;
    for (const path of paths) {
        const res = await fetch(base + path, {
            method: 'POST',
            headers: authHeaders(apiKey, { idempotencyKey: makeIdempotencyKey('vid') }),
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            lastError = new Error(data?.error?.message || data?.error || ('视频请求失败 (HTTP ' + res.status + ') @ ' + path));
            continue;
        }

        const taskId = data.task_id || data.id || data.request_id;
        let item = extractSyncItem(data);
        if (!item) {
            if (!taskId) {
                lastError = new Error('视频接口未返回结果或 task_id @ ' + path);
                continue;
            }
            const pollCandidates = [
                base + path.replace(/\/$/, '') + '/' + taskId,
                base + '/video/generations/' + taskId,
                base + '/videos/generations/' + taskId,
                base + '/videos/' + taskId,
            ];
            let pollErr;
            for (const pollUrl of [...new Set(pollCandidates)]) {
                try {
                    item = await pollTask(pollUrl, apiKey, { timeoutMs });
                    pollErr = null;
                    break;
                } catch (e) {
                    pollErr = e;
                }
            }
            if (!item) {
                lastError = pollErr || new Error('视频任务轮询失败');
                continue;
            }
        }
        return { item, taskId, data };
    }
    throw lastError || new Error('视频请求失败');
}

/**
 * 用 /videos/extensions 把短片续写到目标时长。
 * duration 表示「追加」秒数，不是总时长（官方 xAI 约定）。
 */
async function extendVideoToTarget({
    base, apiKey, model, prompt, videoUrl, currentSeconds, targetSeconds, useOfficialXai,
}) {
    let item = { url: videoUrl };
    let seconds = currentSeconds;
    let rounds = 0;
    const maxRounds = 4;

    while (seconds + 0.75 < targetSeconds && rounds < maxRounds) {
        const remaining = Math.ceil(targetSeconds - seconds);
        // 每次最多追加 15s；优先凑 10s 分档
        let append = Math.min(GROK_EXTEND_MAX_SECONDS, Math.max(3, remaining));
        if (remaining >= 10 && append > 10 && remaining !== 15) {
            append = 10;
        }

        const extendPrompt = prompt
            ? ('Continue seamlessly from the last frame. Keep the same subject, style, and motion. ' + prompt)
            : 'Continue seamlessly from the last frame with consistent motion and style.';

        const body = {
            model,
            prompt: extendPrompt,
            duration: append,
            async: true,
        };
        if (useOfficialXai) {
            body.video = { url: item.url };
        } else {
            // 统一下游同时兼容 video 字符串与 video_url
            body.video = item.url;
            body.video_url = item.url;
        }

        console.log('[gpt2api] 视频扩展第 ' + (rounds + 1) + ' 次：当前约 ' + seconds.toFixed(1) + 's → 追加 ' + append + 's（目标 ' + targetSeconds + 's）');

        let extended;
        try {
            extended = await submitAndPollVideoTask(base, apiKey, '/videos/extensions', body);
        } catch (e) {
            // 部分网关只认 video 对象
            if (!useOfficialXai) {
                body.video = { url: item.url };
                delete body.video_url;
                extended = await submitAndPollVideoTask(base, apiKey, '/videos/extensions', body);
            } else {
                throw e;
            }
        }

        const next = extended.item;
        if (!next?.url) throw new Error('视频扩展未返回 url');
        const reported = itemDurationSeconds(next);
        // 扩展结果应为「原片 + 追加」；若上游只回报追加段时长则累加
        if (reported != null && reported >= seconds - 0.5) {
            seconds = reported;
        } else if (reported != null && reported > 0 && reported < seconds) {
            seconds = seconds + reported;
        } else {
            seconds = seconds + append;
        }
        item = next;
        rounds += 1;
        console.log('[gpt2api] 扩展完成，估算时长 ' + seconds.toFixed(1) + 's');
    }

    return { item, seconds };
}

async function downloadVideoItem(base, item, taskId) {
    const origin = base.replace(/\/v\d+$/, '');
    const proxyUrl = taskId ? (origin + '/api/v1/gen/assets/' + taskId + '/0.mp4') : null;
    const preferProxy = String(item.url || '').includes('assets.grok.com');
    const candidates = preferProxy
        ? [proxyUrl, item.url].filter(Boolean)
        : [item.url, proxyUrl].filter(Boolean);

    let lastErr;
    for (const url of candidates) {
        try {
            return await downloadToBuffer(url, { retries: 1 });
        } catch (e) {
            lastErr = e;
            console.warn('[gpt2api] 视频下载失败 (' + url + ')，尝试备用地址:', e.message);
        }
    }
    throw lastErr || new Error('视频下载失败');
}

/**
 * 视频生成（文生视频 / 图生视频）。返回 Buffer(mp4)。
 *
 * 时长分档（与 gpt2api 后台 model_prices 一致）：
 * - grok-imagine-video / xai/grok-imagine-video：6 / 10 / 20 / 30 秒
 *   · 官方 xAI 单段最长 15s；20/30 若中转未自动拼接，则本地用 /videos/extensions 续写
 * - sora：4 / 8 / 12
 * - veo3.1*：4 / 6 / 8
 *
 * 参数格式：
 * - xai/* 官方路径：aspect_ratio + resolution + image:{url} / reference_images
 * - 统一下游：ratio + quality(hd/fullhd) + image / images[]
 */
export async function generateGpt2apiVideo({ prompt, imageBase64, lastFrameBase64, referenceImages, aspectRatio, resolution, duration, model, baseUrl, apiKey }) {
    if (!apiKey) throw new Error('未配置 gpt2api API Key（请在「设置」中填写）');
    return withOutboundSlot(() => generateGpt2apiVideoInner({
        prompt, imageBase64, lastFrameBase64, referenceImages, aspectRatio, resolution, duration, model, baseUrl, apiKey,
    }), 'video');
}

async function generateGpt2apiVideoInner({ prompt, imageBase64, lastFrameBase64, referenceImages, aspectRatio, resolution, duration, model, baseUrl, apiKey }) {
    const base = (baseUrl || 'https://www.gpt2api.com/v1').replace(/\/+$/, '');

    const isGrokVideo = isGrokImagineVideoModel(model);
    const useOfficialXai = isOfficialXaiVideoModel(model);
    const resolvedDuration = normalizeGpt2apiVideoDuration(duration, model);
    const resolvedResolution = normalizeVideoResolution(resolution);
    let refs = Array.from(new Set([
        ...(Array.isArray(referenceImages) ? referenceImages : []),
        imageBase64,
        lastFrameBase64,
    ].map(toImageInput).filter(Boolean))).slice(0, 8);

    // 图生视频：参考图比例与成片比例不一致时先 letterbox，禁止上游非等比拉伸（人物被拉高）
    // 例如尾帧 750x1000(3:4) + 成片 9:16 → 先垫成 9:16 再送
    if (refs.length > 0 && aspectRatio && aspectRatio !== 'Auto') {
        refs = await letterboxRefsForVideo(refs, aspectRatio);
    }

    // 官方 xAI 单段硬顶 15s。中转站虽写「20/30 自动拼接」，实测常只回 15s。
    // 因此 Grok 超过 15s 时：首包最多 15s，不足部分本地走 /videos/extensions 续写。
    const firstShotDuration = isGrokVideo
        ? Math.min(resolvedDuration, GROK_NATIVE_MAX_SECONDS)
        : resolvedDuration;

    const body = {
        model,
        prompt: prompt || '',
        duration: firstShotDuration,
        async: true,
    };

    // 文生视频：传 ratio；图生视频在已 letterbox 后也传目标画幅，保证成片比例一致
    // 若无参考图且 Auto，则不传 ratio（让上游默认）
    if (useOfficialXai) {
        if (aspectRatio && aspectRatio !== 'Auto') body.aspect_ratio = aspectRatio;
        body.resolution = resolvedResolution;
        if (refs.length > 1) {
            body.operation = 'reference-to-video';
            body.reference_images = refs.map(url => ({ url }));
        } else if (refs.length === 1) {
            body.image = { url: refs[0] };
        }
    } else {
        if (aspectRatio && aspectRatio !== 'Auto') body.ratio = aspectRatio;
        if (RES_TO_VIDEO_QUALITY[resolvedResolution]) {
            body.quality = RES_TO_VIDEO_QUALITY[resolvedResolution];
        } else if (resolvedResolution === '480p') {
            body.resolution = '480p';
        }
        if (refs.length === 1) body.image = refs[0];
        else if (refs.length > 1 && isGrokVideo) body.images = refs;
        else if (refs.length > 1) body.image = refs[0];
    }

    let submitted;
    try {
        submitted = await withUpstreamRetry(
            () => submitAndPollVideoTask(base, apiKey, '/video/generations', body),
            { retries: 2, label: 'gpt2api-video' },
        );
    } catch (firstErr) {
        const msg = String(firstErr.message || firstErr);
        if ((Array.isArray(body.images) || Array.isArray(body.reference_images))
            && /images|reference_images|unknown field|unsupported|invalid parameter|参数/i.test(msg)) {
            console.warn('[gpt2api] 多图视频参数被上游拒绝，回退首张关键帧: ' + msg);
            delete body.images;
            delete body.reference_images;
            delete body.operation;
            if (useOfficialXai) body.image = { url: refs[0] };
            else body.image = refs[0];
            submitted = await withUpstreamRetry(
                () => submitAndPollVideoTask(base, apiKey, '/video/generations', body),
                { retries: 1, label: 'gpt2api-video-fallback' },
            );
        } else if (useOfficialXai && body.image && typeof body.image === 'object'
            && /image|unknown field|unsupported|invalid parameter|参数/i.test(msg)) {
            console.warn('[gpt2api] 官方 image 对象格式被拒，回退字符串: ' + msg);
            body.image = refs[0];
            submitted = await withUpstreamRetry(
                () => submitAndPollVideoTask(base, apiKey, '/video/generations', body),
                { retries: 1, label: 'gpt2api-video-fallback' },
            );
        } else {
            throw firstErr;
        }
    }

    let { item, taskId } = submitted;
    if (!item?.url) throw new Error('视频接口未返回 url');

    let actualSeconds = itemDurationSeconds(item);
    if (actualSeconds == null) {
        // 未回报时长时按首包请求值估算（Grok 首包已 cap 在 15s）
        actualSeconds = firstShotDuration;
    }

    console.log('[gpt2api] 首段视频完成：请求 ' + resolvedDuration + 's，首包 ' + firstShotDuration + 's，回报/估算 ' + actualSeconds.toFixed(1) + 's');

    // 目标明显更长 → 用 extensions 续写（修 30s 只拿到 15s 的问题）
    if (isGrokVideo && actualSeconds + 0.75 < resolvedDuration) {
        const extended = await extendVideoToTarget({
            base,
            apiKey,
            model,
            prompt: prompt || '',
            videoUrl: item.url,
            currentSeconds: actualSeconds,
            targetSeconds: resolvedDuration,
            useOfficialXai: useOfficialXai || isGrokVideo,
        });
        item = extended.item;
        actualSeconds = extended.seconds;
        taskId = null;
        console.log('[gpt2api] 长视频扩展结束：目标 ' + resolvedDuration + 's，最终约 ' + actualSeconds.toFixed(1) + 's');
    }

    return downloadVideoItem(base, item, taskId);
}

/**
 * 文本对话（OpenAI 兼容）。返回模型回复字符串。
 * 使用 SSE 流式接收再拼装：慢速推理模型（如 gpt-5 系列）非流式请求
 * 容易被中转网关 1~2 分钟超时掐断，流式则不受影响。
 */
export async function gpt2apiChat({ messages, model, baseUrl, apiKey, temperature = 0.7, maxTokens, onDelta }) {
    if (!apiKey) throw new Error('未配置 gpt2api API Key（请在「设置」中填写）');
    const base = (baseUrl || 'https://www.gpt2api.com/v1').replace(/\/+$/, '');

    const body = { model, messages, temperature, stream: true };
    if (maxTokens) body.max_tokens = maxTokens;

    const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) });

    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || data?.error || `gpt2api 文本请求失败 (HTTP ${res.status})`);
    }

    const contentType = res.headers.get('content-type') || '';
    // 部分网关会忽略 stream 参数直接返回 JSON，做好兼容
    if (contentType.includes('application/json')) {
        const data = await res.json().catch(() => ({}));
        if (data?.error) throw new Error(data.error.message || data.error);
        return data?.choices?.[0]?.message?.content || '';
    }

    // 解析 SSE 流，拼接 delta.content
    let full = '';
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 留下不完整的最后一行
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
                const json = JSON.parse(payload);
                if (json?.error) throw new Error(json.error.message || json.error);
                const delta = json?.choices?.[0]?.delta?.content;
                if (delta) {
                    full += delta;
                    try { onDelta?.(delta, full.length); } catch { /* 进度回调失败不影响主流程 */ }
                }
            } catch (e) {
                if (e instanceof SyntaxError) continue; // 跳过非 JSON 行
                throw e;
            }
        }
    }
    return full;
}
