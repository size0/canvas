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

function chooseDanceDirection(ageGroup) {
    const pool = CHILD_AGE.test(ageGroup) ? CHILD_DANCE_DIRECTIONS : ADULT_DANCE_DIRECTIONS;
    return pool[Math.floor(Math.random() * pool.length)];
}

function timelineRangesFor(duration) {
    const segmentCount = duration <= 6 ? 3 : duration <= 10 ? 5 : 6;
    const boundaries = Array.from({ length: segmentCount + 1 }, (_, index) =>
        Math.round((duration * index) / segmentCount)
    );
    return Array.from({ length: segmentCount }, (_, index) => [boundaries[index], boundaries[index + 1]]);
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
    const timeline = timelineRangesFor(duration).map(([startSec, endSec], index) => {
        const item = rawTimeline[index] && typeof rawTimeline[index] === 'object'
            ? rawTimeline[index]
            : {};
        return {
            startSec,
            endSec,
            action: cleanString(item.action, fallbackActions[index], 1000),
            connection: cleanString(item.connection, fallbackConnections[index], 700),
            camera: cleanString(item.camera, fallbackCameras[index], 700),
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
        `${item.startSec}-${item.endSec}秒：${item.action}。衔接：${item.connection}。摄影：${item.camera}。环境：${item.environment}。`
    ).join('\n');
    const videoPrompt = [
        isChild
            ? '输入图片是视频的精确第一帧，画面中的人物是本流程生成的原创虚构儿童数字角色。全程延续该虚构角色的整体造型、年龄呈现、身材比例、发型、服装、配饰、场景、灯光与色彩。'
            : '输入图片是视频的精确第一帧，也是舞者视觉身份、面部、年龄呈现、身材比例、发型、服装、配饰、场景、灯光与色彩的严格参考。全程保持视觉连续性，不重新设计人物或空间。',
        childSafe,
        `生成一条 ${duration} 秒、${ASPECT_RATIO} 竖屏、正常实时速度、照片级真实手机摄影质感的连续舞蹈视频。舞种为“${role.danceStyle}”，节拍约 ${role.tempoBpm} BPM，主题为“${role.theme}”。`,
        `舞蹈发生在：${role.scene}。全程专注完成同一支连续舞蹈；场景只提供空间和氛围，不安排生活事件、路人经过、道具突发变化、额外互动或注意力转移。`,
        `核心律动：${storyboard.coreGroove}。动作母题：${storyboard.movementMotif}。这个律动和动作母题贯穿全片并逐步变奏，保证整支舞有统一风格而不是动作拼盘。`,
        `节奏结构：${storyboard.rhythmArc}。舞名：${storyboard.danceName}。`,
        timelineText,
        `镜头总则：${role.cameraLanguage}。保持一镜到底，不随机切镜；人物动作带动镜头，摄影者只做轻微手持跟随、后退、横移或必要的小幅绕行；全程保留完整脚部，禁止固定机位导致人物只在原地机械扭动。`,
        '编舞连续性总则：上面的时间段只是同一支舞的时间标记，不是独立动作卡。每一段必须继承上一段结尾的落脚、重心、朝向、手臂轨迹和运动惯性；通过顺势迈步、重心反弹、身体扭转、手臂延长或收回自然过渡，禁止回到中立站姿后重新摆动作。动作由核心律动持续驱动，上下肢协调，包含启动、经过和收势，不出现“摆姿势—停顿—换姿势”、连续硬切手势、机械左右复制或只有手动脚不动。动作必须踩正常音乐节拍，有清楚脚步、重心、方向、层次、高潮和收尾；不用慢动作拖时长，不机械循环；头发、衣摆和配饰符合真实重力与惯性。',
        isChild
            ? '全局限制：保持单镜头、正常速度和稳定空间连续性；角色身体比例自然，服装发型配饰保持连续；肢体与手指结构正确；不要新增背景人物、生活事件、突发互动或注意力转移；不出现文字、Logo、品牌或水印。'
            : '全局限制：不要切镜、瞬移、随机推拉变焦、慢动作、人物僵住或只移动背景；不要换脸、脸部漂移、年龄变化、身材拉长、服装发型配饰变化、塑料皮肤；不要多余肢体、手指错误或人物克隆；不要新增背景人物、生活事件、突发互动或注意力转移；不要场景结构突变；不要文字、Logo、品牌或水印。',
    ].join('\n\n');

    return { roleImagePrompt, firstFramePrompt, videoPrompt };
}

router.post('/analyze', async (req, res) => {
    const digitalHumanImageUrl = cleanString(req.body?.digitalHumanImageUrl, '', 20_000_000);
    const duration = normalizeDuration(req.body?.duration);
    const plannerModel = cleanString(req.body?.plannerModel, getKey('TEXT_MODEL') || 'grok-4.20-fast', 160);
    const timelineRanges = timelineRangesFor(duration);
    const timelineSkeleton = timelineRanges.map(([start, end], index) =>
        `      {"action":"${start}-${end}秒的完整连续舞句；写清脚步、重心、上肢路径、朝向与能量变化${index === Math.floor(timelineRanges.length / 2) ? '，这里完成一次自然的舞段发展或方向变化' : ''}","connection":"承接上一段结尾的落脚、重心、朝向和动作惯性，并写清本段结尾如何交给下一段","camera":"摄影如何被舞者的连续运动带动","environment":"保持稳定的场景与灯光"}`
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
        const danceDirection = chooseDanceDirection(ageGroup);

        send({ type: 'status', stage: 1, message: `已判断年龄阶段：${ageGroup}；正在按“${danceDirection.split('：')[0]}”方向设计全新造型与编舞…` });
        const reply = await textChat({
            system: `你是拥有十年以上商业舞蹈广告经验的通用数字人造型策略师、服装搭配师、舞蹈编导、运动连续性导演和短视频摄影指导。你不会看到上传图片，只会收到可见年龄阶段，因此不得描述或沿用原图的脸部、身份、性别、民族、健康、气质、身材、体型、姿态、服装、发型、配饰、表情、构图、场景或背景。

任务目标：仅依据年龄阶段，为数字人建立符合大众审美、真实可穿、上镜协调的新造型，并设计一支自然流畅、具有统一律动和完整发展弧线的一镜到底短视频舞蹈。结果必须能直接用于 AI 生图和视频生成。

专业设计框架：
1. 年龄分支：儿童或青少年采用符合年龄、健康得体的造型和低冲击编舞，但低冲击不等于缓慢、呆板或动作稀少，仍需有清楚律动、连续脚步、方向变化和高潮；成年人不套用儿童动作限制，可采用更丰富的力量、幅度、躯干律动与空间移动，但不过度挑逗或低俗。
2. 大众审美搭配：整套服饰必须是现实品牌和商场中常见、真实可买到的日常穿搭，耐看、比例协调并适合舞动，同时具有自然的小网红穿搭辨识度，而不是普通校服、幼儿园服或批量儿童模板。主色通常不超过三种，只设一个视觉重点，其余单品负责平衡；上衣、下装或连衣单品、外搭、袜鞋、发型、少量配饰必须有清楚的风格与季节逻辑。儿童也不能默认生成幼儿园围裙、背带围裙、演出服、卡通徽章堆叠、糖果色全套或刻意卖萌发箍；成年人不能默认网红露肤套装。避免高饱和撞色、舞台戏服感、随机配饰、多个视觉重点、上下装比例失衡或鞋服风格冲突。
3. 舞种与律动：先确定一个贯穿全程的核心 groove，再确定一至两个可识别的动作母题；后续通过方向、幅度、层级和速度变奏发展，而不是不断换新动作。
4. 连续编舞：每段必须继承上一段结尾的落脚、重心、朝向、手臂轨迹和运动惯性。用顺势迈步、重心反弹、身体扭转、手臂延长或收回完成过渡，不允许回到中立站姿再开始下一动作。
5. 自然动作质量：动作要有启动、经过和收势，上下肢协调，重心真实落在支撑脚上。禁止“摆姿势—停顿—换姿势”、连续几个硬手势、机械左右复制、频繁定格、突然甩头、无准备旋转、只有手动脚不动，或把两秒动作拖满整段。
6. 节奏结构：整支舞必须有起拍、建立律动、发展、方向或空间变化、高潮和收尾；时间段只是时间标记，不是独立动作卡。动作密度与 BPM 匹配，转场发生在动作内部。
7. 真实影像：造型定稿照与首帧都必须像审美良好的家人或朋友用手机后置主摄拍到的真实生活画面，而不是 AI 儿童样片、影棚写真或童装目录。场景应干净、有审美、有真实使用痕迹、明确光源方向和空间层次，优先选择有自然侧光、材质层次和安全舞动空间的真实地点；不使用旧学校走廊、医院或机构走廊、过度干净的奶油色样板间、全景均匀暖黄光、虚假柔焦、完美对称构图或与服装同色系的刻意布景。保留自然皮肤与发丝、真实衣料褶皱、鞋底受力、局部曝光差异和适量环境细节。
8. 镜头与场景：舞者运动带动镜头，摄影只做必要的后退、横移和小幅绕行；全程保留脚部。场景只提供舞动空间与氛围，不得设计生活事件、背景人物插曲、道具突发变化、额外互动或注意力转移。

舞风多样性规则：严格围绕本次给定的舞风方向创作，不得无视方向并默认输出“K-pop 弹步舞”“step-touch 加手势”或通用短视频流行舞。除非本次方向明确要求，否则不要使用 K-pop 标签。核心脚步、身体动力和动作母题必须体现该舞种本身的节奏特征。

质量标准：描述必须具体到脚步、支撑脚、重心方向、身体朝向、手臂路径、动作动力和段落衔接。禁止使用“跳一段好看的舞”“自然流畅”“高级感”等无法执行的空泛描述。只输出严格 JSON，不要 Markdown 或解释。`,
            prompt: `可见年龄阶段：${ageGroup}。
本次舞风方向：${danceDirection}。

为该年龄阶段的数字人规划一条 ${duration} 秒、${ASPECT_RATIO}、一镜到底的真实生活感舞蹈视频。不要输出人物视觉分析，只输出：
{
  "roleSetting": {
    "theme": "主题",
    "outfit": "从上到下完整服装与材质颜色",
    "stylingLogic": "说明主辅色、轮廓比例、视觉重点、材质与鞋履为何符合大众审美并适合舞动",
    "hairstyle": "发型",
    "accessories": "配饰",
    "expressionStyle": "表情风格",
    "scene": "有空间结构和可互动环境元素的真实生活场景",
    "lighting": "灯光",
    "colorPalette": "色彩",
    "cameraLanguage": "手机竖屏一镜到底的机位、距离和跟拍方式",
    "danceStyle": "严格基于本次舞风方向进一步具体化，写明核心身体动力和脚步体系，不得改回默认 K-pop 或通用 step-touch",
    "tempoBpm": 118
  },
  "storyboard": {
    "danceName": "原创舞名",
    "coreGroove": "贯穿全片的核心律动，写清膝部弹性、重心节奏和身体动力",
    "movementMotif": "一至两个重复发展而非机械重复的动作母题",
    "rhythmArc": "整条节奏弧线",
    "timeline": [
${timelineSkeleton}
    ]
  }
}

要求：服装先按真实大众穿搭逻辑完成单品组合，不得套用幼儿园围裙、卡通徽章、糖果色鞋、舞台演出服或模板化儿童造型；场景必须有真实使用痕迹和明确自然光或现场光来源，不得使用奶油色空样板间或影棚式均匀暖光。${timelineRanges.length} 段合起来是同一支舞，不是动作清单。相邻两段的结束状态和开始状态必须物理连续，不能重置姿势；每段都写明脚步、支撑脚、重心、朝向、上肢路径、动力和与前后段的衔接。必须有统一核心律动、动作母题的自然变奏、舞段发展、高潮和结尾；不用慢动作填时长；全程不加入生活事件、路人插曲、道具突发变化、额外互动或注意力转移。`,
            model: plannerModel,
            label: '数字人造型与编舞规划',
            maxTokens: 9000,
            temperature: 0.65,
            onDelta: (_delta, total) => {
                if (total % 500 < 30) send({ type: 'progress', stage: 1, chars: total });
            },
        });

        send({ type: 'status', stage: 2, message: '第 2/3 步：正在锁定角色设定和精确首帧…' });
        const plan = normalizePlan({
            ...parseStructuredJson(reply),
            characterProfile: { ageGroup },
        }, duration, danceDirection);
        const prompts = buildPrompts(plan, duration);

        send({ type: 'status', stage: 3, message: `第 3/3 步：正在生成 ${duration} 秒编舞故事板…` });
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
