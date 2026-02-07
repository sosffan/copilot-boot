import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { manager } from './extensionManager';
import { watchVariant as watchVariant, syncInstruction } from './sync';
import { handlers } from './handlers';

const BOOT_ROOT = path.join(os.homedir(), '.copilotboot');
const TEMPLATES_STORE = path.join(BOOT_ROOT, 'templates');
const VARIANTS_STORE = path.join(BOOT_ROOT, 'variants');

// Configuration Interface
interface ToolConfig {
    id: string;
    displayName: string;
    mappings: Array<{ name: string; sourceDir: string; destDir?: string; destPattern?: string; }>;
}

export function activate(context: vscode.ExtensionContext) {
    manager.init(context);

    if (!fs.existsSync(BOOT_ROOT)) fs.mkdirSync(BOOT_ROOT);
    if (!fs.existsSync(TEMPLATES_STORE)) fs.mkdirSync(TEMPLATES_STORE);
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
                case 'unlink':
                    await this._handleUnlink();
                    break;
                case 'delete':
                    await this._handleDelete(data.id);
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
        const targetDir = path.join(TEMPLATES_STORE, data.name);
        try {
            if (fs.existsSync(targetDir)) {
                this._view?.webview.postMessage({ type: 'createError', message: "Instruction already exists." });
                return;
            }

            const configs = this._getToolConfigs();
            const selectedTool = configs.find(t => t.id === data.toolId);
            if (!selectedTool) throw new Error("Invalid tool selected.");

            // 1. Scaffold Master Folder from Embedded Template
            fs.mkdirSync(targetDir, { recursive: true });
            fs.writeFileSync(path.join(targetDir, 'description.md'), data.description || `# ${data.name}`);

            // Find embedded template root - use project source for reliability in development
            const embeddedTemplateRoot = path.join(this._extensionUri.fsPath, 'src', 'template');

            const copyRecursiveSync = (src: string, dest: string) => {
                if (!fs.existsSync(src)) return;
                const stats = fs.statSync(src);
                if (stats.isDirectory()) {
                    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
                    fs.readdirSync(src).forEach((childItemName) => {
                        copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
                    });
                } else {
                    fs.copyFileSync(src, dest);
                }
            };

            // Helper to copy files if mapping matches
            const copyFromTemplate = (subDir: string) => {
                const srcPath = path.join(embeddedTemplateRoot, subDir);
                const destPath = path.join(targetDir, subDir);
                if (fs.existsSync(srcPath)) {
                    copyRecursiveSync(srcPath, destPath);
                }
            };

            // Scaffold source directories based on selected mappings
            data.mappings.forEach(mName => {
                const mapping = selectedTool.mappings.find(m => m.name === mName);
                if (mapping) {
                    // Try to copy from common Claude-style folders
                    copyFromTemplate(mapping.sourceDir);
                    // Ensure the folder exists even if template didn't have it
                    const fullDest = path.join(targetDir, mapping.sourceDir);
                    if (!fs.existsSync(fullDest)) fs.mkdirSync(fullDest, { recursive: true });
                }
            });

            // 2. Refresh so the list updates
            await this.refresh();

            // 3. Auto-Apply
            manager.log.info("Auto-applying new instruction: {}", data.name);
            await this._handleApply(data.name, data.toolId);

            vscode.window.showInformationMessage(`Instruction "${data.name}" initialized and applied for ${selectedTool.displayName}.`);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Creation failed: ${err.message}`);
        }
    }

    private async _handleApply(id: string, toolId: string) {
        manager.log.info("Starting to apply variant link: id - {}, toolId - {}", id, toolId)
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) return vscode.window.showErrorMessage('Open a workspace first.');

        const projectRoot = folders[0].uri.fsPath;
        const instDir = path.join(TEMPLATES_STORE, id);

        const configs = this._getToolConfigs();
        const tool = configs.find(t => t.id === toolId);
        if (!tool) return;

        try {
            // 1. UNLINK ALL: Clean up any existing tool paths defined in any config to prevent conflicts
            configs.forEach(conf => {
                conf.mappings.forEach(m => {
                    this._cleanupMapping(projectRoot, m);
                });
            });

            // 2. TRANSFORM: Generate variants
            const sourceStore = path.join(VARIANTS_STORE, id, toolId);
            if (handlers[toolId]) {
                manager.log.info("Running handler for tool: {}", toolId);
                await handlers[toolId].syncSourceToVariant(instDir, sourceStore);
            } else {
                manager.log.warn("No specific handler found for tool: {}, creating empty directory.", toolId);
                if (!fs.existsSync(sourceStore)) fs.mkdirSync(sourceStore, { recursive: true });
            }

            // 3. LINK NEW: Create symlinks for each mapping
            for (const mapping of tool.mappings) {
                this._linkMapping(projectRoot, sourceStore, mapping);
            }

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

    private async _handleUnlink() {
        manager.log.info("[CopilotBoot] Starting unlink operation");
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) {
            manager.log.warn("[CopilotBoot] No workspace folders found");
            return;
        }

        const projectRoot = folders[0].uri.fsPath;
        manager.log.info("[CopilotBoot] Project root: {}", projectRoot);
        const configs = this._getToolConfigs();
        manager.log.info("[CopilotBoot] Found {} tool configs", configs.length);

        try {
            // Remove any folder/files defined by any tool config
            for (const conf of configs) {
                manager.log.info("[CopilotBoot] Processing config: {} with {} mappings", conf.id, conf.mappings?.length || 0);
                if (conf.mappings) {
                    for (const m of conf.mappings) {
                        manager.log.info("[CopilotBoot] Cleaning up mapping: {} (destDir={}, destPattern={})", m.name, m.destDir, m.destPattern);
                        this._cleanupMapping(projectRoot, m);
                    }
                }
            }

            await this._context.globalState.update('copilotboot.selectedInstruction', undefined);
            await this._context.globalState.update('copilotboot.selectedState', undefined);

            await this.refresh();
            manager.log.info("[CopilotBoot] Unlink completed successfully");
            vscode.window.showInformationMessage('Unlinked instruction.');
        } catch (err: any) {
            manager.log.error("[CopilotBoot] Unlink failed: {}", err.message);
            vscode.window.showErrorMessage(`Unlink failed: ${err.message}`);
        }
    }

    // Inside extension.ts -> CopilotBootViewProvider class

    private async _handleDelete(id: string) {
        manager.log.info("[CopilotBoot] Deleting instruction: {}", id);

        // Show confirmation dialog in VS Code (not in webview)
        // modal: true automatically adds a Cancel button
        const answer = await vscode.window.showWarningMessage(
            `Delete instruction "${id}"? This will permanently remove the instruction and all its variants.`,
            { modal: true },
            'Delete'
        );

        if (answer !== 'Delete') {
            manager.log.info("[CopilotBoot] User cancelled deletion");
            return;
        }

        try {
            // Determine if this is the active instruction; if so, unlink first.
            const selectedState = this._context.globalState.get('copilotboot.selectedState') as any;
            if (selectedState && selectedState.id === id) {
                manager.log.info("[CopilotBoot] Instruction is active, unlinking first");
                await this._handleUnlink();
            }

            const templateDir = path.join(TEMPLATES_STORE, id);
            const variantDir = path.join(VARIANTS_STORE, id);

            manager.log.info("[CopilotBoot] Removing template dir: {}", templateDir);
            // Remove template
            if (fs.existsSync(templateDir)) {
                fs.rmSync(templateDir, { recursive: true, force: true });
                manager.log.info("[CopilotBoot] Template removed");
            } else {
                manager.log.info("[CopilotBoot] Template dir does not exist");
            }

            manager.log.info("[CopilotBoot] Removing variants dir: {}", variantDir);
            // Remove variants
            if (fs.existsSync(variantDir)) {
                fs.rmSync(variantDir, { recursive: true, force: true });
                manager.log.info("[CopilotBoot] Variants removed");
            } else {
                manager.log.info("[CopilotBoot] Variants dir does not exist");
            }

            await this.refresh();
            manager.log.info("[CopilotBoot] Delete completed successfully");
            vscode.window.showInformationMessage(`Instruction "${id}" deleted.`);
        } catch (err: any) {
            manager.log.error("[CopilotBoot] Delete failed: {}", err.message);
            vscode.window.showErrorMessage(`Delete failed: ${err.message}`);
        }
    }

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

        // 2. Get Instructions from ~/.copilotboot/templates
        const entries = fs.readdirSync(TEMPLATES_STORE, { withFileTypes: true });
        const instructions = entries
            .filter(e => e.isDirectory() && e.name !== 'variants')
            .map(d => {
                const descPath = path.join(TEMPLATES_STORE, d.name, 'description.md');
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

    private _cleanupMapping(projectRoot: string, mapping: any) {
        if (!mapping) {
            manager.log.warn("[CopilotBoot] _cleanupMapping: mapping is null/undefined");
            return;
        }
        if (mapping.destDir) {
            const fullPath = path.join(projectRoot, mapping.destDir);
            manager.log.info("[CopilotBoot] Checking destDir path: {}", fullPath);
            if (fs.existsSync(fullPath)) {
                manager.log.info("[CopilotBoot] Removing path: {}", fullPath);
                this._removePath(fullPath);
            } else {
                manager.log.info("[CopilotBoot] Path does not exist: {}", fullPath);
            }
            // Also cleanup empty parent if it was ours
            this._cleanupEmptyParents(projectRoot, fullPath);
        } else if (mapping.destPattern) {
            const destDir = path.join(projectRoot, path.dirname(mapping.destPattern));
            manager.log.info("[CopilotBoot] Checking destPattern dir: {}", destDir);
            if (!fs.existsSync(destDir)) {
                manager.log.info("[CopilotBoot] Pattern dir does not exist: {}", destDir);
                return;
            }

            const patternBase = path.basename(mapping.destPattern);
            const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // Create a regex that matches the pattern with any content for the tokens
            const regexStr = escapeRegExp(patternBase)
                .replace('\\$\\{basename\\}', '(.+)')
                .replace('\\$\\{filename\\}', '(.+)')
                .replace('\\$\\{ext\\}', '(\\..+)');
            const regex = new RegExp(`^${regexStr}$`);
            manager.log.info("[CopilotBoot] Pattern regex: {}", regex.toString());

            const files = fs.readdirSync(destDir);
            manager.log.info("[CopilotBoot] Files in dir: {}", files.join(', '));
            for (const file of files) {
                if (regex.test(file)) {
                    const filePath = path.join(destDir, file);
                    manager.log.info("[CopilotBoot] Removing matched file: {}", filePath);
                    this._removePath(filePath);
                }
            }
            this._cleanupEmptyParents(projectRoot, destDir);
        } else {
            manager.log.warn("[CopilotBoot] Mapping has no destDir or destPattern: {}", mapping.name);
        }
    }

    private _linkMapping(projectRoot: string, sourceStore: string, mapping: any) {
        if (!mapping) return;
        const type = os.platform() === 'win32' ? 'junction' : 'dir';

        if (mapping.destDir) {
            const fullDest = path.join(projectRoot, mapping.destDir);
            const fullSource = path.join(sourceStore, mapping.destDir);

            if (!fs.existsSync(path.dirname(fullDest))) {
                fs.mkdirSync(path.dirname(fullDest), { recursive: true });
            }
            if (fs.existsSync(fullSource)) {
                fs.symlinkSync(fullSource, fullDest, type);
            }
        } else if (mapping.destPattern) {
            const destBaseRel = path.dirname(mapping.destPattern);
            const fullDestBase = path.join(projectRoot, destBaseRel);
            const fullSourceBase = path.join(sourceStore, destBaseRel);

            if (!fs.existsSync(fullDestBase)) fs.mkdirSync(fullDestBase, { recursive: true });
            if (!fs.existsSync(fullSourceBase)) return;

            const patternBase = path.basename(mapping.destPattern);
            const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            const regexStr = escapeRegExp(patternBase)
                .replace('\\$\\{basename\\}', '(.+)')
                .replace('\\$\\{filename\\}', '(.+)')
                .replace('\\$\\{ext\\}', '(\\..+)');
            const regex = new RegExp(`^${regexStr}$`);

            const files = fs.readdirSync(fullSourceBase);
            for (const file of files) {
                if (regex.test(file)) {
                    const destFile = path.join(fullDestBase, file);
                    const sourceFile = path.join(fullSourceBase, file);
                    fs.symlinkSync(sourceFile, destFile, 'file');
                }
            }
        }
    }

    private _removePath(p: string) {
        try {
            const stat = fs.lstatSync(p);
            if (stat.isSymbolicLink()) {
                fs.unlinkSync(p);
            } else {
                fs.rmSync(p, { recursive: true, force: true });
            }
        } catch (e) {
            // Ignore errors
        }
    }

    private _cleanupEmptyParents(projectRoot: string, p: string) {
        let current = path.dirname(p);
        while (current !== projectRoot && current !== path.parse(current).root) {
            try {
                if (fs.readdirSync(current).length === 0) {
                    fs.rmdirSync(current);
                    current = path.dirname(current);
                } else {
                    break;
                }
            } catch (e) {
                break;
            }
        }
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