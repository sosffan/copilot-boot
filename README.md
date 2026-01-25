# Copilot Boot

**One source of truth for your AI instructions. Initialize, sync, and share custom rules across GitHub Copilot, Cline, Kilo, and Cursor.**

---

## 🚀 Overview

**Copilot Boot** is the ultimate bootstrap tool for your AI coding assistants. 

Stop copy-pasting your project rules, coding standards, and architectural guidelines into every new project. **Copilot Boot** allows you to define your AI "personality" and technical requirements once, then instantly "boot" them into any project or workspace.

While it starts with Copilot, it is designed for the modern AI ecosystem. It creates a unified bridge so your custom instructions work seamlessly across **Cline, Kilo, Cursor**, and more.

---

## ✨ Key Features

* **Zero-Config Init**: Run one command to generate standardized instruction files (`.github/copilot-instructions.md`, `CLAUDE.md`, `.cursorrules`) based on your global preferences.
* **Unified Ruleset**: Maintain a single "Source of Truth" file. **Copilot Boot** automatically syncs changes to all supported AI agent config files.
* **Skill Provisioning**: Easily inject specific "Skills" or API contexts into agents like Cline and Kilo without manual setup.
* **Cross-Tool Support**: 
    * **GitHub Copilot**: Custom instruction files and prompt templates.
    * **Cline / Kilo**: Autonomous agent instructions and tool definitions.
    * **Cursor**: `.cursorrules` and `.mdc` context management.

---

## 🛠 How It Works

1.  **Define**: Create your master instruction profile (Global or Team-level).
2.  **Boot**: Run `Copilot Boot: Initialize Project` via the VS Code Command Palette.
3.  **Sync**: As you update your rules, the extension pushes those updates to all local AI configuration files instantly.

---

## 📖 Why "Boot"?

Just like a computer needs a bootloader to start up correctly, your AI needs a "Rule Loader" to understand your code's specific context. **Copilot Boot** ensures your AI assistants are fully briefed and ready to code the moment you open your editor.

---

## 📂 Supported Files

Copilot Boot manages and synchronizes the following (and more):
* `.github/copilot-instructions.md` (GitHub Copilot)
* `CLAUDE.md` (Claude Dev / Cline)
* `.cursorrules` (Cursor)
* `.kilo/rules` (Kilo)

---

## 📝 Release Notes

### 1.0.0
Initial release of **Copilot Boot**.
* Support for **GitHub Copilot** custom instructions.
* Support for **Cline (CLAUDE.md)** and **Cursor (.cursorrules)**.
* Core "Init" engine to bootstrap project-specific rules.
* Global configuration sync across multiple workspaces.
