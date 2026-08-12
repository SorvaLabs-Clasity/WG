# Development

## Layout

```
github-control-hub/
  backend/      Express API, services, jobs, AWS guardrail engine
  frontend/     React + Vite + Tailwind
  desktop/      Electron shell
  infra/        CDK stack
scripts/        setup and deploy
docs/           this
```

## Running locally

```bash
cd github-control-hub/desktop && npm run dev
```

Builds the backend and frontend, then opens Electron against the local backend.

## Where to add things

| Adding | Goes in |
|---|---|
| A security check | `backend/src/services/graphService.ts`, plus `REQUIRES` |
| An AWS guardrail kind | `backend/src/aws-guardrails/catalog.ts` |
| A graph edge type | `backend/src/jobs/graphAggregator.ts` |
| An API route | `backend/src/routes/`, mounted in `server.ts` |
| A page | `frontend/src/pages/`, plus `router.tsx` and `Navbar.tsx` |

## Conventions worth knowing

**Design system first.** `frontend/src/design/` holds `Page`, `StatusSlab`,
`Block`, `InsetRow`, `Note`, `Pill`, `Empty`, `Spinner`. Reach for these before
writing new Tailwind — and never hardcode a dark background, which breaks light
mode.

**Comments say why, not what.** The code says what it does. Comments exist to
record the decision, the constraint, or the failure that motivated it.

**Missing data is not a clean result.** Any check that could return an empty
list because data was never collected must say so instead.

## Read next

- [Testing](testing.md)
