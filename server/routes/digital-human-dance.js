/**
 * 数字人一键编舞：数字人参考图 → 角色设定 → 精确首帧 → Grok 成片。
 *
 * 本路由只负责视觉规划和提示词编排；图片与视频仍由画布节点按顺序生成。
 */
import express from 'express';
import { jsonrepair } from 'jsonrepair';
import { getKey } from '../config.js';
import { multimodalChat, textChat } from '../utils/multimodal-chat.js';

const router = express.Router();
const DEFAULT_DURATION = 20;
const ASPECT_RATIO = '9:16';
const SUPPORTED_DURATIONS = [6, 10, 20, 30];
const CHILD_AGE = /儿童|幼儿|青少年|child|teen/i;
const CHILD_UNSAFE_STYLE = /露脐|抹胸|吊带|滑肩|低胸|性感|挑逗|撩人|扭胯|臀部|胸部|高跟|劈叉|地板动作/gi;
const CHILD_DANCE_DIRECTIONS = [
    '明快儿童爵士律动：连续行进步、圆润手臂路径、清楚重心反弹与方向变化',
    '儿童 Funk groove：基础 bounce、脚跟脚尖变化、肩胸小幅律动与节奏错拍',
    '轻快 Disco swing：侧向摇摆、交叉行进、手臂弧线与空间路线变化',
    '童趣街舞 groove：基础 rock、party step、前后换重心与自然身体律动',
    '音乐剧式快乐舞步：带明确行进路线的爵士步、开合手臂与故事性节奏发展，但不表演剧情',
    '轻盈节奏步舞：脚掌滚动、交叉换步、小幅转向与连续上肢波浪路径',
];
const ADULT_DANCE_DIRECTIONS = [
    'House groove：jack 律动、交叉换步、脚跟内外转与流畅空间移动',
    'Jazz Funk：重心切换、躯干律动、清楚手臂线条与连贯方向变化',
    'R&B groove：松弛拍后律动、身体波浪、滑步与克制的力量变化',
    'Disco Funk：连续摇摆步、交叉行进、转向与富有弹性的手臂弧线',
    'Commercial Jazz：利落行进、延展线条、动态层级和自然旋转衔接',
    'Latin Pop 融合：脚下节奏变化、身体转向与流畅手臂路径，保持商业审美不过度挑逗',
    'Urban Contemporary：呼吸驱动、重心下沉与回弹、连续躯干路径和空间位移',
];
const FACE_REFERENCE_INSTRUCTION = 'IDENTITY LOCK — Reference image 1 is the canonical and highest-priority facial identity source. Preserve the exact same recognizable face: face length and width, forehead, hairline, eye spacing, eye shape, eyelids, eyebrows, nose bridge, nose tip, nostrils, cheek volume, mouth width, lip shape, visible teeth spacing, jawline, chin, ears, skin tone and visible age. Do not average this face with a generic East Asian child or adult face. Do not beautify, enlarge the eyes, narrow the jaw, shrink the nose, change facial proportions, mature, infantilize or replace the person. A natural expression may change, but the underlying face geometry and identity must remain unmistakably the same. If any styling or composition instruction conflicts with identity, preserve the face and simplify the styling. The upload is not a reference for clothing, hairstyle, accessories, pose, composition or background.';
const FORCED_RESTYLE_INSTRUCTION = '除脸部身份和年龄呈现外，上传图中的其余内容全部视为旧方案。重新设计现实中可以买到、日常真的会穿、适合舞动的完整造型；变化要来自合理的服装搭配、发型、配饰、表情和场景，而不是夸张造型、卡通符号或模板化儿童元素。';
const CANDID_REALISM_INSTRUCTION = 'IMAGE QUALITY — 9:16 vertical, high-resolution photorealistic candid lifestyle photo, captured with a modern smartphone rear main camera at a natural shooting distance. RAW-like original-camera texture, realistic local sharpening, natural dynamic range, slight sensor grain and small exposure imperfections; no commercial retouching. Preserve age-appropriate natural skin texture, subtle pores and peach fuzz, true skin color variation, realistic individual hair strands and flyaways, fabric weave, seams, wrinkles, garment weight, shoe texture, sole pressure and correct foot contact with the ground. Use one identifiable real light source with natural falloff, believable highlights and transparent shadows; the environment must have depth and restrained everyday traces. Composition may be slightly off-center with natural breathing room. The subject must not perform a catalog display pose, symmetrical presentation gesture, hands-open product pose, rigid military stance or deliberate cute pose. NEGATIVE — generic AI face, face drift, altered facial proportions, oversized anime eyes, narrowed jaw, tiny nose, plastic skin, porcelain skin, wax figure, excessive skin smoothing, fake bokeh, HDR over-sharpening, creamy filter, uniform warm-yellow lighting, studio softbox light, beauty campaign retouching, perfect symmetry, pristine showroom, institutional school or hospital corridor, kindergarten apron outfit, stacked cartoon badges, decorative headband added only for cuteness, candy-colored template styling, deformed hands, extra fingers, floating feet, elongated legs, text, logo, watermark.';

function cleanString(value, fallback = '', max = 4000) {
    const text = typeof value === 'string' || typeof value === 'number'
        ? String(value).trim()
        : '';
    return (text || fallback).slice(0, max);
}

function normalizeDuration(value) {
    const duration = Number.parseInt(value, 10);
    return SUPPORTED_DURATIONS.includes(duration) ? duration : DEFAULT_DURATION;
}

function danceDirectionOptions(ageGroup) {
    return CHILD_AGE.test(ageGroup) ? CHILD_DANCE_DIRECTIONS : ADULT_DANCE_DIRECTIONS;
}

function timelineRangesFor(duration) {
    const segmentCount = duration <= 6 ? 2 : duration <= 10 ? 3 : duration <= 20 ? 4 : 5;
    const boundaries = Array.from({ length: segmentCount + 1 }, (_, index) =>
        Math.round((duration * index) / segmentCount)
    );
    return Array.from({ length: segmentCount }, (_, index) => [boundaries[index], boundaries[index + 1]]);
}

function distributedFallback(items, index, count) {
    if (count <= 1) return items[0];
    return items[Math.round((index * (items.length - 1)) / (count - 1))];
}

function parseStructuredJson(reply) {
    let text = String(reply || '').trim().replace(/^\uFEFF/, '');
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('角色规划未返回完整 JSON');
    const candidate = text.slice(start, end + 1);
    try {
        return JSON.parse(candidate);
    } catch (strictError) {
        try {
            return JSON.parse(jsonrepair(candidate));
        } catch (repairError) {
            throw new Error(`角色规划 JSON 无法解析：${strictError.message}`);
        }
    }
}

function sanitizeChildText(value, fallback) {
    const text = cleanString(value, fallback, 1200);
    return text.replace(CHILD_UNSAFE_STYLE, match => {
        if (/露脐|抹胸|吊带|滑肩|低胸/i.test(match)) return '完整合身上衣';
        if (/高跟/i.test(match)) return '舒适运动鞋';
        if (/劈叉|地板动作/i.test(match)) return '安全低冲击动作';
        if (/扭胯|臀部|胸部/i.test(match)) return '轻快重心变化';
        return '自然童真';
    });
}

function enforceSafetyMode(plan) {
    const isChild = CHILD_AGE.test(plan.characterProfile.ageGroup);
    if (!isChild) {
        return {
            ...plan,
            safetyMode: 'standard',
            safetyNotice: '成年数字人采用常规视觉连续性规则。',
        };
    }

    plan.characterProfile.continuityNote = '后续生图只延续上传数字人的同一脸部设计与儿童年龄呈现；不延续原图的身材、体型、姿态、气质、服装、发型、配饰、表情、构图或背景。';
    plan.roleSetting.outfit = sanitizeChildText(
        plan.roleSetting.outfit,
        '完整得体、方便活动、符合儿童年龄的日常舞蹈服装与舒适运动鞋',
    );
    plan.roleSetting.hairstyle = sanitizeChildText(plan.roleSetting.hairstyle, '自然、整洁、方便活动的儿童发型');
    plan.roleSetting.accessories = sanitizeChildText(plan.roleSetting.accessories, '少量安全、轻便的儿童配饰');
    plan.roleSetting.expressionStyle = sanitizeChildText(plan.roleSetting.expressionStyle, '自然、童真、自信的表情变化');
    plan.roleSetting.danceStyle = sanitizeChildText(plan.roleSetting.danceStyle, '儿童活力短视频流行舞');
    plan.storyboard.timeline = plan.storyboard.timeline.map(item => ({
        ...item,
        action: sanitizeChildText(item.action, '健康、轻快、低冲击并符合儿童年龄的连续舞步'),
        connection: sanitizeChildText(item.connection, '沿用上一段重心和运动方向自然衔接，不停顿重置'),
        environment: sanitizeChildText(item.environment, '安全、稳定且不干扰舞蹈的场景与灯光'),
    }));
    return {
        ...plan,
        safetyMode: 'fictional-child',
        safetyNotice: '检测到儿童或青少年年龄呈现：启用原创虚构角色模式，不复刻现实未成年人身份，并自动清理成人化造型与动作。',
    };
}

function normalizePlan(raw, duration, danceDirection) {
    const profile = raw?.characterProfile && typeof raw.characterProfile === 'object'
        ? raw.characterProfile
        : {};
    const role = raw?.roleSetting && typeof raw.roleSetting === 'object'
        ? raw.roleSetting
        : {};
    const storyboard = raw?.storyboard && typeof raw.storyboard === 'object'
        ? raw.storyboard
        : {};
    const rawTimeline = Array.isArray(storyboard.timeline) ? storyboard.timeline : [];
    const fallbackActions = [
        '保持首帧的等待姿势半拍，用一个细小的视线或肩部变化接住音乐起拍',
        '用与场景相符的轻快步法进入主舞段，形成清楚但不夸张的偶像记忆点',
        '完成一组方向变化明确的身体律动和手臂线条，动作连续、节拍清晰',
        '延续主舞句并加入一次清楚的方向转换或队形位移，保持动作密度和节拍连续',
        '恢复主节拍，完成全身旋转、低幅度踢腿或安全跳跃组成的高潮组合',
        '收束舞步并稳定落点，保留真实呼吸和自然表情作为结尾',
    ];
    const fallbackCameras = [
        '成人手持手机视角，保持全身和环境，轻微重新构图',
        '人物动作带动摄影者平滑后退，不主动炫技',
        '轻微横移跟随，始终保留脚部，不切镜',
        '镜头跟随方向转换平滑横移，保持舞者始终为唯一视觉主体',
        '小幅绕行配合高潮动作，不推拉变焦',
        '轻微靠近到中景后停稳，保留一镜到底观感',
    ];
    const fallbackConnections = [
        '从首帧当前重心和呼吸自然启动，不先摆新姿势',
        '承接上一段最后一步的落脚、身体朝向和手臂惯性，顺势进入下一舞句',
        '不回到中立站姿，利用上一段未完成的手臂轨迹和重心反弹继续发展',
        '以前一段的行进方向为动力完成转向，转向后立即保持统一律动',
        '借上一段动作回弹提高能量进入高潮，不突然停住后再起跳或旋转',
        '从高潮落脚直接收束幅度与呼吸，完成稳定但不僵硬的结尾',
    ];
    const timelineRanges = timelineRangesFor(duration);
    const timeline = timelineRanges.map(([startSec, endSec], index) => {
        const item = rawTimeline[index] && typeof rawTimeline[index] === 'object'
            ? rawTimeline[index]
            : {};
        const count = timelineRanges.length;
        return {
            startSec,
            endSec,
            counts: cleanString(item.counts, `第 ${index + 1} 个连续舞句`, 120),
            action: cleanString(item.action, distributedFallback(fallbackActions, index, count), 1000),
            connection: cleanString(item.connection, distributedFallback(fallbackConnections, index, count), 700),
            camera: cleanString(item.camera, distributedFallback(fallbackCameras, index, count), 700),
            environment: cleanString(item.environment, '场景结构和灯光保持连续，不新增人物或环境事件', 500),
        };
    });

    const plan = {
        characterProfile: {
            ageGroup: cleanString(profile.ageGroup, '无法确认', 30),
            visualSummary: '规划模型仅从上传图判断可见年龄阶段，不读取其他人物或造型信息。',
            continuityNote: '后续生图以上传图作为唯一脸部身份参考，只保持同一张脸和年龄呈现；其余视觉元素全部重新设计。',
        },
        roleSetting: {
            theme: cleanString(role.theme, '真实生活场景中的短视频舞蹈', 150),
            outfit: cleanString(role.outfit, '选择与人物年龄呈现、舞种和场景协调且便于活动的完整服装', 900),
            stylingLogic: cleanString(role.stylingLogic, '控制在三种主色以内，轮廓利落、比例协调、可穿耐看并适合全身舞动', 700),
            hairstyle: cleanString(role.hairstyle, '重新设计一款与上传图明显不同、适合舞蹈和场景的新发型', 500),
            accessories: cleanString(role.accessories, '少量与主题协调、不会抢主体的配饰', 500),
            expressionStyle: cleanString(role.expressionStyle, '自然、自信，随舞蹈起拍、展开、高潮和收尾产生连贯变化', 500),
            scene: cleanString(role.scene, '选择与人物气质和舞种相符、可供全身舞动的真实生活场景', 900),
            lighting: cleanString(role.lighting, '符合场景来源的真实自然光或环境光', 500),
            colorPalette: cleanString(role.colorPalette, '协调、真实、不过度商业精修', 400),
            cameraLanguage: cleanString(role.cameraLanguage, '9:16 手机竖屏，成人视线附近的手持跟拍，全身入镜，人物带动镜头', 700),
            danceStyle: cleanString(role.danceStyle, danceDirection, 300),
            tempoBpm: Math.max(80, Math.min(150, Number.parseInt(role.tempoBpm, 10) || 118)),
        },
        storyboard: {
            danceName: cleanString(storyboard.danceName, '生活感一镜到底舞蹈', 120),
            coreGroove: cleanString(storyboard.coreGroove, '贯穿全程的自然膝部弹性、清楚重心转移和呼吸节奏', 500),
            movementMotif: cleanString(storyboard.movementMotif, '选择一组易识别的脚步与手臂路径作为动作母题，并在后续舞段中自然变奏', 700),
            rhythmArc: cleanString(storyboard.rhythmArc, '起拍—进入—展开—方向变化—高潮—稳定收尾', 500),
            timeline,
        },
    };
    return enforceSafetyMode(plan);
}

function buildPrompts(plan, duration) {
    const { characterProfile: character, roleSetting: role, storyboard } = plan;
    const isChild = plan.safetyMode === 'fictional-child';
    const childSafe = isChild
        ? '这是一个全新原创的虚构儿童数字角色。服装完整得体，舞蹈健康、童真、低冲击并符合年龄。'
        : '服装与编舞应符合人物明确的年龄呈现，不改变年龄感。';
    const continuity = isChild
        ? `输入素材是用户声明有权使用、且不对应现实未成年人的原创虚构儿童数字角色。只保持该虚构角色的同一张脸和儿童年龄呈现，不推断现实身份。${character.continuityNote}`
        : `输入数字人只作为同一张脸和年龄呈现的视觉参考，不推断现实身份。${character.continuityNote}`;

    const roleImagePrompt = [
        `生成一张 ${ASPECT_RATIO} 竖版、真实手机抓拍质感的“舞蹈造型定稿照”，不是分镜拼图。`,
        `【最高优先级：身份锁定】${continuity}`,
        FACE_REFERENCE_INSTRUCTION,
        `【年龄与安全】${childSafe}`,
        `【全新造型边界】${FORCED_RESTYLE_INSTRUCTION}`,
        `【主题与完整服装】主题：${role.theme}。从上到下完整服装：${role.outfit}。`,
        `【大众审美搭配】${role.stylingLogic}。`,
        `【发型、配饰与表情】发型可以按规划改变，但不得改变发际线、耳位和面部结构：${role.hairstyle}。配饰：${role.accessories}。表情风格：${role.expressionStyle}。`,
        `【真实场景、灯光与色彩】场景：${role.scene}。灯光：${role.lighting}。色彩：${role.colorPalette}。`,
        `【镜头与构图】${role.cameraLanguage}。使用手机后置主摄的自然透视，摄影者与人物保持足够距离，机位在成人胸口至视线高度并轻微俯拍约 5–8 度；人物完整入镜，脚部清楚，身体比例自然，人物占画面约 55%–65%，脸部在最终 9:16 画面中仍清晰可辨，保留真实环境，不拉长腿部，不使用低机位仰拍、超广角或夸张景深。`,
        CANDID_REALISM_INSTRUCTION,
        isChild
            ? '用参考图中的同一张脸建立新的虚构儿童角色造型，再锁定本次新生成的服装、发型、配饰、表情风格和场景供后续首帧使用。儿童造型必须像真实家庭日常穿搭，不使用幼儿园围裙、演出服、卡通徽章堆叠或刻意卖萌造型。只输出单张完整画面，不要多格排版、文字、Logo、水印、换脸、额外肢体或混乱背景。'
            : '用参考图中的同一张脸建立全新造型，再一次性锁定后续视频使用的新服装、新发型、新配饰、新表情风格和新场景。禁止多格排版、文字、Logo、水印、换脸、年龄漂移、额外肢体、塑料皮肤和背景结构混乱。',
    ].join('\n');

    const first = storyboard.timeline[0];
    const firstFramePrompt = [
        `根据输入的原始身份图和角色造型定稿图，生成一张 ${ASPECT_RATIO} 竖版“精确视频首帧”，只输出单张画面。`,
        'REFERENCE ORDER — Reference image 1 is the original canonical face identity and has absolute priority for the face. Reference image 2 is the approved styling image and is used only for clothing, hairstyle, accessories, body styling, scene, lighting and color. Never copy the face from reference image 2 when it differs from reference image 1.',
        FACE_REFERENCE_INSTRUCTION,
        isChild
            ? '参考图2是本流程刚刚生成的原创虚构儿童角色造型图。仅从参考图2延续身材比例、服装、发型、配饰、表情基调、场景结构、灯光和色彩；脸部身份和年龄呈现始终以参考图1为准。'
            : '仅从参考图2锁定身材比例、服装、发型、配饰、表情基调、场景结构、灯光和色彩，不重新设计；脸部身份和年龄呈现始终以参考图1为准。',
        childSafe,
        CANDID_REALISM_INSTRUCTION,
        `舞种：${role.danceStyle}，约 ${role.tempoBpm} BPM。核心律动：${storyboard.coreGroove}。动作母题：${storyboard.movementMotif}。首帧处于动作真正开始前的稳定起拍状态：${first.action}。`,
        `镜头：${first.camera}。${role.cameraLanguage}。必须完整保留双脚和头顶安全区，人物占画面约 55%–68%，镜头略高于或接近人物视线，避免仰拍、透视拉伸和超长腿。`,
        '首帧只建立舞蹈起拍状态，不加入路人、道具突发变化、互动插曲或注意力转移。',
        isChild
            ? '只输出一个虚构角色的单张首帧，不要九宫格、分镜板、动作残影、多人复制、文字、水印、服装变化或场景变化。'
            : '禁止九宫格、分镜板、动作残影、多人复制、文字、水印、服装变化、场景变化和脸部漂移。',
    ].join('\n');

    const timelineText = storyboard.timeline.map(item =>
        `${item.startSec}-${item.endSec}秒（${item.counts}）：${item.action}。衔接：${item.connection}。`
    ).join('\n');
    const videoPrompt = [
        isChild
            ? '输入图片是视频的精确第一帧，画面中的人物是本流程生成的原创虚构儿童数字角色。全程延续该虚构角色的整体造型、年龄呈现、身材比例、发型、服装、配饰、场景、灯光与色彩。'
            : '输入图片是视频的精确第一帧，也是舞者视觉身份、面部、年龄呈现、身材比例、发型、服装、配饰、场景、灯光与色彩的严格参考。全程保持视觉连续性，不重新设计人物或空间。',
        childSafe,
        `生成 ${duration} 秒、${ASPECT_RATIO} 竖屏、正常实时速度的一镜到底舞蹈。舞种：${role.danceStyle}；约 ${role.tempoBpm} BPM；舞名：${storyboard.danceName}。`,
        `场景：${role.scene}。核心 groove：${storyboard.coreGroove}。动作母题：${storyboard.movementMotif}。节奏弧线：${storyboard.rhythmArc}。`,
        timelineText,
        '这些时间段是同一支舞的连续舞句，不是独立动作卡。基础 groove 从第一拍持续到最后一拍；每句继承上一句的落脚、支撑脚、重心、朝向、手臂轨迹和惯性，不能站回中立位再重新摆动作。上下肢同时参与，动作有启动、经过与收势；禁止连续硬手势、机械左右复制、频繁定格、只有手动脚不动，或用慢动作拖时长。',
        `摄影：${role.cameraLanguage}。舞者带动镜头，摄影者只做必要的轻微跟随、后退或横移；全程保留完整脚部，不切镜、不炫技运镜。`,
        isChild
            ? '限制：保持正常速度、身体比例和造型连续；舞蹈健康、符合年龄但必须有明确节拍、脚步密度、方向变化与高潮；不新增人物或事件；不要文字、Logo、水印、肢体错误。'
            : '限制：不要切镜、慢动作、僵住、换脸、年龄变化、身材拉长、造型变化、人物克隆或场景突变；不新增人物或事件；不要文字、Logo、水印。',
    ].join('\n\n');

    return { roleImagePrompt, firstFramePrompt, videoPrompt };
}

router.post('/analyze', async (req, res) => {
    const digitalHumanImageUrl = cleanString(req.body?.digitalHumanImageUrl, '', 20_000_000);
    const duration = normalizeDuration(req.body?.duration);
    const plannerModel = cleanString(req.body?.plannerModel, getKey('TEXT_MODEL') || 'grok-4.20-fast', 160);
    const timelineRanges = timelineRangesFor(duration);
    const timelineSkeleton = timelineRanges.map(([start, end], index) =>
        `      {"counts":"按最终 BPM 标明本段覆盖的连续八拍范围","action":"${start}-${end}秒的完整连续舞句；逐拍写清左右脚、支撑脚、重心、膝髋躯干动力、手臂路径、朝向和能量变化${index === Math.floor(timelineRanges.length / 2) ? '，这里发展动作母题并完成方向或空间变化' : ''}","connection":"写清本段最后落脚、重心、朝向和手臂轨迹如何直接启动下一舞句"}`
    ).join(',\n');
    if (!digitalHumanImageUrl) return res.status(400).json({ error: '请上传数字人图片' });
    if (!getKey('TEXT_API_KEY')) return res.status(400).json({ error: '请先在设置中配置文字模型 API Key' });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = data => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        send({ type: 'status', stage: 1, message: '第 1/3 步：仅判断数字人的可见年龄阶段…' });
        const ageReply = await multimodalChat({
            system: `你是数字人素材的年龄阶段分类器。你只能观察并输出画面人物的可见年龄阶段，不得分析、描述、推断或利用脸部细节、身份、性别、民族、健康、气质、身材、体型、姿态、服装、发型、配饰、表情、构图、场景或背景。输入是用户声明有权使用的虚构或自有数字人素材。只输出严格 JSON，不要 Markdown 或解释。`,
            prompt: `只判断画面人物的可见年龄阶段。输出 {"ageGroup":"约4岁儿童/约15岁青少年/约23岁成年/无法确认"}，年龄数字按画面合理估计，且只能包含 ageGroup 这一个字段。`,
            imageUrls: [digitalHumanImageUrl],
            libraryDir: req.app.locals.LIBRARY_DIR,
            model: plannerModel,
            label: '数字人年龄阶段判断',
            maxTokens: 120,
            temperature: 0,
        });
        const ageGroup = cleanString(parseStructuredJson(ageReply)?.ageGroup, '无法确认', 30);
        const directionOptions = danceDirectionOptions(ageGroup);

        send({ type: 'status', stage: 1, message: `已判断年龄阶段：${ageGroup}；正在单独规划全新造型与场景…` });
        const stylingReply = await textChat({
            system: `你是拥有十五年以上商业广告经验的数字人造型策略师、服装搭配师和生活方式摄影指导。你只负责服装、发型、配饰、表情基调、真实场景、灯光和手机摄影方案，不负责设计舞步。

你不会看到上传图片，只会收到可见年龄阶段，不得描述或沿用原图的脸部、身份、性别、民族、身材、体型、姿态、服装、发型、配饰、表情、构图、场景或背景。

整套造型必须符合大众审美、现实可买、比例协调、方便舞动，并有自然的小网红辨识度。主色不超过三种，只设一个视觉重点。儿童不得套用幼儿园围裙、背带围裙、演出服、卡通徽章堆叠、糖果色全套或刻意卖萌发箍；成年人不得默认网红露肤套装。场景必须有真实使用痕迹、明确光源和完整全身舞动空间，避免奶油色空样板间、影棚均匀暖光、机构走廊和童装目录质感。

只输出严格 JSON，不要 Markdown 或解释。`,
            prompt: `可见年龄阶段：${ageGroup}。

只规划造型与场景：
{
  "roleSetting": {
    "theme": "生活化视觉主题",
    "outfit": "从上到下的完整服装、材质与颜色",
    "stylingLogic": "主辅色、轮廓比例、视觉重点、材质与鞋履逻辑",
    "hairstyle": "全新发型",
    "accessories": "少量协调配饰",
    "expressionStyle": "自然表情基调",
    "scene": "有真实使用痕迹和完整舞动空间的生活场景",
    "lighting": "明确的真实光源",
    "colorPalette": "真实克制的色彩",
    "cameraLanguage": "9:16 手机一镜到底的机位、距离与跟拍原则"
  }
}`,
            model: plannerModel,
            label: '数字人造型与场景规划',
            maxTokens: 3500,
            temperature: 0.55,
            onDelta: (_delta, total) => {
                if (total % 500 < 30) send({ type: 'progress', stage: 1, chars: total });
            },
        });
        const styling = parseStructuredJson(stylingReply);
        const stylingRole = styling?.roleSetting && typeof styling.roleSetting === 'object'
            ? styling.roleSetting
            : {};

        send({ type: 'status', stage: 2, message: '第 2/3 步：二十年资深编舞总监正在按八拍设计完整舞句…' });
        const choreographyReply = await textChat({
            system: `你是一名拥有二十年舞台、MV、商业广告与短视频编舞经验的资深编舞总监，熟悉儿童爵士、Funk、Disco、House、Jazz Funk、Commercial Jazz、R&B、Latin Pop 和 Contemporary。你的唯一任务是设计一支真人能够在指定时长与 BPM 下连续完成的完整舞蹈；你不负责重新设计服装、场景、灯光或摄影。

编舞方法：
1. 先从允许的舞风中选择最适合既定造型与场景的一种，不得固定使用 K-pop、通用 step-touch、摆手势或原地弹步。
2. 先建立从第一拍持续到最后一拍的核心 groove，再建立一至两个动作母题；后续只通过方向、幅度、层级、速度和空间路线发展母题。
3. 以 4/4 拍和八拍舞句组织编舞。每个舞句写清拍数、左右脚顺序、支撑脚、重心转移、膝髋躯干动力、手臂路径、朝向、能量变化以及结尾落脚。
4. 每句必须从上一句的落脚、支撑脚、重心、朝向、手臂轨迹与运动惯性直接启动，禁止回到中立站姿再摆下一个动作。
5. 动作必须有启动、经过和收势，上下肢协同。禁止摆姿势—停顿—换姿势、连续硬手势、机械镜像复制、频繁定格、无准备旋转、只有手动脚不动或把两秒动作拖满整段。
6. 儿童或青少年编舞要健康、符合年龄、避免高风险动作，但仍必须轻快、有弹性、有连续脚步、有方向变化和清楚高潮；安全不等于缓慢、僵硬或动作稀少。成年人可使用更丰富的力量、幅度、躯干律动与空间移动，但不过度挑逗。
7. 整支舞必须具备起拍、groove 建立、发展、方向或空间变化、高潮和完整收尾。输出的是舞谱，不是镜头清单。

质量标准：让专业舞者照文字能够实际跳出来。禁止“跳得自然好看”“做流畅动作”等空话。只输出严格 JSON，不要 Markdown 或解释。`,
            prompt: `可见年龄阶段：${ageGroup}。
成片时长：${duration} 秒。
既定造型与场景（只能适配，不得改写）：
${JSON.stringify(stylingRole)}

允许选择的舞风：
- ${directionOptions.join('\n- ')}

请根据场景空间、服装活动度与年龄，从以上舞风中选择最合适的一种并具体化。输出：
{
  "danceStyle": "选定舞种、核心身体动力与脚步体系",
  "tempoBpm": 118,
  "storyboard": {
    "danceName": "原创舞名",
    "coreGroove": "贯穿全片的基础律动与重心节奏",
    "movementMotif": "一至两个可以连续变奏的动作母题",
    "rhythmArc": "从起拍到高潮和收尾的能量弧线",
    "timeline": [
${timelineSkeleton}
    ]
  }
}

${timelineRanges.length} 个时间段只是同一支舞的连续舞句标记。根据你选择的 BPM，为每段填写合理的八拍范围；动作密度必须足以形成舞蹈，但不要塞入无法在对应秒数内完成的动作。`,
            model: plannerModel,
            label: '二十年资深编舞规划',
            maxTokens: 6000,
            temperature: 0.6,
            onDelta: (_delta, total) => {
                if (total % 500 < 30) send({ type: 'progress', stage: 2, chars: total });
            },
        });
        const choreography = parseStructuredJson(choreographyReply);
        const danceDirection = cleanString(choreography?.danceStyle, directionOptions[0], 300);

        send({ type: 'status', stage: 3, message: `第 3/3 步：正在整理 ${duration} 秒连续八拍舞谱与生成提示词…` });
        const plan = normalizePlan({
            roleSetting: {
                ...stylingRole,
                danceStyle: danceDirection,
                tempoBpm: choreography?.tempoBpm,
            },
            storyboard: choreography?.storyboard,
            characterProfile: { ageGroup },
        }, duration, danceDirection);
        const prompts = buildPrompts(plan, duration);
        send({
            type: 'done',
            data: {
                ...plan,
                ...prompts,
                aspectRatio: ASPECT_RATIO,
                duration,
                plannerModel,
                danceDirection,
                videoModel: 'grok-imagine-video',
            },
        });
    } catch (error) {
        console.error('[DigitalHumanDance] analyze failed:', error);
        send({ type: 'error', error: error?.message || '数字人编舞规划失败' });
    } finally {
        if (!res.writableEnded) res.end();
    }
});

export default router;
export {
    buildPrompts,
    danceDirectionOptions,
    normalizePlan,
    timelineRangesFor,
};
