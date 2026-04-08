/**
 * Todo List Extension - Session-backed todo state with widget and commands.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
    getToolResultText,
    renderSuccessText,
    renderTodoListResult,
    renderTodoWidgetLines,
    TodoListComponent,
} from "./render.js";
import {
    cloneTodos,
    findTodoTarget,
    formatAddedTodoMessage,
    formatResetTodoMessage,
    formatTodoNoteMessage,
    formatTodoSummary,
    formatToggleTodoMessage,
    getNextTodoId,
    getOrderedTodos,
    getTodoStats,
    normalizeTodos,
    shouldResetCompletedTodos,
    TODO_WIDGET_ID,
    TODO_WIDGET_TOGGLE_SHORTCUT,
    type Todo,
    type TodoDetails,
    TodoParams,
    type TodoToolParams,
} from "./state.js";

export default function todolist(pi: ExtensionAPI): void {
    let todos: Todo[] = [];
    let widgetExpanded = false;

    const syncTodoUi = (ctx: ExtensionContext) => {
        if (!ctx.hasUI) {
            return;
        }

        const { openCount } = getTodoStats(todos);
        if (!openCount) {
            ctx.ui.setStatus(TODO_WIDGET_ID, undefined);
            ctx.ui.setWidget(TODO_WIDGET_ID, undefined);
            return;
        }

        ctx.ui.setStatus(TODO_WIDGET_ID, undefined);
        ctx.ui.setWidget(TODO_WIDGET_ID, (_tui, theme) => ({
            render(width: number): string[] {
                return renderTodoWidgetLines(
                    todos,
                    theme,
                    width,
                    widgetExpanded,
                );
            },
            invalidate() {},
        }));
    };

    const reconstructState = (ctx: ExtensionContext) => {
        todos = [];

        for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type !== "message") {
                continue;
            }

            const message = entry.message;
            if (message.role !== "toolResult" || message.toolName !== "todo") {
                continue;
            }

            const details = message.details as TodoDetails | undefined;
            if (details) {
                todos = normalizeTodos(cloneTodos(details.todos));
            }
        }

        syncTodoUi(ctx);
    };

    const toggleWidgetExpanded = (ctx: ExtensionContext) => {
        widgetExpanded = !widgetExpanded;
        syncTodoUi(ctx);
        ctx.ui.notify(
            `Todo widget ${widgetExpanded ? "expanded" : "collapsed"}`,
            "info",
        );
    };

    pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
    pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

    pi.registerCommand("todos-widget", {
        description: "Toggle compact/expanded todo widget",
        handler: async (_args, ctx) => toggleWidgetExpanded(ctx),
    });

    pi.registerShortcut(TODO_WIDGET_TOGGLE_SHORTCUT, {
        description: "Toggle expanded todo widget",
        handler: async (ctx) => toggleWidgetExpanded(ctx),
    });

    pi.registerTool({
        name: "todo",
        label: "Todo",
        description:
            "Manage a lightweight todo list for short-lived self-guidance, not a permanent log. Keep it small and current, avoid logging every micro-step, and reset when the task direction changes. Completed items drop out of the active list while work continues. If all todos are completed, adding a new todo automatically restarts the list at #1. Use position for visible ordering, or id if needed. Actions: list, add (text, note), toggle (id/position), note (id/position, note), clear/reset",
        parameters: TodoParams as never,

        async execute(
            _toolCallId,
            params: TodoToolParams,
            _signal,
            _onUpdate,
            ctx,
        ) {
            const buildDetails = (
                action: TodoDetails["action"],
                error?: string,
            ): TodoDetails => {
                const stats = getTodoStats(todos);
                return {
                    action,
                    todos: cloneTodos(todos),
                    nextId: getNextTodoId(todos),
                    doneCount: stats.doneCount,
                    openCount: stats.openCount,
                    totalCount: stats.totalCount,
                    error,
                };
            };

            const buildErrorResult = (
                action: TodoDetails["action"],
                error: string,
            ) => ({
                content: [{ type: "text" as const, text: `Error: ${error}` }],
                details: buildDetails(action, error),
            });

            const stats = getTodoStats(todos);

            switch (params.action) {
                case "list": {
                    syncTodoUi(ctx);
                    const orderedTodos = getOrderedTodos(todos);
                    const text = !todos.length
                        ? "No active todos"
                        : stats.openCount === 0
                          ? "Checklist complete — next add will start fresh"
                          : [
                                `${stats.openCount} active • ${stats.doneCount} done hidden`,
                                ...orderedTodos.map((todo, index) =>
                                    formatTodoSummary(todo, index + 1),
                                ),
                            ].join("\n");
                    return {
                        content: [{ type: "text", text }],
                        details: buildDetails("list"),
                    };
                }

                case "add": {
                    if (!params.text) {
                        return buildErrorResult("add", "text required");
                    }

                    const restartedFromCompletedList =
                        shouldResetCompletedTodos(todos);
                    if (restartedFromCompletedList) {
                        todos = [];
                    }

                    const newTodo: Todo = {
                        id: getNextTodoId(todos),
                        text: params.text,
                        done: false,
                        note: params.note?.trim() || undefined,
                    };
                    todos.push(newTodo);
                    todos = normalizeTodos(todos);
                    syncTodoUi(ctx);
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatAddedTodoMessage(
                                    newTodo,
                                    restartedFromCompletedList,
                                ),
                            },
                        ],
                        details: buildDetails("add"),
                    };
                }

                case "toggle": {
                    const target = findTodoTarget(todos, params);
                    if (
                        target.error ||
                        !target.todo ||
                        target.position === undefined
                    ) {
                        return buildErrorResult(
                            "toggle",
                            target.error ?? "item not found",
                        );
                    }

                    target.todo.done = !target.todo.done;
                    todos = normalizeTodos(todos);
                    syncTodoUi(ctx);
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatToggleTodoMessage(
                                    target.todo,
                                    target.position,
                                ),
                            },
                        ],
                        details: buildDetails("toggle"),
                    };
                }

                case "note": {
                    const target = findTodoTarget(todos, params);
                    if (
                        target.error ||
                        !target.todo ||
                        target.position === undefined
                    ) {
                        return buildErrorResult(
                            "note",
                            target.error ?? "item not found",
                        );
                    }

                    const note = params.note?.trim() || undefined;
                    target.todo.note = note;
                    todos = normalizeTodos(todos);
                    syncTodoUi(ctx);
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatTodoNoteMessage(
                                    target.position,
                                    note,
                                ),
                            },
                        ],
                        details: buildDetails("note"),
                    };
                }

                case "clear":
                case "reset": {
                    const count = todos.length;
                    todos = [];
                    syncTodoUi(ctx);
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatResetTodoMessage(
                                    params.action,
                                    count,
                                ),
                            },
                        ],
                        details: buildDetails(params.action),
                    };
                }

                default:
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Unknown action: ${params.action}`,
                            },
                        ],
                        details: buildDetails(
                            "list",
                            `unknown action: ${params.action}`,
                        ),
                    };
            }
        },

        renderCall(args: TodoToolParams, theme, _context) {
            let text =
                theme.fg("toolTitle", theme.bold("todo ")) +
                theme.fg("muted", args.action);
            if (args.text) {
                text += ` ${theme.fg("dim", `"${args.text}"`)}`;
            }
            if (args.position !== undefined) {
                text += ` ${theme.fg("accent", `item ${args.position}`)}`;
            } else if (args.id !== undefined) {
                text += ` ${theme.fg("dim", `id ${args.id}`)}`;
            }
            return new Text(text, 0, 0);
        },

        renderResult(result, { expanded }, theme, _context) {
            const details = result.details as TodoDetails | undefined;
            if (!details) {
                return new Text(getToolResultText(result), 0, 0);
            }

            if (details.error) {
                return new Text(
                    theme.fg("error", `Error: ${details.error}`),
                    0,
                    0,
                );
            }

            switch (details.action) {
                case "list":
                    return renderTodoListResult(details, expanded, theme);

                case "add": {
                    const added = details.todos[details.todos.length - 1];
                    let text = theme.fg("success", "✓ Added ");
                    if (added) {
                        text += theme.fg("accent", added.text);
                        if (added.note) {
                            text += `\n${theme.fg("dim", `↳ ${added.note}`)}`;
                        }
                    } else {
                        text += theme.fg("dim", getToolResultText(result));
                    }
                    return new Text(text, 0, 0);
                }

                case "toggle":
                case "note":
                    return renderSuccessText(theme, getToolResultText(result));

                case "clear":
                    return renderSuccessText(
                        theme,
                        "Cleared all todos; next item will start at #1",
                    );

                case "reset":
                    return renderSuccessText(
                        theme,
                        "Reset todo list; next item will start at #1",
                    );
            }

            return new Text("", 0, 0);
        },
    });

    pi.registerCommand("todos", {
        description: "Show all todos on the current branch",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI) {
                ctx.ui.notify("/todos requires interactive mode", "error");
                return;
            }

            await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
                return new TodoListComponent(todos, theme, () => done());
            });
        },
    });
}
