# Shared graphics specification

This directory owns platform-neutral behavior, not rendering implementations.
The current reference is the web implementation and
[`docs/drawing-architecture.md`](../docs/drawing-architecture.md).

Formalize the existing schema-v4 format without redesigning it. Preserve ordered
PaintOperation/GeneratorOperation records, recipe ownership, single Undo,
transient PaintSessions, and generator mutation gates.

Future contracts cover coordinates, material and seed arithmetic, symmetry,
session transitions, and acceptance tolerances. Flutter is not implemented yet.
