import { describe, expect, it } from "bun:test";
import { ResponseParser } from "./runtime/response-parser";

describe("ResponseParser", () => {
  it("should parse fenced JSON with trailing text", () => {
    const parser = new ResponseParser();
    const parsed = parser.parse(`先说明一下
\`\`\`json
{"thought":"解析成功","action":{"type":"say","content":"ok"}}
\`\`\`
附加文本 {invalid-json-tail}`);
    expect(parsed.thought).toBe("解析成功");
    expect(parsed.action.type).toBe("say");
    expect(parsed.action.content).toBe("ok");
  });

  it("should recover truncated JSON", () => {
    const parser = new ResponseParser();
    const parsed = parser.parse(`\`\`\`markdown
{"thought":"继续执行","action":{"type":"tool_call","function":{"name":"kairo_terminal_exec","arguments":{"sessionId":"main","command":"cat > /app/file << 'EOF'\\n标题"}}`);
    expect(parsed.action.type).toBe("tool_call");
    expect(parsed.action.function.name).toBe("kairo_terminal_exec");
  });

  it("should fallback to auto-correction say action", () => {
    const parser = new ResponseParser();
    const parsed = parser.parse("这是普通文本响应，不是 JSON");
    expect(parsed.action.type).toBe("say");
    expect(parsed.action.continue).toBe(true);
    expect(parsed.action.continueReason).toBe("response_parse_failed");
  });
});
