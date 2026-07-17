/** 单镜字段上限：保留足够细节，仅防止极端超长 */
export const PRODUCT_IMAGE_PROMPT_MAX_CHARS = 1400;
export const PRODUCT_VIDEO_PROMPT_MAX_CHARS = 1100;
export const PRODUCT_STORYBOARD_PROMPT_MAX_CHARS = 5000;

function normalizeText(value) {
    return String(value || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\t ]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
function excerpt(value, maxChars) {
    const text = normalizeText(value);
    return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function limitText(value, maxChars) {
    const text = normalizeText(value);
    if (text.length <= maxChars) return text;
    const marker = '\n…（重复内容已精简）…\n';
    const available = Math.max(0, maxChars - marker.length);
    const headLength = Math.ceil(available * 0.72);
    const tailLength = available - headLength;
    return `${text.slice(0, headLength).trimEnd()}${marker}${text.slice(-tailLength).trimStart()}`
        .slice(0, maxChars);
}

function withoutExact(text, repeatedValue) {
    const source = normalizeText(text);
    const repeated = normalizeText(repeatedValue);
    return repeated ? source.split(repeated).join('').replace(/^[，。；、\s]+/, '') : source;
}

export function compactProductShotPrompts({
    imagePrompt,
    videoPrompt,
    consistencyAnchor,
    styleAnchor,
    visualDirection,
    sceneWorld,
    colorLighting,
}) {
    const anchor = excerpt(consistencyAnchor, 400);
    const compactImage = withoutExact(imagePrompt, consistencyAnchor);
    const compactVideo = withoutExact(videoPrompt, consistencyAnchor);

    return {
        imagePrompt: limitText([
            `产品一致性：${anchor}`,
            styleAnchor ? `摄影风格：${excerpt(styleAnchor, 160)}` : '',
            visualDirection ? `视觉方向：${excerpt(visualDirection, 200)}` : '',
            sceneWorld ? `场景：${excerpt(sceneWorld, 120)}` : '',
            colorLighting ? `灯光色彩：${excerpt(colorLighting, 120)}` : '',
            `当前镜头：${limitText(compactImage, 560)}`,
            '负面约束：禁止商品变形、改色、包装或Logo漂移、文字乱码、增加不存在的部件、手指异常、主体融合、过度锐化和廉价塑料感。',
        ].filter(Boolean).join('\n'), PRODUCT_IMAGE_PROMPT_MAX_CHARS),
        videoPrompt: limitText([
            `产品一致性：${anchor}`,
            `当前镜头：${limitText(compactVideo, 480)}`,
            '动作和运镜只保留一个明确方向，起止完整、节奏自然、物理运动可信，并为下一镜头保留连续性。',
            '负面约束：禁止商品变形、改色、包装或Logo漂移、文字乱码、闪烁跳变、重复生成、镜头抖动和无关部件。',
        ].filter(Boolean).join('\n'), PRODUCT_VIDEO_PROMPT_MAX_CHARS),
    };
}

export function buildCompactBackendStoryboardPrompt(concept, {
    videoDuration,
    aspectRatio,
    industry,
    productName,
    consistencyAnchor,
}) {
    const shots = Array.isArray(concept?.shots) ? concept.shots : [];
    const shotLines = shots.map((shot, index) => [
        `镜头${String(index + 1).padStart(2, '0')} ${shot.startSec ?? index * 2}-${shot.endSec ?? Math.min(videoDuration, index * 2 + 2)}秒`,
        `职责：${excerpt(shot.shotPurpose, 40)}`,
        `景别：${excerpt(shot.shotSize, 20)}`,
        `机位：${excerpt(shot.camera, 36)}`,
        `场景：${excerpt(shot.scene, 70)}`,
        `动作：${excerpt(shot.action, 90)}`,
        `构图：${excerpt(shot.composition, 70)}`,
        shot.subtitle ? `短注：${excerpt(shot.subtitle, 24)}` : '',
    ].filter(Boolean).join('｜'));

    return limitText([
        `生成一张${aspectRatio}专业商业广告故事板母版大图，只输出一张拼版，不是单帧海报。`,
        `标题《${excerpt(concept?.title || productName || '产品广告', 40)}》｜行业：${excerpt(industry || '通用电商', 24)}｜时长：${videoDuration}秒｜分镜数：${shots.length}。`,
        `严格按镜头01至镜头${String(shots.length).padStart(2, '0')}排列，画格数量必须准确；每格使用${aspectRatio}成片安全区，禁止增加空白格或额外画格。`,
        `产品一致性：${excerpt(consistencyAnchor, 420)}`,
        `整体视觉：${excerpt(concept?.visualDirection, 260)}`,
        `场景世界：${excerpt(concept?.sceneWorld, 160)}`,
        `色彩灯光：${excerpt(concept?.colorLighting, 160)}`,
        `道具策略：${excerpt(concept?.propStrategy, 120)}`,
        '逐格内容：',
        ...shotLines,
        '所有画格保持同一产品、包装结构、颜色、材质、比例、Logo与可见文字位置。禁止变形、改色、复制、额外部件、文字乱码、水印或额外画格。',
    ].filter(Boolean).join('\n'), PRODUCT_STORYBOARD_PROMPT_MAX_CHARS);
}
