import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BOOT_ROOT = path.join(os.homedir(), '.copilotboot');
const VARIANTS_STORE = path.join(BOOT_ROOT, 'variants'); 

const syncLocks = new Set<string>();
const debounceTimeouts = new Map<string, NodeJS.Timeout>();

/**
 * Core synchronization logic that uses .bootconfig.json to map files
 */
export async function syncInstruction(instructionName: string, direction: 'v2s' | 's2v' = 'v2s'): Promise<void> {
    if (syncLocks.has(instructionName)) return;
    syncLocks.add(instructionName);

    try {
        const sourceBase = path.join(BOOT_ROOT, instructionName);
        const bootConfigPath = path.join(sourceBase, '.bootconfig.json');

        if (!fs.existsSync(bootConfigPath)) return;

        // Load the instruction-specific configuration
        const { toolId, mappings } = JSON.parse(fs.readFileSync(bootConfigPath, 'utf8'));
        
        // Load the tool definition (e.g., kilo.json) to get directory rules
        // Note: This assumes the extension is running and can access its own src/type-config
        // In production, you'd pass this config path or the loaded tool config.
        const toolConfig = await getToolConfigById(toolId);
        if (!toolConfig) return;

        const variantPath = path.join(VARIANTS_STORE, instructionName, toolId);
        if (!fs.existsSync(variantPath)) fs.mkdirSync(variantPath, { recursive: true });

        // Iterate through only the mappings the user enabled for this instruction
        for (const mappingName of mappings) {
            const mapDef = toolConfig.mappings.find((m: any) => m.name === mappingName);
            if (!mapDef) continue;

            // Handle variable substitution for ${root} if necessary, though for sync 
            // we usually just care about sourceDir -> destDir relative to roots.
            const sourceDir = path.join(sourceBase, mapDef.sourceDir);
            const targetDir = path.join(variantPath, mapDef.destDir.replace('${root}/', ''));

            if (direction === 's2v') {
                syncFolders(sourceDir, targetDir);
            } else {
                syncFolders(targetDir, sourceDir);
            }
        }
    } catch (err) {
        console.error(`Sync failed for ${instructionName}:`, err);
    } finally {
        setTimeout(() => syncLocks.delete(instructionName), 300);
    }
}

/**
 * Simple recursive folder sync (can be enhanced with more complex logic if needed)
 */
function syncFolders(from: string, to: string) {
    if (!fs.existsSync(from)) return;
    if (!fs.existsSync(to)) fs.mkdirSync(to, { recursive: true });

    const files = fs.readdirSync(from);
    for (const file of files) {
        const srcFile = path.join(from, file);
        const destFile = path.join(to, file);

        if (fs.lstatSync(srcFile).isDirectory()) {
            syncFolders(srcFile, destFile);
        } else {
            // Only copy if modified or non-existent to prevent infinite loops
            const srcStat = fs.statSync(srcFile);
            if (!fs.existsSync(destFile) || srcStat.mtimeMs > fs.statSync(destFile).mtimeMs) {
                fs.copyFileSync(srcFile, destFile);
            }
        }
    }
}

/**
 * Helper to fetch tool config. In a real extension, you might pass this from manager.
 */
async function getToolConfigById(toolId: string) {
    // This is a placeholder logic - in extension.ts we already have this list.
    // You may want to move the getToolConfigs logic to a shared utility.
    try {
        // Adjust this path based on your build structure (out vs src)
        const configPath = path.join(__dirname, 'type-config', `${toolId}.json`);
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (e) { return null; }
    return null;
}

export function watchVariant(instructionName: string) {
    const watchTarget = path.join(VARIANTS_STORE, instructionName);
    if (!fs.existsSync(watchTarget)) return null;

    return fs.watch(watchTarget, { recursive: true }, (event, filename) => {
        if (!filename || filename.includes('.git') || filename.endsWith('~')) return;

        const existingTimeout = debounceTimeouts.get(instructionName);
        if (existingTimeout) clearTimeout(existingTimeout);

        const newTimeout = setTimeout(async () => {
            await syncInstruction(instructionName, 'v2s');
            debounceTimeouts.delete(instructionName);
        }, 500);

        debounceTimeouts.set(instructionName, newTimeout);
    });
}