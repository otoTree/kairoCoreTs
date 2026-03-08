import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export interface LinePatchInput {
  workspaceRoot: string;
  filePath: string;
  startLine: number;
  endLine: number;
  replacement: string;
  expectedOriginal?: string;
  dryRun?: boolean;
}

export interface LinePatchResult {
  filePath: string;
  changed: boolean;
  oldText: string;
  newText: string;
  lineRange: { startLine: number; endLine: number };
}

function toLines(content: string): { lines: string[]; newline: string; trailingNewline: boolean } {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, newline, trailingNewline };
}

function fromLines(lines: string[], newline: string, trailingNewline: boolean): string {
  if (lines.length === 0) return "";
  const joined = lines.join(newline);
  return trailingNewline ? `${joined}${newline}` : joined;
}

function resolvePathInsideWorkspace(workspaceRoot: string, filePath: string): string {
  const root = resolve(workspaceRoot);
  const resolved = resolve(root, filePath);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || rel.includes(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("filePath is outside workspace");
  }
  return resolved;
}

export async function applyLinePatch(input: LinePatchInput): Promise<LinePatchResult> {
  const resolvedFilePath = resolvePathInsideWorkspace(input.workspaceRoot, input.filePath);
  if (!Number.isInteger(input.startLine) || !Number.isInteger(input.endLine)) {
    throw new Error("startLine and endLine must be integers");
  }
  if (input.startLine < 1 || input.endLine < input.startLine) {
    throw new Error("invalid line range");
  }

  const content = await readFile(resolvedFilePath, "utf-8");
  const parsed = toLines(content);
  if (input.endLine > parsed.lines.length) {
    throw new Error(`line range exceeds file length: ${parsed.lines.length}`);
  }

  const startIndex = input.startLine - 1;
  const deleteCount = input.endLine - input.startLine + 1;
  const oldLines = parsed.lines.slice(startIndex, startIndex + deleteCount);
  const oldText = oldLines.join(parsed.newline);

  if (typeof input.expectedOriginal === "string" && oldText !== input.expectedOriginal) {
    throw new Error("expectedOriginal mismatch");
  }

  const replacementLines = input.replacement.length === 0 ? [] : input.replacement.split(/\r?\n/);
  const nextLines = parsed.lines.slice();
  nextLines.splice(startIndex, deleteCount, ...replacementLines);
  const nextContent = fromLines(nextLines, parsed.newline, parsed.trailingNewline);

  if (!input.dryRun && nextContent !== content) {
    await writeFile(resolvedFilePath, nextContent, "utf-8");
  }

  return {
    filePath: resolvedFilePath,
    changed: nextContent !== content,
    oldText,
    newText: replacementLines.join(parsed.newline),
    lineRange: { startLine: input.startLine, endLine: input.endLine },
  };
}
