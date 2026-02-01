import * as fs from 'fs';
import * as path from 'path';
import { manager } from './extensionManager';

export interface InstructionHandler {
    /** Target directory name within ~/.copilotboot/variants/{name}/ */
    id: string;
    /** Logic to transform source files to the tool's specific format */
    syncSourceToVariant: (sourceBase: string, variantPath: string) => Promise<void>;
    /** Logic to sync tool-specific edits back to the source format */
    syncVariantToSource: (variantPath: string, sourceBase: string) => Promise<void>;
}

interface ToolMapping {
    name: string;
    sourceDir: string;
    destDir: string;
}

interface ToolConfig {
    id: string;
    displayName: string;
    root: string;
    mappings: ToolMapping[];
}

/**
 * Loads a tool configuration from src/type-config/{id}.json
 */
function getToolConfig(id: string): ToolConfig | null {
    try {
        // Find extension root by looking for package.json
        let currentDir = __dirname;
        let extensionRoot = '';
        while (currentDir !== path.parse(currentDir).root) {
            if (fs.existsSync(path.join(currentDir, 'package.json'))) {
                extensionRoot = currentDir;
                break;
            }
            currentDir = path.dirname(currentDir);
        }

        const pathsToTry = [
            path.join(__dirname, 'type-config', `${id}.json`),
            path.join(extensionRoot, 'src', 'type-config', `${id}.json`),
            path.join(extensionRoot, 'out', 'type-config', `${id}.json`),
            path.join(extensionRoot, 'type-config', `${id}.json`)
        ];

        for (const configPath of pathsToTry) {
            if (fs.existsSync(configPath)) {
                return JSON.parse(fs.readFileSync(configPath, 'utf8'));
            }
        }
    } catch (e) {
        manager.log.error(`[CopilotBoot] Error loading config for ${id}: ${e}`);
    }
    return null;
}

/**
 * Factory to create a handler for tools that use configuration mappings.
 */
function createConfigHandler(id: string): InstructionHandler {
    return {
        id,
        async syncSourceToVariant(sourceBase, variantPath) {
            if (!fs.existsSync(variantPath)) fs.mkdirSync(variantPath, { recursive: true });
            const config = getToolConfig(id);
            if (config) {
                await syncByConfig(sourceBase, variantPath, config, 's2v');
            }
        },
        async syncVariantToSource(variantPath, sourceBase) {
            const config = getToolConfig(id);
            if (config) {
                await syncByConfig(sourceBase, variantPath, config, 'v2s');
            }
        }
    };
}

/**
 * Generic sync helper that uses tool configuration mappings
 */
async function syncByConfig(sourceRoot: string, targetRoot: string, config: ToolConfig, direction: 's2v' | 'v2s') {
    for (const mapping of config.mappings) {
        const srcPath = direction === 's2v'
            ? path.join(sourceRoot, mapping.sourceDir)
            : path.join(targetRoot, mapping.destDir);

        const destPath = direction === 's2v'
            ? path.join(targetRoot, mapping.destDir)
            : path.join(sourceRoot, mapping.sourceDir);

        if (fs.existsSync(srcPath)) {
            manager.log.info(`[CopilotBoot] Syncing mapping "${mapping.name}" (${direction}): ${srcPath} -> ${destPath}`);
            copyFolderSync(srcPath, destPath);
        }
    }
}

export const handlers: Record<string, InstructionHandler> = {
    'githubcopilot': {
        id: 'githubcopilot',
        async syncSourceToVariant(sourceBase, variantPath) {
            if (!fs.existsSync(variantPath)) fs.mkdirSync(variantPath, { recursive: true });

            const subDirs = ['rules', 'prompts'];
            for (const subDir of subDirs) {
                const srcDir = path.join(sourceBase, subDir);
                if (!fs.existsSync(srcDir)) continue;

                const destDir = path.join(variantPath, subDir);
                if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

                const files = fs.readdirSync(srcDir);
                for (const file of files) {
                    if (file.endsWith('.md')) {
                        const sourceFilePath = path.join(srcDir, file);
                        const targetName = file.replace('.md', '.instruction.md');
                        const targetFilePath = path.join(destDir, targetName);

                        const srcStat = fs.statSync(sourceFilePath);
                        if (!fs.existsSync(targetFilePath) || srcStat.mtimeMs > fs.statSync(targetFilePath).mtimeMs) {
                            const content = fs.readFileSync(sourceFilePath, 'utf8');
                            fs.writeFileSync(targetFilePath, content);
                        }
                    }
                }
            }
        },
        async syncVariantToSource(variantPath, sourceBase) {
            const subDirs = ['rules', 'prompts'];
            for (const subDir of subDirs) {
                const varDir = path.join(variantPath, subDir);
                if (!fs.existsSync(varDir)) continue;

                const srcDir = path.join(sourceBase, subDir);
                if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });

                const files = fs.readdirSync(varDir);
                for (const file of files) {
                    if (file.endsWith('.instruction.md')) {
                        const variantFilePath = path.join(varDir, file);
                        const sourceName = file.replace('.instruction.md', '.md');
                        const sourceFilePath = path.join(srcDir, sourceName);

                        const variantStat = fs.statSync(variantFilePath);
                        if (!fs.existsSync(sourceFilePath) || variantStat.mtimeMs > fs.statSync(sourceFilePath).mtimeMs) {
                            const content = fs.readFileSync(variantFilePath, 'utf8');
                            fs.writeFileSync(sourceFilePath, content);
                        }
                    }
                }
            }
        }
    },

    'kilo': createConfigHandler('kilo'),
    'cline': createConfigHandler('cline')
};

/**
 * Helper to recursively copy directories with mtime check to prevent infinite loops.
 */
function copyFolderSync(from: string, to: string) {
    if (!fs.existsSync(to)) fs.mkdirSync(to, { recursive: true });
    fs.readdirSync(from).forEach(element => {
        if (element === 'workspace' || element === '.git') return;
        const fromPath = path.join(from, element);
        const toPath = path.join(to, element);
        const stat = fs.lstatSync(fromPath);

        if (stat.isFile()) {
            if (!fs.existsSync(toPath) || stat.mtimeMs > fs.statSync(toPath).mtimeMs) {
                fs.copyFileSync(fromPath, toPath);
            }
        } else if (stat.isDirectory()) {
            copyFolderSync(fromPath, toPath);
        }
    });
}