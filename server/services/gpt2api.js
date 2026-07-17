import net from 'node:net';
import { lookup as lookupDns } from 'node:dns/promises';

/**
 * gpt2api.js
 *
 * gpt2api.com（OpenAI 兼容下游接口）服务封装。
 * 统一支持文本 / 图像 / 视频；图像与视频走异步任务 + 轮询。
 *
 * 接入地址形如 https://www.gpt2api.com/v1
 * 鉴权：Authorization: Bearer sk-xxx
 */

// gpt2api 提供的模型 ID（用于在生成路由里判断走哪个提供商）
export const GPT2API_IMAGE_MODELS = ['nano-banana-pro', 'nano-banana-v2', 'nano-banana', 'gpt-image-2'];
export const GPT2API_VIDEO_MODELS = ['xai/grok-imagine-video', 'grok-imagine-video', 'sora', 'veo3.1', 'veo3.1-flash', 'veo3.1-lite'];

export const isGpt2apiImageModel = (id) => GPT2API_IMAGE_MODELS.includes(id);
export const isGpt2apiVideoModel = (id) => GPT2API_VIDEO_MODELS.includes(id);

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
// 视频分辨率 → quality
const RES_TO_VIDEO_QUALITY = { '720p': 'hd', '1080p': 'fullhd' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 确保为 data URL（gpt2api 接受 data:image/...;base64,... 或公网 URL） */
function toImageInput(value) {
    if (!value) return null;
    if (value.startsWith('http://') || value.startsWith('https://')) return value;
    if (value.startsWith('data:')) return value;
    return `data:image/png;base64,${value}`;
}

function authHeaders(apiKey) {
    return {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
    };
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

async function downloadToBuffer(url, { retries = 3 } = {}) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`下载生成结果失败 (HTTP ${resp.status})`);
            return Buffer.from(await resp.arrayBuffer());
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

    const res = await fetch(endpoint, { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || data?.error || `图像请求失败 (HTTP ${res.status})`);

    // 同步返回：直接取结果
    let item = extractSyncItem(data);
    if (!item) {
        const nestedTask = extractNestedAsyncTask(data, requestBase);
        if (nestedTask) {
            console.log('[gpt2api] Async image task created:', nestedTask.id || nestedTask.statusUrl);
            item = await pollNestedAsyncImageTask(nestedTask, requestBase, apiKey, { timeoutMs: 300000 });
        } else {
            // Keep compatibility with legacy top-level task_id responses.
            const taskId = data.task_id || data.id;
            if (!taskId) throw new Error('Image API returned neither a result nor task_id');
            item = await pollTask(`${requestBase}/images/generations/${taskId}`, apiKey, { timeoutMs: 300000 });
        }
    }

    if (item.buffer) return { buffer: item.buffer, format: item.format || 'png' };
    if (item.url) {
        const buffer = await downloadToBuffer(item.url);
        const format = item.url.includes('.jpg') || item.url.includes('.jpeg') ? 'jpg' : 'png';
        return { buffer, format };
    }
    // 兼容 b64_json 形式
    return { buffer: Buffer.from(item.b64_json, 'base64'), format: 'png' };
}

/**
 * 视频生成（文生视频 / 图生视频）。返回 Buffer(mp4)。
 */
export async function generateGpt2apiVideo({ prompt, imageBase64, lastFrameBase64, referenceImages, aspectRatio, resolution, duration, model, baseUrl, apiKey }) {
    if (!apiKey) throw new Error('未配置 gpt2api API Key（请在「设置」中填写）');
    const base = (baseUrl || 'https://www.gpt2api.com/v1').replace(/\/+$/, '');

    const isGrokVideo = /(?:^|\/)grok-imagine-video$/i.test(String(model || ''));
    const refs = Array.from(new Set([
        ...(Array.isArray(referenceImages) ? referenceImages : []),
        imageBase64,
        lastFrameBase64,
    ].map(toImageInput).filter(Boolean))).slice(0, 8);
    const body = {
        model,
        prompt: prompt || '',
        duration: duration || 6,
        async: true,
    };
    if (aspectRatio && aspectRatio !== 'Auto') body.ratio = aspectRatio;
    if (resolution && RES_TO_VIDEO_QUALITY[resolution]) body.quality = RES_TO_VIDEO_QUALITY[resolution];
    if (refs.length === 1) body.image = refs[0];
    else if (refs.length > 1 && isGrokVideo) body.images = refs;
    else if (refs.length > 1) body.image = refs[0];

    let res = await fetch(`${base}/video/generations`, { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) });
    let data = await res.json().catch(() => ({}));
    const errorText = String(data?.error?.message || data?.error || '');
    if (!res.ok && Array.isArray(body.images) && /images|unknown field|unsupported|invalid parameter|参数/i.test(errorText)) {
        console.warn(`[gpt2api] 多图视频参数被上游拒绝，回退首张关键帧: ${errorText}`);
        delete body.images;
        body.image = refs[0];
        res = await fetch(`${base}/video/generations`, { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) });
        data = await res.json().catch(() => ({}));
    }
    if (!res.ok) throw new Error(data?.error?.message || data?.error || `视频请求失败 (HTTP ${res.status})`);

    const taskId = data.task_id || data.id;
    let item = extractSyncItem(data);
    if (!item) {
        if (!taskId) throw new Error('视频接口未返回结果或 task_id');
        item = await pollTask(`${base}/video/generations/${taskId}`, apiKey, { timeoutMs: 900000 });
    }

    // 中转站自带结果代理：/api/v1/gen/assets/{taskId}/0.mp4。
    // grok-imagine-video 等模型的 result.url 是上游原始地址（assets.grok.com，
    // 需要 grok.com 登录态，直接下载 403），但代理地址可以正常下载。
    const origin = base.replace(/\/v\d+$/, '');
    const proxyUrl = taskId ? `${origin}/api/v1/gen/assets/${taskId}/0.mp4` : null;
    const preferProxy = String(item.url).includes('assets.grok.com');

    const candidates = preferProxy
        ? [proxyUrl, item.url].filter(Boolean)
        : [item.url, proxyUrl].filter(Boolean);

    let lastErr;
    for (const url of candidates) {
        try {
            return await downloadToBuffer(url, { retries: 1 });
        } catch (e) {
            lastErr = e;
            console.warn(`[gpt2api] 视频下载失败 (${url})，尝试备用地址:`, e.message);
        }
    }
    throw lastErr || new Error('视频下载失败');
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
