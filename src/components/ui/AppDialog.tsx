/**
 * AppDialog.tsx
 *
 * 全局统一提示框（替代原生 alert / confirm，样式与应用内其它弹窗一致）。
 * 用法：
 *   showAppAlert('消息内容');
 *   const ok = await showAppConfirm('确定删除吗？', { title: '删除素材', confirmText: '删除', danger: true });
 * 需要在应用根部挂载一次 <AppDialogHost />。
 */
import { useEffect, useState } from 'react';

interface DialogState {
    mode: 'alert' | 'confirm';
    title: string;
    message: string;
    confirmText: string;
    cancelText: string;
    danger: boolean;
    resolve?: (ok: boolean) => void;
}

let pushDialog: ((s: DialogState) => void) | null = null;

export function showAppAlert(message: string, title = '提示') {
    if (!pushDialog) { window.alert(message); return; }
    pushDialog({ mode: 'alert', title, message, confirmText: '知道了', cancelText: '', danger: false });
}

export function showAppConfirm(
    message: string,
    opts: { title?: string; confirmText?: string; cancelText?: string; danger?: boolean } = {}
): Promise<boolean> {
    if (!pushDialog) return Promise.resolve(window.confirm(message));
    return new Promise<boolean>(resolve => {
        pushDialog!({
            mode: 'confirm',
            title: opts.title || '确认操作',
            message,
            confirmText: opts.confirmText || '确定',
            cancelText: opts.cancelText || '取消',
            danger: opts.danger ?? false,
            resolve,
        });
    });
}

export function AppDialogHost() {
    const [dlg, setDlg] = useState<DialogState | null>(null);

    useEffect(() => {
        pushDialog = setDlg;
        return () => { pushDialog = null; };
    }, []);

    if (!dlg) return null;

    const close = (ok: boolean) => {
        dlg.resolve?.(ok);
        setDlg(null);
    };

    return (
        <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[9999]"
            onClick={() => close(false)}
        >
            <div
                className="bg-[#1a1a1a] border border-neutral-700 rounded-2xl p-6 w-[340px] shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                <h3 className="text-lg font-semibold text-white mb-2">{dlg.title}</h3>
                <p className="text-sm text-neutral-400 mb-5 whitespace-pre-wrap break-words">{dlg.message}</p>
                <div className="flex justify-end gap-2">
                    {dlg.mode === 'confirm' && (
                        <button
                            onClick={() => close(false)}
                            className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm transition-colors"
                        >
                            {dlg.cancelText}
                        </button>
                    )}
                    <button
                        onClick={() => close(true)}
                        autoFocus
                        className={`px-4 py-2 rounded-lg text-white text-sm transition-colors ${dlg.danger ? 'bg-red-600 hover:bg-red-500' : 'bg-cyan-600 hover:bg-cyan-500'}`}
                    >
                        {dlg.confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
}
