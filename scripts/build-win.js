"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
process.env.electron_config_cache ||= path.join(projectRoot, ".cache", "electron");
process.env.ELECTRON_CACHE ||= process.env.electron_config_cache;
const check = spawnSync(process.execPath, [path.join(__dirname, "check.js")], {
  cwd: projectRoot, stdio: "inherit"
});
if (check.error) throw check.error;
if (check.status !== 0) process.exit(check.status || 1);
const smoke = spawnSync(process.execPath, [path.join(__dirname, "run-electron.cjs"), "scripts/smoke-renderer.cjs"], { cwd: projectRoot, stdio: "inherit" });
if (smoke.status !== 0) process.exit(smoke.status || 1);
const args = process.argv.slice(2);
const outputOption = args.find((arg) => arg.startsWith("--config.directories.output="));
const outputRoot = path.resolve(
  projectRoot,
  outputOption ? outputOption.slice(outputOption.indexOf("=") + 1) : "release"
);
const userData = path.join(outputRoot, "win-unpacked", ".userdata");
const backup = path.join(projectRoot, ".cache", `build-userdata-${path.basename(outputRoot)}`);
let hasBackup = false;

try {
  if (fs.existsSync(userData)) {
    fs.rmSync(backup, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.cpSync(userData, backup, { recursive: true });
    hasBackup = true;
  } else if (fs.existsSync(backup)) {
    // Recover data left by an interrupted earlier build.
    hasBackup = true;
  }

  const cli = require.resolve("electron-builder/cli.js");
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE || path.join(projectRoot, ".cache", "electron-builder")
    },
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
  else require("./verify-package.cjs").verifyPackage(outputRoot);
} finally {
  if (hasBackup && fs.existsSync(backup)) {
    fs.mkdirSync(path.dirname(userData), { recursive: true });
    fs.cpSync(backup, userData, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
  }
}
