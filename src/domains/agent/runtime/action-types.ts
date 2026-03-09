export interface SayAction {
  type: "say";
  content?: string;
  continue?: boolean;
  final?: boolean;
  continueReason?: string;
}

export interface QueryAction {
  type: "query";
  content?: string;
}

export interface FinishAction {
  type: "finish";
  result?: unknown;
}

export interface RenderAction {
  type: "render";
  surfaceId?: string;
  tree?: unknown;
}

export interface ToolCallAction {
  type: "tool_call";
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

export interface NoopAction {
  type: "noop";
  content?: string;
}

export interface GenericAction {
  type: string;
  [key: string]: unknown;
}

export type AgentAction =
  | SayAction
  | QueryAction
  | FinishAction
  | RenderAction
  | ToolCallAction
  | NoopAction
  | GenericAction;
