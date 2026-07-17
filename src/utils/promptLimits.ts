/**
 * 提示词工具：默认不做硬截断（用户确认长提示词上游可生成）。
 * limitPrompt 仅做空白规范化；maxChars 仅在显式传入且 >0 时作为可选兜底。
 */
export const IMAGE_PROMPT_MAX_CHARS = 100_000;
export const STORYBOARD_PROMPT_MAX_CHARS = 100_000;
export const SINGLE_VIDEO_PROMPT_MAX_CHARS = 100_000;
export const VIDEO_PROMPT_MAX_CHARS = 100_000;

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
  characterAnchor?: string;
  visualDirection?: string;
  sceneWorld?: string;
  colorLighting?: string;
  shots?: PromptShot[];
};

type VideoPromptInput = {
  productName?: string;
  videoDuration: number;
  consistencyAnchor?: string;
  characterAnchor?: string;
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

/** 保留原文，仅在 maxChars 显式且极长时才截断（默认不截） */
const excerpt = (value: unknown, maxChars?: number): string => {
  const text = compactWhitespace(value);
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
};

export const limitPrompt = (value: unknown, maxChars?: number): string => {
  const text = compactWhitespace(value);
  // 默认不截断：未传 maxChars、≤0、或超大阈值都原样返回
  if (!Number.isFinite(maxChars as number) || !maxChars || maxChars >= 50_000 || text.length <= maxChars) {
    return text;
  }

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
  characterAnchor,
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
      `职责：${excerpt(shot.shotPurpose)}`,
      `景别：${excerpt(shot.shotSize)}`,
      `机位：${excerpt(shot.camera)}`,
      `场景：${excerpt(shot.scene)}`,
      `动作：${excerpt(shot.action)}`,
      `构图：${excerpt(shot.composition)}`,
      shot.subtitle ? `短注：${excerpt(shot.subtitle)}` : '',
    ].filter(Boolean).join('｜');
  });

  return limitPrompt([
    `生成一张${aspectRatio}专业商业广告故事板母版大图，只输出一张拼版，不是单帧海报。`,
    `标题《${excerpt(title || productName || '产品广告')}》｜行业：${excerpt(industry || '通用电商')}｜时长：${videoDuration}秒｜分镜数：${shots.length}。`,
    `严格按镜头01至镜头${String(shots.length).padStart(2, '0')}排列，画格数量必须准确；每格使用${aspectRatio}成片安全区，编号与时间码清晰，禁止增加空白格或额外画格。`,
    `产品一致性：${excerpt(consistencyAnchor)}`,
    characterAnchor ? `数字人/出镜人物一致性（人物五官、发型、体态、气质以此为准，禁止另造脸）：${excerpt(characterAnchor)}` : '',
    `整体视觉：${excerpt(visualDirection)}`,
    `场景世界：${excerpt(sceneWorld)}`,
    `色彩灯光：${excerpt(colorLighting)}`,
    '逐格内容：',
    ...shotLines,
    '所有画格保持同一产品、同一包装结构、颜色、材质、比例、Logo与可见文字位置；禁止产品变形、改色、复制、增加不存在的部件、文字乱码、水印或额外画格。',
    characterAnchor ? '有人物出镜时，全片同一数字人身份，脸型发型体态与数字人参考一致；禁止把人脸画到包装上。' : '',
  ].filter(Boolean).join('\n'));
};

export const buildCompactProductVideoPrompt = ({
  productName,
  videoDuration,
  consistencyAnchor,
  characterAnchor,
  visualDirection,
  rhythm,
  voiceover,
  subtitles,
  shots = [],
}: VideoPromptInput): string => {
  const timeline = shots.map((shot, index) => {
    const startSec = shot.startSec ?? index * 2;
    const endSec = shot.endSec ?? Math.min(videoDuration, startSec + 2);
    return [
      `【${startSec}-${endSec}秒｜镜头 ${index + 1}】`,
      excerpt(shot.shotPurpose),
      excerpt(shot.action),
      excerpt(shot.camera),
      excerpt(shot.transition),
    ].filter(Boolean).join('；');
  });

  return limitPrompt([
    `生成${videoDuration}秒${excerpt(productName || '产品')}商业广告。第一张参考图为按时间顺序排列的完整故事板；若另有数字人参考图则用于锁定人物外貌；其余产品参考图只用于锁定产品外观。`,
    `产品一致性：${excerpt(consistencyAnchor)}`,
    characterAnchor ? `数字人/出镜人物一致性：${excerpt(characterAnchor)}` : '',
    `视觉方向：${excerpt(visualDirection)}`,
    `整体节奏：${excerpt(rhythm)}`,
    '时间线：',
    ...timeline,
    voiceover ? `中文口播：${excerpt(voiceover)}` : '',
    subtitles ? `字幕重点：${excerpt(subtitles)}` : '',
    '严格按时间线演绎；产品外观、包装、颜色、材质、比例、Logo与可见文字全程不变。禁止闪烁、跳切、变形、重复生成和无关文字。',
    characterAnchor ? '人物外貌以数字人参考为准，禁止换脸、换发型或另造角色。' : '',
  ].filter(Boolean).join('\n'));
};
