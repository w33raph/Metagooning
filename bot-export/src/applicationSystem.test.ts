import test from "node:test";
import assert from "node:assert/strict";
import { createApplicationSession, getCurrentQuestion, parseApplicationQuestions, submitApplicationAnswer } from "./applicationSystem";

test("parses newline-delimited questions", () => {
  assert.deepEqual(parseApplicationQuestions("What is your name?\nWhy do you want to join?"), [
    "What is your name?",
    "Why do you want to join?",
  ]);
});

test("advances through questions and stores answers", () => {
  const session = createApplicationSession(["Name", "Age"]);
  assert.equal(getCurrentQuestion(session), "Name");

  const updated = submitApplicationAnswer(session, "Alex");
  assert.equal(updated.currentIndex, 1);
  assert.deepEqual(updated.answers, ["Alex"]);
  assert.equal(getCurrentQuestion(updated), "Age");
});
