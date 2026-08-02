"""Text-mode file access in this repo must name its encoding.

`Path.read_text()` / `open()` without `encoding=` decode using the platform's locale: UTF-8 on the
Linux CI runners, cp1252 on a Windows workstation. `test_example_config_parses` read the shipped
`config.example.toml` that way and passed only by luck — the example is UTF-8, and the non-ASCII it
already contains (em-dashes, `§`) happens to survive a cp1252 decode. The first character outside
cp1252 (a `⚠️`, say) would have failed on Windows with `UnicodeDecodeError` while staying green in
CI.

That's the blind spot this file closes, and it wants a source lint rather than a runtime test: the
defect is invisible on the machine that reviews the PR, so nothing you can assert about *behaviour*
on Linux will catch it. Production code was never exposed — `load_config` opens the file in binary
for `tomllib.load` (ADR 0016's stdlib-only config path) — but a test that only passes by luck is
still a test that lies.
"""

import ast
from pathlib import Path

# tests/ -> stylus/ -> packages/ -> repo root. Python lives under packages/, but scan the whole
# checkout so a new package doesn't quietly opt out of this rule.
_REPO_ROOT = Path(__file__).resolve().parents[3]

# Never our sources: dependency trees, build output, virtualenvs, and the git worktrees under
# .claude/ — each of those is a second full checkout of this repo on another branch.
_PRUNED = {
    ".claude",
    ".git",
    ".mypy_cache",
    ".next",
    ".pytest_cache",
    ".turbo",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "venv",
}

# The calls that fall back to the platform locale when `encoding=` is omitted.
_TEXT_IO = frozenset({"open", "read_text", "write_text"})


def _python_sources():
    stack = [_REPO_ROOT]
    while stack:
        for entry in stack.pop().iterdir():
            if entry.is_dir():
                if entry.name not in _PRUNED:
                    stack.append(entry)
            elif entry.suffix == ".py":
                yield entry


def _called_name(call):
    """`open(...)` -> "open", `p.read_text(...)` -> "read_text", anything else -> None."""
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return None


def _mode_arg(call, name):
    """The call's `mode` argument, if it has one. Positional index differs by callee: builtin
    `open(file, mode)` puts it second, `Path.open(mode)` first; read_text/write_text have none."""
    if name == "open":
        index = 1 if isinstance(call.func, ast.Name) else 0
        if len(call.args) > index:
            return call.args[index]
    for keyword in call.keywords:
        if keyword.arg == "mode":
            return keyword.value
    return None


def _is_binary(call, name):
    mode = _mode_arg(call, name)
    return isinstance(mode, ast.Constant) and isinstance(mode.value, str) and "b" in mode.value


def _locale_dependent_calls(source, path):
    for node in ast.walk(ast.parse(source, filename=str(path))):
        if not isinstance(node, ast.Call):
            continue
        name = _called_name(node)
        if name not in _TEXT_IO or _is_binary(node, name):
            continue
        if any(keyword.arg == "encoding" for keyword in node.keywords):
            continue
        yield f"{path.relative_to(_REPO_ROOT).as_posix()}:{node.lineno}: {name}()"


def test_no_text_file_access_relies_on_the_platform_locale():
    offenders = sorted(
        offender
        for path in _python_sources()
        for offender in _locale_dependent_calls(path.read_text(encoding="utf-8"), path)
    )
    assert not offenders, (
        "text-mode file access without an explicit encoding. These read as UTF-8 on the CI runner "
        "and cp1252 on a Windows workstation, so the same file parses in one place and raises "
        'UnicodeDecodeError in the other. Pass `encoding="utf-8"` (or open in binary mode):\n  '
        + "\n  ".join(offenders)
    )
