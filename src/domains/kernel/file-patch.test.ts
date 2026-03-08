import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyLinePatch } from "./file-patch";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function createWorkspaceFile(name: string, content: string) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "kairo-file-patch-"));
  tempDirs.push(workspaceRoot);
  const filePath = join(workspaceRoot, name);
  await writeFile(filePath, content, "utf-8");
  return { workspaceRoot, filePath };
}

describe("applyLinePatch", () => {
  it("should replace a single line and write to file", async () => {
    const { workspaceRoot, filePath } = await createWorkspaceFile(
      "sample.ts",
      ["const a = 1;", "const b = 2;", "export { a, b };", ""].join("\n"),
    );

    const result = await applyLinePatch({
      workspaceRoot,
      filePath: "sample.ts",
      startLine: 2,
      endLine: 2,
      replacement: "const b = 3;",
      expectedOriginal: "const b = 2;",
    });

    expect(result.changed).toBe(true);
    expect(result.oldText).toBe("const b = 2;");
    const updated = await readFile(filePath, "utf-8");
    expect(updated).toContain("const b = 3;");
    expect(updated).not.toContain("const b = 2;");
  });

  it("should fail when expectedOriginal does not match", async () => {
    const { workspaceRoot } = await createWorkspaceFile(
      "sample.ts",
      ["line1", "line2", "line3"].join("\n"),
    );

    await expect(
      applyLinePatch({
        workspaceRoot,
        filePath: "sample.ts",
        startLine: 2,
        endLine: 2,
        replacement: "next",
        expectedOriginal: "wrong",
      }),
    ).rejects.toThrow("expectedOriginal mismatch");
  });

  it("should reject path outside workspace", async () => {
    const { workspaceRoot } = await createWorkspaceFile("sample.ts", "line1");

    await expect(
      applyLinePatch({
        workspaceRoot,
        filePath: "../escape.ts",
        startLine: 1,
        endLine: 1,
        replacement: "next",
      }),
    ).rejects.toThrow("filePath is outside workspace");
  });

  it("should support dryRun without writing file", async () => {
    const { workspaceRoot, filePath } = await createWorkspaceFile("sample.ts", ["a", "b"].join("\n"));

    const result = await applyLinePatch({
      workspaceRoot,
      filePath: "sample.ts",
      startLine: 1,
      endLine: 1,
      replacement: "x",
      dryRun: true,
    });

    expect(result.changed).toBe(true);
    const after = await readFile(filePath, "utf-8");
    expect(after).toBe(["a", "b"].join("\n"));
  });
});
