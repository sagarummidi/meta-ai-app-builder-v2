---
name: vercel-react-best-practices
description: Apply Vercel React and Next.js performance principles when planning and generating React TypeScript applications.
license: MIT
source: https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices
---

# Vercel React Best Practices — App Builder Profile

Adapted from Vercel's MIT-licensed `vercel-react-best-practices` skill. This project profile selects the highest-impact rules for generated React applications; it is not a copy of the complete upstream 70-rule collection.

## Apply during generation

1. **Avoid async waterfalls:** start independent data requests together and await them together; do not serialize unrelated fetches.
2. **Keep the bundle lean:** import only what is used; avoid large dependencies for small features; lazy-load genuinely heavy, non-critical views.
3. **Keep components focused:** split only when it improves reuse, clarity, or isolation. Do not create files/components merely to inflate the architecture.
4. **Minimize client work:** prefer static/server-renderable output when the target supports it; keep state local and avoid unnecessary effects or rerenders.
5. **Render efficiently:** use stable keys, derive values during render, and avoid expensive work in render loops.
6. **Preserve requested features:** performance optimization must not remove requested functionality or replace real interactions with decorative placeholders.

## Generation efficiency

- Plan the smallest complete file set that satisfies the user's request. Do not default to 30–50 files; add modules only when complexity requires them.
- Reuse existing components and dependencies when available. Do not add a package for functionality that can be implemented cleanly with existing tools.
- Keep each generated file focused and concise, but never omit required behavior, validation, accessibility, or error states.
- Generate only manifest-listed files and avoid speculative features.
- Prefer parallel work only for independent tasks; keep dependent tasks ordered.

## Scope

Use these principles for generated React/Next.js code. They guide code structure and runtime performance; they do not guarantee lower model inference latency. Do not apply framework-specific Next.js server rules to a client-only Sandpack preview unless the generated target actually runs in Next.js.
