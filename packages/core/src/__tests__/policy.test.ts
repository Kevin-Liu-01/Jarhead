import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAction } from "../policy.ts";

test("observing never asks", () => {
  for (const kind of ["screenshot", "zoom", "cursor_position", "wait"]) assert.equal(classifyAction({ kind }).verdict, "run");
});

test("ordinary clicks and typing run without asking", () => {
  assert.equal(classifyAction({ kind: "left_click", app: "Google Chrome", target: "Search" }).verdict, "run");
  assert.equal(classifyAction({ kind: "type", app: "Notes", text: "hello" }).verdict, "run");
  assert.equal(classifyAction({ kind: "scroll", app: "Slack" }).verdict, "run");
  assert.equal(classifyAction({ kind: "open_app", target: "Safari" }).verdict, "run");
});

test("irreversible controls need a yes, and a yes unlocks exactly that", () => {
  assert.equal(classifyAction({ kind: "left_click", app: "Mail", target: "Send" }).verdict, "confirm");
  assert.equal(classifyAction({ kind: "left_click", app: "Mail", target: "Send", confirmed: true }).verdict, "run");
  assert.equal(classifyAction({ kind: "left_click", app: "Amazon", target: "Place your order" }).verdict, "confirm");
  assert.equal(classifyAction({ kind: "left_click", app: "GitHub", target: "Merge pull request" }).verdict, "confirm");
});

test("secret fields are refused even when confirmed", () => {
  assert.equal(classifyAction({ kind: "type", text: "hunter2", secureField: true, confirmed: true }).verdict, "refuse");
});

test("credential apps are hands-off until confirmed", () => {
  assert.equal(classifyAction({ kind: "left_click", app: "1Password", target: "Copy" }).verdict, "confirm");
  assert.equal(classifyAction({ kind: "screenshot", app: "1Password" }).verdict, "run");
});

test("shell commands: read-only runs, mutating asks, destructive refuses", () => {
  assert.equal(classifyAction({ kind: "run_shell", text: "git status" }).verdict, "run");
  assert.equal(classifyAction({ kind: "run_shell", text: "ls -la ~/repos" }).verdict, "run");
  assert.equal(classifyAction({ kind: "run_shell", text: "npm install" }).verdict, "confirm");
  assert.equal(classifyAction({ kind: "run_shell", text: "npm install", confirmed: true }).verdict, "run");
  assert.equal(classifyAction({ kind: "run_shell", text: "sudo rm -rf / --no-preserve-root", confirmed: true }).verdict, "refuse");
});

test("unknown kinds ask rather than run", () => {
  assert.equal(classifyAction({ kind: "teleport" }).verdict, "confirm");
});
