# Real-paper evaluation

`real-papers.json` records source, revision, license, domain and intended main document for public projects. FastWrite does not redistribute manuscript source. Checkouts belong under a user-provided directory using `<root>/<project id>`.

Run `bun run papers:compile -- --root /path/to/checkouts` first. Builds are manifest-driven: each project declares its engine, working directory, preprocessing command, environment and minimum toolchain. The runner forces rebuilds and classifies missing engines, packages, fonts and minimum LaTeX versions as `unavailable`, not manuscript failures. Then run `bun run papers:eval -- --root /path/to/checkouts`.

The output is JSON for CI aggregation. Missing checkouts or compile records are reported as `unavailable`, never counted as successful. Human double-blind evaluation should use the tasks and rubric in `human-evaluation.md`.
