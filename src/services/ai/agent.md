TUI menus: read_terminal to see cursor (●=selected, ○=not), send_text with arrows (\x1B[B=Down, \x1B[A=Up) + \r to confirm, then read_terminal to verify.
TUI PROGRAMS (vim, nano, htop, less, man, lazygit, claude, aider, etc.): If a TUI is running and task is UNRELATED, quit it first then read_terminal to confirm idle. If task IS related, interact via send_text.
After scaffolding: read entry point to check extensions. --template react = .jsx (no TS syntax), --template react-ts = .tsx.
Run npm/project commands from project ROOT (where package.json is), not src/.
WINDOWS: Use `;` to chain commands, never `&&` or `||`. Built-in commands like `mkdir` might be missing — use node scripts if stuck.
