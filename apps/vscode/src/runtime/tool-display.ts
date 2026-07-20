import type { ToolInputDisplay } from "@moonshot-ai/kimi-code-sdk";

import type { DisplayBlock } from "../../shared/legacy-sdk";

export function describeToolDisplay(display: ToolInputDisplay): string {
  switch (display.kind) {
    case "command":
      return display.command;
    case "file_io":
      return `${display.operation} ${display.path}`;
    case "diff":
      return `Edit ${display.path}`;
    case "search":
      return `Search for ${display.query}`;
    case "url_fetch":
      return display.url;
    case "agent_call":
      return display.prompt;
    case "skill_call":
      return display.args ? `${display.skill_name} ${display.args}` : display.skill_name;
    case "todo_list":
      return "Update the task list";
    case "task":
      return display.description;
    case "task_stop":
      return display.task_description;
    case "plan_review":
      return display.plan;
    case "goal_start":
      return display.objective;
    case "generic":
      return display.summary;
  }
}

export function toLegacyDisplay(display: ToolInputDisplay): DisplayBlock[] {
  switch (display.kind) {
    case "command":
      return [{ type: "shell", language: display.language ?? "bash", command: display.command }];
    case "diff":
      return [{ type: "diff", path: display.path, old_text: display.before, new_text: display.after }];
    case "file_io":
      if (
        display.before !== undefined ||
        display.after !== undefined ||
        display.content !== undefined
      ) {
        return [{
          type: "diff",
          path: display.path,
          old_text: display.before ?? "",
          new_text: display.after ?? display.content ?? "",
        }];
      }
      return [{ type: "brief", text: describeToolDisplay(display) }];
    case "todo_list":
      return [{
        type: "todo",
        items: display.items.map((item) => ({
          title: item.title,
          status: item.status === "done" || item.status === "in_progress" ? item.status : "pending",
        })),
      }];
    case "search":
    case "url_fetch":
    case "agent_call":
    case "skill_call":
    case "task":
    case "task_stop":
    case "plan_review":
    case "goal_start":
    case "generic":
      return [{ type: "brief", text: describeToolDisplay(display) }];
  }
}
