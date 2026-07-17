/** 长提示词默认不截断（上游已支持更长 prompt） */
export const PRODUCT_IMAGE_PROMPT_MAX_CHARS = 100000;
export const PRODUCT_VIDEO_PROMPT_MAX_CHARS = 100000;
export const PRODUCT_STORYBOARD_PROMPT_MAX_CHARS = 100000;

function normalizeText(value) {
    return String(value || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\t ]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function excerpt(value, maxChars) {
    const text = normalizeText(value);
    if (!maxChars || maxChars <= 0 || maxChars >= 50000 || text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function limitText(value, maxChars) {
    const text = normalizeText(value);
    if (!maxChars || maxChars <= 0 || maxChars >= 50000 || text.length <= maxChars) return text;
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
    characterAnchor,
    styleAnchor,
    visualDirection,
    sceneWorld,
    colorLighting,
}) {
    const anchor = normalizeText(consistencyAnchor);
    const talent = normalizeText(characterAnchor);
    const compactImage = withoutExact(imagePrompt, consistencyAnchor);
    const compactVideo = withoutExact(videoPrompt, consistencyAnchor);

    return {
        imagePrompt: limitText([
            anchor ? `产品一致性：${anchor}` : '',
            talent ? `数字人/出镜人物一致性：${talent}` : '',
            styleAnchor ? `摄影风格：${normalizeText(styleAnchor)}` : '',
            visualDirection ? `视觉方向：${normalizeText(visualDirection)}` : '',
            sceneWorld ? `场景：${normalizeText(sceneWorld)}` : '',
            colorLighting ? `灯光色彩：${normalizeText(colorLighting)}` : '',
            `当前镜头：${normalizeText(compactImage)}`,
            '负面约束：禁止商品变形、改色、包装或Logo漂移、文字乱码、增加不存在的部件、手指异常、主体融合、过度锐化和廉价塑料感。',
            talent ? '有人物出镜时外貌必须以数字人参考为准，禁止另造脸。' : '',
        ].filter(Boolean).join('\n'), PRODUCT_IMAGE_PROMPT_MAX_CHARS),
        videoPrompt: limitText([
            anchor ? `产品一致性：${anchor}` : '',
            talent ? `数字人/出镜人物一致性：${talent}` : '',
            `当前镜头：${normalizeText(compactVideo)}`,
            '动作和运镜只保留一个明确方向，起止完整、节奏自然、物理运动可信，并为下一镜头保留连续性。',
            '负面约束：禁止商品变形、改色、包装或Logo漂移、文字乱码、闪烁跳变、重复生成、镜头抖动和无关部件。',
            talent ? '人物外貌以数字人参考为准。' : '',
        ].filter(Boolean).join('\n'), PRODUCT_VIDEO_PROMPT_MAX_CHARS),
    };
}

export function buildCompactBackendStoryboardPrompt(concept, {
    videoDuration,
    aspectRatio,
    industry,
    productName,
    consistencyAnchor,
    characterAnchor,
}) {
    const shots = Array.isArray(concept?.shots) ? concept.shots : [];
    const shotLines = shots.map((shot, index) => [
        `镜头${String(index + 1).padStart(2, '0')} ${shot.startSec ?? index * 2}-${shot.endSec ?? Math.min(videoDuration, index * 2 + 2)}秒`,
        `职责：${normalizeText(shot.shotPurpose)}`,
        `景别：${normalizeText(shot.shotSize)}`,
        `机位：${normalizeText(shot.camera)}`,
        `场景：${normalizeText(shot.scene)}`,
        `动作：${normalizeText(shot.action)}`,
        `构图：${normalizeText(shot.composition)}`,
        shot.subtitle ? `短注：${normalizeText(shot.subtitle)}` : '',
    ].filter(Boolean).join('｜'));

    return limitText([
        `生成一张${aspectRatio}专业商业广告故事板母版大图，只输出一张拼版，不是单帧海报。`,
        `标题《${normalizeText(concept?.title || productName || '产品广告')}》｜行业：${normalizeText(industry || '通用电商')}｜时长：${videoDuration}秒｜分镜数：${shots.length}。`,
        `严格按镜头01至镜头${String(shots.length).padStart(2, '0')}排列，画格数量必须准确；每格使用${aspectRatio}成片安全区，禁止增加空白格或额外画格。`,
        `产品一致性：${normalizeText(consistencyAnchor)}`,
        characterAnchor ? `数字人/出镜人物一致性：${normalizeText(characterAnchor)}` : '',
        `整体视觉：${normalizeText(concept?.visualDirection)}`,
        `场景世界：${normalizeText(concept?.sceneWorld)}`,
        `色彩灯光：${normalizeText(concept?.colorLighting)}`,
        `道具策略：${normalizeText(concept?.propStrategy)}`,
        '逐格内容：',
        ...shotLines,
        '所有画格保持同一产品、包装结构、颜色、材质、比例、Logo与可见文字位置。禁止变形、改色、复制、额外部件、文字乱码、水印或额外画格。',
        characterAnchor ? '有人物出镜时全片同一数字人身份，禁止另造脸。' : '',
    ].filter(Boolean).join('\n'), PRODUCT_STORYBOARD_PROMPT_MAX_CHARS);
}
