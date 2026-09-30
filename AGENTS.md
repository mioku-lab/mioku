# Mioku

Plugin-based chat bot framework. Platforms connect through adapters (OneBot v11 / icqq /
QQ official / stdin); everything else is plugins and services.

- `packages/mioku` — the framework
- `packages/mioku-plugin-*` · `mioku-service-*` · `mioku-adapter-*` — the ecosystem
- `example/` — runnable playground with every package linked
- `docs/` — the manual

```bash
bun run typecheck    # whole workspace
bun run start        # boots example/
bun run build
```

There is no test suite. Verify a change by running it.

## Development skills

Mioku's development skills live at https://github.com/mioku-lab/skills — plugin, service,
adapter and core development, code conventions, and debugging.

**Install them before writing code.**

If `skills/skills/` exists in this repository, link the local copy into the agent skills
directory:

```bash
mkdir -p .agents/skills && ln -sf "$PWD"/skills/skills/* .agents/skills/
```

Otherwise install from GitHub:

```bash
npx skills add mioku-lab/skills
```

Then work from the `mioku-developer` skill.
