import { test } from "node:test";
import assert from "node:assert/strict";
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
