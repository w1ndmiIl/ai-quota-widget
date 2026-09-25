"use strict";
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");
function verifyPackage(output) {
  const project = path.resolve(__dirname,"..");
  const archive = path.join(output,"win-unpacked","resources","app.asar");
  let count = 0;
  function visit(directory) {
    for (const entry of fs.readdirSync(path.join(project,directory),{withFileTypes:true})) {
      const file = path.join(directory,entry.name);
      if(entry.isDirectory()) visit(file);
      else { if(!asar.extractFile(archive,file).equals(fs.readFileSync(path.join(project,file)))) throw new Error(`Packaged source mismatch: ${file}`); count++; }
    }
  }
  visit("src");
  for(const name of asar.listPackage(archive)) if(/(?:^|[\\/])(?:\.userdata|test|\.cache)(?:[\\/]|$)/.test(name)) throw new Error(`Private/test data in archive: ${name}`);
  console.log(`Verified ${count} packaged source files.`);
}
if(require.main===module) verifyPackage(path.resolve(process.argv[2]||"release"));
module.exports={verifyPackage};
