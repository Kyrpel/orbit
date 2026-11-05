# Examples

## A disposable repository to try Orbit

```bash
pnpm demo:repo ~/orbit-demo
pnpm orbit repo add ~/orbit-demo/shop-api
pnpm orbit run "Add an optional percentage discount to cartTotal" --repo shop-api \
  -d "cartTotal(items, discountPercent = 0). Throw RangeError outside 0-100. Add tests." --watch
```

With the scripted runtime you see the whole flow (worktree, checks, approvals, local commit) without AI. With Claude Code or an API key you get a real implementation.

## Good mission descriptions

Concrete and checkable beats long:

```
Title: Return 429 with Retry-After when login is rate limited

Limit POST /login to 5 attempts per minute per IP.
On the 6th attempt return 429 and a Retry-After header in seconds.
Reuse the existing RateLimiter in src/lib/rate-limit.ts.
Add tests for the limit and the reset.
```

## Verification commands by stack

Orbit detects these when you connect a repository; adjust them in Projects → Checks. Commands run without a shell, one command per entry.

| Stack | Setup | Verification |
|---|---|---|
| pnpm | `pnpm install --frozen-lockfile` | `pnpm run typecheck`, `pnpm run lint`, `pnpm test` |
| npm | `npm ci` | `npm run lint`, `npm test` |
| Python (uv) | `uv sync` | `uv run pytest` |
| Python (poetry) | `poetry install` | `poetry run pytest` |
| Go | — | `go vet ./...`, `go test ./...` |
| Rust | — | `cargo test` |
| Java (Maven) | — | `mvn -q -B test` |

## A multi-repository project

Map one Asana project (say "SaaS Platform") to `saas-frontend`, `saas-backend` and `shared-sdk`. For a task like "Show the invoice due date in the billing page", the planner proposes the repositories that need changes, with evidence such as the API field in `saas-backend` and the component in `saas-frontend`, and Orbit asks you to confirm the scope before any code is touched. Each repository gets its own branch, review and pull request.
