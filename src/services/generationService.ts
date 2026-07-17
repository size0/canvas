import { limitPrompt } from '../utils/promptLimits.ts';

/**
 * generationService.ts
 * 
 * Frontend service layer for AI content generation.
 * Proxies requests to backend API which handles multiple providers:
 * - Image: Gemini Pro, Kling AI
 * - Video: Veo 3.1, Kling AI
 */

export interface GenerateImageParams {
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  imageBase64?: string | string[]; // Supports single image or array of images
  imageModel?: string; // Image model version (e.g., 'gemini-pro', 'kling-v2')
  nodeId?: string; // ID of the node initiating generation
  // Kling V1.5 reference settings
  klingReferenceMode?: 'subject' | 'face';
  klingFaceIntensity?: number; // 0-100
  klingSubjectIntensity?: number; // 0-100
  title?: string; // 节点标题（如「分镜 01」），存入素材元数据供剪辑页区分
  signal?: AbortSignal; // 用于「停止生成」中止在途请求
}

export interface GenerateVideoParams {
  prompt: string;
  imageBase64?: string; // For Image-to-Video (start frame)
  lastFrameBase64?: string; // For frame-to-frame interpolation (end frame)
  referenceImages?: string[]; // Ordered keyframes for multi-image video generation
  aspectRatio?: string;
  resolution?: string; // Add resolution to params
  duration?: number; // Model-specific video duration in seconds
  videoModel?: string; // Video model version (e.g., 'veo-3.1', 'kling-v2-1')
  motionReferenceUrl?: string; // For Kling 2.6 motion control
  generateAudio?: boolean; // For Kling 2.6 and Veo 3.1 native audio (default: true)
  nodeId?: string; // ID of the node initiating generation
  title?: string; // 节点标题（如「镜头 01 视频」），存入素材元数据供剪辑页区分
  signal?: AbortSignal; // 用于「停止生成」中止在途请求
}

/**
 * Generates an image by calling the backend API
 */
const waitFor = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new DOMException('The operation was aborted.', 'AbortError'));
    return;
  }

  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(new DOMException('The operation was aborted.', 'AbortError'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});

const recoverMediaResult = async (
  nodeId: string,
  signal?: AbortSignal,
  timeoutMs = 12 * 60 * 1000,
): Promise<string | null> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const response = await fetch('/api/generation-status/' + encodeURIComponent(nodeId), {
      signal,
      cache: 'no-store',
    });
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.status === 'success' && data.resultUrl) return data.resultUrl;
      // pending = 服务端还在跑，继续等；stale 也先等一会儿，避免刚提交时误判
    }
    await waitFor(4000, signal);
  }
  return null;
};

const isRecoverableFailure = (error: unknown, response?: Response): boolean => {
  const msg = String((error as any)?.message || error || '');
  if (response && [502, 503, 504].includes(response.status)) return true;
  return /timeout|timed?\s*out|i\/o timeout|network|fetch failed|proxy|gateway|ECONNRESET|aborted|Failed to fetch/i.test(msg);
};

export const generateImage = async (params: GenerateImageParams): Promise<string> => {
  const { signal, ...rawBody } = params;
  // 长提示词不再截断，仅做空白规范化
  const body = {
    ...rawBody,
    prompt: limitPrompt(rawBody.prompt),
  };

  try {
    let response: Response;
    try {
      response = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      // 代理/浏览器断开时，服务端可能仍在生成并已写入 nodeId 结果
      if (rawBody.nodeId && isRecoverableFailure(error)) {
        const recovered = await recoverMediaResult(rawBody.nodeId, signal);
        if (recovered) return recovered;
      }
      throw error;
    }

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const message = errData.error || response.statusText || 'Image generation failed';
      if (rawBody.nodeId && isRecoverableFailure(message, response)) {
        const recovered = await recoverMediaResult(rawBody.nodeId, signal);
        if (recovered) return recovered;
      }
      throw new Error(message);
    }

    const data = await response.json();
    if (!data.resultUrl) {
      if (rawBody.nodeId) {
        const recovered = await recoverMediaResult(rawBody.nodeId, signal, 60_000);
        if (recovered) return recovered;
      }
      throw new Error('No image data returned from server');
    }
    return data.resultUrl;

  } catch (error) {
    console.error('Image Generation Error:', error);
    // 最后再捞一次：上游已出图、本机已落盘，但 HTTP 响应丢了
    if (rawBody.nodeId && isRecoverableFailure(error)) {
      try {
        const recovered = await recoverMediaResult(rawBody.nodeId, signal, 90_000);
        if (recovered) return recovered;
      } catch { /* ignore */ }
    }
    throw error;
  }
};

const DEFAULT_VIDEO_DURATIONS = [6, 10, 20, 30] as const;
const VIDEO_DURATIONS_BY_MODEL: Record<string, readonly number[]> = {
  'xai/grok-imagine-video': DEFAULT_VIDEO_DURATIONS,
  'grok-imagine-video': DEFAULT_VIDEO_DURATIONS,
  'sora': [4, 8, 12],
  'veo3.1': [4, 6, 8],
  'veo3.1-flash': [4, 6, 8],
  'veo3.1-lite': [4, 6, 8],
};

const normalizeVideoDuration = (duration: unknown, model?: string): number => {
  const supported = VIDEO_DURATIONS_BY_MODEL[model || ''] || DEFAULT_VIDEO_DURATIONS;
  const requested = Number(duration);
  if (!Number.isFinite(requested)) return supported[0];

  return supported.reduce(
    (best, value) => value <= requested ? value : best,
    supported[0],
  );
};

const normalizeVideoResolution = (resolution?: string): string => {
  const normalized = String(resolution || '').toLowerCase();
  if (['480p', '720p', '1080p'].includes(normalized)) return normalized;
  return '720p';
};

const responseErrorMessage = async (response: Response): Promise<string> => {
  const raw = (await response.text().catch(() => '')).trim();
  if (!raw) return response.statusText || ('Video request failed (HTTP ' + response.status + ')');

  try {
    const data = JSON.parse(raw);
    const error = data?.error?.message || data?.error || data?.message;
    if (typeof error === 'string' && error.trim()) return error.trim();
  } catch {
    // Vercel proxy errors are plain text rather than JSON.
  }

  return raw.slice(0, 500);
};

const recoverVideoResult = async (
  nodeId: string,
  signal?: AbortSignal,
  timeoutMs = 15 * 60 * 1000,
): Promise<string | null> => recoverMediaResult(nodeId, signal, timeoutMs);

const isRecoverableProxyFailure = (response: Response, message: string): boolean => (
  isRecoverableFailure(message, response)
);

/**
 * Generates a video by calling the backend API.
 * Saved canvases can contain old image resolution or duration values, so the
 * final request boundary always normalizes them before crossing the Vercel proxy.
 */
export const generateVideo = async (params: GenerateVideoParams): Promise<string> => {
  const { signal, ...rawBody } = params;
  // 保留 xai/grok-imagine-video：后端会按官方 xAI 参数格式发送
  const normalizedVideoModel = rawBody.videoModel;
  const body = {
    ...rawBody,
    // 长提示词不再截断，仅做空白规范化
    prompt: limitPrompt(rawBody.prompt),
    videoModel: normalizedVideoModel,
    duration: normalizeVideoDuration(rawBody.duration, normalizedVideoModel),
    resolution: normalizeVideoResolution(rawBody.resolution),
  };

  try {
    let response: Response;
    try {
      response = await fetch('/api/generate-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (!signal?.aborted && rawBody.nodeId) {
        const recovered = await recoverVideoResult(rawBody.nodeId, signal);
        if (recovered) return recovered;
      }
      throw error;
    }

    if (!response.ok) {
      const message = await responseErrorMessage(response);
      if (rawBody.nodeId && isRecoverableProxyFailure(response, message)) {
        const recovered = await recoverVideoResult(rawBody.nodeId, signal);
        if (recovered) return recovered;
      }
      throw new Error(message);
    }

    const data = await response.json();
    if (!data.resultUrl) {
      throw new Error('No video data returned from server');
    }
    return data.resultUrl;

  } catch (error) {
    console.error('Video Generation Error:', error);
    throw error;
  }
};
