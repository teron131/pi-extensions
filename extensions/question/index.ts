/**
 * Question Tool - Unified tool for asking structured questions.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import {
    errorResult,
    formatAnswerSummary,
    type Question,
    QuestionnaireParams,
    type QuestionnaireResult,
    type QuestionnaireToolParams,
} from "./schema.js";
import { runQuestionnaireSession } from "./session.js";

export default function question(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "question",
        label: "Question",
        description:
            "Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
        parameters: QuestionnaireParams as never,

        async execute(
            _toolCallId,
            params: QuestionnaireToolParams,
            _signal,
            _onUpdate,
            ctx,
        ) {
            if (!ctx.hasUI) {
                return errorResult(
                    "Error: UI not available (running in non-interactive mode)",
                );
            }
            if (params.questions.length === 0) {
                return errorResult("Error: No questions provided");
            }

            const questions: Question[] = params.questions.map(
                (question, index) => ({
                    ...question,
                    label: question.label || `Q${index + 1}`,
                    allowOther: question.allowOther !== false,
                    noteLabel: question.noteLabel || "Note",
                }),
            );

            const result = await runQuestionnaireSession(ctx, questions);
            if (result.cancelled) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "User cancelled the question flow",
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

        renderCall(args: QuestionnaireToolParams, theme, _context) {
            const questions =
                (args.questions as QuestionnaireToolParams["questions"]) ?? [];
            const count = questions.length;
            const labels = questions
                .map((question) => question.label || question.id)
                .join(", ");
            let text = theme.fg("toolTitle", theme.bold("question "));
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
                const textBlock = result.content[0];
                return new Text(
                    textBlock?.type === "text" ? textBlock.text : "",
                    0,
                    0,
                );
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
