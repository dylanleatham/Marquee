## Real findings

**A test runner that can discover nothing and still exit 0** — the #283 shape.

```diff
-    "test:contracts": "node ../scripts/node-test.mjs",
+    "test:contracts": "node --test",
```

```json
[
  {
    "severity": "blocking",
    "file": "packages/contracts/package.json",
    "line": 12,
    "message": "Bare `node --test` exits 0 when it discovers no test files, so a renamed or relocated test leaves this task reporting success having asserted nothing.",
    "suggestion": "Keep the scripts/node-test.mjs wrapper, which fails a run that reported `# tests 0`."
  }
]
```

**A setting dropped before it reaches the process that reads it** — the #223 shape. Note the finding
is on the workflow that sets the variable, but the cause is the file that fails to declare it.

```diff
   "test:unit": {
-    "env": ["VITEST_MAX_FORKS", "MARQUEE_REQUIRE_FFMPEG"]
   }
```

```json
[
  {
    "severity": "blocking",
    "file": "turbo.json",
    "line": 34,
    "message": "ci.yml still sets VITEST_MAX_FORKS, but turbo runs in strict env mode and drops any variable turbo.json does not declare — so the cap never reaches vitest and the leg silently runs the default pool.",
    "suggestion": "Keep the variable in the task's `env` array, or stop setting it in the workflow."
  }
]
```

**A skip that reads as a pass.**

```diff
-      - name: Install ffmpeg
-        run: choco install ffmpeg -y
```

```json
[
  {
    "severity": "blocking",
    "file": ".github/workflows/ci.yml",
    "line": 61,
    "message": "Removing the ffmpeg install makes every real-binary test skip itself, and a skipped test reports the same green as a passing one — this exact hole was filed twice (#180, #217).",
    "suggestion": "Keep the install, or set MARQUEE_REQUIRE_FFMPEG so a missing binary fails the leg instead of skipping it."
  }
]
```

**A guard neutered while what it guarded remains.**

```diff
       - name: Type check
         run: pnpm run type-check
+        continue-on-error: true
```

```json
[
  {
    "severity": "blocking",
    "file": ".github/workflows/ci.yml",
    "line": 48,
    "message": "`continue-on-error: true` makes this step incapable of failing the job, so a type error now produces the same green check as a clean run.",
    "suggestion": "Drop the flag, or move the step to a non-blocking workflow if it is genuinely advisory."
  }
]
```

## Not findings — reply `[]`

**A check that fails loudly.** Correct behaviour, not a finding.

```diff
+      - name: Verify the report covers this commit
+        run: node scripts/check-report.mjs --sha "$GITHUB_SHA"
```

**A check being slow, duplicated, or expensive.** Real concerns; not this reviewer's.

```diff
-    runs-on: ubuntu-latest
+    runs-on: windows-latest
```

**Adding a genuinely optional step**, where absence is visible and intended.

```diff
+      - name: Upload coverage artifact
+        if: always()
+        uses: actions/upload-artifact@v4
```

**A test file edited.** Whether the assertions are good is `test-auditor`'s question — you care only
about whether the _runner_ can go quiet.

```diff
-    expect(result.status).toBe(200);
+    expect(result.status).toBe(201);
```

**A new env var that nothing consumes yet.** Unused is not the same as silently dropped; there is no
check here whose output could change.

```diff
   env:
+    MARQUEE_LOG_LEVEL: debug
```
