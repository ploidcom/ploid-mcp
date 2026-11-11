import { z } from "zod";

/**
 * Tool-input bounds that stay out of the advertised JSON schema. Some LLM
 * clients clamp arguments to a schema's `minimum`/`maximum`/`maxLength`
 * before calling the tool, so an out-of-range request silently becomes a
 * billable in-range one. The range is stated in the field description and
 * checked here instead, and the backend repeats it with a free 422.
 */
export function boundedInt(min: number, max: number) {
    return z.number().check((ctx) => {
        if (Number.isInteger(ctx.value) && ctx.value >= min && ctx.value <= max) return;
        ctx.issues.push({ code: "custom", input: ctx.value, message: `must be a whole number between ${min} and ${max} (got ${ctx.value})` });
    });
}

export function boundedString(min: number, max: number) {
    return z
        .string()
        .trim()
        .min(min)
        .check((ctx) => {
            if (ctx.value.length <= max) return;
            ctx.issues.push({ code: "custom", input: ctx.value, message: `must be at most ${max} characters (got ${ctx.value.length})` });
        });
}

export function boundedArray<T extends z.ZodType>(item: T, max: number) {
    return z.array(item).check((ctx) => {
        if (ctx.value.length <= max) return;
        ctx.issues.push({ code: "custom", input: ctx.value, message: `must have at most ${max} items (got ${ctx.value.length})` });
    });
}

export function rangeNote(min: number, max: number, fallback?: number): string {
    return `Whole number from ${min} to ${max}${fallback === undefined ? "" : `, default ${fallback}`}. Values outside this range are rejected without charge.`;
}
