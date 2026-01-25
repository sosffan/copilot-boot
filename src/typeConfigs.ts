import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type TypeMapping = {
    sourceDir: string;
    destDir?: string;
    destPattern?: string;
};

export type TypeConfig = {
    id: string;
    displayName: string;
    root: string; // root folder under workspace variant
    mappings: TypeMapping[];
};

// Load built-in config from extension folder, allow override from ~/.copilotboot/types/{id}.json
export async function loadTypeConfig(typeId: string): Promise<TypeConfig | null> {
    const builtIn = path.join(__dirname, 'type-config', `${typeId}.json`);
    let config: TypeConfig | null = null;
    try {
        const raw = await fs.promises.readFile(builtIn, 'utf8');
        config = JSON.parse(raw) as TypeConfig;
    } catch (err) {
        // no built-in
    }
    // user override
    const userCfg = path.join(os.homedir(), '.copilotboot', 'types', `${typeId}.json`);
    try {
        const rawu = await fs.promises.readFile(userCfg, 'utf8');
        const userConf = JSON.parse(rawu) as Partial<TypeConfig>;
        if (!config) config = userConf as TypeConfig;
        else config = { ...config, ...userConf, mappings: userConf.mappings ?? config.mappings } as TypeConfig;
    } catch (err) {
        // ignore
    }
    return config;
}

export async function listAvailableTypes(): Promise<string[]> {
    const dir = path.join(__dirname, 'type-config');
    try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        return entries.filter(e => e.isFile()).map(e => path.parse(e.name).name);
    } catch (err) {
        return [];
    }
}

function replaceVars(tpl: string, vars: Record<string, string>) {
    return tpl.replace(/\$\{([^}]+)\}/g, (_, k) => vars[k] ?? '');
}

// Convert source template into type-specific variant according to config
export async function convertTemplate(sourceBase: string, variantRoot: string, typeId: string): Promise<string> {
    const cfg = await loadTypeConfig(typeId);
    if (!cfg) throw new Error(`Type config not found: ${typeId}`);
    const root = cfg.root;
    const destRoot = path.join(variantRoot, root);
    // ensure base
    await fs.promises.mkdir(destRoot, { recursive: true });
    const vars = { root };
    // apply mappings
    for (const m of cfg.mappings) {
        const srcDir = path.join(sourceBase, m.sourceDir);
        try {
            const entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
            for (const e of entries) {
                const srcPath = path.join(srcDir, e.name);
                if (e.isDirectory()) {
                    // copy directory recursively into destDir if destDir specified
                    if (m.destDir) {
                        const destDirResolved = replaceVars(m.destDir, vars);
                        const destFull = path.join(variantRoot, destDirResolved);
                        await copyRecursive(srcPath, path.join(destFull, e.name));
                    } else if (m.destPattern) {
                        // not handling directory->pattern
                    }
                } else if (e.isFile()) {
                    if (m.destPattern) {
                        const baseName = path.parse(e.name).name;
                        // Avoid duplicating '.instruction.md' when source file already has that suffix
                        let adjustedBase = baseName;
                        if (m.destPattern.includes('.instruction.md') && e.name.endsWith('.instruction.md')) {
                            adjustedBase = baseName.replace(/\.instruction$/i, '');
                        }
                        const destRel = replaceVars(m.destPattern, { ...vars, basename: adjustedBase });
                        const destFull = path.join(variantRoot, destRel);
                        await fs.promises.mkdir(path.dirname(destFull), { recursive: true });
                        await fs.promises.copyFile(srcPath, destFull);
                    } else if (m.destDir) {
                        const destDirResolved = replaceVars(m.destDir, vars);
                        const destFull = path.join(variantRoot, destDirResolved, e.name);
                        await fs.promises.mkdir(path.dirname(destFull), { recursive: true });
                        await fs.promises.copyFile(srcPath, destFull);
                    } else {
                        // default: copy into destRoot preserving relative under sourceBase
                        const rel = path.relative(sourceBase, srcPath);
                        const destFull = path.join(destRoot, rel);
                        await fs.promises.mkdir(path.dirname(destFull), { recursive: true });
                        await fs.promises.copyFile(srcPath, destFull);
                    }
                }
            }
        } catch (err) {
            // ignore missing source dir
        }
    }
    // also copy any top-level files not covered by mappings into destRoot (e.g., description.md)
    try {
        const topEntries = await fs.promises.readdir(sourceBase, { withFileTypes: true });
        for (const e of topEntries) {
            if (e.isFile()) {
                const name = e.name;
                // skip if already copied (e.g., description.md) - just copy
                const srcPath = path.join(sourceBase, name);
                const destFull = path.join(destRoot, name);
                await fs.promises.copyFile(srcPath, destFull).catch(() => {});
            }
        }
    } catch (err) {
        // ignore
    }
    return destRoot;
}

// simple recursive copy used by converter
export async function copyRecursive(src: string, dest: string) {
    const stat = await fs.promises.stat(src);
    if (stat.isDirectory()) {
        await fs.promises.mkdir(dest, { recursive: true });
        const entries = await fs.promises.readdir(src, { withFileTypes: true });
        for (const e of entries) {
            const srcPath = path.join(src, e.name);
            const destPath = path.join(dest, e.name);
            if (e.isDirectory()) {
                await copyRecursive(srcPath, destPath);
            } else if (e.isSymbolicLink()) {
                // skip symlinks
            } else {
                await fs.promises.copyFile(srcPath, destPath);
            }
        }
    } else {
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.copyFile(src, dest);
    }
}
