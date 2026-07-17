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
export const generateImage = async (params: GenerateImageParams): Promise<string> => {
  try {
    const { signal, ...body } = params;
    const response = await fetch('/api/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || response.statusText);
    }

    const data = await response.json();
    if (!data.resultUrl) {
      throw new Error("No image data returned from server");
    }
    return data.resultUrl;

  } catch (error) {
    console.error("Image Generation Error:", error);
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

const recoverVideoResult = async (
  nodeId: string,
  signal?: AbortSignal,
  timeoutMs = 15 * 60 * 1000,
): Promise<string | null> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch('/api/generation-status/' + encodeURIComponent(nodeId), {
      signal,
      cache: 'no-store',
    });
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.status === 'success' && data.resultUrl) return data.resultUrl;
      if (data.status === 'stale') return null;
    }

    await waitFor(5000, signal);
  }

  return null;
};

const isRecoverableProxyFailure = (response: Response, message: string): boolean => (
  [502, 503, 504].includes(response.status)
  || /proxy|gateway|timed?\s*out|timeout|upstream/i.test(message)
);

/**
 * Generates a video by calling the backend API.
 * Saved canvases can contain old image resolution or duration values, so the
 * final request boundary always normalizes them before crossing the Vercel proxy.
 */
export const generateVideo = async (params: GenerateVideoParams): Promise<string> => {
  const { signal, ...rawBody } = params;
  const normalizedVideoModel = rawBody.videoModel === 'xai/grok-imagine-video'
    ? 'grok-imagine-video'
    : rawBody.videoModel;
  const body = {
    ...rawBody,
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
