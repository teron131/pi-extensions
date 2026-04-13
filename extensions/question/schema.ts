/**
 * Questionnaire schemas, types, and pure helpers.
 */

import { Type } from "@sinclair/typebox";

export interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

export interface QuestionDependency {
	questionId: string;
	answerValues?: string[];
}

export interface QuestionInput {
	id: string;
	label?: string;
	prompt: string;
	options: QuestionOption[];
	allowOther?: boolean;
	noteLabel?: string;
	dependsOn?: QuestionDependency;
}

export interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
	noteLabel: string;
	dependsOn?: QuestionDependency;
}

export interface Answer {
	id: string;
	skipped: boolean;
	choiceValue?: string;
	choiceLabel?: string;
	choiceIndex?: number;
	choiceWasCustom?: boolean;
	note?: string;
}

export interface ChoiceItem {
	kind: "skip" | "option" | "custom";
	label: string;
	description?: string;
	option?: QuestionOption;
}

export interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

export interface QuestionnaireToolParams {
	questions: QuestionInput[];
}

export const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(
		Type.String({ description: "Optional description shown below label" }),
	),
});

export const QuestionDependencySchema = Type.Object({
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

export const QuestionSchema = Type.Object({
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
			description: "Label shown for the freeform note field (default: 'Note')",
		}),
	),
	dependsOn: Type.Optional(QuestionDependencySchema),
});

export const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "Questions to ask the user",
	}),
});

export function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

export function isQuestionVisible(
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

export function getVisibleQuestions(
	questions: Question[],
	answersById: Map<string, Answer>,
): Question[] {
	return questions.filter((question) =>
		isQuestionVisible(question, answersById),
	);
}

export function buildSubmittedAnswers(
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

export function getQuestionById(
	questions: Question[],
	questionId: string,
): Question | undefined {
	return questions.find((question) => question.id === questionId);
}

export function formatAnswerSummary(
	question: Question,
	answer: Answer,
): string {
	if (answer.skipped) {
		return `${question.label}: skipped`;
	}

	const choicePart = answer.choiceLabel
		? ` ${answer.choiceWasCustom ? `custom: ${answer.choiceLabel}` : answer.choiceLabel}`
		: "";
	const header = `${question.label}:${choicePart}`;
	return answer.note ? `${header}\nNote: ${answer.note}` : header;
}
