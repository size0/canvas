/**
 * 桌面端自定义标题栏（无边框窗口）
 *
 * 仅在 Electron 环境（window.desktopWindow 存在）下渲染。
 * 提供拖拽区域 + 最小化 / 最大化(还原) / 关闭按钮。
 * 渲染时会在 <html> 上设置 --titlebar-h 变量，供其他固定面板做顶部偏移。
 */
import React, { useEffect, useState } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';

interface DesktopWindowAPI {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    onMaximizeChange: (cb: (val: boolean) => void) => () => void;
}

declare global {
    interface Window {
        desktopWindow?: DesktopWindowAPI;
    }
}

export const TITLEBAR_HEIGHT = 36;

/** 是否运行在 Electron 桌面环境 */
export function isDesktop(): boolean {
    return typeof window !== 'undefined' && !!window.desktopWindow;
}

export function DesktopTitleBar() {
    const api = window.desktopWindow;
    const [maximized, setMaximized] = useState(false);

    useEffect(() => {
        if (!api) return;
        document.documentElement.style.setProperty('--titlebar-h', `${TITLEBAR_HEIGHT}px`);
        api.isMaximized().then(setMaximized).catch(() => { });
        const off = api.onMaximizeChange(setMaximized);
        return () => {
            off();
            document.documentElement.style.removeProperty('--titlebar-h');
        };
    }, [api]);

    if (!api) return null;

    const btnBase = 'h-full w-12 flex items-center justify-center transition-colors duration-150 outline-none';

    return (
        <div
            className="fixed top-0 left-0 right-0 z-[10000] flex items-stretch justify-between bg-gradient-to-r from-[#0a0a0c] via-[#0c0c10] to-[#0a0a0c] border-b border-white/[0.06] select-none"
            style={{ height: TITLEBAR_HEIGHT, WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
            {/* 左侧：logo + 应用名 */}
            <div className="flex items-center gap-2.5 pl-3 pointer-events-none">
                <img src="/logo.png" alt="" className="w-5 h-5 object-contain" />
                <span className="text-[12px] font-semibold tracking-wide bg-gradient-to-r from-cyan-400 to-violet-400 bg-clip-text text-transparent">
                    Magical Canvas
                </span>
            </div>

            {/* 右侧：窗口控制按钮 */}
            <div className="flex items-stretch" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                <button
                    onClick={() => api.minimize()}
                    title="最小化"
                    className={`${btnBase} text-neutral-400 hover:text-white hover:bg-white/10 active:bg-white/15`}
                >
                    <Minus size={15} strokeWidth={2} />
                </button>
                <button
                    onClick={() => api.toggleMaximize()}
                    title={maximized ? '还原' : '最大化'}
                    className={`${btnBase} text-neutral-400 hover:text-white hover:bg-white/10 active:bg-white/15`}
                >
                    {maximized
                        ? <Copy size={13} strokeWidth={2} className="scale-x-[-1]" />
                        : <Square size={12.5} strokeWidth={2} />}
                </button>
                <button
                    onClick={() => api.close()}
                    title="关闭"
                    className={`${btnBase} text-neutral-400 hover:text-white hover:bg-[#e81123] active:bg-[#bf0f1d]`}
                >
                    <X size={16} strokeWidth={2} />
                </button>
            </div>
        </div>
    );
}
