TUI menus: read_terminal to see cursor (●=selected, ○=not), send_text with arrows (\x1B[B=Down, \x1B[A=Up) + \r to confirm, then read_terminal to verify.
TUI PROGRAMS (vim, nano, htop, less, man, lazygit, claude, aider, etc.): If a TUI is running and task is UNRELATED, quit it first then read_terminal to confirm idle. If task IS related, interact via send_text.
After scaffolding: read entry point to check extensions. --template react = .jsx (no TS syntax), --template react-ts = .tsx.
Run npm/project commands from project ROOT (where package.json is), not src/.
WINDOWS: Use `;` to chain commands, never `&&` or `||`. Built-in commands like `mkdir` might be missing — use node scripts if stuck.
TASK FOCUS: Only execute the CURRENT TASK. Prior conversation is context only — never re-run previous commands or revisit completed work.
LONG-RUNNING COMMANDS: docker compose, npm install, builds etc. can take minutes. After run_in_terminal, use read_terminal repeatedly to monitor. Do NOT run execute_command or Ctrl+C while a process is running — be patient and wait for it to finish.
SERVER URLs: When reporting URLs in final_answer, use the ACTUAL port from terminal output (read_terminal), not the default. Ports may differ if defaults are in use (e.g. 5174 instead of 5173).
