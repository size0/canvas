/**
 * 提示词长度上限：只兜底，不故意压扁创意。
 * 目标是避免个别接口在 4k~5k+ 字时报错，而不是把每句都砍到几十个字。
 */
export const IMAGE_PROMPT_MAX_CHARS = 2000;
export const STORYBOARD_PROMPT_MAX_CHARS = 5000;
export const SINGLE_VIDEO_PROMPT_MAX_CHARS = 1600;
/** 多关键帧合成一条成片时的总 prompt；略低于常见 4k 敏感区 */
export const VIDEO_PROMPT_MAX_CHARS = 3000;

type PromptShot = {
  startSec?: number;
  endSec?: number;
  shotPurpose?: string;
  scene?: string;
  shotSize?: string;
  camera?: string;
  composition?: string;
  action?: string;
  subtitle?: string;
  transition?: string;
};

type StoryboardPromptInput = {
  title?: string;
  productName?: string;
  industry?: string;
  videoDuration: number;
  aspectRatio: string;
  consistencyAnchor?: string;
  visualDirection?: string;
  sceneWorld?: string;
  colorLighting?: string;
  shots?: PromptShot[];
};

type VideoPromptInput = {
  productName?: string;
  videoDuration: number;
  consistencyAnchor?: string;
  visualDirection?: string;
  rhythm?: string;
  voiceover?: string;
  subtitles?: string;
  shots?: PromptShot[];
};

const compactWhitespace = (value: unknown): string => String(value || '')
  .replace(/\r\n?/g, '\n')
  .replace(/[\t ]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const excerpt = (value: unknown, maxChars: number): string => {
  const text = compactWhitespace(value);
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
};

export const limitPrompt = (value: unknown, maxChars: number): string => {
  const text = compactWhitespace(value);
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;

  const marker = '\n…（中间重复内容已自动精简）…\n';
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(available * 0.72);
  const tailLength = available - headLength;
  return `${text.slice(0, headLength).trimEnd()}${marker}${text.slice(-tailLength).trimStart()}`
    .slice(0, maxChars);
};

export const buildCompactProductStoryboardPrompt = ({
  title,
  productName,
  industry,
  videoDuration,
  aspectRatio,
  consistencyAnchor,
  visualDirection,
  sceneWorld,
  colorLighting,
  shots = [],
}: StoryboardPromptInput): string => {
  const shotLines = shots.map((shot, index) => {
    const startSec = shot.startSec ?? index * 2;
    const endSec = shot.endSec ?? Math.min(videoDuration, startSec + 2);
    return [
      `镜头${String(index + 1).padStart(2, '0')} ${startSec}-${endSec}秒`,
      `职责：${excerpt(shot.shotPurpose, 40)}`,
      `景别：${excerpt(shot.shotSize, 20)}`,
      `机位：${excerpt(shot.camera, 36)}`,
      `场景：${excerpt(shot.scene, 70)}`,
      `动作：${excerpt(shot.action, 90)}`,
      `构图：${excerpt(shot.composition, 70)}`,
      shot.subtitle ? `短注：${excerpt(shot.subtitle, 24)}` : '',
    ].filter(Boolean).join('｜');
  });

  return limitPrompt([
    `生成一张${aspectRatio}专业商业广告故事板母版大图，只输出一张拼版，不是单帧海报。`,
    `标题《${excerpt(title || productName || '产品广告', 40)}》｜行业：${excerpt(industry || '通用电商', 24)}｜时长：${videoDuration}秒｜分镜数：${shots.length}。`,
    `严格按镜头01至镜头${String(shots.length).padStart(2, '0')}排列，画格数量必须准确；每格使用${aspectRatio}成片安全区，编号与时间码清晰，禁止增加空白格或额外画格。`,
    `产品一致性：${excerpt(consistencyAnchor, 420)}`,
    `整体视觉：${excerpt(visualDirection, 260)}`,
    `场景世界：${excerpt(sceneWorld, 160)}`,
    `色彩灯光：${excerpt(colorLighting, 160)}`,
    '逐格内容：',
    ...shotLines,
    '所有画格保持同一产品、同一包装结构、颜色、材质、比例、Logo与可见文字位置；禁止产品变形、改色、复制、增加不存在的部件、文字乱码、水印或额外画格。',
  ].filter(Boolean).join('\n'), STORYBOARD_PROMPT_MAX_CHARS);
};

export const buildCompactProductVideoPrompt = ({
  productName,
  videoDuration,
  consistencyAnchor,
  visualDirection,
  rhythm,
  voiceover,
  subtitles,
  shots = [],
}: VideoPromptInput): string => {
  const perShotBudget = Math.max(48, Math.min(110, Math.floor(1600 / Math.max(1, shots.length))));
  const timeline = shots.map((shot, index) => {
    const startSec = shot.startSec ?? index * 2;
    const endSec = shot.endSec ?? Math.min(videoDuration, startSec + 2);
    return [
      `【${startSec}-${endSec}秒｜镜头 ${index + 1}】`,
      excerpt(shot.shotPurpose, 36),
      excerpt(shot.action, perShotBudget),
      excerpt(shot.camera, 40),
      excerpt(shot.transition, 28),
    ].filter(Boolean).join('；');
  });

  return limitPrompt([
    `生成${videoDuration}秒${excerpt(productName || '产品', 40)}商业广告。第一张参考图为按时间顺序排列的完整故事板，其余参考图只用于锁定产品外观。`,
    `产品一致性：${excerpt(consistencyAnchor, 360)}`,
    `视觉方向：${excerpt(visualDirection, 220)}`,
    `整体节奏：${excerpt(rhythm, 140)}`,
    '时间线：',
    ...timeline,
    voiceover ? `中文口播：${excerpt(voiceover, 280)}` : '',
    subtitles ? `字幕重点：${excerpt(subtitles, 140)}` : '',
    '严格按时间线演绎；产品外观、包装、颜色、材质、比例、Logo与可见文字全程不变。禁止闪烁、跳切、变形、重复生成和无关文字。',
  ].filter(Boolean).join('\n'), VIDEO_PROMPT_MAX_CHARS);
};
