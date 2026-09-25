"use strict";
const fs = require("node:fs");
const path = require("node:path");
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temporary, file);
  } finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
}
module.exports = { writeJson };
