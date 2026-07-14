# Repository Guidelines

## Project Structure & Module Organization

Wiki Globe is a static CesiumJS application with no bundler. `index.html` defines the UI shell and loads CDN dependencies; `js/app.js` boots the viewer and wires controls. Put reusable globe features in `js/layers/`, agent functionality in `js/agent/`, and shared loaders or utilities directly under `js/`. Styling lives in `css/style.css`, imagery in `assets/`, and runtime datasets in `data/`. Data update and validation scripts belong in `scripts/data/`. Architecture notes and future specifications live in `docs/`.

## Development, Validation, and Data Commands

- `python -m http.server 8080` serves the repository at `http://localhost:8080`. Do not open `index.html` with `file://`; ES modules and textures require HTTP.
- `npx serve -l 8080` is an equivalent local server.
- `npm run data:validate` runs schema, range, and sanity checks for every generated dataset.
- `npm run data:update:<target>` regenerates one dataset, for example `npm run data:update:ports`.
- `npm run data:update` refreshes all generated datasets and may make network-dependent, large changes.

There is no build, lint, or general `npm test` command.

## Coding Style & Naming Conventions

Follow the existing plain JavaScript ES-module style: two-space indentation, semicolons, double-quoted strings, trailing commas in multiline literals, and `const`/`let` instead of `var`. Use `PascalCase` for layer classes, `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for constants, and kebab-case filenames such as `power-plants.js`. Keep DOM IDs and CSS classes kebab-case. New globe overlays should follow the layer lifecycle used in `js/layers/` and be wired through `js/app.js`.

Do not hand-edit generated `data/*.latest.json` or `*.latest.geojson`; change the matching updater and validator. Add attribution to both the sidebar and `README.md` for new imagery or data sources.

## Testing Guidelines

Run `npm run data:validate` after data or pipeline changes. For application changes, serve locally and exercise affected toggles, hover/click behavior, responsive panels, browser console output, and fallback behavior when live APIs fail. For visual changes, check desktop and narrow viewports. There is no coverage requirement or test-file naming convention yet.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commits with optional scopes: `feat(layers): ...`, `fix(ui): ...`, `docs(data): ...`, and `refactor(ui): ...`. Keep each commit focused and imperative. Pull requests should explain user-visible behavior, list validation performed, link relevant issues/specs, include screenshots for UI changes, and identify regenerated datasets or new external sources.

## Security & Configuration

Never commit API keys. Keep provider credentials in the app's supported local browser storage or query-string configuration, and avoid logging secrets or committing local caches.
