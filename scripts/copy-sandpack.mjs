import fs from "node:fs";
import path from "node:path";

const SOURCE_DIR = path.resolve("node_modules/@codesandbox/sandpack-client/sandpack");
const TARGET_DIR = path.resolve("public/sandpack");

function copySandpack() {
  console.log("[copy-sandpack] Checking source directory...");
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`[copy-sandpack] Error: Source directory does not exist: ${SOURCE_DIR}`);
    process.exit(1);
  }

  if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
  }

  console.log(`[copy-sandpack] Copying runtime from ${SOURCE_DIR} to ${TARGET_DIR}...`);
  fs.cpSync(SOURCE_DIR, TARGET_DIR, { recursive: true });
  console.log("[copy-sandpack] Self-hosted Sandpack assets successfully copied.");
}

copySandpack();
