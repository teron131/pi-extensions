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
    clearTodos,
    cloneTodos,
    findTodoTarget,
    findTodoTargetByTitle,
    findTodoTargets,
    formatAddedTodoMessage,
    formatRemovedTodoMessage,
    formatResetTodoMessage,
    formatTodoNoteMessage,
    formatTodoSummary,
    formatTodoTargetLabel,
    formatToggleTodoMessage,
    getNextTodoId,
    getOrderedVisibleTodos,
    getTodoStats,
    getTodos,
    getVisibleTodos,
    setTodos,
    shouldResetCompletedTodos,
    subscribeTodos,
    TODO_STATE_ENTRY,
    TODO_WIDGET_ID,
    TODO_WIDGET_TOGGLE_SHORTCUT,
    type Todo,
    type TodoDetails,
    type TodoInput,
    TodoParams,
    type TodoToolParams,
} from "./state.js";

export default function todolist(pi: ExtensionAPI): void {
    let widgetExpanded = false;
    let activeContext: ExtensionContext | null = null;
    let reconstructingState = false;

    const rememberContext = (ctx: ExtensionContext): void => {
        activeContext = ctx;
    };

    const syncTodoUi = (ctx: ExtensionContext) => {
        rememberContext(ctx);
        if (!ctx.hasUI) {
            return;
        }

        const todos = getTodos();
        const visibleTodos = getVisibleTodos(todos);
        if (!visibleTodos.length) {
            ctx.ui.setStatus(TODO_WIDGET_ID, undefined);
            ctx.ui.setWidget(TODO_WIDGET_ID, undefined);
            return;
        }

        ctx.ui.setStatus(TODO_WIDGET_ID, undefined);
        ctx.ui.setWidget(TODO_WIDGET_ID, (_tui, theme) => ({
            render(width: number): string[] {
                return renderTodoWidgetLines(
                    getTodos(),
                    theme,
                    width,
                    widgetExpanded,
                );
            },
            invalidate() {},
        }));
    };

    subscribeTodos(() => {
        if (!activeContext || reconstructingState) {
            return;
        }
        syncTodoUi(activeContext);
    });

    const reconstructState = (ctx: ExtensionContext) => {
        rememberContext(ctx);
        reconstructingState = true;
        clearTodos();

        for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === "message") {
                const message = entry.message;
                if (
                    message.role === "toolResult" &&
                    message.toolName === "todo"
                ) {
                    const details = message.details as TodoDetails | undefined;
                    if (details) {
                        setTodos(details.todos);
                    }
                }
                continue;
            }

            if (entry.type !== "custom") {
                continue;
            }

            if (entry.customType === TODO_STATE_ENTRY) {
                const data = entry.data as { todos?: Todo[] } | undefined;
                if (data?.todos) {
                    setTodos(data.todos);
                }
            }
        }

        reconstructingState = false;
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
            "Manage a lightweight todo list for short-lived self-guidance, not a permanent log. Keep it small and current, avoid logging every micro-step, and reset when the task direction changes. Completed items drop out of the visible list while work continues, but stay in memory so progress can still be tracked. If all todos are completed, adding a new todo automatically restarts the list at #1. Use position for visible ordering, or id if needed. Actions: list, add (text or items), toggle (id/position), note (id/position, note), remove (title/text fuzzy match, or id/ids/position/positions), clear/reset",
        parameters: TodoParams as never,

        async execute(
            _toolCallId,
            params: TodoToolParams,
            _signal,
            _onUpdate,
            ctx,
        ) {
            rememberContext(ctx);
            let currentTodos = getTodos();

            const commitTodos = (nextTodos: Todo[]): void => {
                currentTodos = cloneTodos(nextTodos);
                setTodos(currentTodos);
            };

            const buildDetails = (
                action: TodoDetails["action"],
                error?: string,
            ): TodoDetails => {
                const stats = getTodoStats(currentTodos);
                return {
                    action,
                    todos: cloneTodos(currentTodos),
                    nextId: getNextTodoId(currentTodos),
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

            switch (params.action) {
                case "list": {
                    syncTodoUi(ctx);
                    const visibleTodos = getOrderedVisibleTodos(currentTodos);
                    const stats = getTodoStats(currentTodos);
                    const text = !currentTodos.length
                        ? "No active todos"
                        : stats.openCount === 0
                          ? "Checklist complete — next add will start fresh"
                          : [
                                `${stats.openCount} active • ${stats.doneCount} done hidden`,
                                ...visibleTodos.map((todo, index) =>
                                    formatTodoSummary(todo, index + 1),
                                ),
                            ].join("\n");
                    return {
                        content: [{ type: "text", text }],
                        details: buildDetails("list"),
                    };
                }

                case "add": {
                    const itemInputs: TodoInput[] = params.items?.length
                        ? params.items
                        : params.text
                          ? [{ text: params.text, note: params.note }]
                          : [];
                    const items = itemInputs
                        .map((item) => ({
                            text: item.text.trim(),
                            note: item.note?.trim() || undefined,
                        }))
                        .filter((item) => item.text.length > 0);

                    if (!items.length) {
                        return buildErrorResult(
                            "add",
                            "text or items required",
                        );
                    }

                    const restartedFromCompletedList =
                        shouldResetCompletedTodos(currentTodos);
                    const baseTodos = restartedFromCompletedList
                        ? []
                        : currentTodos;
                    let nextId = getNextTodoId(baseTodos);
                    const addedTodos: Todo[] = items.map((item) => ({
                        id: nextId++,
                        text: item.text,
                        done: false,
                        note: item.note,
                    }));

                    commitTodos([...baseTodos, ...addedTodos]);
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatAddedTodoMessage(
                                    addedTodos,
                                    restartedFromCompletedList,
                                ),
                            },
                        ],
                        details: buildDetails("add"),
                    };
                }

                case "remove": {
                    const title = params.title?.trim() || params.text?.trim();
                    if (title) {
                        const result = findTodoTargetByTitle(
                            currentTodos,
                            title,
                        );
                        if (result.error || !result.todo) {
                            return buildErrorResult(
                                "remove",
                                result.error ?? "item not found",
                            );
                        }

                        const matchedTodo = result.todo;
                        commitTodos(
                            currentTodos.filter(
                                (todo) => todo.id !== matchedTodo.id,
                            ),
                        );
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: formatRemovedTodoMessage([
                                        {
                                            todo: matchedTodo,
                                            position: result.position,
                                        },
                                    ]),
                                },
                            ],
                            details: buildDetails("remove"),
                        };
                    }

                    const result = findTodoTargets(currentTodos, params);
                    if (result.error || !result.targets?.length) {
                        return buildErrorResult(
                            "remove",
                            result.error ?? "item not found",
                        );
                    }

                    const removedIds = new Set(
                        result.targets.map((target) => target.todo.id),
                    );
                    commitTodos(
                        currentTodos.filter((todo) => !removedIds.has(todo.id)),
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatRemovedTodoMessage(result.targets),
                            },
                        ],
                        details: buildDetails("remove"),
                    };
                }

                case "toggle": {
                    const target = findTodoTarget(currentTodos, params);
                    if (target.error || !target.todo) {
                        return buildErrorResult(
                            "toggle",
                            target.error ?? "item not found",
                        );
                    }

                    target.todo.done = !target.todo.done;
                    commitTodos(currentTodos);
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatToggleTodoMessage(
                                    target.todo,
                                    formatTodoTargetLabel(
                                        target.todo,
                                        target.position,
                                    ),
                                ),
                            },
                        ],
                        details: buildDetails("toggle"),
                    };
                }

                case "note": {
                    const target = findTodoTarget(currentTodos, params);
                    if (target.error || !target.todo) {
                        return buildErrorResult(
                            "note",
                            target.error ?? "item not found",
                        );
                    }

                    const note = params.note?.trim() || undefined;
                    target.todo.note = note;
                    commitTodos(currentTodos);
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatTodoNoteMessage(
                                    formatTodoTargetLabel(
                                        target.todo,
                                        target.position,
                                    ),
                                    note,
                                ),
                            },
                        ],
                        details: buildDetails("note"),
                    };
                }

                case "clear":
                case "reset": {
                    const count = currentTodos.length;
                    commitTodos([]);
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
            if (args.items?.length) {
                text += ` ${theme.fg("dim", `${args.items.length} items`)}`;
            } else if (args.text) {
                text += ` ${theme.fg("dim", `"${args.text}"`)}`;
            }
            if (args.positions?.length) {
                text += ` ${theme.fg("accent", `${args.positions.length} positions`)}`;
            } else if (args.position !== undefined) {
                text += ` ${theme.fg("accent", `item ${args.position}`)}`;
            }
            if (args.ids?.length) {
                text += ` ${theme.fg("dim", `${args.ids.length} ids`)}`;
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

                case "add":
                case "remove":
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
            rememberContext(ctx);
            if (!ctx.hasUI) {
                ctx.ui.notify("/todos requires interactive mode", "error");
                return;
            }

            await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
                return new TodoListComponent(
                    () => getTodos(),
                    theme,
                    () => done(),
                );
            });
        },
    });
}
