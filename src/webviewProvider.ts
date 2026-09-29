import * as vscode from "vscode";
import { DiagnosticResult, TargetLocation } from "./geminiService";

export class TraceFixWebview {
  public static currentPanel: vscode.WebviewPanel | undefined;
  private static readonly viewType = "traceFixWebview";

  public static show(
    extensionUri: vscode.Uri,
    result: DiagnosticResult,
    originalTrace: string,
    onApplyFix?: (target: TargetLocation | undefined, fixCode: string) => Promise<boolean>,
    onFixAllErrors?: (target: TargetLocation | undefined) => Promise<boolean>,
    onReanalyze?: () => void
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (TraceFixWebview.currentPanel) {
      TraceFixWebview.currentPanel.reveal(column);
      TraceFixWebview.currentPanel.webview.html = TraceFixWebview.getHtmlForWebview(
        TraceFixWebview.currentPanel.webview,
        result,
        originalTrace
      );
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      TraceFixWebview.viewType,
      "TraceFix: AI Diagnosis & Fix",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    TraceFixWebview.currentPanel = panel;

    panel.webview.html = TraceFixWebview.getHtmlForWebview(
      panel.webview,
      result,
      originalTrace
    );

    panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "copyCode": {
            await vscode.env.clipboard.writeText(message.text);
            vscode.window.showInformationMessage("TraceFix: Fix code copied to clipboard!");
            break;
          }
          case "copyAll": {
            await vscode.env.clipboard.writeText(message.text);
            vscode.window.showInformationMessage("TraceFix: Full diagnostic report copied to clipboard!");
            break;
          }
          case "applyFix": {
            if (onApplyFix) {
              const success = await onApplyFix(message.target, message.fixCode);
              if (success) {
                panel.webview.postMessage({ command: "fixApplied" });
              }
            }
            break;
          }
          case "fixAllErrors": {
            if (onFixAllErrors) {
              const success = await onFixAllErrors(message.target);
              if (success) {
                panel.webview.postMessage({ command: "allFixed" });
              }
            }
            break;
          }
          case "reanalyze": {
            if (onReanalyze) {
              onReanalyze();
            }
            break;
          }
        }
      },
      undefined
    );

    panel.onDidDispose(() => {
      TraceFixWebview.currentPanel = undefined;
    });
  }

  private static escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  private static stripEmojis(text: string): string {
    return text
      .replace(
        /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/gu,
        ""
      )
      .trim();
  }

  private static formatMarkdown(md: string): string {
    const cleaned = TraceFixWebview.stripEmojis(md);

    // Process code blocks first
    const codeBlocks: string[] = [];
    let processed = cleaned.replace(/```([a-zA-Z0-9_\-+]*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
      const index = codeBlocks.length;
      const escapedCode = TraceFixWebview.escapeHtml(code.trim());
      const rawCode = TraceFixWebview.escapeHtml(code.trim());
      const langLabel = lang ? `<span class="code-lang">${TraceFixWebview.escapeHtml(lang)}</span>` : "";
      codeBlocks.push(`
        <div class="code-container">
          <div class="code-header">
            ${langLabel}
            <button class="copy-snippet-btn" data-code="${rawCode}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span>Copy</span>
            </button>
          </div>
          <pre class="code-block"><code>${escapedCode}</code></pre>
        </div>
      `);
      return `__CODE_BLOCK_${index}__`;
    });

    // Inline formatting
    processed = TraceFixWebview.escapeHtml(processed);
    processed = processed.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    processed = processed.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    processed = processed.replace(/`([^`]+)`/g, "<code class='inline-code'>$1</code>");

    // Replace arrow representations with styled vector arrow icon
    const arrowSvg = `<span class="trace-arrow"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg></span>`;
    processed = processed.replace(/(?:➡️|-&gt;|->|-->|=>|➔)/g, arrowSvg);

    // Convert line breaks and paragraphs
    const paragraphs = processed.split(/\n\s*\n/).map((p) => {
      const trimmed = p.trim();
      if (!trimmed) {
        return "";
      }
      if (trimmed.startsWith("__CODE_BLOCK_")) {
        return trimmed;
      }
      return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    });

    processed = paragraphs.join("\n");

    // Reinsert code blocks
    codeBlocks.forEach((block, index) => {
      processed = processed.replace(`__CODE_BLOCK_${index}__`, block);
    });

    return processed;
  }

  private static getHtmlForWebview(
    webview: vscode.Webview,
    result: DiagnosticResult,
    originalTrace: string
  ): string {
    const nonce = Math.random().toString(36).substring(2, 15);

    const formattedWhatHappened = TraceFixWebview.formatMarkdown(result.whatHappened);
    const formattedTracePath = TraceFixWebview.formatMarkdown(result.tracePath);
    const formattedTheFix = TraceFixWebview.formatMarkdown(result.theFix);
    const escapedTrace = TraceFixWebview.escapeHtml(originalTrace);
    const rawFixCode = TraceFixWebview.escapeHtml(result.fixCode);

    const targetLabel = result.target?.fileName
      ? ` to ${result.target.fileName}${result.target.line ? " (Line " + result.target.line + ")" : ""}`
      : " to File";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>TraceFix Diagnostic</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #cccccc);
      --card-bg: var(--vscode-editorWidget-background, #252526);
      --card-border: var(--vscode-widget-border, #3c3c3c);
      --code-bg: var(--vscode-textCodeBlock-background, #181818);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --accent-blue: #4fc1ff;
      --accent-green: #4ec9b0;
      --accent-amber: #dcdcaa;
      --radius: 8px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
      font-size: 13.5px;
      line-height: 1.6;
      padding: 20px 24px 60px 24px;
      max-width: 900px;
      margin: 0 auto;
    }

    /* Top Hero Header */
    .hero-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 16px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 24px;
    }

    .title-group {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-badge {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: var(--radius);
      background: linear-gradient(135deg, #007acc, #4fc1ff);
      color: #ffffff;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    }

    .app-title {
      font-size: 19px;
      font-weight: 700;
      color: var(--vscode-editor-foreground);
      letter-spacing: -0.2px;
    }

    .app-subtitle {
      font-size: 11.5px;
      opacity: 0.7;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .header-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 14px;
      border-radius: 5px;
      border: 1px solid transparent;
      font-size: 12.5px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease-in-out;
      user-select: none;
    }

    .btn-sm {
      padding: 4px 10px;
      font-size: 11.5px;
    }

    .btn svg {
      flex-shrink: 0;
    }

    .btn-apply {
      background: #2e7d32;
      color: #ffffff;
      font-weight: 600;
    }

    .btn-apply:hover {
      background: #1b5e20;
      box-shadow: 0 2px 8px rgba(46, 125, 50, 0.4);
    }

    .btn-apply-all {
      background: linear-gradient(135deg, #007acc, #0e639c);
      color: #ffffff;
      font-weight: 600;
      border: 1px solid rgba(79, 193, 255, 0.35);
    }

    .btn-apply-all:hover {
      background: linear-gradient(135deg, #1177bb, #007acc);
      box-shadow: 0 2px 8px rgba(0, 122, 204, 0.4);
    }

    .btn-primary {
      background: var(--btn-bg);
      color: var(--btn-fg);
    }

    .btn-primary:hover {
      background: var(--btn-hover);
      box-shadow: 0 2px 6px rgba(0,0,0,0.2);
    }

    .btn-secondary {
      background: transparent;
      color: var(--fg);
      border-color: var(--card-border);
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.06);
    }

    .btn-success {
      background: #1b5e20 !important;
      color: #ffffff !important;
    }

    /* Cards */
    .diagnostic-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      margin-bottom: 20px;
      overflow: hidden;
      box-shadow: 0 2px 6px rgba(0,0,0,0.15);
      transition: border-color 0.2s;
    }

    .diagnostic-card:hover {
      border-color: rgba(255,255,255,0.2);
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 18px;
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid var(--card-border);
    }

    .card-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 14px;
      font-weight: 600;
    }

    .card-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .section-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.05);
    }

    .icon-amber {
      color: #cca700;
      background: rgba(204, 167, 0, 0.12);
    }

    .icon-blue {
      color: #4fc1ff;
      background: rgba(79, 193, 255, 0.12);
    }

    .icon-green {
      color: #4ec9b0;
      background: rgba(78, 201, 176, 0.12);
    }

    .card-body {
      padding: 18px 20px;
    }

    /* Section specifics */
    .card-what-happened {
      border-left: 4px solid #cca700;
    }

    .card-what-happened .card-body p {
      font-size: 14px;
      line-height: 1.65;
      font-weight: 450;
    }

    .card-trace-path {
      border-left: 4px solid #4fc1ff;
    }

    .trace-flow-container {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .trace-arrow {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--accent-blue);
      margin: 0 6px;
      vertical-align: middle;
    }

    .card-the-fix {
      border-left: 4px solid #4ec9b0;
    }

    /* Code styling */
    .code-container {
      position: relative;
      background: var(--code-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      margin: 14px 0 6px 0;
      overflow: hidden;
    }

    .code-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      background: rgba(0, 0, 0, 0.25);
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      font-size: 11.5px;
    }

    .code-lang {
      text-transform: uppercase;
      opacity: 0.7;
      font-weight: 600;
      letter-spacing: 0.5px;
    }

    .copy-snippet-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      font-size: 11px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--fg);
      border: none;
      cursor: pointer;
      transition: background 0.15s;
    }

    .copy-snippet-btn:hover {
      background: rgba(255, 255, 255, 0.16);
    }

    pre.code-block {
      padding: 14px 16px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family, "Consolas", "Courier New", monospace);
      font-size: 12.5px;
      line-height: 1.5;
    }

    code.inline-code {
      background: rgba(255, 255, 255, 0.08);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family, "Consolas", "Courier New", monospace);
      font-size: 12px;
      color: #9cdcfe;
    }

    /* Collapsible Original Trace */
    details.original-trace-accordion {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      margin-top: 24px;
      overflow: hidden;
    }

    details.original-trace-accordion summary {
      padding: 12px 18px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      user-select: none;
      opacity: 0.85;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    details.original-trace-accordion summary:hover {
      opacity: 1;
      background: rgba(255, 255, 255, 0.02);
    }

    .summary-title {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .original-trace-content {
      padding: 14px 18px;
      border-top: 1px solid var(--card-border);
      background: var(--code-bg);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 250px;
      overflow-y: auto;
      color: #888888;
    }

    /* Footer Note */
    .footer-note {
      text-align: center;
      margin-top: 24px;
      font-size: 11.5px;
      opacity: 0.5;
    }
  </style>
</head>
<body>
  <!-- Header Bar -->
  <header class="hero-header">
    <div class="title-group">
      <div class="logo-badge">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
        </svg>
      </div>
      <div>
        <div class="app-title">TraceFix</div>
        <div class="app-subtitle">AI Error Diagnostic & Fix</div>
      </div>
    </div>
    <div class="header-actions">
      ${
        rawFixCode
          ? `<button id="btn-apply-fix" class="btn btn-apply" title="Directly replace the error line in the source file">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
              </svg>
              <span id="btn-apply-text">Apply Fix${targetLabel}</span>
            </button>`
          : ""
      }
      <button id="btn-fix-all" class="btn btn-apply-all" title="Resolve all errors, bugs, and syntax issues across this entire file at once">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
        </svg>
        <span id="btn-fix-all-text">⚡ Fix All Errors in File</span>
      </button>
      ${
        rawFixCode
          ? `<button id="btn-copy-fix-main" class="btn btn-secondary" title="Copy the code fix snippet">
              <svg id="icon-copy-main" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span id="btn-copy-text">Copy Fix Code</span>
            </button>`
          : ""
      }
      <button id="btn-copy-all" class="btn btn-secondary" title="Copy full report as markdown">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
        </svg>
        <span>Copy Report</span>
      </button>
      <button id="btn-reanalyze" class="btn btn-secondary" title="Analyze another error">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10"></polyline>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
        </svg>
        <span>Analyze Another</span>
      </button>
    </div>
  </header>

  <!-- Section 1: What Happened -->
  <section class="diagnostic-card card-what-happened">
    <div class="card-header">
      <div class="card-title">
        <span class="section-icon icon-amber">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
        </span>
        <span>What Happened (Simple Words)</span>
      </div>
    </div>
    <div class="card-body">
      ${formattedWhatHappened || "<p>Analysis complete.</p>"}
    </div>
  </section>

  <!-- Section 2: Trace Path -->
  <section class="diagnostic-card card-trace-path">
    <div class="card-header">
      <div class="card-title">
        <span class="section-icon icon-blue">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="6" y1="3" x2="6" y2="15"></line>
            <circle cx="18" cy="6" r="3"></circle>
            <circle cx="6" cy="18" r="3"></circle>
            <path d="M18 9a9 9 0 0 1-9 9"></path>
          </svg>
        </span>
        <span>Trace Path</span>
      </div>
    </div>
    <div class="card-body trace-flow-container">
      ${formattedTracePath || "<p>Direct error occurrence.</p>"}
    </div>
  </section>

  <!-- Section 3: The Fix -->
  <section class="diagnostic-card card-the-fix">
    <div class="card-header">
      <div class="card-title">
        <span class="section-icon icon-green">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="16 18 22 12 16 6"></polyline>
            <polyline points="8 6 2 12 8 18"></polyline>
          </svg>
        </span>
        <span>The Fix</span>
      </div>
      <div class="card-actions">
        ${
          rawFixCode
            ? `<button id="btn-card-apply-fix" class="btn btn-apply btn-sm">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
                </svg>
                <span>Apply Fix</span>
              </button>
              <button class="btn btn-primary btn-sm copy-snippet-btn" data-code="${rawFixCode}">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                <span>Copy Code</span>
              </button>`
            : ""
        }
      </div>
    </div>
    <div class="card-body">
      ${formattedTheFix}
    </div>
  </section>

  <!-- Collapsible Original Stack Trace -->
  <details class="original-trace-accordion">
    <summary>
      <div class="summary-title">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="4 17 10 11 4 5"></polyline>
          <line x1="12" y1="19" x2="20" y2="19"></line>
        </svg>
        <span>Original Stack Trace / Error Log</span>
      </div>
      <span style="font-size: 11px; opacity: 0.6;">(Click to expand)</span>
    </summary>
    <div class="original-trace-content">${escapedTrace}</div>
  </details>

  <footer class="footer-note">
    TraceFix &bull; Powered by Google Gemini AI &bull; Ready to paste into your codebase
  </footer>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const checkSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    const copySvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';

    // Apply Single Line Fix
    function sendApplyFix() {
      const code = ${JSON.stringify(result.fixCode)};
      const target = ${JSON.stringify(result.target)};
      vscode.postMessage({ command: 'applyFix', fixCode: code, target: target });
    }

    const applyMainBtn = document.getElementById('btn-apply-fix');
    if (applyMainBtn) {
      applyMainBtn.addEventListener('click', sendApplyFix);
    }

    const applyCardBtn = document.getElementById('btn-card-apply-fix');
    if (applyCardBtn) {
      applyCardBtn.addEventListener('click', sendApplyFix);
    }

    // Fix All Errors in File Button
    const fixAllBtn = document.getElementById('btn-fix-all');
    if (fixAllBtn) {
      fixAllBtn.addEventListener('click', () => {
        const target = ${JSON.stringify(result.target)};
        const originalText = fixAllBtn.innerHTML;
        fixAllBtn.innerHTML = '<span>Fixing All Errors...</span>';
        vscode.postMessage({ command: 'fixAllErrors', target: target });
      });
    }

    // Handle messages back from extension
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.command === 'fixApplied') {
        if (applyMainBtn) {
          applyMainBtn.classList.add('btn-success');
          applyMainBtn.innerHTML = checkSvg + '<span>Applied to File!</span>';
        }
        if (applyCardBtn) {
          applyCardBtn.classList.add('btn-success');
          applyCardBtn.innerHTML = checkSvg + '<span>Applied!</span>';
        }
      } else if (message.command === 'allFixed') {
        if (fixAllBtn) {
          fixAllBtn.classList.add('btn-success');
          fixAllBtn.innerHTML = checkSvg + '<span>All Errors Fixed!</span>';
        }
      }
    });

    // Copy Fix Code hero button
    const copyMainBtn = document.getElementById('btn-copy-fix-main');
    const copyTextSpan = document.getElementById('btn-copy-text');
    if (copyMainBtn) {
      copyMainBtn.addEventListener('click', () => {
        const code = ${JSON.stringify(result.fixCode)};
        vscode.postMessage({ command: 'copyCode', text: code });
        if (copyTextSpan) {
          const original = copyTextSpan.innerText;
          copyTextSpan.innerText = 'Copied';
          copyMainBtn.classList.add('btn-success');
          copyMainBtn.innerHTML = checkSvg + '<span>Copied</span>';
          setTimeout(() => {
            copyMainBtn.innerHTML = copySvg + '<span id="btn-copy-text">' + original + '</span>';
            copyMainBtn.classList.remove('btn-success');
          }, 2000);
        }
      });
    }

    // Copy All Report button
    const copyAllBtn = document.getElementById('btn-copy-all');
    if (copyAllBtn) {
      copyAllBtn.addEventListener('click', () => {
        const fullMarkdown = ${JSON.stringify(result.rawMarkdown)};
        vscode.postMessage({ command: 'copyAll', text: fullMarkdown });
      });
    }

    // Re-analyze button
    const reanalyzeBtn = document.getElementById('btn-reanalyze');
    if (reanalyzeBtn) {
      reanalyzeBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'reanalyze' });
      });
    }

    // Individual code block copy buttons
    document.querySelectorAll('.copy-snippet-btn').forEach(button => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const code = button.getAttribute('data-code');
        if (code) {
          vscode.postMessage({ command: 'copyCode', text: code });
          const textSpan = button.querySelector('span');
          if (textSpan) {
            const original = textSpan.innerText;
            textSpan.innerText = 'Copied';
            setTimeout(() => {
              textSpan.innerText = original;
            }, 1800);
          }
        }
      });
    });
  </script>
</body>
</html>`;
  }
}
