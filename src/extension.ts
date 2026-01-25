import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { manager } from './extensionManager';
import { watchVariant as watchVariant, syncInstruction } from './sync';

const BOOT_ROOT = path.join(os.homedir(), '.copilotboot');
const VARIANTS_STORE = path.join(BOOT_ROOT, 'variants');

// Configuration Interface
interface ToolConfig {
    id: string;
    displayName: string;
    root: string;
    mappings: Array<{ name: string; sourceDir: string; destDir: string; }>;
}

export function activate(context: vscode.ExtensionContext) {
    manager.init(context);

    if (!fs.existsSync(BOOT_ROOT)) fs.mkdirSync(BOOT_ROOT);
    if (!fs.existsSync(VARIANTS_STORE)) fs.mkdirSync(VARIANTS_STORE);

    manager.log.info('CopilotBoot active');

    let activeWatcher: vscode.Disposable | null = null;

    const startWatching = (instructionName: string) => {
        if (activeWatcher) {
            activeWatcher.dispose();
        }
        const fsWatcher = watchVariant(instructionName);
        if (fsWatcher) {
            activeWatcher = new vscode.Disposable(() => fsWatcher.close());
            context.subscriptions.push(activeWatcher);
        }
    };

    const savedInstruction = context.globalState.get<string>('copilotboot.selectedInstruction');
    if (savedInstruction) {
        startWatching(savedInstruction);
    }

    const provider = new CopilotBootViewProvider(context.extensionUri, context, (id) => startWatching(id));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('copilotboot.mainView', provider));
    context.subscriptions.push(vscode.commands.registerCommand('copilotboot.refreshWebview', () => provider.refresh()));
}

class CopilotBootViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext,
        private readonly _onInstructionApplied: (id: string) => void
    ) { }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlContent(webviewView.webview, this._extensionUri);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'requestData':
                    await this.refresh();
                    break;
                case 'create':
                    await this._handleCreate(data);
                    break;
                case 'apply':
                    await this._handleApply(data.id, data.toolId);
                    break;
            }
        });
    }

    /**
     * Reads all JSON files from src/type-config
     */
    private _getToolConfigs(): ToolConfig[] {
        const configPath = path.join(this._extensionUri.fsPath, 'src', 'type-config');
        if (!fs.existsSync(configPath)) return [];

        return fs.readdirSync(configPath)
            .filter(file => file.endsWith('.json'))
            .map(file => {
                const content = fs.readFileSync(path.join(configPath, file), 'utf8');
                return JSON.parse(content) as ToolConfig;
            });
    }

    private async _handleCreate(data: { name: string, description: string, toolId: string, mappings: string[] }) {
        const targetDir = path.join(BOOT_ROOT, data.name);
        try {
            if (fs.existsSync(targetDir)) {
                throw new Error("Instruction already exists.");
            }

            const configs = this._getToolConfigs();
            const selectedTool = configs.find(t => t.id === data.toolId);
            if (!selectedTool) throw new Error("Invalid tool selected.");

            // 1. Scaffold Master Folder
            fs.mkdirSync(targetDir, { recursive: true });
            fs.writeFileSync(path.join(targetDir, 'description.md'), data.description || `# ${data.name}`);

            // 2. Scaffold source directories based on selected mappings
            data.mappings.forEach(mName => {
                const mapping = selectedTool.mappings.find(m => m.name === mName);
                if (mapping) {
                    const sourcePath = path.join(targetDir, mapping.sourceDir);
                    if (!fs.existsSync(sourcePath)) fs.mkdirSync(sourcePath, { recursive: true });
                }
            });

            await syncInstruction(data.name, 's2v');
            await this.refresh();
            vscode.window.showInformationMessage(`Instruction "${data.name}" created for ${selectedTool.displayName}.`);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Creation failed: ${err.message}`);
        }
    }

    private async _handleApply(id: string, toolId: string) {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) return vscode.window.showErrorMessage('Open a workspace first.');

        const projectRoot = folders[0].uri.fsPath;
        const instDir = path.join(BOOT_ROOT, id);

        const configs = this._getToolConfigs();
        const tool = configs.find(t => t.id === toolId);
        if (!tool) return;

        try {
            // UNLINK OLD: Remove any root folder defined by any tool config to prevent conflicts
            configs.forEach(conf => {
                const oldPath = path.join(projectRoot, conf.root);
                if (fs.existsSync(oldPath)) {
                    const stat = fs.lstatSync(oldPath);
                    if (stat.isSymbolicLink()) {
                        fs.unlinkSync(oldPath);
                    } else {
                        // If it's a real directory (not a link), remove it recursively. TODO,  new task is to read current instruction and able to save as a new instruction.
                        fs.rmSync(oldPath, { recursive: true, force: true });
                    }
                    manager.log.info(`Cleaned up existing tool path: ${conf.root}`);

                }
            });

            // LINK NEW: Create symlink from Workspace Store to Project Root
            const sourceStore = path.join(VARIANTS_STORE, id, toolId);
            const fullLinkPath = path.join(projectRoot, tool.root);

            if (!fs.existsSync(sourceStore)) fs.mkdirSync(sourceStore, { recursive: true });

            const type = os.platform() === 'win32' ? 'junction' : 'dir';
            fs.symlinkSync(sourceStore, fullLinkPath, type);

            await this._context.globalState.update('copilotboot.selectedInstruction', id);
            await this._context.globalState.update('copilotboot.selectedState', {
                id: id,
                toolId: toolId
            });
            this._onInstructionApplied(id);
            await this.refresh();
            vscode.window.showInformationMessage(`Switched to ${id} (${tool.displayName})`);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Apply failed: ${err.message}`);
        }
    }

    // Inside extension.ts -> CopilotBootViewProvider class

    public async refresh() {
        if (!this._view) return;

        // 1. Get Tool Configurations from src/type-config
        const configPath = path.join(this._extensionUri.fsPath, 'src', 'type-config');
        let availableTools: any[] = [];

        if (fs.existsSync(configPath)) {
            availableTools = fs.readdirSync(configPath)
                .filter(file => file.endsWith('.json'))
                .map(file => {
                    const content = fs.readFileSync(path.join(configPath, file), 'utf8');
                    return JSON.parse(content);
                    // This returns the object containing id, displayName, etc.
                });
        }

        // 2. Get Instructions from ~/.copilotboot
        const entries = fs.readdirSync(BOOT_ROOT, { withFileTypes: true });
        const instructions = entries
            .filter(e => e.isDirectory() && e.name !== 'variants')
            .map(d => {
                const descPath = path.join(BOOT_ROOT, d.name, 'description.md');
                return {
                    id: d.name,
                    name: d.name,
                    description: fs.existsSync(descPath) ? fs.readFileSync(descPath, 'utf8') : ""
                };
            });

        // 3. Send everything to home.js
        this._view.webview.postMessage({
            type: 'update',
            instructions: instructions,
            availableTools: availableTools, // <--- THIS is where availableTools comes from
            selected: this._context.globalState.get('copilotboot.selectedState')
            // selectedState should be { id: 'instName', toolId: 'kilo' }
        });
    }

    private _getHtmlContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
        const toolkitUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode-elements', 'elements', 'dist', 'bundled.js'));
        const htmlPath = vscode.Uri.joinPath(extensionUri, 'src', 'media', 'home.html');
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'media', 'home.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'media', 'home.css'));

        return fs.readFileSync(htmlPath.fsPath, 'utf8')
            .replace(/{{toolkitUri}}/g, toolkitUri.toString())
            .replace(/{{cspSource}}/g, webview.cspSource)
            .replace(/{{scriptUri}}/g, scriptUri.toString())
            .replace(/{{styleUri}}/g, styleUri.toString());
    }
}