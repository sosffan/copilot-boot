import * as fs from 'fs';
import * as path from 'path';

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
        console.error(`[CopilotBoot] Error loading config for ${id}:`, e);
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
            copyFolderSync(srcPath, destPath);
        }
    }
}

export const handlers: Record<string, InstructionHandler> = {
    'githubcopilot': {
        id: 'githubcopilot',
        async syncSourceToVariant(sourceBase, variantPath) {
            if (!fs.existsSync(variantPath)) fs.mkdirSync(variantPath, { recursive: true });

            const rulesDir = path.join(sourceBase, 'rules');
            if (!fs.existsSync(rulesDir)) return;

            const files = fs.readdirSync(rulesDir);
            for (const file of files) {
                if (file.endsWith('.md')) {
                    const content = fs.readFileSync(path.join(rulesDir, file), 'utf8');
                    // GitHub Copilot prefers .instruction.md suffix
                    const targetName = file.replace('.md', '.instruction.md');
                    fs.writeFileSync(path.join(variantPath, targetName), content);
                }
            }
        },
        async syncVariantToSource(variantPath, sourceBase) {
            const files = fs.readdirSync(variantPath);
            for (const file of files) {
                if (file.endsWith('.instruction.md')) {
                    const content = fs.readFileSync(path.join(variantPath, file), 'utf8');
                    const sourceName = file.replace('.instruction.md', '.md');
                    fs.writeFileSync(path.join(sourceBase, 'rules', sourceName), content);
                }
            }
        }
    },

    'kilo': createConfigHandler('kilo'),
    'cline': createConfigHandler('cline')
};

/**
 * Helper to recursively copy directories
 */
function copyFolderSync(from: string, to: string) {
    if (!fs.existsSync(to)) fs.mkdirSync(to, { recursive: true });
    fs.readdirSync(from).forEach(element => {
        if (element === 'workspace' || element === '.git') return;
        const fromPath = path.join(from, element);
        const toPath = path.join(to, element);
        const stat = fs.lstatSync(fromPath);
        if (stat.isFile()) {
            fs.copyFileSync(fromPath, toPath);
        } else if (stat.isDirectory()) {
            copyFolderSync(fromPath, toPath);
        }
    });
}