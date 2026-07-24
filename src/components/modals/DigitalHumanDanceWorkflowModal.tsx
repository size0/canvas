import React, { useEffect, useRef, useState } from 'react';
import {
    ArrowRight, CheckCircle2, Film, Image as ImageIcon, Loader2,
    Music2, ScanFace, Sparkles, Upload, X,
} from 'lucide-react';

export interface DanceTimelineItem {
    startSec: number;
    endSec: number;
    counts: string;
    action: string;
    connection: string;
    camera: string;
    environment: string;
}

export type DanceDuration = 6 | 10 | 20 | 30;

export interface DigitalHumanDanceWorkflowResult {
    characterProfile: {
        ageGroup: string;
        visualSummary: string;
        continuityNote: string;
    };
    roleSetting: {
        theme: string;
        outfit: string;
        stylingLogic: string;
        hairstyle: string;
        accessories: string;
        expressionStyle: string;
        scene: string;
        lighting: string;
        colorPalette: string;
        cameraLanguage: string;
        danceStyle: string;
        tempoBpm: number;
    };
    storyboard: {
        danceName: string;
        coreGroove: string;
        movementMotif: string;
        rhythmArc: string;
        timeline: DanceTimelineItem[];
    };
    roleImagePrompt: string;
    firstFramePrompt: string;
    videoPrompt: string;
    aspectRatio: '9:16';
    duration: DanceDuration;
    videoModel: 'grok-imagine-video';
    plannerModel?: string;
    danceDirection?: string;
    safetyMode?: 'standard' | 'fictional-child';
    safetyNotice?: string;
}

export interface DigitalHumanDanceWorkflowOptions {
    digitalHumanImage: string;
    aspectRatio: '9:16';
    duration: DanceDuration;
    plannerModel: string;
    autoGenerate: true;
}

interface DigitalHumanDanceWorkflowModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreate: (result: DigitalHumanDanceWorkflowResult, opts: DigitalHumanDanceWorkflowOptions) => void;
}

const PIPELINE = [
    { label: '年龄与脸部', desc: '只判断年龄，保留同一张脸', icon: ScanFace },
    { label: '造型与场景', desc: '服装、发型、配饰和空间', icon: ImageIcon },
    { label: '八拍编舞', desc: '资深编舞总监设计连续舞句', icon: Music2 },
    { label: 'Grok 成片', desc: '9:16、一镜到底', icon: Film },
];

export const DigitalHumanDanceWorkflowModal: React.FC<DigitalHumanDanceWorkflowModalProps> = ({
    isOpen,
    onClose,
    onCreate,
}) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [digitalHumanImage, setDigitalHumanImage] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [stage, setStage] = useState('等待上传数字人');
    const [stageNo, setStageNo] = useState(0);
    const [elapsed, setElapsed] = useState(0);
    const [duration, setDuration] = useState<DanceDuration>(20);
    const [plannerModel, setPlannerModel] = useState('');
    const [plannerApiUrl, setPlannerApiUrl] = useState('');
    const [plannerKeyConfigured, setPlannerKeyConfigured] = useState<boolean | null>(null);

    useEffect(() => () => {
        if (timerRef.current) clearInterval(timerRef.current);
    }, []);

    useEffect(() => {
        if (!isOpen && !loading) {
            setError('');
            setStage('等待上传数字人');
            setStageNo(0);
            setElapsed(0);
        }
    }, [isOpen, loading]);

    useEffect(() => {
        if (!isOpen) return;
        let active = true;
        fetch('/api/settings')
            .then(response => response.json())
            .then(data => {
                if (!active) return;
                const settings = data?.settings || {};
                setPlannerModel(String(settings.TEXT_MODEL || 'grok-4.20-fast'));
                setPlannerApiUrl(String(settings.TEXT_API_URL || ''));
                setPlannerKeyConfigured(Boolean(String(settings.TEXT_API_KEY || '').trim()));
            })
            .catch(() => {
                if (active) setPlannerKeyConfigured(null);
            });
        return () => { active = false; };
    }, [isOpen]);

    if (!isOpen) return null;

    const handleUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            setError('请选择图片文件');
            return;
        }
        if (file.size > 8 * 1024 * 1024) {
            setError('数字人图片不能超过 8 MB');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            setDigitalHumanImage(String(reader.result || ''));
            setError('');
        };
        reader.onerror = () => setError('图片读取失败，请重新选择');
        reader.readAsDataURL(file);
    };

    const handleSubmit = async () => {
        if (!digitalHumanImage) {
            setError('请先上传数字人图片');
            return;
        }
        if (!plannerModel.trim()) {
            setError('请填写用于角色与编舞规划的 LLM 模型名');
            return;
        }
        setLoading(true);
        setError('');
        setStageNo(0);
        setStage('正在提交数字人…');
        setElapsed(0);
        timerRef.current = setInterval(() => setElapsed(value => value + 1), 1000);

        try {
            const response = await fetch('/api/digital-human-dance/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    digitalHumanImageUrl: digitalHumanImage,
                    duration,
                    plannerModel: plannerModel.trim(),
                }),
            });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data?.error || `角色规划失败（HTTP ${response.status}）`);
            }
            if (!response.body) throw new Error('浏览器不支持流式响应');

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let result: DigitalHumanDanceWorkflowResult | null = null;
            let serverError = '';
            const consumeEvent = (raw: string) => {
                const payload = raw.split('\n')
                    .filter(line => line.startsWith('data:'))
                    .map(line => line.slice(5).trim())
                    .join('\n');
                if (!payload) return;
                try {
                    const event = JSON.parse(payload);
                    if (event.type === 'status') {
                        setStage(event.message || 'AI 正在规划…');
                        setStageNo(Number(event.stage) || 0);
                    } else if (event.type === 'progress') {
                        if (event.stage) setStageNo(Number(event.stage));
                    } else if (event.type === 'done') {
                        result = event.data;
                    } else if (event.type === 'error') {
                        serverError = event.error || '数字人编舞规划失败';
                    }
                } catch {
                    // 忽略心跳或非 JSON 片段。
                }
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
                const events = buffer.split('\n\n');
                buffer = events.pop() || '';
                events.forEach(consumeEvent);
            }
            buffer += decoder.decode();
            if (buffer.trim()) consumeEvent(buffer);
            if (serverError) throw new Error(serverError);
            if (!result) throw new Error('连接中断，未收到编舞规划结果，请重试');

            onCreate(result, {
                digitalHumanImage,
                aspectRatio: '9:16',
                duration,
                plannerModel: plannerModel.trim(),
                autoGenerate: true,
            });
            onClose();
        } catch (err: any) {
            setError(err?.message || '数字人一键编舞失败，请重试');
        } finally {
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-x-0 bottom-0 z-[9000] flex items-center justify-center" style={{ top: 'var(--titlebar-h, 0px)' }}>
            <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={loading ? undefined : onClose} />
            <div className="relative w-[760px] max-w-[94vw] max-h-[92vh] overflow-hidden rounded-2xl border border-white/10 bg-[#141416] shadow-2xl">
                <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-400/25 bg-amber-500/10">
                            <Music2 size={19} className="text-amber-300" />
                        </div>
                        <div>
                            <h2 className="text-sm font-semibold text-white">数字人一键编舞</h2>
                            <p className="mt-0.5 text-[11px] text-neutral-500">只上传数字人；仅判断年龄并保留同一张脸，其余造型全部重做</p>
                        </div>
                    </div>
                    <button onClick={onClose} disabled={loading} className="rounded-lg p-1.5 text-neutral-500 hover:bg-white/10 hover:text-white disabled:opacity-40">
                        <X size={16} />
                    </button>
                </div>

                <div className="max-h-[calc(92vh-132px)] space-y-5 overflow-y-auto px-5 py-5">
                    <section className="grid grid-cols-4 gap-2">
                        {PIPELINE.map((item, index) => (
                            <React.Fragment key={item.label}>
                                <div className={`relative rounded-xl border px-3 py-3 ${stageNo > index + 1 || (!loading && digitalHumanImage && index === 0)
                                    ? 'border-emerald-500/30 bg-emerald-500/[0.06]'
                                    : stageNo === index + 1
                                        ? 'border-amber-500/45 bg-amber-500/[0.08]'
                                        : 'border-white/[0.07] bg-white/[0.025]'}`}>
                                    <item.icon size={15} className={stageNo === index + 1 ? 'text-amber-300' : 'text-neutral-500'} />
                                    <div className="mt-2 text-xs font-medium text-neutral-200">{item.label}</div>
                                    <div className="mt-1 text-[10px] leading-4 text-neutral-600">{index === 3 ? `${duration} 秒、${item.desc}` : item.desc}</div>
                                    {index < PIPELINE.length - 1 && <ArrowRight size={12} className="absolute -right-[11px] top-1/2 z-10 -translate-y-1/2 text-neutral-700" />}
                                </div>
                            </React.Fragment>
                        ))}
                    </section>

                    <section className="grid grid-cols-[250px_minmax(0,1fr)] gap-5">
                        <div>
                            <div className="mb-2 flex items-center gap-1.5 text-xs text-neutral-300">
                                <ScanFace size={14} className="text-amber-300" />数字人图片
                                <span className="ml-auto text-[10px] text-red-300">必填</span>
                            </div>
                            <button
                                type="button"
                                disabled={loading}
                                onClick={() => inputRef.current?.click()}
                                className={`relative h-[300px] w-full overflow-hidden rounded-xl border border-dashed bg-black/35 transition-colors ${digitalHumanImage ? 'border-emerald-500/45' : 'border-white/15 hover:border-amber-400/55'}`}
                            >
                                {digitalHumanImage ? (
                                    <>
                                        <img src={digitalHumanImage} alt="数字人预览" className="h-full w-full object-contain" />
                                        <span className="absolute left-2 top-2 flex items-center gap-1 rounded-md bg-emerald-500/90 px-2 py-1 text-[10px] font-medium text-white">
                                            <CheckCircle2 size={11} />已读取
                                        </span>
                                        <span className="absolute bottom-2 right-2 rounded-md bg-black/75 px-2 py-1 text-[10px] text-white">点击替换</span>
                                    </>
                                ) : (
                                    <span className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-xs text-neutral-500">
                                        <Upload size={28} />
                                        <span>上传一张数字人卡或清晰全身图</span>
                                        <span className="text-[10px] leading-4 text-neutral-600">支持 JPG / PNG / WebP，最大 8 MB</span>
                                    </span>
                                )}
                            </button>
                            <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />
                        </div>

                        <div className="space-y-3">
                            <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.05] p-4">
                                <div className="flex items-center justify-between text-xs font-medium text-violet-200">
                                    <span className="flex items-center gap-2"><Sparkles size={14} />规划 LLM</span>
                                    <span className={`text-[10px] ${plannerKeyConfigured === false ? 'text-red-300' : 'text-emerald-300'}`}>
                                        {plannerKeyConfigured === false ? '未配置 KEY' : plannerKeyConfigured === true ? 'KEY 已配置' : '读取配置中'}
                                    </span>
                                </div>
                                <input
                                    value={plannerModel}
                                    onChange={event => setPlannerModel(event.target.value)}
                                    disabled={loading}
                                    placeholder="例如：grok-4.20-fast"
                                    className="mt-3 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-neutral-200 outline-none focus:border-violet-400/50 disabled:opacity-50"
                                />
                                <div className="mt-2 truncate text-[10px] text-neutral-600" title={plannerApiUrl || '使用设置中的文字模型接口'}>
                                    接口：{plannerApiUrl || '使用「设置 → 文字模型」中的 Base URL'}
                                </div>
                                <div className="mt-1 text-[10px] text-neutral-600">模型看图时只判断年龄阶段；造型规划只接收年龄，不读取原图其余信息。网址和 KEY 继续读取全局设置。</div>
                            </div>
                            <div className="rounded-xl border border-white/[0.07] bg-black/25 p-4">
                                <div className="flex items-center justify-between text-xs font-medium text-white">
                                    <span>成片时长</span><span className="text-amber-300">{duration} 秒</span>
                                </div>
                                <div className="mt-3 grid grid-cols-4 gap-2">
                                    {([6, 10, 20, 30] as DanceDuration[]).map(value => (
                                        <button
                                            key={value}
                                            type="button"
                                            onClick={() => setDuration(value)}
                                            disabled={loading}
                                            className={`rounded-lg border py-2 text-xs transition-colors ${duration === value
                                                ? 'border-amber-400/55 bg-amber-500/15 text-amber-200'
                                                : 'border-white/[0.07] bg-white/[0.025] text-neutral-500 hover:text-neutral-200'}`}
                                        >{value}s</button>
                                    ))}
                                </div>
                            </div>
                            <div className="rounded-xl border border-white/[0.07] bg-black/25 p-4">
                                <div className="flex items-center gap-2 text-xs font-medium text-white"><Sparkles size={14} className="text-amber-300" />系统会自动决定</div>
                                <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                                    {['大众审美服装搭配', '协调发型与配饰', '匹配的真实舞蹈场景', '独立选择舞种与 BPM', `${duration} 秒八拍舞句`, '核心 groove 与连续变奏'].map(item => (
                                        <div key={item} className="rounded-lg border border-white/[0.05] bg-white/[0.025] px-2.5 py-2 text-neutral-400">{item}</div>
                                    ))}
                                </div>
                            </div>
                            <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/[0.05] p-4">
                                <div className="text-xs font-medium text-cyan-200">输出规格</div>
                                <div className="mt-2 flex gap-2 text-[11px] text-neutral-300">
                                    <span className="rounded-md bg-black/25 px-2 py-1">9:16 竖屏</span>
                                    <span className="rounded-md bg-black/25 px-2 py-1">{duration} 秒</span>
                                    <span className="rounded-md bg-black/25 px-2 py-1">一镜到底</span>
                                    <span className="rounded-md bg-black/25 px-2 py-1">Grok</span>
                                </div>
                                <p className="mt-3 text-[10px] leading-5 text-neutral-500">上传图只用于判断年龄和后续锁定同一张脸。服装、发型、配饰、表情、身体姿态与场景都由系统重新设计。</p>
                            </div>
                            <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2.5 text-[10px] leading-5 text-amber-100/70">
                                请只上传你有权使用的自有或虚构数字人素材。检测到儿童形象时，会自动改为“不对应真人的原创虚构角色”模式，并清理不符合年龄的造型与动作描述。
                            </div>
                            {loading && (
                                <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3 py-3">
                                    <div className="flex items-center gap-2 text-xs text-amber-200"><Loader2 size={14} className="animate-spin" />{stage}</div>
                                    <div className="mt-1 text-[10px] text-neutral-500">已用时 {elapsed}s，请勿关闭窗口</div>
                                </div>
                            )}
                            {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs leading-5 text-red-300">{error}</div>}
                        </div>
                    </section>
                </div>

                <div className="flex items-center justify-between border-t border-white/[0.06] bg-black/20 px-5 py-3.5">
                    <span className="text-[10px] text-neutral-600">生成后，角色设定和编舞故事板仍可在画布中编辑</span>
                    <div className="flex gap-2">
                        <button onClick={onClose} disabled={loading} className="rounded-lg bg-white/[0.04] px-4 py-2 text-xs text-neutral-400 hover:text-white disabled:opacity-40">取消</button>
                        <button onClick={handleSubmit} disabled={loading || !digitalHumanImage || !plannerModel.trim() || plannerKeyConfigured === false}
                            className="flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-xs font-medium text-black hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40">
                            {loading ? <Loader2 size={14} className="animate-spin" /> : <Music2 size={14} />}
                            {loading ? '正在规划…' : '开始一键编舞'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
