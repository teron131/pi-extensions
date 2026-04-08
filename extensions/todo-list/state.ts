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

export interface TodoInput {
    text: string;
    note?: string;
}

export interface TodoStats {
    doneCount: number;
    openCount: number;
    totalCount: number;
}

export type TodoAction =
    | "list"
    | "add"
    | "toggle"
    | "clear"
    | "note"
    | "remove"
    | "reset";

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
    items?: TodoInput[];
    id?: number;
    position?: number;
    ids?: number[];
    positions?: number[];
}

export interface TodoTarget {
    todo: Todo;
    position?: number;
}

const TodoActionSchema = Type.Union([
    Type.Literal("list"),
    Type.Literal("add"),
    Type.Literal("toggle"),
    Type.Literal("clear"),
    Type.Literal("note"),
    Type.Literal("remove"),
    Type.Literal("reset"),
]);

export const TODO_WIDGET_ID = "todo-list";
export const TODO_WIDGET_TOGGLE_SHORTCUT = Key.ctrlShift("t");
export const TODO_WIDGET_TOGGLE_HINT = "Ctrl+Shift+T";
export const TODO_WIDGET_COMPACT_TODO_COUNT = 4;
export const TODO_STATE_ENTRY = "todo-state";

export const TodoParams = Type.Object({
    action: TodoActionSchema,
    text: Type.Optional(
        Type.String({ description: "Todo text (for single add)" }),
    ),
    note: Type.Optional(
        Type.String({ description: "Optional note or update text" }),
    ),
    items: Type.Optional(
        Type.Array(
            Type.Object({
                text: Type.String({ description: "Todo text" }),
                note: Type.Optional(
                    Type.String({ description: "Optional note for this todo" }),
                ),
            }),
            {
                description: "Multiple todos to add at once",
            },
        ),
    ),
    id: Type.Optional(
        Type.Number({
            description: "Internal todo ID (optional for toggle/note/remove)",
        }),
    ),
    position: Type.Optional(
        Type.Number({
            description:
                "Visible todo position (1-based) for toggle/note/remove",
        }),
    ),
    ids: Type.Optional(
        Type.Array(Type.Number(), {
            description: "Multiple internal todo IDs for remove",
        }),
    ),
    positions: Type.Optional(
        Type.Array(Type.Number(), {
            description: "Multiple visible todo positions (1-based) for remove",
        }),
    ),
});

let todos: Todo[] = [];
type TodosListener = (todos: Todo[]) => void;
const listeners = new Set<TodosListener>();

function notifyTodosChanged(): void {
    const snapshot = getTodos();
    for (const listener of listeners) {
        listener(snapshot);
    }
}

export function subscribeTodos(listener: TodosListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getTodos(): Todo[] {
    return cloneTodos(todos);
}

export function setTodos(nextTodos: Todo[]): void {
    todos = cloneTodos(nextTodos);
    notifyTodosChanged();
}

export function clearTodos(): void {
    todos = [];
    notifyTodosChanged();
}

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
    return todos.length ? Math.max(...todos.map((t) => t.id)) + 1 : 1;
}

export function shouldResetCompletedTodos(todos: Todo[]): boolean {
    return todos.length > 0 && todos.every((todo) => todo.done);
}

export function getVisibleTodos(todos: Todo[]): Todo[] {
    const openTodos = todos.filter((todo) => !todo.done);
    return openTodos.length > 0 ? openTodos : todos;
}

export function getOrderedTodos(todos: Todo[]): Todo[] {
    return [
        ...todos.filter((todo) => !todo.done),
        ...todos.filter((todo) => todo.done),
    ];
}

export function getOrderedVisibleTodos(todos: Todo[]): Todo[] {
    return getOrderedTodos(getVisibleTodos(todos));
}

export function findTodoTarget(
    todos: Todo[],
    params: { id?: number; position?: number },
): { todo?: Todo; position?: number; error?: string } {
    const visibleTodos = getOrderedVisibleTodos(todos);

    if (params.position !== undefined) {
        if (params.position < 1 || params.position > visibleTodos.length) {
            return {
                error: `item ${params.position} not found`,
            };
        }

        const todo = visibleTodos[params.position - 1];
        return {
            todo,
            position: params.position,
        };
    }

    if (params.id !== undefined) {
        const todo = todos.find((candidate) => candidate.id === params.id);
        if (!todo) {
            return {
                error: `todo id ${params.id} not found`,
            };
        }

        const visibleIndex = visibleTodos.findIndex(
            (candidate) => candidate.id === todo.id,
        );
        return {
            todo,
            position: visibleIndex >= 0 ? visibleIndex + 1 : undefined,
        };
    }

    return {
        error: "id or position required",
    };
}

export function findTodoTargets(
    todos: Todo[],
    params: {
        id?: number;
        position?: number;
        ids?: number[];
        positions?: number[];
    },
): { targets?: TodoTarget[]; error?: string } {
    const visibleTodos = getOrderedVisibleTodos(todos);
    const targets: TodoTarget[] = [];
    const seenIds = new Set<number>();

    const addTarget = (todo: Todo, position?: number): void => {
        if (seenIds.has(todo.id)) return;
        seenIds.add(todo.id);
        targets.push({ todo, position });
    };

    const positions = [
        ...(params.positions ?? []),
        ...(params.position !== undefined ? [params.position] : []),
    ];
    for (const pos of positions) {
        if (pos < 1 || pos > visibleTodos.length) {
            return { error: `item ${pos} not found` };
        }
        addTarget(visibleTodos[pos - 1], pos);
    }

    const ids = [
        ...(params.ids ?? []),
        ...(params.id !== undefined ? [params.id] : []),
    ];
    for (const id of ids) {
        const todo = todos.find((c) => c.id === id);
        if (!todo) return { error: `todo id ${id} not found` };
        const visibleIdx = visibleTodos.findIndex((c) => c.id === todo.id);
        addTarget(todo, visibleIdx >= 0 ? visibleIdx + 1 : undefined);
    }

    if (!targets.length) {
        return { error: "id, ids, position, or positions required" };
    }
    return { targets };
}

export function formatTodoTargetLabel(todo: Todo, position?: number): string {
    return position !== undefined ? `item ${position}` : `todo ${todo.id}`;
}

export function formatTodoSummary(todo: Todo, position: number): string {
    return `${position}. [${todo.done ? "x" : " "}] ${todo.text}`;
}

export function formatAddedTodoMessage(
    addedTodos: Todo[],
    restarted: boolean,
): string {
    if (addedTodos.length === 1) {
        const [todo] = addedTodos;
        const noteText = todo.note ? `\nNote: ${todo.note}` : "";
        if (restarted) {
            return `Restarted completed checklist\nAdded: ${todo.text}${noteText}`;
        }

        return `Added: ${todo.text}${noteText}`;
    }

    const prefix = restarted
        ? "Restarted completed checklist\nAdded todos:"
        : "Added todos:";
    const items = addedTodos.map((todo) => {
        const noteText = todo.note ? ` (${todo.note})` : "";
        return `- ${todo.text}${noteText}`;
    });
    return [prefix, ...items].join("\n");
}

export function formatRemovedTodoMessage(targets: TodoTarget[]): string {
    if (targets.length === 1) {
        const [target] = targets;
        return `Removed ${formatTodoTargetLabel(target.todo, target.position)}: ${target.todo.text}`;
    }

    return [
        `Removed ${targets.length} todos:`,
        ...targets.map(
            (target) =>
                `- ${formatTodoTargetLabel(target.todo, target.position)}: ${target.todo.text}`,
        ),
    ].join("\n");
}

export function formatToggleTodoMessage(todo: Todo, label: string): string {
    const statusText = todo.done ? "Completed" : "Reopened";
    const noteText = todo.note ? `\nNote: ${todo.note}` : "";
    return `${statusText} ${label}: ${todo.text}${noteText}`;
}

export function formatTodoNoteMessage(label: string, note?: string): string {
    return note
        ? `Updated note for ${label}\nNote: ${note}`
        : `Cleared note for ${label}`;
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
