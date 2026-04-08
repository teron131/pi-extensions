/**
 * Questionnaire Tool - Unified tool for asking structured questions
 *
 * Supports optional skip-by-default choices, per-question notes, and simple
 * dependency-based question visibility for follow-up prompts.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
    Editor,
    type EditorTheme,
    Key,
    matchesKey,
    Text,
    truncateToWidth,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// Types
interface QuestionOption {
    value: string;
    label: string;
    description?: string;
}

interface QuestionDependency {
    questionId: string;
    answerValues?: string[];
}

interface Question {
    id: string;
    label: string;
    prompt: string;
    options: QuestionOption[];
    allowOther: boolean;
    noteLabel: string;
    dependsOn?: QuestionDependency;
}

interface Answer {
    id: string;
    skipped: boolean;
    choiceValue?: string;
    choiceLabel?: string;
    choiceIndex?: number;
    choiceWasCustom?: boolean;
    note?: string;
}

interface ChoiceItem {
    kind: "skip" | "option" | "custom";
    label: string;
    description?: string;
    option?: QuestionOption;
}

interface QuestionnaireResult {
    questions: Question[];
    answers: Answer[];
    cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
    value: Type.String({ description: "The value returned when selected" }),
    label: Type.String({ description: "Display label for the option" }),
    description: Type.Optional(
        Type.String({ description: "Optional description shown below label" }),
    ),
});

const QuestionDependencySchema = Type.Object({
    questionId: Type.String({
        description: "Question ID that controls whether this question is shown",
    }),
    answerValues: Type.Optional(
        Type.Array(Type.String(), {
            description:
                "Allowed answer values from the dependency question. If omitted, any non-skipped answer qualifies.",
        }),
    ),
});

const QuestionSchema = Type.Object({
    id: Type.String({ description: "Unique identifier for this question" }),
    label: Type.Optional(
        Type.String({
            description:
                "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
        }),
    ),
    prompt: Type.String({ description: "The full question text to display" }),
    options: Type.Array(QuestionOptionSchema, {
        description: "Available options to choose from",
    }),
    allowOther: Type.Optional(
        Type.Boolean({
            description: "Allow 'Type something' option (default: true)",
        }),
    ),
    noteLabel: Type.Optional(
        Type.String({
            description:
                "Label shown for the freeform note field (default: 'Note')",
        }),
    ),
    dependsOn: Type.Optional(QuestionDependencySchema),
});

const QuestionnaireParams = Type.Object({
    questions: Type.Array(QuestionSchema, {
        description: "Questions to ask the user",
    }),
});

function errorResult(
    message: string,
    questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
    return {
        content: [{ type: "text", text: message }],
        details: { questions, answers: [], cancelled: true },
    };
}

function isQuestionVisible(
    question: Question,
    answersById: Map<string, Answer>,
): boolean {
    if (!question.dependsOn) {
        return true;
    }

    const dependencyAnswer = answersById.get(question.dependsOn.questionId);
    if (!dependencyAnswer || dependencyAnswer.skipped) {
        return false;
    }

    if (
        !question.dependsOn.answerValues ||
        question.dependsOn.answerValues.length === 0
    ) {
        return true;
    }

    return question.dependsOn.answerValues.includes(
        dependencyAnswer.choiceValue ?? "",
    );
}

function getVisibleQuestions(
    questions: Question[],
    answersById: Map<string, Answer>,
): Question[] {
    return questions.filter((question) =>
        isQuestionVisible(question, answersById),
    );
}

function buildSubmittedAnswers(
    questions: Question[],
    answersById: Map<string, Answer>,
): Answer[] {
    return questions.map((question) => {
        const answer = answersById.get(question.id);
        if (answer) {
            return answer;
        }

        return { id: question.id, skipped: true };
    });
}

function getQuestionById(
    questions: Question[],
    questionId: string,
): Question | undefined {
    return questions.find((question) => question.id === questionId);
}

function formatAnswerSummary(question: Question, answer: Answer): string {
    if (answer.skipped) return `${question.label}: skipped`;

    const choicePart = answer.choiceLabel
        ? ` ${answer.choiceWasCustom ? `custom: ${answer.choiceLabel}` : answer.choiceLabel}`
        : "";
    const header = `${question.label}:${choicePart}`;
    return answer.note ? `${header}\nNote: ${answer.note}` : header;
}

export default function questionnaire(pi: ExtensionAPI) {
    pi.registerTool({
        name: "questionnaire",
        label: "Questionnaire",
        description:
            "Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
        parameters: QuestionnaireParams,

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            if (!ctx.hasUI) {
                return errorResult(
                    "Error: UI not available (running in non-interactive mode)",
                );
            }
            if (params.questions.length === 0) {
                return errorResult("Error: No questions provided");
            }

            // Normalize questions with defaults
            const questions: Question[] = params.questions.map((q, i) => ({
                ...q,
                label: q.label || `Q${i + 1}`,
                allowOther: q.allowOther !== false,
                noteLabel: q.noteLabel || "Note",
            }));

            const isMulti = questions.length > 1;
            const result = await ctx.ui.custom<QuestionnaireResult>(
                (tui, theme, _kb, done) => {
                    let currentTab = 0;
                    let cachedLines: string[] | undefined;
                    let inputMode: "note" | "customChoice" | null = null;
                    let inputQuestionId: string | null = null;
                    const answers = new Map<string, Answer>();
                    const choiceIndexByQuestion = new Map<string, number>();

                    const editorTheme: EditorTheme = {
                        borderColor: (s) => theme.fg("accent", s),
                        selectList: {
                            selectedPrefix: (t) => theme.fg("accent", t),
                            selectedText: (t) => theme.fg("accent", t),
                            description: (t) => theme.fg("muted", t),
                            scrollInfo: (t) => theme.fg("dim", t),
                            noMatch: (t) => theme.fg("warning", t),
                        },
                    };
                    const editor = new Editor(tui, editorTheme);

                    function refresh() {
                        cachedLines = undefined;
                        const visibleCount = getVisibleQuestions(
                            questions,
                            answers,
                        ).length;
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

                    function buildChoiceItems(
                        question: Question,
                    ): ChoiceItem[] {
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

                    function setSelectionIndex(
                        questionId: string,
                        index: number,
                    ) {
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

                    function commitCustomChoice(
                        question: Question,
                        value: string,
                    ) {
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
                            answers: buildSubmittedAnswers(
                                visibleQuestions,
                                answers,
                            ),
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

                        const question = getQuestionById(
                            questions,
                            inputQuestionId,
                        );
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
                        const isSubmitTab =
                            currentTab === visibleQuestions.length;

                        if (isMulti) {
                            if (
                                matchesKey(data, Key.tab) ||
                                matchesKey(data, Key.right)
                            ) {
                                currentTab =
                                    (currentTab + 1) %
                                    (visibleQuestions.length + 1);
                                refresh();
                                return;
                            }
                            if (
                                matchesKey(data, Key.shift("tab")) ||
                                matchesKey(data, Key.left)
                            ) {
                                currentTab =
                                    (currentTab -
                                        1 +
                                        visibleQuestions.length +
                                        1) %
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
                                Math.min(
                                    items.length - 1,
                                    currentSelection + 1,
                                ),
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
                                        ? (answers.get(question.id)
                                              ?.choiceValue ?? "")
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
                        add: (line: string) => void,
                    ) {
                        const items = buildChoiceItems(question);
                        for (const [index, item] of items.entries()) {
                            const selected = index === selectedIndex;
                            const prefix = selected
                                ? theme.fg("accent", "> ")
                                : "  ";
                            const labelIndex =
                                item.kind === "skip" ? "0" : String(index);
                            add(
                                prefix +
                                    theme.fg(
                                        selected ? "accent" : "text",
                                        `${labelIndex}. ${item.label}`,
                                    ),
                            );
                            if (item.description) {
                                add(
                                    `     ${theme.fg("muted", item.description)}`,
                                );
                            }
                        }
                    }

                    function render(width: number): string[] {
                        if (cachedLines) return cachedLines;

                        const lines: string[] = [];
                        const visibleQuestions = currentVisibleQuestions();
                        const question = currentQuestion();
                        const add = (s: string) =>
                            lines.push(truncateToWidth(s, width));
                        const separator = theme.fg("accent", "─".repeat(width));

                        add(separator);

                        if (isMulti) {
                            const tabs: string[] = ["← "];
                            for (let i = 0; i < visibleQuestions.length; i++) {
                                const visibleQuestion = visibleQuestions[i];
                                const isActive = i === currentTab;
                                const isAnswered = answers.has(
                                    visibleQuestion.id,
                                );
                                const box = isAnswered ? "■" : "□";
                                const color = isAnswered ? "success" : "muted";
                                const text = ` ${box} ${visibleQuestion.label} `;
                                const styled = isActive
                                    ? theme.bg(
                                          "selectedBg",
                                          theme.fg("text", text),
                                      )
                                    : theme.fg(color, text);
                                tabs.push(`${styled} `);
                            }
                            const submitStyled =
                                currentTab === visibleQuestions.length
                                    ? theme.bg(
                                          "selectedBg",
                                          theme.fg("text", " ✓ Submit "),
                                      )
                                    : theme.fg("success", " ✓ Submit ");
                            tabs.push(`${submitStyled} →`);
                            add(` ${tabs.join("")}`);
                            lines.push("");
                        }

                        if (inputMode && question) {
                            add(theme.fg("text", ` ${question.prompt}`));
                            lines.push("");
                            add(theme.fg("muted", ` ${question.noteLabel}:`));
                            for (const line of editor.render(width - 2)) {
                                add(` ${line}`);
                            }
                            lines.push("");
                            add(
                                theme.fg(
                                    "dim",
                                    inputMode === "customChoice"
                                        ? " Enter to save custom response • Esc to cancel"
                                        : " Enter to save note • Esc to cancel",
                                ),
                            );
                        } else if (currentTab === visibleQuestions.length) {
                            add(
                                theme.fg(
                                    "accent",
                                    theme.bold(" Ready to submit"),
                                ),
                            );
                            lines.push("");
                            for (const visibleQuestion of visibleQuestions) {
                                const answer = answers.get(
                                    visibleQuestion.id,
                                ) ?? {
                                    id: visibleQuestion.id,
                                    skipped: true,
                                };
                                for (const line of formatAnswerSummary(
                                    visibleQuestion,
                                    answer,
                                ).split("\n")) {
                                    add(theme.fg("text", line));
                                }
                            }
                            lines.push("");
                            add(theme.fg("success", " Press Enter to submit"));
                        } else if (question) {
                            const selectionIndex = Math.min(
                                Math.max(getSelectionIndex(question), 0),
                                buildChoiceItems(question).length - 1,
                            );
                            setSelectionIndex(question.id, selectionIndex);
                            add(theme.fg("text", ` ${question.prompt}`));
                            lines.push("");
                            renderChoiceItems(question, selectionIndex, add);
                            lines.push("");
                            const answer = answers.get(question.id);
                            if (answer?.note) {
                                add(
                                    theme.fg(
                                        "muted",
                                        ` ${question.noteLabel}: ${answer.note}`,
                                    ),
                                );
                                lines.push("");
                            }
                            add(
                                theme.fg(
                                    "dim",
                                    isMulti
                                        ? " Tab/←→ navigate • ↑↓ select • n note • Enter choose/submit • Esc cancel"
                                        : " ↑↓ select • n note • Enter choose • Esc cancel",
                                ),
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
                },
            );

            if (result.cancelled) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "User cancelled the questionnaire",
                        },
                    ],
                    details: result,
                };
            }

            const answerLines = result.questions.map((question) => {
                const answer = result.answers.find(
                    (item) => item.id === question.id,
                );
                return answer
                    ? formatAnswerSummary(question, answer)
                    : `${question.label}: skipped`;
            });

            return {
                content: [{ type: "text", text: answerLines.join("\n") }],
                details: result,
            };
        },

        renderCall(args, theme, _context) {
            const qs = (args.questions as Question[]) || [];
            const count = qs.length;
            const labels = qs.map((q) => q.label || q.id).join(", ");
            let text = theme.fg("toolTitle", theme.bold("questionnaire "));
            text += theme.fg(
                "muted",
                `${count} question${count !== 1 ? "s" : ""}`,
            );
            if (labels) {
                text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
            }
            return new Text(text, 0, 0);
        },

        renderResult(result, _options, theme, _context) {
            const details = result.details as QuestionnaireResult | undefined;
            if (!details) {
                const text = result.content[0];
                return new Text(text?.type === "text" ? text.text : "", 0, 0);
            }
            if (details.cancelled) {
                return new Text(theme.fg("warning", "Cancelled"), 0, 0);
            }
            const lines = details.questions.map((question) => {
                const answer = details.answers.find(
                    (item) => item.id === question.id,
                );
                if (!answer || answer.skipped) {
                    return `${theme.fg("success", "✓ ")}${theme.fg("accent", question.id)}: ${theme.fg("muted", "skipped")}`;
                }

                let text = `${theme.fg("success", "✓ ")}${theme.fg("accent", question.id)}: `;
                if (answer.choiceLabel) {
                    text += answer.choiceWasCustom
                        ? `${theme.fg("muted", "custom: ")}${answer.choiceLabel}`
                        : answer.choiceLabel;
                }
                if (answer.note) {
                    text += `\n${theme.fg("muted", `Note: ${answer.note}`)}`;
                }
                return text;
            });
            return new Text(lines.join("\n"), 0, 0);
        },
    });
}
