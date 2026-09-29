import { GoogleGenerativeAI } from "@google/generative-ai";

export interface TargetLocation {
  fileName?: string;
  filePath?: string;
  line?: number;
  column?: number;
}

export interface DiagnosticResult {
  rawMarkdown: string;
  whatHappened: string;
  tracePath: string;
  theFix: string;
  fixCode: string;
  target?: TargetLocation;
}

export interface FullFileFixResult {
  summary: string;
  fixes: string[];
  fixedCode: string;
}

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private modelName: string;

  constructor(apiKey: string, modelName: string = "gemini-3.5-flash-lite") {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = modelName;
  }

  /**
   * Cascading model caller.
   * If a model returns 429 (rate limit), 503 (high demand), or 404 (model not found),
   * it automatically fails over to the next available Gemini model!
   */
  private async generateWithFallback(
    systemPrompt: string,
    userPrompt: string
  ): Promise<string> {
    const candidateModels = Array.from(
      new Set([
        this.modelName,
        "gemini-3.5-flash-lite",
        "gemini-3.5-flash",
        "gemini-3.7-flash",
        "gemini-3.8-flash",
        "gemini-3.6-flash"
      ])
    );

    let lastErrorMsg = "";

    for (const modelToTry of candidateModels) {
      try {
        const model = this.genAI.getGenerativeModel({
          model: modelToTry,
          systemInstruction: systemPrompt
        });

        const response = await model.generateContent(userPrompt);
        const text = response.response.text();
        if (text && text.trim().length > 0) {
          return text;
        }
      } catch (err: any) {
        const msg = err?.message || String(err);
        lastErrorMsg = msg;

        // If key itself is rejected by Google, fail immediately
        if (
          msg.includes("API_KEY_INVALID") ||
          msg.includes("403") ||
          msg.includes("401")
        ) {
          throw new Error(
            "Invalid Gemini API Key. Please verify or update your key in Settings (`traceFix.apiKey`)."
          );
        }

        // For 429 (quota), 503 (high demand), 404 (not found), continue to next model in cascade!
        continue;
      }
    }

    throw new Error(
      `All Gemini AI models currently busy or rate-limited. Please wait 30 seconds and try again. (${lastErrorMsg})`
    );
  }

  /**
   * Analyzes an error log or stack trace using Google Gemini API.
   * Prompts the model to return 3 strict sections without emojis:
   * 1. What Happened (Simple Words)
   * 2. Trace Path
   * 3. The Fix
   */
  async analyzeTrace(
    traceText: string,
    fileContext?: { fileName?: string; languageId?: string; fileSnippet?: string }
  ): Promise<DiagnosticResult> {
    const target = GeminiService.extractTargetFromTrace(traceText, fileContext);

    const systemPrompt = `You are TraceFix, a professional AI diagnostic and code-fixing tool for software developers.
Your mission is to analyze error logs and stack traces, explain root causes in very simple, jargon-free plain English / Roman Urdu friendly tone (ELI5 - explain like I'm 5, zero confusing jargon), chart the execution path leading up to the crash, and provide a direct copy-paste and auto-applicable code fix.

IMPORTANT: Do NOT use emojis anywhere in your response. Keep formatting clean, precise, and professional.

Strict Output Format Requirements:
You MUST structure your entire response into EXACTLY these three sections using these exact markdown headers:

### What Happened (Simple Words)
Maximum 2 sentences. Explain the core mistake in simple, human terms without complex technical jargon and without emojis.

### Trace Path
A clear step-by-step visual path showing the execution flow and file call stack right up to the crash point.
Format lines using standard arrows:
FileA.ts (line X: functionA) -> FileB.ts (line Y: functionB) -> Crash Point: Line Z (error trigger)
Add a brief 1-line note if relevant. Do NOT use emojis.

### The Fix
Direct, actionable explanation of how to fix it, followed by a fenced code block with the exact corrected code snippet:
\`\`\`<language>
// corrected code
\`\`\`
Ensure the code snippet in the fenced block contains ONLY the exact corrected code line or block ready to replace the broken code in the project.`;

    let prompt = `Analyze this error stack trace / log:\n\n\`\`\`\n${traceText.trim()}\n\`\`\``;

    if (fileContext && fileContext.fileName) {
      prompt += `\n\nContext:\n- File: ${fileContext.fileName}`;
      if (fileContext.languageId) {
        prompt += `\n- Language: ${fileContext.languageId}`;
      }
      if (fileContext.fileSnippet) {
        prompt += `\n- Surrounding Code:\n\`\`\`${fileContext.languageId || ""}\n${fileContext.fileSnippet}\n\`\`\``;
      }
    }

    const raw = await this.generateWithFallback(systemPrompt, prompt);
    return this.parseResponse(raw, target);
  }

  /**
   * Analyzes an entire file and fixes ALL errors, syntax bugs, type mismatches, and logic errors at once.
   */
  async fixAllErrorsInFile(
    fileContent: string,
    fileName: string,
    languageId?: string
  ): Promise<FullFileFixResult> {
    const systemPrompt = `You are TraceFix AI. You specialize in fixing all errors, bugs, syntax mistakes, type mismatches, variable casing issues, off-by-one errors, and logic flaws in a complete source code file at once.
Do NOT use emojis anywhere.
Analyze the provided code file thoroughly and output your response using this exact structure:

### Fixes:
- Fixed error 1
- Fixed error 2
- Fixed error 3

### Corrected Code:
\`\`\`${languageId || ""}
<complete pristine corrected source code file ready to run directly without any bugs>
\`\`\``;

    const userPrompt = `Fix all errors, logic bugs, casing issues, and runtime crashes in this ${languageId || "source"} file named "${fileName}":\n\n${fileContent}`;

    const raw = await this.generateWithFallback(systemPrompt, userPrompt);

    // 1. Try extracting fixes list
    const fixesMatch = raw.match(/###\s*Fixes:[^\n]*\n([\s\S]*?)(?=###\s*Corrected Code|```|$)/i);
    const fixes: string[] = [];
    if (fixesMatch) {
      const lines = fixesMatch[1].split("\n");
      for (const line of lines) {
        const trimmed = line.replace(/^[\s*\-]+/, "").trim();
        if (trimmed && !trimmed.startsWith("###")) {
          fixes.push(trimmed);
        }
      }
    }

    // 2. Try extracting code block
    const codeMatch = raw.match(/```(?:[a-zA-Z0-9_\-+]*)\r?\n([\s\S]*?)```/);
    let fixedCode = codeMatch ? codeMatch[1].trim() : "";

    // 3. Fallback: check if JSON was returned
    if (!fixedCode) {
      try {
        let cleaned = raw.trim();
        if (cleaned.startsWith("```json")) {
          cleaned = cleaned.replace(/^```json\s*/i, "").replace(/```\s*$/i, "");
        } else if (cleaned.startsWith("```")) {
          cleaned = cleaned.replace(/^```\s*/, "").replace(/```\s*$/, "");
        }
        const parsed = JSON.parse(cleaned);
        if (parsed.fixedCode) {
          fixedCode = parsed.fixedCode.trim();
        }
        if (Array.isArray(parsed.fixes)) {
          fixes.push(...parsed.fixes);
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    // 4. Ultimate fallback if raw text itself is code
    if (!fixedCode && raw.length > fileContent.length / 2) {
      fixedCode = raw.trim();
    }

    return {
      summary: fixes.length > 0 ? `Fixed ${fixes.length} issues in ${fileName}` : "All errors resolved.",
      fixes: fixes.length > 0 ? fixes : ["Resolved all syntax and runtime issues"],
      fixedCode: fixedCode || fileContent
    };
  }

  /**
   * Extracts target file and line number from error logs.
   */
  public static extractTargetFromTrace(
    traceText: string,
    fileContext?: { fileName?: string }
  ): TargetLocation | undefined {
    // 1. Python: File "test/a.py", line 1
    const pyMatch = traceText.match(/File\s+["']([^"']+)["'],\s*line\s*(\d+)/i);
    if (pyMatch) {
      const rawPath = pyMatch[1].trim();
      const fileName = rawPath.replace(/\\/g, "/").split("/").pop() || rawPath;
      return {
        filePath: rawPath,
        fileName,
        line: parseInt(pyMatch[2], 10)
      };
    }

    // 2. Node.js / JS / TS: at UserList (src/components/UserList.tsx:24:18)
    const jsMatches = [
      ...traceText.matchAll(
        /(?:at\s+(?:[^\s\(\)]+\s+)?\(?|\s+)([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+):(\d+)(?::(\d+))?\)?/g
      )
    ];
    for (const m of jsMatches) {
      const rawPath = m[1].trim();
      if (
        !rawPath.includes("node_modules") &&
        !rawPath.startsWith("node:") &&
        !rawPath.startsWith("internal/")
      ) {
        const fileName = rawPath.replace(/\\/g, "/").split("/").pop() || rawPath;
        return {
          filePath: rawPath,
          fileName,
          line: parseInt(m[2], 10),
          column: m[3] ? parseInt(m[3], 10) : undefined
        };
      }
    }

    // 3. Rust: --> src/main.rs:14:5
    const rustMatch = traceText.match(
      /-->\s*([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+):(\d+)(?::(\d+))?/
    );
    if (rustMatch) {
      const rawPath = rustMatch[1].trim();
      const fileName = rawPath.replace(/\\/g, "/").split("/").pop() || rawPath;
      return {
        filePath: rawPath,
        fileName,
        line: parseInt(rustMatch[2], 10),
        column: rustMatch[3] ? parseInt(rustMatch[3], 10) : undefined
      };
    }

    // 4. Go: main.go:12: ...
    const goMatch = traceText.match(/([a-zA-Z0-9_\-./\\]+\.go):(\d+)/);
    if (goMatch) {
      const rawPath = goMatch[1].trim();
      const fileName = rawPath.replace(/\\/g, "/").split("/").pop() || rawPath;
      return {
        filePath: rawPath,
        fileName,
        line: parseInt(goMatch[2], 10)
      };
    }

    // 5. Generic fallback: path/file.ext:12
    const genMatch = traceText.match(/([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+):(\d+)/);
    if (genMatch && !genMatch[1].includes("node_modules")) {
      const rawPath = genMatch[1].trim();
      const fileName = rawPath.replace(/\\/g, "/").split("/").pop() || rawPath;
      return {
        filePath: rawPath,
        fileName,
        line: parseInt(genMatch[2], 10)
      };
    }

    if (fileContext?.fileName) {
      return {
        filePath: fileContext.fileName,
        fileName: fileContext.fileName.replace(/\\/g, "/").split("/").pop()
      };
    }

    return undefined;
  }

  /**
   * Removes emojis from strings to maintain clean professional appearance.
   */
  private stripEmojis(text: string): string {
    return text
      .replace(
        /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/gu,
        ""
      )
      .trim();
  }

  /**
   * Parses the Gemini response into dedicated sections and extracts the fix code block.
   */
  private parseResponse(raw: string, target?: TargetLocation): DiagnosticResult {
    const cleaned = this.stripEmojis(raw);
    let whatHappened = "";
    let tracePath = "";
    let theFix = "";
    let fixCode = "";

    // Flexible regex matchers for headers
    const whatHappenedMatch = cleaned.match(
      /###\s*What Happened[^\n]*\n([\s\S]*?)(?=###\s*Trace Path|$)/i
    );
    const tracePathMatch = cleaned.match(
      /###\s*Trace Path[^\n]*\n([\s\S]*?)(?=###\s*The Fix|$)/i
    );
    const theFixMatch = cleaned.match(/###\s*The Fix[^\n]*\n([\s\S]*)$/i);

    if (whatHappenedMatch) {
      whatHappened = this.stripEmojis(whatHappenedMatch[1]);
    }
    if (tracePathMatch) {
      tracePath = this.stripEmojis(tracePathMatch[1]);
    }
    if (theFixMatch) {
      theFix = this.stripEmojis(theFixMatch[1]);
    }

    // Extract the primary fenced code block from "The Fix" (or anywhere in markdown if missing)
    const codeBlockMatch = (theFix || cleaned).match(
      /```(?:[a-zA-Z0-9_\-+]*)\r?\n([\s\S]*?)```/
    );
    if (codeBlockMatch) {
      fixCode = codeBlockMatch[1].trim();
    }

    // Fallbacks if formatting was slightly deviated
    if (!whatHappened && !tracePath && !theFix) {
      whatHappened = cleaned;
      theFix = cleaned;
    }

    return {
      rawMarkdown: cleaned,
      whatHappened,
      tracePath,
      theFix,
      fixCode,
      target
    };
  }
}
