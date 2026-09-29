import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { GeminiService, TargetLocation, DiagnosticResult } from "./geminiService";
import { TraceFixWebview } from "./webviewProvider";

// Decoration for fixed lines (subtle green glow)
let fixPreviewDecorationType: vscode.TextEditorDecorationType;

/**
 * CodeActionProvider for VS Code's Light Bulb (Quick Fix) menu.
 * When an error occurs on a line, clicking the light bulb shows "Fix with TraceFix"
 * as well as "Fix All Errors in This File".
 */
class TraceFixCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const targetLine = range.start.line;

    const errorDiags = context.diagnostics.filter(
      (d) =>
        d.severity === vscode.DiagnosticSeverity.Error ||
        d.severity === vscode.DiagnosticSeverity.Warning
    );

    if (errorDiags.length > 0) {
      const shortMsg = errorDiags[0].message.split("\n")[0];
      const singleFixAction = new vscode.CodeAction(
        `Fix with TraceFix: ${shortMsg}`,
        vscode.CodeActionKind.QuickFix
      );
      singleFixAction.isPreferred = true;
      singleFixAction.command = {
        command: "trace-fix.applyQuickFixFromLightBulb",
        title: "Fix with TraceFix",
        arguments: [document, targetLine, errorDiags[0].message]
      };
      actions.push(singleFixAction);
    } else {
      const singleFixAction = new vscode.CodeAction(
        "Fix with TraceFix",
        vscode.CodeActionKind.QuickFix
      );
      singleFixAction.isPreferred = true;
      singleFixAction.command = {
        command: "trace-fix.applyQuickFixFromLightBulb",
        title: "Fix with TraceFix",
        arguments: [document, targetLine]
      };
      actions.push(singleFixAction);
    }

    // ⚡ Always provide option to Fix All Errors in File
    const fixAllAction = new vscode.CodeAction(
      "⚡ Fix All Errors in This File (TraceFix)",
      vscode.CodeActionKind.QuickFix
    );
    fixAllAction.command = {
      command: "trace-fix.fixAllErrorsInFile",
      title: "Fix All Errors in File",
      arguments: [{ filePath: document.fileName, fileName: path.basename(document.fileName) }]
    };
    actions.push(fixAllAction);

    // Explain & Fix Trace diagnostic action
    const explainAction = new vscode.CodeAction(
      "Explain & Fix Trace (TraceFix)",
      vscode.CodeActionKind.QuickFix
    );
    explainAction.command = {
      command: "trace-fix.explainTrace",
      title: "Explain & Fix Trace"
    };
    actions.push(explainAction);

    return actions;
  }
}

/**
 * Activates the TraceFix extension.
 */
export function activate(context: vscode.ExtensionContext) {
  fixPreviewDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgba(46, 125, 50, 0.28)",
    border: "1px solid rgba(78, 201, 176, 0.7)",
    borderRadius: "3px",
    isWholeLine: true,
    overviewRulerColor: "#4ec9b0",
    overviewRulerLane: vscode.OverviewRulerLane.Right
  });

  // Auto-configure terminal right-click to show context menu on Windows
  try {
    const termConfig = vscode.workspace.getConfiguration("terminal.integrated");
    if (termConfig.get<string>("rightClickBehavior") !== "default") {
      termConfig.update("rightClickBehavior", "default", vscode.ConfigurationTarget.Global);
    }
  } catch {
    // Ignore setting update failure
  }

  // 1. Light Bulb Quick Fix Command (Single Line)
  const lightBulbFixCommand = vscode.commands.registerCommand(
    "trace-fix.applyQuickFixFromLightBulb",
    async (document?: vscode.TextDocument, lineIndex?: number, errorMsg?: string) => {
      try {
        await executeLightBulbFix(context, document, lineIndex, errorMsg);
      } catch (error: any) {
        handleError(error);
      }
    }
  );

  // 2. Fix All Errors in File Command (Multi-error solver)
  const fixAllErrorsCommand = vscode.commands.registerCommand(
    "trace-fix.fixAllErrorsInFile",
    async (target?: TargetLocation) => {
      try {
        await executeFixAllFlow(context, target);
      } catch (error: any) {
        handleError(error);
      }
    }
  );

  // 3. Terminal & Editor Direct Fix Command
  const directFixTerminalCommand = vscode.commands.registerCommand(
    "trace-fix.directFixTerminalTrace",
    async () => {
      try {
        await executeDirectTerminalFix(context);
      } catch (error: any) {
        handleError(error);
      }
    }
  );

  // 4. Side Panel Explain Commands
  const explainTerminalCommand = vscode.commands.registerCommand(
    "trace-fix.explainTerminalTrace",
    async () => {
      try {
        await executeSidePanelDiagnostic(context);
      } catch (error: any) {
        handleError(error);
      }
    }
  );

  const explainTraceCommand = vscode.commands.registerCommand(
    "trace-fix.explainTrace",
    async () => {
      try {
        await executeSidePanelDiagnostic(context);
      } catch (error: any) {
        handleError(error);
      }
    }
  );

  // 5. Register Code Actions Provider for the Light Bulb on all files
  const codeActionProvider = vscode.languages.registerCodeActionsProvider(
    { scheme: "file" },
    new TraceFixCodeActionProvider(),
    {
      providedCodeActionKinds: TraceFixCodeActionProvider.providedCodeActionKinds
    }
  );

  context.subscriptions.push(
    lightBulbFixCommand,
    fixAllErrorsCommand,
    directFixTerminalCommand,
    explainTerminalCommand,
    explainTraceCommand,
    codeActionProvider,
    fixPreviewDecorationType
  );
}

/**
 * Fix All Errors in File Flow:
 * Solves all syntax, runtime, casing, type, and logic bugs across the entire file at once.
 */
async function executeFixAllFlow(
  context: vscode.ExtensionContext,
  target?: TargetLocation
): Promise<boolean> {
  const targetUri = await resolveTargetUri(target);
  if (!targetUri) {
    vscode.window.showWarningMessage("TraceFix: Could not find target file to fix.");
    return false;
  }

  const doc = await vscode.workspace.openTextDocument(targetUri);
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

  const fileContent = doc.getText();
  const fileName = path.basename(targetUri.fsPath);

  const apiKey = await getOrPromptApiKey();
  if (!apiKey) {
    return false;
  }

  const config = vscode.workspace.getConfiguration("traceFix");
  const modelName = config.get<string>("model") || "gemini-3.6-flash";

  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `TraceFix: Solving all errors in ${fileName} with Gemini AI...`,
      cancellable: false
    },
    async (progress) => {
      progress.report({ increment: 30, message: "Analyzing all bugs and type issues..." });
      const geminiService = new GeminiService(apiKey, modelName);

      const fixResult = await geminiService.fixAllErrorsInFile(
        fileContent,
        fileName,
        doc.languageId
      );
      progress.report({ increment: 50, message: "Applying full file fix..." });

      if (!fixResult.fixedCode || fixResult.fixedCode === fileContent) {
        vscode.window.showInformationMessage("TraceFix: No errors found in this file!");
        return false;
      }

      // Replace whole document content
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(fileContent.length)
      );

      const originalCode = fileContent;
      const success = await editor.edit((builder) => {
        builder.replace(fullRange, fixResult.fixedCode);
      });

      if (success) {
        await doc.save();
        editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);

        // Highlight
        editor.setDecorations(fixPreviewDecorationType, [
          new vscode.Range(0, 0, Math.min(25, doc.lineCount - 1), 0)
        ]);
        setTimeout(() => {
          editor.setDecorations(fixPreviewDecorationType, []);
        }, 3000);

        const count = fixResult.fixes.length;
        vscode.window
          .showInformationMessage(
            `TraceFix: Successfully fixed all ${count} issues in ${fileName}!`,
            "Undo",
            "View List of Fixes"
          )
          .then(async (choice) => {
            if (choice === "Undo") {
              const currentRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length)
              );
              await editor.edit((builder) => {
                builder.replace(currentRange, originalCode);
              });
              await doc.save();
              vscode.window.showInformationMessage("TraceFix: Reverted all changes.");
            } else if (choice === "View List of Fixes") {
              const items = fixResult.fixes.map((f, i) => ({
                label: `$(check) Fix #${i + 1}`,
                description: f
              }));
              await vscode.window.showQuickPick(items, {
                title: `TraceFix: ${count} Fixes Applied to ${fileName}`
              });
            }
          });
        return true;
      }
      return false;
    }
  );
}

/**
 * Light Bulb Fix: Called when the developer clicks the light bulb (💡) or presses Ctrl+.
 */
async function executeLightBulbFix(
  context: vscode.ExtensionContext,
  document?: vscode.TextDocument,
  lineIndex?: number,
  errorMsg?: string
) {
  const doc = document || vscode.window.activeTextEditor?.document;
  if (!doc) {
    return;
  }

  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  const targetLine = typeof lineIndex === "number" ? lineIndex : editor.selection.start.line;
  const currentLineText = doc.lineAt(targetLine).text;

  // Build error prompt from diagnostic or line context
  const traceText = `File "${doc.fileName}", line ${targetLine + 1}
    ${currentLineText.trim()}
${errorMsg || "SyntaxError or Runtime Error on this line"}`;

  const apiKey = await getOrPromptApiKey();
  if (!apiKey) {
    return;
  }

  const config = vscode.workspace.getConfiguration("traceFix");
  const modelName = config.get<string>("model") || "gemini-3.6-flash";

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "TraceFix: Fixing error with Gemini AI...",
      cancellable: false
    },
    async (progress) => {
      progress.report({ increment: 30, message: "Generating code fix..." });
      const geminiService = new GeminiService(apiKey, modelName);

      const fileContext = {
        fileName: doc.fileName,
        languageId: doc.languageId,
        fileSnippet: doc.getText(
          new vscode.Range(
            Math.max(0, targetLine - 8),
            0,
            Math.min(doc.lineCount - 1, targetLine + 8),
            120
          )
        )
      };

      const result = await geminiService.analyzeTrace(traceText, fileContext);
      progress.report({ increment: 60, message: "Applying fix..." });

      if (!result.fixCode) {
        vscode.window.showWarningMessage("TraceFix: Could not generate a replacement code snippet.");
        return;
      }

      // Replace the error line directly
      const lineRange = doc.lineAt(targetLine).range;
      const success = await editor.edit((builder) => {
        builder.replace(lineRange, result.fixCode);
      });

      if (success) {
        await doc.save();
        editor.revealRange(lineRange, vscode.TextEditorRevealType.InCenter);
        editor.setDecorations(fixPreviewDecorationType, [lineRange]);
        setTimeout(() => {
          editor.setDecorations(fixPreviewDecorationType, []);
        }, 3000);

        vscode.window
          .showInformationMessage(
            `TraceFix: Successfully fixed line ${targetLine + 1}!`,
            "Undo",
            "Fix All Errors in File"
          )
          .then(async (choice) => {
            if (choice === "Undo") {
              await vscode.commands.executeCommand("undo");
              vscode.window.showInformationMessage("TraceFix: Reverted change.");
            } else if (choice === "Fix All Errors in File") {
              await executeFixAllFlow(context, { filePath: doc.fileName, fileName: path.basename(doc.fileName) });
            }
          });
      }
    }
  );
}

/**
 * Terminal Direct Fix: Reads error from terminal, locates target file & line, applies fix directly.
 */
async function executeDirectTerminalFix(context: vscode.ExtensionContext) {
  let traceText = await getErrorTraceFromEnvironment();

  if (!traceText) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const choice = await vscode.window.showInformationMessage(
        `TraceFix: No error text selected in terminal. Fix errors in '${path.basename(editor.document.fileName)}'?`,
        "⚡ Fix All Errors in File",
        "Fix Current Line",
        "Paste Error Log"
      );
      if (choice === "⚡ Fix All Errors in File") {
        await executeFixAllFlow(context, { filePath: editor.document.fileName, fileName: path.basename(editor.document.fileName) });
        return;
      } else if (choice === "Fix Current Line") {
        await executeLightBulbFix(context, editor.document, editor.selection.start.line);
        return;
      } else if (choice === "Paste Error Log") {
        const input = await vscode.window.showInputBox({
          prompt: "Paste your error log or stack trace to auto-fix...",
          placeHolder: "e.g. File 'a.py', line 1: SyntaxError...",
          ignoreFocusOut: true
        });
        if (!input || !input.trim()) {
          return;
        }
        traceText = input.trim();
      } else {
        return;
      }
    } else {
      const input = await vscode.window.showInputBox({
        prompt: "Paste your error log or stack trace to auto-fix...",
        placeHolder: "e.g. File 'a.py', line 1: SyntaxError...",
        ignoreFocusOut: true
      });
      if (!input || !input.trim()) {
        return;
      }
      traceText = input.trim();
    }
  }

  const apiKey = await getOrPromptApiKey();
  if (!apiKey) {
    return;
  }

  const config = vscode.workspace.getConfiguration("traceFix");
  const modelName = config.get<string>("model") || "gemini-3.6-flash";

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "TraceFix: Locating and fixing error with Gemini AI...",
      cancellable: false
    },
    async (progress) => {
      progress.report({ increment: 30, message: "Analyzing trace..." });
      const geminiService = new GeminiService(apiKey, modelName);

      const editor = vscode.window.activeTextEditor;
      const fileContext = editor
        ? {
            fileName: editor.document.fileName,
            languageId: editor.document.languageId
          }
        : undefined;

      const result = await geminiService.analyzeTrace(traceText, fileContext);
      progress.report({ increment: 60, message: "Applying code fix..." });

      if (!result.fixCode) {
        vscode.window.showWarningMessage("TraceFix: Could not generate code fix.");
        return;
      }

      // Locate target file
      const targetUri = await resolveTargetUri(result.target);
      if (!targetUri) {
        vscode.window.showWarningMessage("TraceFix: Could not find the file referenced in the error.");
        return;
      }

      const doc = await vscode.workspace.openTextDocument(targetUri);
      const targetEditor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

      const targetLine = result.target?.line || 1;
      const lineIndex = Math.min(doc.lineCount - 1, Math.max(0, targetLine - 1));
      const lineRange = doc.lineAt(lineIndex).range;

      const success = await targetEditor.edit((builder) => {
        builder.replace(lineRange, result.fixCode);
      });

      if (success) {
        await doc.save();
        targetEditor.revealRange(lineRange, vscode.TextEditorRevealType.InCenter);
        targetEditor.setDecorations(fixPreviewDecorationType, [lineRange]);
        setTimeout(() => {
          targetEditor.setDecorations(fixPreviewDecorationType, []);
        }, 3000);

        const fileName = path.basename(targetUri.fsPath);
        vscode.window
          .showInformationMessage(
            `TraceFix: Successfully fixed ${fileName} at line ${targetLine}!`,
            "Undo",
            "Fix All Errors in File",
            "Explain Why"
          )
          .then(async (choice) => {
            if (choice === "Undo") {
              await vscode.commands.executeCommand("undo");
              vscode.window.showInformationMessage("TraceFix: Reverted change.");
            } else if (choice === "Fix All Errors in File") {
              await executeFixAllFlow(context, result.target);
            } else if (choice === "Explain Why") {
              TraceFixWebview.show(
                context.extensionUri,
                result,
                traceText,
                async (tgt, code) => applyFixDirectly(tgt, code),
                async (tgt) => executeFixAllFlow(context, tgt)
              );
            }
          });
      }
    }
  );
}

/**
 * Checks if a string looks like an error log or stack trace.
 */
function isLikelyError(text: string): boolean {
  return /error|exception|traceback|syntaxerror|nameerror|typeerror|failed|fatal|undefined|null|expected|out of range|invalid/i.test(
    text
  );
}

/**
 * Retrieves the error trace from terminal, editor selection, or file diagnostics.
 */
async function getErrorTraceFromEnvironment(): Promise<string> {
  // 1. Try reading terminal selection
  try {
    const prevClip = await vscode.env.clipboard.readText();
    await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
    await new Promise((r) => setTimeout(r, 80));
    const termClip = (await vscode.env.clipboard.readText()).trim();
    if (termClip && termClip.length > 0) {
      return termClip;
    }
  } catch {
    // Ignore terminal copy errors
  }

  // 2. Check active editor selection
  const editor = vscode.window.activeTextEditor;
  if (editor && !editor.selection.isEmpty) {
    const selectedText = editor.document.getText(editor.selection).trim();
    if (selectedText) {
      return selectedText;
    }
  }

  // 3. Check active editor diagnostics (e.g. Problems tab errors)
  if (editor) {
    const diags = vscode.languages.getDiagnostics(editor.document.uri);
    const errors = diags.filter(
      (d) => d.severity === vscode.DiagnosticSeverity.Error
    );
    if (errors.length > 0) {
      const err = errors[0];
      const lineText = editor.document.lineAt(err.range.start.line).text;
      return `File "${editor.document.fileName}", line ${err.range.start.line + 1}\n    ${lineText.trim()}\n${err.message}`;
    }
  }

  // 4. Check clipboard as fallback
  const clip = (await vscode.env.clipboard.readText()).trim();
  if (clip && isLikelyError(clip)) {
    return clip;
  }

  return "";
}

/**
 * Opens full side-by-side Webview panel.
 */
async function executeSidePanelDiagnostic(context: vscode.ExtensionContext) {
  let traceText = await getErrorTraceFromEnvironment();

  if (!traceText) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const diags = vscode.languages.getDiagnostics(editor.document.uri);
      const errors = diags.filter(
        (d) => d.severity === vscode.DiagnosticSeverity.Error
      );
      if (errors.length > 0) {
        const err = errors[0];
        const lineText = editor.document.lineAt(err.range.start.line).text;
        traceText = `File "${editor.document.fileName}", line ${err.range.start.line + 1}\n    ${lineText.trim()}\n${err.message}`;
      } else {
        traceText = `File "${editor.document.fileName}", line 1\n${editor.document.getText()}`;
      }
    } else {
      const input = await vscode.window.showInputBox({
        prompt: "Paste your stack trace or error log here...",
        placeHolder: "e.g. SyntaxError: expected ':' at line 1",
        ignoreFocusOut: true
      });
      if (!input || !input.trim()) {
        return;
      }
      traceText = input.trim();
    }
  }

  const apiKey = await getOrPromptApiKey();
  if (!apiKey) {
    return;
  }

  const config = vscode.workspace.getConfiguration("traceFix");
  const modelName = config.get<string>("model") || "gemini-3.6-flash";

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "TraceFix: Diagnosing error trace with Gemini AI...",
      cancellable: false
    },
    async (progress) => {
      progress.report({ increment: 30, message: "Connecting to Gemini..." });
      const geminiService = new GeminiService(apiKey, modelName);

      const editor = vscode.window.activeTextEditor;
      const fileContext = editor
        ? {
            fileName: editor.document.fileName,
            languageId: editor.document.languageId
          }
        : undefined;

      const result = await geminiService.analyzeTrace(traceText, fileContext);
      progress.report({ increment: 70, message: "Rendering diagnostic panel..." });

      TraceFixWebview.show(
        context.extensionUri,
        result,
        traceText,
        async (target, fixCode) => applyFixDirectly(target, fixCode),
        async (target) => executeFixAllFlow(context, target)
      );
    }
  );
}

/**
 * Resolves the target file URI from a TargetLocation.
 */
async function resolveTargetUri(target?: TargetLocation): Promise<vscode.Uri | undefined> {
  if (target?.filePath) {
    if (path.isAbsolute(target.filePath) && fs.existsSync(target.filePath)) {
      return vscode.Uri.file(target.filePath);
    }
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      for (const folder of workspaceFolders) {
        const candidate = path.resolve(folder.uri.fsPath, target.filePath);
        if (fs.existsSync(candidate)) {
          return vscode.Uri.file(candidate);
        }
      }
    }
    if (vscode.window.activeTextEditor) {
      const activeDir = path.dirname(vscode.window.activeTextEditor.document.fileName);
      const candidateActive = path.resolve(activeDir, target.filePath);
      if (fs.existsSync(candidateActive)) {
        return vscode.Uri.file(candidateActive);
      }
      const candidateBase = path.resolve(activeDir, path.basename(target.filePath));
      if (fs.existsSync(candidateBase)) {
        return vscode.Uri.file(candidateBase);
      }
    }
  }

  if (target?.fileName) {
    if (
      vscode.window.activeTextEditor &&
      path.basename(vscode.window.activeTextEditor.document.fileName) === target.fileName
    ) {
      return vscode.window.activeTextEditor.document.uri;
    }
    const found = await vscode.workspace.findFiles("**/" + target.fileName, "**/node_modules/**", 1);
    if (found.length > 0) {
      return found[0];
    }
  }

  if (vscode.window.activeTextEditor) {
    return vscode.window.activeTextEditor.document.uri;
  }

  const selection = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Select File to Apply Fix"
  });
  if (selection && selection.length > 0) {
    return selection[0];
  }

  return undefined;
}

/**
 * Directly applies fix code into the document.
 */
async function applyFixDirectly(
  target: TargetLocation | undefined,
  fixCode: string
): Promise<boolean> {
  try {
    const targetUri = await resolveTargetUri(target);
    if (!targetUri) {
      vscode.window.showWarningMessage("TraceFix: Could not locate target file to apply fix.");
      return false;
    }

    const document = await vscode.workspace.openTextDocument(targetUri);
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);

    let rangeToReplace: vscode.Range;
    if (target?.line && target.line > 0 && target.line <= document.lineCount) {
      const lineIndex = target.line - 1;
      rangeToReplace = document.lineAt(lineIndex).range;
    } else if (!editor.selection.isEmpty) {
      rangeToReplace = editor.selection;
    } else {
      rangeToReplace = document.lineAt(0).range;
    }

    const editSuccess = await editor.edit((editBuilder) => {
      editBuilder.replace(rangeToReplace, fixCode);
    });

    if (editSuccess) {
      await document.save();
      editor.revealRange(rangeToReplace, vscode.TextEditorRevealType.InCenter);
      editor.setDecorations(fixPreviewDecorationType, [rangeToReplace]);
      setTimeout(() => {
        editor.setDecorations(fixPreviewDecorationType, []);
      }, 2500);

      vscode.window.showInformationMessage(
        `TraceFix: Successfully applied fix to ${path.basename(targetUri.fsPath)}${
          target?.line ? " (Line " + target.line + ")" : ""
        }!`
      );
      return true;
    }
    return false;
  } catch (err: any) {
    vscode.window.showErrorMessage(`TraceFix failed to apply fix: ${err.message}`);
    return false;
  }
}

/**
 * Gets or prompts for the Google Gemini API Key.
 */
async function getOrPromptApiKey(): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration("traceFix");
  let apiKey = config.get<string>("apiKey")?.trim();

  if (!apiKey) {
    const enteredKey = await vscode.window.showInputBox({
      password: true,
      prompt: "Enter your Google Gemini API Key",
      placeHolder: "AIzaSy...",
      ignoreFocusOut: true
    });

    if (!enteredKey || !enteredKey.trim()) {
      const selection = await vscode.window.showWarningMessage(
        "TraceFix requires a Google Gemini API Key to diagnose errors.",
        "Get API Key (Google AI Studio)"
      );
      if (selection === "Get API Key (Google AI Studio)") {
        vscode.env.openExternal(vscode.Uri.parse("https://aistudio.google.com/app/apikey"));
      }
      return undefined;
    }

    apiKey = enteredKey.trim();
    await config.update("apiKey", apiKey, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage("TraceFix: Gemini API Key saved successfully!");
  }

  return apiKey;
}

/**
 * Handles errors with user-friendly action buttons.
 */
function handleError(error: any) {
  const message = error?.message || String(error);

  if (message.includes("API Key") || message.includes("API_KEY")) {
    vscode.window
      .showErrorMessage(`TraceFix: ${message}`, "Update API Key", "Get Free Key")
      .then(async (selection) => {
        if (selection === "Update API Key") {
          const newKey = await vscode.window.showInputBox({
            password: true,
            prompt: "Enter your Gemini API Key",
            ignoreFocusOut: true
          });
          if (newKey && newKey.trim()) {
            await vscode.workspace
              .getConfiguration("traceFix")
              .update("apiKey", newKey.trim(), vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage("TraceFix: API Key updated!");
          }
        } else if (selection === "Get Free Key") {
          vscode.env.openExternal(vscode.Uri.parse("https://aistudio.google.com/app/apikey"));
        }
      });
  } else {
    vscode.window.showErrorMessage(`TraceFix Error: ${message}`);
  }
}

/**
 * Extension deactivation.
 */
export function deactivate() {
  if (TraceFixWebview.currentPanel) {
    TraceFixWebview.currentPanel.dispose();
  }
}
