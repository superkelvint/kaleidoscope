# Document contract

The current format is implemented by `apps/web/drawing-document.js` and
`apps/web/stroke-recipe.js`. It stores `version: 4`, `backgroundColor`, and one
ordered `operations` sequence. Schema-v3 migration remains supported.

A formal schema must describe the existing format and its semantic validation;
this directory does not yet contain a JSON Schema validator.
