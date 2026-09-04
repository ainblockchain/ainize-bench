# graph/ — The Graph integration

Everything that touches **The Graph** lives here, kept apart from the marketplace packages so it can be
opened as a standalone repository (a hackathon submission needs a public repo) without dragging the rest
of Ainize with it.

What belongs here:

- **Subgraph → dataset**: pipelines that turn a Standardized Subgraph query (Messari-style schemas,
  ERC-4626 tokenized vaults, Agent0/ERC-8004) or a Substreams package into a canonical Ainize teaching
  dataset (`{prompt, answer}` rows) with provenance — which subgraph, which query, which block, row hashes.
- **Substreams modules** we author or extend, and any standardized-schema work.
- **The MCP client side** that calls The Graph's Subgraph MCP and hands its rows to `packages/mcp`.
- **The benchmark harness** that measures the quality difference between: base model · base + Subgraph MCP ·
  base + Ainize knowledge · both — accuracy, latency, tokens, cost, hallucinated-address rate, side effects.
- Demo scripts, evidence and the submission write-up.

What does *not* belong here: the marketplace itself (`packages/*`), the trainer (`/mnt/newdata/qwen3.8`),
or anything that would break if The Graph were removed.

Live data only: every pipeline reads from a Graph provider (Subgraph Studio API key, The Graph Market for
Substreams). Mocked, local-only or static datasets do not qualify for the tracks this targets and are not
accepted here either.
