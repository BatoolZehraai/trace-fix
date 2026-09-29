# TraceFix

> **Targeted 1-Click AI Error Diagnostic & Auto-Fix Tool for Developers**  
> Explains errors in plain English / Roman Urdu, visualizes execution flow, and fixes code directly with Copilot-style Light Bulb and Terminal integration. Powered by **Google Gemini AI**.

---

## Why TraceFix?

Debugging cryptic error logs and long stack traces wastes valuable development time. **TraceFix** brings instant, jargon-free resolution right inside VS Code:

- ** Copilot-Style Light Bulb QuickFix:** Press `Ctrl + .` on any error line to fix that line directly, or click **"⚡ Fix All Errors in This File"** to resolve all syntax, typing, casing, and logic issues across the entire file at once.
- ** Terminal Right-Click Solve:** Highlight any stack trace or error log in the VS Code terminal, right-click, and select **"Fix with TraceFix"** or **"Fix All Errors in File"** to immediately repair the source code without annoying prompts.
- **🔍 Dedicated Visual Diagnostic Panel:** Right-click and choose **"Explain & Fix Trace"** to open a clean side panel featuring:
  1. **What Happened (Simple Words):** A clear, ELI5 explanation of the root cause without confusing technical jargon.
  2. **Trace Path:** A visual step-by-step path (`File A -> File B -> Crash Point`) charting the execution flow leading up to the failure.
  3. **The Fix:** Actionable guidance with a direct **"Apply Fix"** button and copyable code snippet.
- ** Autonomous Multi-Model Resilience:** Built-in automatic cascading fallback (`gemini-3.5-flash-lite`, `gemini-3.5-flash`, `gemini-3.7-flash`, `gemini-3.8-flash`) ensures that temporary rate limits or spikes on one model never disrupt your workflow.
- ** Clean & Vector-Crafted:** Strictly zero emojis, built with crisp SVG vector icons styled natively to match your active VS Code theme.

---

## Features & Usage

### 1. Light Bulb QuickFix (Editor)
Place your cursor on any red squiggly or syntax error and press `Ctrl + .` (or click the light bulb `💡`):
- **`Fix with TraceFix: [error description]`** - Automatically replaces and repairs the error line in-place.
- **`Fix All Errors in This File (TraceFix)`** - Resolves every bug, casing mistake, and runtime issue in the active document simultaneously.
- **`Explain & Fix Trace (TraceFix)`** - Opens the side-by-side diagnostic breakdown.

### 2. Terminal Right-Click Direct Fix
When an exception occurs in your terminal (Python, Node.js, Go, Rust, Java, etc.):
1. Select the error log or traceback with your mouse.
2. Right-click and choose **`Fix with TraceFix`** or **`Fix All Errors in File (TraceFix)`**.
3. TraceFix locates the source file, corrects the code, highlights the fixed line with a subtle glow, and saves the file automatically.

### 3. Undo Support & Safety
Every applied fix includes an instant **`Undo`** button in the notification popup, allowing you to revert changes with a single click.

---

## Setup & Configuration

### Getting a Gemini API Key
TraceFix connects directly to Google Gemini AI via your own API key (free tier available):
1. Get your free API key at [Google AI Studio](https://aistudio.google.com/app/apikey).
2. TraceFix will automatically prompt you on your first run, or you can open VS Code Settings (`Ctrl + ,`), search for `TraceFix: Api Key`, and paste your key.

### Extension Settings

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `traceFix.apiKey` | `string` (masked) | `""` | Google Gemini API key used for diagnostics. |
| `traceFix.model` | `string` | `"gemini-3.5-flash-lite"` | Primary model for diagnostics (with auto-fallback to available models). |

---
