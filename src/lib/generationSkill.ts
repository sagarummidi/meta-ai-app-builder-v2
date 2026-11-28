/**
 * Curated runtime guidance adapted from Vercel's MIT-licensed
 * vercel-react-best-practices skill.
 * Source: https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices
 *
 * Keep this compact: it is injected into each generation call, so a long
 * ruleset would increase prompt tokens and could slow generation.
 */
export const GENERATION_SKILL_GUIDANCE = `Apply these React performance and generation-efficiency rules:
- Plan the smallest complete file set that satisfies the user's requirements; do not over-engineer or create files without a clear purpose.
- Preserve every requested feature and implement real interactions, validation, accessibility, loading, and error states.
- Avoid async waterfalls: run independent data requests in parallel.
- Keep dependencies and bundles lean; reuse available libraries and lazy-load only genuinely heavy non-critical views.
- Keep components focused; avoid unnecessary state, effects, rerenders, and expensive render-loop work.
- Generate only requested/manifest-listed files; keep code concise without omitting required behavior.
- Use framework-specific server features only when the target runtime supports them.`;
