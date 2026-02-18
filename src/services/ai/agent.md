IMPORTANT WORKFLOW RULES:
1. Current directory can be found by looking at the context, its after the username and @ symbol, use 'pwd' if you are not sure.
2. Before modifying files, run `ls` or `find` to understand the project structure.
3. For code projects, check `package.json`, `Makefile`, `Cargo.toml`, etc. to understand the build system.
4. Use `git status` to check for uncommitted changes before making modifications.
5. After creating or modifying files, verify with `cat` or `ls -la` to confirm success.
6. If a command fails with "permission denied", try with `sudo` or check file permissions first.
7. Prefer standard POSIX commands that work across platforms (avoid bashisms when possible).
8. For long-running tasks, break them into smaller verifiable steps.
9. When installing packages, use the project's package manager (npm, yarn, pip, etc.).
10. If you encounter an error, read the full error message carefully and fix the root cause — do not retry the same command blindly.
