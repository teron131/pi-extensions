/**
 * Todo List Extension - Demonstrates session-backed todo state with notes
 *
 * This extension:
 * - Registers a `todo` tool for the LLM to manage todos
 * - Registers a `/todos` command for users to view the list
 * - Preserves todo state in session history so branching stays consistent
 *
 * State is stored in tool result details (not external files), which allows
 * proper branching - when you branch, the todo state is automatically
 * correct for that point in history.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
    Theme,
} from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface Todo {
    id: number;
    text: string;
    done: boolean;
    note?: string;
}

interface TodoStats {
    doneCount: number;
    openCount: number;
    totalCount: number;
}

interface TodoDetails {
    action: "list" | "add" | "toggle" | "clear" | "note" | "reset";
    todos: Todo[];
    nextId: number;
    doneCount: number;
    openCount: number;
    totalCount: number;
    error?: string;
}

const TODO_WIDGET_ID = "todo-list";
const TODO_WIDGET_TOGGLE_SHORTCUT = Key.ctrlShift("t");
const TODO_WIDGET_TOGGLE_HINT = "Ctrl+Shift+T";
const TODO_WIDGET_COMPACT_TODO_COUNT = 4;

const TodoParams = Type.Object({
    action: StringEnum([
        "list",
        "add",
        "toggle",
        "clear",
        "note",
        "reset",
    ] as const),
    text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
    note: Type.Optional(
        Type.String({ description: "Optional note or update text" }),
    ),
    id: Type.Optional(
        Type.Number({
            description: "Internal todo ID (optional for toggle/note)",
        }),
    ),
    position: Type.Optional(
        Type.Number({
            description: "Visible todo position (1-based) for toggle/note",
        }),
    ),
});

function getTodoStats(todos: Todo[]): TodoStats {
    const doneCount = todos.filter((todo) => todo.done).length;
    return {
        doneCount,
        openCount: todos.length - doneCount,
        totalCount: todos.length,
    };
}

function cloneTodos(todos: Todo[]): Todo[] {
    return todos.map((todo) => ({ ...todo }));
}

function getNextTodoId(todos: Todo[]): number {
    if (!todos.length) {
        return 1;
    }

    return Math.max(...todos.map((todo) => todo.id)) + 1;
}

function shouldResetCompletedTodos(todos: Todo[]): boolean {
    return todos.length > 0 && todos.every((todo) => todo.done);
}

function getOrderedTodos(todos: Todo[]): Todo[] {
    return [
        ...todos.filter((todo) => !todo.done),
        ...todos.filter((todo) => todo.done),
    ];
}

function normalizeTodos(todos: Todo[]): Todo[] {
    const openTodos = todos.filter((todo) => !todo.done);
    return openTodos.length > 0 ? openTodos : todos;
}

function findTodoTarget(
    todos: Todo[],
    params: { id?: number; position?: number },
): { todo?: Todo; position?: number; error?: string } {
    const orderedTodos = getOrderedTodos(todos);

    if (params.position !== undefined) {
        if (params.position < 1 || params.position > orderedTodos.length) {
            return {
                error: `item ${params.position} not found`,
            };
        }

        const todo = orderedTodos[params.position - 1];
        return {
            todo,
            position: params.position,
        };
    }

    if (params.id !== undefined) {
        const todoIndex = orderedTodos.findIndex(
            (todo) => todo.id === params.id,
        );
        if (todoIndex === -1) {
            return {
                error: `todo id ${params.id} not found`,
            };
        }

        return {
            todo: orderedTodos[todoIndex],
            position: todoIndex + 1,
        };
    }

    return {
        error: "id or position required",
    };
}

function formatTodoSummary(todo: Todo, position: number): string {
    return `${position}. [${todo.done ? "x" : " "}] ${todo.text}`;
}

function renderTodoLine(
    todo: Todo,
    theme: Theme,
    options?: { position?: number; showPosition?: boolean },
): string {
    const check = todo.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
    const text = todo.done
        ? theme.fg("dim", todo.text)
        : theme.fg("accent", todo.text);
    const prefix = options?.showPosition
        ? `  ${theme.fg("dim", `${options.position}.`)} `
        : "  ";
    return `${prefix}${check} ${text}`;
}

function renderTodoNoteLine(todo: Todo, theme: Theme): string | null {
    if (!todo.note) {
        return null;
    }

    return `     ${theme.fg("dim", `↳ ${todo.note}`)}`;
}

function formatAddedTodoMessage(todo: Todo, restarted: boolean): string {
    const noteText = todo.note ? `\nNote: ${todo.note}` : "";
    if (restarted) {
        return `Restarted completed checklist\nAdded: ${todo.text}${noteText}`;
    }

    return `Added: ${todo.text}${noteText}`;
}

function formatToggleTodoMessage(todo: Todo, position: number): string {
    const statusText = todo.done ? "Completed" : "Reopened";
    const noteText = todo.note ? `\nNote: ${todo.note}` : "";
    return `${statusText} item ${position}: ${todo.text}${noteText}`;
}

function formatTodoNoteMessage(position: number, note?: string): string {
    return note
        ? `Updated note for item ${position}\nNote: ${note}`
        : `Cleared note for item ${position}`;
}

function formatResetTodoMessage(
    action: TodoDetails["action"],
    count: number,
): string {
    if (action === "reset") {
        return "Reset todo list; next item will start at #1";
    }

    return `Cleared ${count} todo${count === 1 ? "" : "s"}; next item will start at #1`;
}

function renderTodoListLines(
    todos: Todo[],
    theme: Theme,
    width: number,
): string[] {
    const lines: string[] = [];
    const addLine = (line = "") => {
        lines.push(truncateToWidth(line, width));
    };

    addLine();
    const title = theme.fg("accent", theme.bold(" 📋 Todo List "));
    const headerLine =
        theme.fg("borderMuted", "─".repeat(2)) +
        title +
        theme.fg("borderMuted", "─".repeat(Math.max(0, width - 15)));
    addLine(headerLine);

    if (todos.length === 0) {
        addLine();
        addLine(
            `  ${theme.fg("dim", "No active todos. Use this as lightweight self-guidance.")}`,
        );
        addLine();
        addLine(`  ${theme.fg("dim", "Press Escape to close")}`);
        addLine();
        return lines;
    }

    const orderedTodos = getOrderedTodos(todos);
    const { doneCount, openCount, totalCount } = getTodoStats(todos);

    addLine();
    if (openCount === 0) {
        addLine(
            `  ${theme.fg("success", "Checklist complete")}${theme.fg("muted", " • next add starts a fresh list")}`,
        );
    } else {
        addLine(
            `  ${theme.fg("muted", `${openCount} active • ${doneCount} done hidden • ${totalCount} in memory`)}`,
        );
        addLine();
        addLine(`  ${theme.fg("accent", theme.bold("Current"))}`);
        for (const [index, todo] of orderedTodos.entries()) {
            addLine(
                renderTodoLine(todo, theme, {
                    position: index + 1,
                    showPosition: true,
                }),
            );
            const noteLine = renderTodoNoteLine(todo, theme);
            if (noteLine) {
                addLine(noteLine);
            }
        }
    }

    addLine();
    addLine(`  ${theme.fg("dim", "Press Escape to close")}`);
    addLine();

    return lines;
}

function renderTodoWidgetLines(
    todos: Todo[],
    theme: Theme,
    width: number,
    expanded: boolean,
): string[] {
    const { doneCount, openCount } = getTodoStats(todos);
    const orderedTodos = getOrderedTodos(todos);
    const visibleTodos = expanded
        ? orderedTodos
        : orderedTodos.slice(0, TODO_WIDGET_COMPACT_TODO_COUNT);
    const toggleHint = expanded
        ? theme.fg("dim", `(${TODO_WIDGET_TOGGLE_HINT} collapse)`)
        : theme.fg("dim", `(${TODO_WIDGET_TOGGLE_HINT} expand)`);
    const summary = expanded
        ? `${openCount} active • ${doneCount} hidden`
        : `${openCount} active`;
    const lines = [
        truncateToWidth(
            `${theme.fg("accent", theme.bold("📋 Todo List"))} ${theme.fg("muted", summary)} ${toggleHint}`,
            width,
        ),
    ];

    for (const todo of visibleTodos) {
        lines.push(truncateToWidth(renderTodoLine(todo, theme), width));
        const noteLine = renderTodoNoteLine(todo, theme);
        if (noteLine) {
            lines.push(truncateToWidth(noteLine, width));
        }
    }

    if (orderedTodos.length > visibleTodos.length) {
        lines.push(
            truncateToWidth(
                `  ${theme.fg("dim", `… ${orderedTodos.length - visibleTodos.length} more`)}`,
                width,
            ),
        );
    }

    return lines;
}

function getToolResultText(result: {
    content: { type: string; text?: string }[];
}): string {
    const text = result.content[0];
    return text?.type === "text" && typeof text.text === "string"
        ? text.text
        : "";
}

function renderSuccessText(theme: Theme, text: string): Text {
    return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text), 0, 0);
}

function renderTodoListResult(
    details: TodoDetails,
    expanded: boolean,
    theme: Theme,
): Text {
    if (details.todos.length === 0) {
        return new Text(theme.fg("dim", "No active todos"), 0, 0);
    }

    if (details.openCount === 0) {
        return new Text(
            theme.fg("success", "✓ Checklist complete") +
                theme.fg("dim", " • next add starts fresh"),
            0,
            0,
        );
    }

    const orderedTodos = getOrderedTodos(details.todos);
    const displayTodos = expanded ? orderedTodos : orderedTodos.slice(0, 5);
    let listText = theme.fg(
        "muted",
        `${details.openCount} active • ${details.doneCount} done hidden`,
    );

    for (const [index, todo] of displayTodos.entries()) {
        const line = renderTodoLine(todo, theme, {
            position: index + 1,
            showPosition: expanded,
        });
        listText += `\n${line}`;
        if (todo.note) {
            listText += `\n    ${theme.fg("dim", `↳ ${todo.note}`)}`;
        }
    }

    if (!expanded && orderedTodos.length > 5) {
        listText += `\n${theme.fg("dim", `... ${orderedTodos.length - 5} more`)}`;
    }

    return new Text(listText, 0, 0);
}

/**
 * UI component for the /todos command
 */
class TodoListComponent {
    private todos: Todo[];
    private theme: Theme;
    private onClose: () => void;
    private cachedWidth?: number;
    private cachedLines?: string[];

    constructor(todos: Todo[], theme: Theme, onClose: () => void) {
        this.todos = todos;
        this.theme = theme;
        this.onClose = onClose;
    }

    handleInput(data: string): void {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
            this.onClose();
        }
    }

    render(width: number): string[] {
        if (this.cachedLines && this.cachedWidth === width) {
            return this.cachedLines;
        }

        const lines = renderTodoListLines(this.todos, this.theme, width);
        this.cachedWidth = width;
        this.cachedLines = lines;
        return lines;
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }
}

export default function (pi: ExtensionAPI) {
    // In-memory state (reconstructed from session on load)
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

    /**
     * Reconstruct state from session entries.
     * Scans tool results for this tool and applies them in order.
     */
    const reconstructState = (ctx: ExtensionContext) => {
        todos = [];

        for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type !== "message") continue;
            const msg = entry.message;
            if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

            const details = msg.details as TodoDetails | undefined;
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

    // Reconstruct state on session events
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

    // Register the todo tool for the LLM
    pi.registerTool({
        name: "todo",
        label: "Todo",
        description:
            "Manage a lightweight todo list for short-lived self-guidance, not a permanent log. Keep it small and current, avoid logging every micro-step, and reset when the task direction changes. Completed items drop out of the active list while work continues. If all todos are completed, adding a new todo automatically restarts the list at #1. Use position for visible ordering, or id if needed. Actions: list, add (text, note), toggle (id/position), note (id/position, note), clear/reset",
        parameters: TodoParams,

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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

        renderCall(args, theme, _context) {
            let text =
                theme.fg("toolTitle", theme.bold("todo ")) +
                theme.fg("muted", args.action);
            if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
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
                case "list": {
                    return renderTodoListResult(details, expanded, theme);
                }

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

                case "toggle": {
                    return renderSuccessText(theme, getToolResultText(result));
                }

                case "note": {
                    return renderSuccessText(theme, getToolResultText(result));
                }

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

    // Register the /todos command for users
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
