export function isCommand(input: string): boolean {
    const commonCommands = [
        'cd', 'ls', 'pwd', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'cat', 'less', 'head', 'tail', 'grep', 'find',
        'git', 'npm', 'node', 'yarn', 'pnpm', 'bun', 'docker', 'kubectl', 'ssh', 'scp', 'curl', 'wget',
        'echo', 'printf', 'history', 'clear', 'exit', 'source', 'export', 'unset', 'env',
        'vi', 'vim', 'nano', 'code', 'open', 'python', 'python3', 'pip', 'pip3', 'top', 'htop', 'ps', 'kill'
    ];

    const firstWord = input.trim().split(' ')[0];

    // Check if first word is a known command
    if (commonCommands.includes(firstWord)) return true;

    // Check if it looks like a path or relative command
    if (firstWord.startsWith('./') || firstWord.startsWith('/')) return true;

    // Simple heuristic: If it contains many spaces and no known command, assume prompt
    // If it starts with a verb "List", "Create", "Undo", "Find", it's likely a prompt.
    const promptVerbs = ['list', 'create', 'make', 'undo', 'delete', 'remove', 'find', 'search', 'show', 'check', 'how'];
    if (promptVerbs.includes(firstWord.toLowerCase())) return false;

    // Default fallback: If uncertain, lean towards command if it's short, Prompt if it's long?
    // Let's assume prompt if unknown.
    return false;
}
