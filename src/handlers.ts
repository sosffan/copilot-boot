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

export const handlers: Record<string, InstructionHandler> = {
    'githubcopilot': {
        id: 'githubcopilot',
        async syncSourceToVariant(sourceBase, variantPath) {
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
            // Skills could be handled similarly or symlinked
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

    'kilo': {
        id: 'kilo',
        async syncSourceToVariant(sourceBase, variantPath) {
            const kiloRulesDir = path.join(variantPath, '.kilorules');
            if (!fs.existsSync(kiloRulesDir)) fs.mkdirSync(kiloRulesDir, { recursive: true });
            
            // Kilo uses a nested structure; we can recursively copy the whole source
            copyFolderSync(sourceBase, kiloRulesDir);
        },
        async syncVariantToSource(variantPath, sourceBase) {
            const kiloRulesDir = path.join(variantPath, '.kilorules');
            if (fs.existsSync(kiloRulesDir)) {
                copyFolderSync(kiloRulesDir, sourceBase);
            }
        }
    }
};

/**
 * Helper to recursively copy directories for tools like Kilo 
 * that don't require filename transformations.
 */
function copyFolderSync(from: string, to: string) {
    if (!fs.existsSync(to)) fs.mkdirSync(to, { recursive: true });
    fs.readdirSync(from).forEach(element => {
        if (element === 'workspace') return; // Avoid recursive loops
        const stat = fs.lstatSync(path.join(from, element));
        if (stat.isFile()) {
            fs.copyFileSync(path.join(from, element), path.join(to, element));
        } else if (stat.isDirectory()) {
            copyFolderSync(path.join(from, element), path.join(to, element));
        }
    });
}