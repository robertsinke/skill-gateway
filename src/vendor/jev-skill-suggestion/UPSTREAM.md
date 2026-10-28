# Vendored Jev skill-suggestion policy

Source: https://github.com/davila7/claude-code-templates/tree/4efb68547887d2a4dd714074bd7ecb4171dc9fee/cli-tool/components/mods/productivity/jev-skill-suggestion

- Revision: `4efb68547887d2a4dd714074bd7ecb4171dc9fee`
- Original path: `hooks/policy.ts`
- SHA-256: `85b18ffaaf5eb43c41360f77ec525627605ad7cf1fdec081a8ab5d7ae954244c`
- License: MIT; original license reproduced in `LICENSE`.

`policy.ts` is an unchanged copy, including unused Claude-specific helpers. Keeping the small, dependency-free upstream module intact makes provenance and behavior easy to verify; we do not maintain a subtly different copy of its decision algorithm. The Pi adapter uses its request builders, response readers, shortlist, gate, fit rejection and final decision. The original Claude hook's I/O and injection wrapper are adapted separately in `src/jev-skill-suggestion.ts` and `extensions/jev-skill-suggestion.ts`.

Update this pin, checksum test and attribution together when intentionally testing another upstream version. Do not silently change thresholds or prompts inside the vendored file.
