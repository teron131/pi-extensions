/**
 * Interactive questionnaire session flow.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
    Editor,
    type EditorTheme,
    Key,
    matchesKey,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import {
    type Answer,
    buildSubmittedAnswers,
    type ChoiceItem,
    formatAnswerSummary,
    getQuestionById,
    getVisibleQuestions,
    type Question,
    type QuestionnaireResult,
    type QuestionOption,
} from "./schema.js";

export async function runQuestionnaireSession(
    ctx: ExtensionContext,
    questions: Question[],
): Promise<QuestionnaireResult> {
    const isMulti = questions.length > 1;

    return ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
        let currentTab = 0;
        let cachedLines: string[] | undefined;
        let inputMode: "note" | "customChoice" | null = null;
        let inputQuestionId: string | null = null;
        const answers = new Map<string, Answer>();
        const choiceIndexByQuestion = new Map<string, number>();

        const editorTheme: EditorTheme = {
            borderColor: (state) => theme.fg("accent", state),
            selectList: {
                selectedPrefix: (text) => theme.fg("accent", text),
                selectedText: (text) => theme.fg("accent", text),
                description: (text) => theme.fg("muted", text),
                scrollInfo: (text) => theme.fg("dim", text),
                noMatch: (text) => theme.fg("warning", text),
            },
        };
        const editor = new Editor(tui, editorTheme);

        function refresh() {
            cachedLines = undefined;
            const visibleCount = getVisibleQuestions(questions, answers).length;
            if (currentTab > visibleCount) {
                currentTab = visibleCount;
            }
            tui.requestRender();
        }

        function currentVisibleQuestions(): Question[] {
            return getVisibleQuestions(questions, answers);
        }

        function currentQuestion(): Question | undefined {
            return currentVisibleQuestions()[currentTab];
        }

        function buildChoiceItems(question: Question): ChoiceItem[] {
            const items: ChoiceItem[] = [
                { kind: "skip", label: "Skip this question" },
                ...question.options.map((option) => ({
                    kind: "option" as const,
                    label: option.label,
                    description: option.description,
                    option,
                })),
            ];

            if (question.allowOther) {
                items.push({
                    kind: "custom",
                    label: "Type custom response",
                });
            }

            return items;
        }

        function getSelectionIndex(question: Question): number {
            return (
                choiceIndexByQuestion.get(question.id) ??
                answers.get(question.id)?.choiceIndex ??
                0
            );
        }

        function setSelectionIndex(questionId: string, index: number) {
            choiceIndexByQuestion.set(questionId, index);
        }

        function startEditor(
            mode: "note" | "customChoice",
            question: Question,
            initialText: string,
        ) {
            inputMode = mode;
            inputQuestionId = question.id;
            editor.setText(initialText);
            refresh();
        }

        function stopEditor() {
            inputMode = null;
            inputQuestionId = null;
            editor.setText("");
        }

        function commitSkip(question: Question) {
            answers.delete(question.id);
            setSelectionIndex(question.id, 0);
        }

        function commitOptionChoice(
            question: Question,
            option: QuestionOption,
            optionIndex: number,
        ) {
            const next: Answer = {
                id: question.id,
                skipped: false,
                choiceValue: option.value,
                choiceLabel: option.label,
                choiceIndex: optionIndex,
                choiceWasCustom: false,
                note: answers.get(question.id)?.note,
            };
            answers.set(question.id, next);
            setSelectionIndex(question.id, optionIndex);
        }

        function commitCustomChoice(question: Question, value: string) {
            const trimmed = value.trim();
            const choiceValue = trimmed || "(no response)";
            const choiceIndex = question.options.length + 1;
            const next: Answer = {
                id: question.id,
                skipped: false,
                choiceValue,
                choiceLabel: choiceValue,
                choiceIndex,
                choiceWasCustom: true,
                note: answers.get(question.id)?.note,
            };
            answers.set(question.id, next);
            setSelectionIndex(question.id, choiceIndex);
        }

        function commitNote(question: Question, note: string) {
            const trimmed = note.trim();
            const current = answers.get(question.id);
            if (!current && !trimmed) {
                return;
            }

            if (!current && trimmed) {
                answers.set(question.id, {
                    id: question.id,
                    skipped: false,
                    note: trimmed,
                });
                return;
            }

            if (!current) {
                return;
            }

            const next: Answer = {
                ...current,
                note: trimmed || undefined,
                skipped: !current.choiceLabel && !trimmed,
            };
            if (!next.choiceLabel && !next.note) {
                answers.delete(question.id);
                return;
            }
            answers.set(question.id, next);
        }

        function submit(cancelled: boolean) {
            const visibleQuestions = currentVisibleQuestions();
            done({
                questions: visibleQuestions,
                answers: buildSubmittedAnswers(visibleQuestions, answers),
                cancelled,
            });
        }

        function advance() {
            if (!isMulti) {
                submit(false);
                return;
            }

            const visibleCount = currentVisibleQuestions().length;
            if (currentTab < visibleCount - 1) {
                currentTab += 1;
            } else {
                currentTab = visibleCount;
            }
            refresh();
        }

        editor.onSubmit = (value) => {
            if (!inputQuestionId) {
                return;
            }

            const question = getQuestionById(questions, inputQuestionId);
            if (!question) {
                stopEditor();
                return;
            }

            if (inputMode === "customChoice") {
                commitCustomChoice(question, value);
                stopEditor();
                startEditor(
                    "note",
                    question,
                    answers.get(question.id)?.note ?? "",
                );
                return;
            }

            commitNote(question, value);
            stopEditor();
            advance();
        };

        function handleInput(data: string) {
            if (inputMode) {
                if (matchesKey(data, Key.escape)) {
                    stopEditor();
                    refresh();
                    return;
                }
                editor.handleInput(data);
                refresh();
                return;
            }

            const visibleQuestions = currentVisibleQuestions();
            const question = currentQuestion();
            const isSubmitTab = currentTab === visibleQuestions.length;

            if (isMulti) {
                if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                    currentTab =
                        (currentTab + 1) % (visibleQuestions.length + 1);
                    refresh();
                    return;
                }
                if (
                    matchesKey(data, Key.shift("tab")) ||
                    matchesKey(data, Key.left)
                ) {
                    currentTab =
                        (currentTab - 1 + visibleQuestions.length + 1) %
                        (visibleQuestions.length + 1);
                    refresh();
                    return;
                }
            }

            if (isSubmitTab) {
                if (matchesKey(data, Key.enter)) {
                    submit(false);
                } else if (matchesKey(data, Key.escape)) {
                    submit(true);
                }
                return;
            }

            if (!question) {
                if (matchesKey(data, Key.escape)) {
                    submit(true);
                }
                return;
            }

            const items = buildChoiceItems(question);
            const currentSelection = Math.min(
                Math.max(getSelectionIndex(question), 0),
                items.length - 1,
            );
            setSelectionIndex(question.id, currentSelection);

            if (matchesKey(data, Key.up)) {
                setSelectionIndex(
                    question.id,
                    Math.max(0, currentSelection - 1),
                );
                refresh();
                return;
            }
            if (matchesKey(data, Key.down)) {
                setSelectionIndex(
                    question.id,
                    Math.min(items.length - 1, currentSelection + 1),
                );
                refresh();
                return;
            }

            if (data === "n" || data === "N") {
                startEditor(
                    "note",
                    question,
                    answers.get(question.id)?.note ?? "",
                );
                return;
            }

            if (matchesKey(data, Key.escape)) {
                submit(true);
                return;
            }

            if (matchesKey(data, Key.enter)) {
                const selected = items[currentSelection];
                if (!selected || selected.kind === "skip") {
                    commitSkip(question);
                    advance();
                    return;
                }

                if (selected.kind === "custom") {
                    startEditor(
                        "customChoice",
                        question,
                        answers.get(question.id)?.choiceWasCustom
                            ? (answers.get(question.id)?.choiceValue ?? "")
                            : "",
                    );
                    return;
                }

                if (selected.kind === "option" && selected.option) {
                    commitOptionChoice(
                        question,
                        selected.option,
                        currentSelection,
                    );
                    advance();
                }
            }
        }

        function renderChoiceItems(
            question: Question,
            selectedIndex: number,
            addWrapped: (
                text: string,
                initialPrefix?: string,
                continuationPrefix?: string,
            ) => void,
        ) {
            const items = buildChoiceItems(question);
            for (const [index, item] of items.entries()) {
                const selected = index === selectedIndex;
                const prefix = selected ? theme.fg("accent", "> ") : "  ";
                const labelIndex = item.kind === "skip" ? "0" : String(index);
                const numberPrefixRaw = `${labelIndex}. `;
                const numberPrefix = theme.fg(
                    selected ? "accent" : "text",
                    numberPrefixRaw,
                );
                const continuationPrefix = " ".repeat(
                    visibleWidth(prefix) + visibleWidth(numberPrefixRaw),
                );

                addWrapped(
                    theme.fg(selected ? "accent" : "text", item.label),
                    `${prefix}${numberPrefix}`,
                    continuationPrefix,
                );
                if (item.description) {
                    addWrapped(
                        theme.fg("muted", item.description),
                        "     ",
                        "     ",
                    );
                }
            }
        }

        function render(width: number): string[] {
            if (cachedLines) {
                return cachedLines;
            }

            const lines: string[] = [];
            const visibleQuestions = currentVisibleQuestions();
            const question = currentQuestion();
            const add = (line: string) =>
                lines.push(truncateToWidth(line, width));
            const addWrapped = (
                text: string,
                initialPrefix = "",
                continuationPrefix = initialPrefix,
            ) => {
                const availableWidth = Math.max(
                    1,
                    width - visibleWidth(initialPrefix),
                );
                const wrapped = wrapTextWithAnsi(text, availableWidth);
                if (wrapped.length === 0) {
                    add(initialPrefix);
                    return;
                }

                add(`${initialPrefix}${wrapped[0]}`);
                for (const line of wrapped.slice(1)) {
                    add(`${continuationPrefix}${line}`);
                }
            };
            const separator = theme.fg("accent", "─".repeat(width));

            add(separator);

            if (isMulti) {
                const tabs: string[] = ["← "];
                for (let index = 0; index < visibleQuestions.length; index++) {
                    const visibleQuestion = visibleQuestions[index];
                    const isActive = index === currentTab;
                    const isAnswered = answers.has(visibleQuestion.id);
                    const box = isAnswered ? "■" : "□";
                    const color = isAnswered ? "success" : "muted";
                    const text = ` ${box} ${visibleQuestion.label} `;
                    const styled = isActive
                        ? theme.bg("selectedBg", theme.fg("text", text))
                        : theme.fg(color, text);
                    tabs.push(`${styled} `);
                }
                const submitStyled =
                    currentTab === visibleQuestions.length
                        ? theme.bg("selectedBg", theme.fg("text", " ✓ Submit "))
                        : theme.fg("success", " ✓ Submit ");
                tabs.push(`${submitStyled} →`);
                add(` ${tabs.join("")}`);
                lines.push("");
            }

            if (inputMode && question) {
                addWrapped(theme.fg("text", question.prompt), " ", " ");
                lines.push("");
                addWrapped(
                    theme.fg("muted", `${question.noteLabel}:`),
                    " ",
                    " ",
                );
                for (const line of editor.render(width - 2)) {
                    add(` ${line}`);
                }
                lines.push("");
                addWrapped(
                    theme.fg(
                        "dim",
                        inputMode === "customChoice"
                            ? "Enter to save custom response • Esc to cancel"
                            : "Enter to save note • Esc to cancel",
                    ),
                    " ",
                    " ",
                );
            } else if (currentTab === visibleQuestions.length) {
                add(theme.fg("accent", theme.bold(" Ready to submit")));
                lines.push("");
                for (const visibleQuestion of visibleQuestions) {
                    const answer = answers.get(visibleQuestion.id) ?? {
                        id: visibleQuestion.id,
                        skipped: true,
                    };
                    for (const line of formatAnswerSummary(
                        visibleQuestion,
                        answer,
                    ).split("\n")) {
                        addWrapped(theme.fg("text", line));
                    }
                }
                lines.push("");
                addWrapped(
                    theme.fg("success", "Press Enter to submit"),
                    " ",
                    " ",
                );
            } else if (question) {
                const selectionIndex = Math.min(
                    Math.max(getSelectionIndex(question), 0),
                    buildChoiceItems(question).length - 1,
                );
                setSelectionIndex(question.id, selectionIndex);
                addWrapped(theme.fg("text", question.prompt), " ", " ");
                lines.push("");
                renderChoiceItems(question, selectionIndex, addWrapped);
                lines.push("");
                const answer = answers.get(question.id);
                if (answer?.note) {
                    addWrapped(
                        theme.fg("muted", answer.note),
                        theme.fg("muted", ` ${question.noteLabel}: `),
                        " ".repeat(question.noteLabel.length + 3),
                    );
                    lines.push("");
                }
                addWrapped(
                    theme.fg(
                        "dim",
                        isMulti
                            ? "Tab/←→ navigate • ↑↓ select • n note • Enter choose/submit • Esc cancel"
                            : "↑↓ select • n note • Enter choose • Esc cancel",
                    ),
                    " ",
                    " ",
                );
            }

            lines.push("");
            add(separator);

            cachedLines = lines;
            return lines;
        }

        return {
            render,
            invalidate: () => {
                cachedLines = undefined;
            },
            handleInput,
        };
    });
}
