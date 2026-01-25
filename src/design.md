This update transforms the system into a **Configuration-Driven Architecture**. Instead of hardcoding tools like "Kilo" or "Cline," the system now dynamically generates the UI and sync logic based on JSON definitions.

---

## 🤖 Enhanced System Specification (v2.0)

### 1. Data Definitions & Metadata

* **Metadata Store (`description.md`):** Every instruction set folder contains a mandatory `description.md`.
* **Logic:** On creation, the user provides an optional summary. On the UI list, this content is served via a **Hover Tooltip** or an expandable "info" chevron.


* **Dynamic Type Registry (`src/type-config/`):** * The system scans this directory for `{id}.json` files.
* **Display Logic:** UI dropdowns populate via `$.displayName`.
* **Mapping Logic:** Defines how `sourceDir` (Master) maps to `destDir` (Project), including variable substitution for `${root}`.



### 2. Dependency Injection & Mapping

* **Granular Composition:** Users no longer sync "Kilo" as a block. They select specific **sub-modules** (e.g., only Rules and Prompts).
* **Source:** Defined in `$.mappings[*].name` within the tool configuration file.

---

## 🧠 Enhanced Architectural Logic

### 1. The Dynamic Handler Engine

The hardcoded `handlers.ts` is replaced by a **Generic Tool Handler** that loads configurations at runtime.

**Link/Unlink Sequence (The "Clean Switch" Logic):**
To prevent file system conflicts when switching instructions:

1. **Identity Phase:** System identifies the `activeInstruction` from `globalState`.
2. **Destruction Phase:** * Read the `type-config` for the *previous* tool.
* Identify the `root` path in the project (e.g., `.kilocode`).
* **Unlink:** Recursively remove the symlink or junction at that root to ensure a clean slate.


3. **Construction Phase:**
* Create the new directory structure for the *new* tool.
* Execute symlink commands for the specific `mappings` selected by the user.



### 2. Creation & Scaffolding Logic

1. **Form Input:** Name + Description + Tool Type.
2. **Dynamic Options:** Once Tool Type is selected, the UI parses `kilo.json` and renders a checkbox list of `mappings`.
3. **Scaffolding:**
* Create `~/.copilotboot/{name}/description.md`.
* For each selected mapping (e.g., "Rules"), create the corresponding `sourceDir` (e.g., `rules/`) in the master folder.



---

## 🎨 Enhanced UI/UX Requirements

### 1. The Multi-Select Component

* **Component:** `vscode-checkbox-group` or a vertical list of `vscode-checkbox`.
* **State Management:** These checkboxes remain disabled until a "Tool Type" is selected. Upon selection, the JS fetches the JSON and populates the labels.

### 2. The Hover/Info System

* **Implementation:** Use the `title` attribute for a native browser tooltip, or a custom absolute-positioned `div` that renders the Markdown content of `description.md` when the user hovers over an instruction card.

### 3. Dynamic Configuration Registry

* **Registry Loader:** A utility function that reads the `src/type-config/` directory.
```typescript
interface ToolConfig {
    id: string;
    displayName: string;
    root: string;
    mappings: Array<{ name: string; sourceDir: string; destDir: string; }>;
}

```



---

## 📝 Updated Logical Flow (Markdown)

| Step | Action | Logic Detail |
| --- | --- | --- |
| **Step 1** | **Scan Configs** | `fs.readdirSync('src/type-config')` to build the Tool Selection list. |
| **Step 2** | **Form Build** | Reactively show `mappings[].name` as checkboxes based on selected Tool. |
| **Step 3** | **Unlink Previous** | Check `activeInstruction`. Remove the path defined in the old config's `root`. |
| **Step 4** | **Link New** | Map `~/.copilotboot/{name}/{sourceDir}` -> `{project}/{destDir}` for all checked mappings. |
| **Step 5** | **Watch** | Start `fs.watch` on the master folders to broadcast changes to the project symlinks. |

---

## 🚀 Next Step

This design is now significantly more powerful. **Would you like me to rewrite the `handlers.ts` logic to be "Configuration-Aware," so it can handle any JSON file you drop into the `type-config` folder?**