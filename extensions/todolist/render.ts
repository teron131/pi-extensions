/**
 * Todo list rendering helpers and UI component.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import {
    getOrderedTodos,
    getTodoStats,
    TODO_WIDGET_COMPACT_TODO_COUNT,
    TODO_WIDGET_TOGGLE_HINT,
    type Todo,
    type TodoDetails,
} from "./state.js";

export function renderTodoLine(
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

export function renderTodoNoteLine(todo: Todo, theme: Theme): string | null {
    if (!todo.note) {
        return null;
    }

    return `     ${theme.fg("dim", `↳ ${todo.note}`)}`;
}

export function renderTodoListLines(
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

export function renderTodoWidgetLines(
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

export function getToolResultText(result: {
    content: { type: string; text?: string }[];
}): string {
    const text = result.content[0];
    return text?.type === "text" && typeof text.text === "string"
        ? text.text
        : "";
}

export function renderSuccessText(theme: Theme, text: string): Text {
    return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text), 0, 0);
}

export function renderTodoListResult(
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

export class TodoListComponent {
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
