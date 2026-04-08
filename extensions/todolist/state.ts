/**
 * Todo list state, schema, and pure helpers.
 */

import { Key } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

export interface Todo {
    id: number;
    text: string;
    done: boolean;
    note?: string;
}

export interface TodoStats {
    doneCount: number;
    openCount: number;
    totalCount: number;
}

export type TodoAction = "list" | "add" | "toggle" | "clear" | "note" | "reset";

export interface TodoDetails {
    action: TodoAction;
    todos: Todo[];
    nextId: number;
    doneCount: number;
    openCount: number;
    totalCount: number;
    error?: string;
}

export interface TodoToolParams {
    action: TodoAction;
    text?: string;
    note?: string;
    id?: number;
    position?: number;
}

const TodoActionSchema = Type.Union([
    Type.Literal("list"),
    Type.Literal("add"),
    Type.Literal("toggle"),
    Type.Literal("clear"),
    Type.Literal("note"),
    Type.Literal("reset"),
]);

export const TODO_WIDGET_ID = "todo-list";
export const TODO_WIDGET_TOGGLE_SHORTCUT = Key.ctrlShift("t");
export const TODO_WIDGET_TOGGLE_HINT = "Ctrl+Shift+T";
export const TODO_WIDGET_COMPACT_TODO_COUNT = 4;

export const TodoParams = Type.Object({
    action: TodoActionSchema,
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

export function getTodoStats(todos: Todo[]): TodoStats {
    const doneCount = todos.filter((todo) => todo.done).length;
    return {
        doneCount,
        openCount: todos.length - doneCount,
        totalCount: todos.length,
    };
}

export function cloneTodos(todos: Todo[]): Todo[] {
    return todos.map((todo) => ({ ...todo }));
}

export function getNextTodoId(todos: Todo[]): number {
    if (!todos.length) {
        return 1;
    }

    return Math.max(...todos.map((todo) => todo.id)) + 1;
}

export function shouldResetCompletedTodos(todos: Todo[]): boolean {
    return todos.length > 0 && todos.every((todo) => todo.done);
}

export function getOrderedTodos(todos: Todo[]): Todo[] {
    return [
        ...todos.filter((todo) => !todo.done),
        ...todos.filter((todo) => todo.done),
    ];
}

export function normalizeTodos(todos: Todo[]): Todo[] {
    const openTodos = todos.filter((todo) => !todo.done);
    return openTodos.length > 0 ? openTodos : todos;
}

export function findTodoTarget(
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

export function formatTodoSummary(todo: Todo, position: number): string {
    return `${position}. [${todo.done ? "x" : " "}] ${todo.text}`;
}

export function formatAddedTodoMessage(todo: Todo, restarted: boolean): string {
    const noteText = todo.note ? `\nNote: ${todo.note}` : "";
    if (restarted) {
        return `Restarted completed checklist\nAdded: ${todo.text}${noteText}`;
    }

    return `Added: ${todo.text}${noteText}`;
}

export function formatToggleTodoMessage(todo: Todo, position: number): string {
    const statusText = todo.done ? "Completed" : "Reopened";
    const noteText = todo.note ? `\nNote: ${todo.note}` : "";
    return `${statusText} item ${position}: ${todo.text}${noteText}`;
}

export function formatTodoNoteMessage(position: number, note?: string): string {
    return note
        ? `Updated note for item ${position}\nNote: ${note}`
        : `Cleared note for item ${position}`;
}

export function formatResetTodoMessage(
    action: TodoDetails["action"],
    count: number,
): string {
    if (action === "reset") {
        return "Reset todo list; next item will start at #1";
    }

    return `Cleared ${count} todo${count === 1 ? "" : "s"}; next item will start at #1`;
}
