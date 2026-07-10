#!/usr/bin/env node
// One-command environment check + bootstrap. `pnpm run setup`.
import { existsSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
let problems = 0;

console.log("Marquee setup\n");

// Node version
const major = Number(process.versions.node.split(".")[0]);
if (major === 20) ok(`Node ${process.versions.node}`);
else {
  warn(
    `Node ${process.versions.node} — this project pins Node 20 (see .nvmrc)`,
  );
  problems++;
}

// Optional tools
for (const [cmd, label] of [
  ["pnpm --version", "pnpm"],
  ["python --version", "Python (needed only for Stylus)"],
  ["ffmpeg -version", "ffmpeg (needed for Curator video validation)"],
  ["git --version", "git"],
]) {
  try {
    execSync(cmd, { stdio: "ignore" });
    ok(label);
  } catch {
    warn(`${label} not found on PATH`);
  }
}

// Seed .env
if (!existsSync(".env")) {
  if (existsSync(".env.example")) {
    copyFileSync(".env.example", ".env");
    ok("created .env from .env.example — fill in real values");
  }
} else ok(".env already present");

console.log(
  problems === 0
    ? "\nLooks good. Next: `pnpm install`, then `pnpm run test:fast`."
    : "\nSome checks need attention above before you build.",
);
