#!/usr/bin/env node
import { run } from "./run.js";

run(process.argv.slice(2), {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
}).then((code) => {
  process.exitCode = code;
});
