// Copied once from the extension's background.ts, then the core's own (docs/PLAN.md, Repositories).

// Input token budget per provider. Groq's free tier allows ~8000 tokens a minute, input and output together (N4)
export const INPUT_TOKEN_BUDGET: Record<string, number> = { groq: 4000 };

// M0 measured 2.84 characters per token for Ukrainian with qwen's tokenizer, so this counts about 5% short
export const estimateTokens = (text: string) => Math.ceil(text.length / 3);
