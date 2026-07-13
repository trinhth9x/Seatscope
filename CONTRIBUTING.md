# Contributing to Seatscope

Thanks for your interest in contributing.

## Before You Start

- Read [README.md](README.md) for setup, architecture, and connector details.
- For larger changes, open an issue first so the approach can be discussed before you spend time implementing it.
- Keep pull requests focused. Avoid mixing unrelated fixes, refactors, or formatting-only changes.

## Local Setup

### Option 1: Docker

```bash
docker compose up -d
```

The app will be available at `http://localhost:4000`.

### Option 2: Node.js

Requires Node.js 20+.

```bash
npm ci
npm start
```

## Types of Contributions

Contributions are welcome for:

- bug fixes
- new connectors
- UI improvements
- docs improvements
- performance or reliability improvements

If you add a new connector, keep it consistent with the existing connector model in `src/connectors/` and make sure it returns the same raw shape used by the rest of the app.

## Workflow

1. Fork the repository.
2. Create a branch for your change.
3. Make the smallest change that solves the problem.
4. Test your change locally.
5. Open a pull request with a clear description.

Example branch names:

- `fix/github-last-activity`
- `feat/azure-devops-connector`
- `docs/update-readme`

## Pull Request Guidelines

Please include:

- what problem you are solving
- what changed
- how you tested it
- screenshots if the UI changed

Please avoid:

- unrelated refactors
- drive-by formatting changes
- large scope changes without prior discussion

## Testing

There is currently no formal test suite in this repository.

Before opening a PR, at minimum:

- start the app locally
- verify the relevant UI or connector behavior
- confirm there are no obvious runtime errors in the browser or server logs

## Security

- Never commit real credentials, API tokens, or data from customer environments.
- Connector secrets should stay in local environment variables or local ignored files only.

## Questions

If you are unsure where to start, open an issue describing the bug, idea, or connector you want to work on.
