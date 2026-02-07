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
    destDir?: string;
    destPattern?: string;
}

interface ToolConfig {
    id: string;
    displayName: string;
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
        if (mapping.destPattern) {
            const patternBase = path.basename(mapping.destPattern);
            const patternDir = path.dirname(mapping.destPattern);
            const [prefix, suffix] = patternBase.split('${basename}');

            // Escape prefix/suffix for regex
            const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`^${escapeRegExp(prefix)}(.+)${escapeRegExp(suffix)}$`);

            if (direction === 's2v') {
                const srcDir = path.join(sourceRoot, mapping.sourceDir);
                if (!fs.existsSync(srcDir)) continue;

                const destBaseFull = path.join(targetRoot, patternDir);
                if (!fs.existsSync(destBaseFull)) fs.mkdirSync(destBaseFull, { recursive: true });

                const files = fs.readdirSync(srcDir);
                for (const file of files) {
                    const ext = path.extname(file);
                    const basename = path.basename(file, ext);

                    // Filter: if pattern ends with .md and file doesn't, skip? 
                    // No, let user define tokens. 
                    const targetName = patternBase
                        .replace('${basename}', basename)
                        .replace('${filename}', file)
                        .replace('${ext}', ext);

                    const sourceFilePath = path.join(srcDir, file);
                    const targetFilePath = path.join(destBaseFull, targetName);

                    const srcStat = fs.statSync(sourceFilePath);
                    if (!fs.existsSync(targetFilePath) || srcStat.mtimeMs > fs.statSync(targetFilePath).mtimeMs) {
                        manager.log.info(`[CopilotBoot] Syncing pattern-matched file (s2v): ${sourceFilePath} -> ${targetFilePath}`);
                        fs.copyFileSync(sourceFilePath, targetFilePath);
                    }
                }
            } else {
                // v2s: Search targetRoot for files matching pattern and sync back to sourceDir
                const srcDir = path.join(sourceRoot, mapping.sourceDir);
                if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });

                const destBaseFull = path.join(targetRoot, patternDir);
                if (!fs.existsSync(destBaseFull)) continue;

                const files = fs.readdirSync(destBaseFull);
                for (const file of files) {
                    const match = file.match(regex);
                    if (match) {
                        const basename = match[1];
                        // How to find the correct source extension? 
                        // We check for files in srcDir that would produce this target file
                        const sourceFiles = fs.readdirSync(srcDir).filter(f => {
                            const fExt = path.extname(f);
                            const fBName = path.basename(f, fExt);
                            const expectedTarget = patternBase
                                .replace('${basename}', fBName)
                                .replace('${filename}', f)
                                .replace('${ext}', fExt);
                            return expectedTarget === file;
                        });

                        // Default to .md if no file found yet (e.g. new file in project)
                        const sourceFilename = sourceFiles.length > 0 ? sourceFiles[0] : (patternBase.includes('${ext}') ? file.replace(prefix, '').replace(suffix, '') : `${basename}.md`);
                        const sourceFilePath = path.join(srcDir, sourceFilename);
                        const targetFilePath = path.join(destBaseFull, file);

                        const targetStat = fs.statSync(targetFilePath);
                        if (!fs.existsSync(sourceFilePath) || targetStat.mtimeMs > fs.statSync(sourceFilePath).mtimeMs) {
                            manager.log.info(`[CopilotBoot] Syncing pattern-matched file (v2s): ${targetFilePath} -> ${sourceFilePath}`);
                            fs.copyFileSync(targetFilePath, sourceFilePath);
                        }
                    }
                }
            }
        } else if (mapping.destDir) {
            // Directory sync
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
}

export const handlers: Record<string, InstructionHandler> = {
    'githubcopilot': createConfigHandler('githubcopilot'),
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