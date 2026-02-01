import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { manager } from './extensionManager';

const BOOT_ROOT = path.join(os.homedir(), '.copilotboot');
const TEMPLATES_STORE = path.join(BOOT_ROOT, 'templates');
const VARIANTS_STORE = path.join(BOOT_ROOT, 'variants');

import { handlers } from './handlers';

const syncLocks = new Set<string>();
const debounceTimeouts = new Map<string, NodeJS.Timeout>();
const instructionSyncInProgress = new Set<string>();

/**
 * Syncs a specific variant back to the template, then updates all other variants.
 */
export async function syncVariantToTemplate(instructionName: string, toolId: string): Promise<void> {
    const lockKey = `${instructionName}:${toolId}`;
    if (syncLocks.has(lockKey) || instructionSyncInProgress.has(instructionName)) return;

    syncLocks.add(lockKey);
    instructionSyncInProgress.add(instructionName);

    try {
        const templatePath = path.join(TEMPLATES_STORE, instructionName);
        const variantPath = path.join(VARIANTS_STORE, instructionName, toolId);

        if (!fs.existsSync(templatePath) || !fs.existsSync(variantPath)) return;

        manager.log.info(`[CopilotBoot] [${instructionName}] Syncing ${toolId} variant -> template`);

        // 1. Sync Variant -> Template
        if (handlers[toolId]) {
            await handlers[toolId].syncVariantToSource(variantPath, templatePath);
        }

        // 2. Fan-out: Sync Template -> All OTHER Variants
        // This will update other tool folders under TEMPLATES_STORE/instructionName
        await syncTemplateToVariants(instructionName, toolId);

    } catch (err) {
        manager.log.error(`[CopilotBoot] [${instructionName}] Sync back failed for ${toolId}: ${err}`);
    } finally {
        // Keep the instruction lock for a short cooldown to swallow secondary watcher events
        setTimeout(() => {
            instructionSyncInProgress.delete(instructionName);
            syncLocks.delete(lockKey);
        }, 1000);
    }
}

/**
 * Syncs the template to all tool variants for this instruction.
 * Optionally skip one tool (the one that just synced back).
 */
export async function syncTemplateToVariants(instructionName: string, skipToolId?: string): Promise<void> {
    const templatePath = path.join(TEMPLATES_STORE, instructionName);
    if (!fs.existsSync(templatePath)) return;

    const variantRoot = path.join(VARIANTS_STORE, instructionName);
    if (!fs.existsSync(variantRoot)) return;

    const toolIds = fs.readdirSync(variantRoot).filter(d => fs.lstatSync(path.join(variantRoot, d)).isDirectory());

    for (const toolId of toolIds) {
        if (toolId === skipToolId) continue;
        if (handlers[toolId]) {
            const variantPath = path.join(variantRoot, toolId);
            manager.log.info(`[CopilotBoot] [${instructionName}] Fanning out: template -> ${toolId}`);
            await handlers[toolId].syncSourceToVariant(templatePath, variantPath);
        }
    }
}

/**
 * Wrapper for template-to-variants
 */
export async function syncInstruction(instructionName: string, direction: 'v2s' | 's2v' = 'v2s'): Promise<void> {
    if (direction === 's2v') {
        await syncTemplateToVariants(instructionName);
    }
}

export function watchVariant(instructionName: string) {
    const watchTarget = path.join(VARIANTS_STORE, instructionName);
    if (!fs.existsSync(watchTarget)) {
        manager.log.warn(`[CopilotBoot] Watch target does not exist: ${watchTarget}`);
        return null;
    }

    manager.log.info(`[CopilotBoot] Monitoring instruction for changes: ${instructionName}`);

    return fs.watch(watchTarget, { recursive: true }, (event, filename) => {
        if (!filename || filename.includes('.git') || filename.endsWith('~')) return;

        // Path is toolId/...
        const parts = filename.split(path.sep);
        const toolId = parts[0];

        // If we're already syncing this instruction, ignore events (especially from our own writes)
        if (instructionSyncInProgress.has(instructionName)) return;

        const debounceKey = `${instructionName}:${toolId}`;
        const existingTimeout = debounceTimeouts.get(debounceKey);
        if (existingTimeout) clearTimeout(existingTimeout);

        const newTimeout = setTimeout(async () => {
            await syncVariantToTemplate(instructionName, toolId);
            debounceTimeouts.delete(debounceKey);
        }, 500);

        debounceTimeouts.set(debounceKey, newTimeout);
    });
}