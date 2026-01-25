import * as vscode from 'vscode';

class ExtensionManager {
    private static _instance: ExtensionManager;
    private _context?: vscode.ExtensionContext;
    private _log?: vscode.LogOutputChannel;

    private constructor() { }

    public static get instance(): ExtensionManager {
        if (!ExtensionManager._instance) {
            ExtensionManager._instance = new ExtensionManager();
        }
        return ExtensionManager._instance;
    }

    public init(context: vscode.ExtensionContext) {
        this._context = context;
        this._log = vscode.window.createOutputChannel("Copilot Boot", { log: true });
        context.subscriptions.push(this._log);
    }

    // Internal getters to handle the "not initialized" errors
    public get context(): vscode.ExtensionContext {
        if (!this._context) throw new Error("Manager not initialized!");
        return this._context;
    }

    public get log(): vscode.LogOutputChannel {
        if (!this._log) throw new Error("Manager not initialized!");
        return this._log;
    }
}
export const manager = ExtensionManager.instance;
