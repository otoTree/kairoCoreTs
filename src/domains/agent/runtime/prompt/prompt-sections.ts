import type { PromptObservation, PromptSectionContext } from "./prompt-types";

export function buildLongTaskGuidance(context: PromptSectionContext): string {
  if (!context.hasCreateLongTaskTool) {
    return "";
  }
  return `

【Long-Running Task Delegation】
- As the main agent, you should stay responsive and delegate long-running multi-step work to Task Agent.
- If the user request is clearly long-running (e.g. generating 100 items, batch processing many files), call tool "kairo_create_long_task" first instead of executing all steps yourself.
- After delegation, use "say" to clearly inform the user the task is running in background and they can continue asking other questions.
- If user asks for progress and tool "${context.hasQueryTaskTool ? "kairo_query_task_status" : "kairo_create_long_task"}" is available, query task status and report concise progress.
- If user asks to stop background task and tool "${context.hasCancelTaskTool ? "kairo_cancel_task" : "kairo_create_long_task"}" is available, cancel it and confirm.
- You must actively inspect Task Agent outputs and progress artifacts by yourself.
- If you detect abnormal states (e.g. repeated same outputs, no real progress across multiple reports, obvious loop or persistent execution errors), proactively stop that Task Agent via tool "${context.hasCancelTaskTool ? "kairo_cancel_task" : "kairo_create_long_task"}" with a clear reason, without waiting for user instruction.
- After proactive stopping, immediately explain to the user why it was stopped and what you will do next.
- Do not pretend delegation happened. Use actual tool calls.
`;
}

export function buildChannelFileGuidance(context: PromptSectionContext): string {
  if (!context.hasFeishuSendFileTool) {
    return "";
  }
  return `

【Channel File Delivery】
- If you need to send a local file back to user in Feishu, call tool "kairo_feishu_send_file".
- Do not assume channel adapters will auto-detect file paths from normal text output.
- Prefer absolute local file paths when calling "kairo_feishu_send_file".
`;
}

export function buildUserPrompt(observations: PromptObservation[]): string {
  if (observations.length === 0) return "No new observations.";
  return observations
    .map((observation) => {
      if (observation.type === "user_message") return `User: ${observation.text}`;
      if (observation.type === "system_event") return `System Event: ${observation.name} ${JSON.stringify(observation.payload)}`;
      if (observation.type === "action_result") return `Action Result: ${JSON.stringify(observation.result)}`;
      return JSON.stringify(observation);
    })
    .join("\n");
}
