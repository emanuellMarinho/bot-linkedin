import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { setImmediate } from "node:timers/promises";
import {
  assertWindowsRuntime,
  seaConfiguration,
} from "../scripts/build-windows.js";

test("Windows packaging refuses another platform and keeps dynamic imports available", () => {
  assert.throws(() => assertWindowsRuntime("linux", "x64"), /Windows x64/);
  assert.throws(() => assertWindowsRuntime("win32", "arm64"), /Windows x64/);
  const sea = seaConfiguration("launcher.cjs", "output.blob");
  assert.equal(sea.main, "launcher.cjs");
  assert.equal(sea.useCodeCache, false);
  assert.equal(sea.useSnapshot, false);
  assert.deepEqual(sea.execArgv, ["--use-env-proxy"]);
  assert.equal(sea.execArgvExtension, "none");
});

for (const tty of [true, false]) {
  test(`Windows launcher keeps a missing-package error visible only for interactive terminal (${tty})`, async () => {
    let waits = 0,
      closes = 0;
    const messages = [];
    const childProcess = {
      execPath: path.resolve("portable", "VagaRadar.exe"),
      stdin: { isTTY: tty },
      stdout: { isTTY: tty },
      exitCode: 0,
    };
    const source = fs.readFileSync(
      new URL("../scripts/sea-launcher.cjs", import.meta.url),
      "utf8",
    );
    vm.runInNewContext(source, {
      process: childProcess,
      console: {
        error(message) {
          messages.push(message);
        },
      },
      require(name) {
        if (name === "node:path") return path;
        if (name === "node:fs")
          return {
            existsSync() {
              return false;
            },
          };
        if (name === "node:module")
          return {
            createRequire() {
              throw new Error("Unexpected app load");
            },
          };
        if (name === "node:url") return {};
        if (name === "node:readline/promises")
          return {
            createInterface() {
              return {
                async question() {
                  waits++;
                },
                close() {
                  closes++;
                },
              };
            },
          };
        throw new Error("Unexpected dependency");
      },
    });
    await setImmediate();
    assert.equal(childProcess.exitCode, 1);
    assert.equal(waits, tty ? 1 : 0);
    assert.equal(closes, tty ? 1 : 0);
    assert.match(messages.join(" "), /Pacote incompleto/);
  });
}
