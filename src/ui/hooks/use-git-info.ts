import { useState, useEffect } from "react";
import { execFile } from "node:child_process";

export interface GitInfo {
  branch: string;
  ahead: number;
  behind: number;
  changes: number;
}

export function useGitInfo(cwd: string | null): GitInfo | null {
  const [info, setInfo] = useState<GitInfo | null>(null);

  useEffect(() => {
    if (!cwd) {
      setInfo(null);
      return;
    }

    function poll() {
      execFile(
        "git",
        ["status", "--porcelain=v1", "-b"],
        { cwd: cwd!, timeout: 3000 },
        (err, stdout) => {
          if (err) {
            setInfo(null);
            return;
          }
          setInfo(parseGitStatus(stdout));
        },
      );
    }

    poll();
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  }, [cwd]);

  return info;
}

function parseGitStatus(output: string): GitInfo | null {
  const lines = output.split("\n");
  const branchLine = lines[0];
  if (!branchLine || !branchLine.startsWith("## ")) return null;

  // Parse branch name: "## main...origin/main [ahead 2, behind 1]"
  const rest = branchLine.slice(3);
  const dotIndex = rest.indexOf("...");
  const bracketIndex = rest.indexOf("[");

  let branch: string;
  if (dotIndex >= 0) {
    branch = rest.slice(0, dotIndex);
  } else if (bracketIndex >= 0) {
    branch = rest.slice(0, bracketIndex).trim();
  } else {
    branch = rest.trim();
  }

  let ahead = 0;
  let behind = 0;
  if (bracketIndex >= 0) {
    const info = rest.slice(bracketIndex);
    const aheadMatch = info.match(/ahead (\d+)/);
    const behindMatch = info.match(/behind (\d+)/);
    if (aheadMatch) ahead = parseInt(aheadMatch[1]!, 10);
    if (behindMatch) behind = parseInt(behindMatch[1]!, 10);
  }

  // Count changed files (non-empty, non-branch lines)
  const changes = lines.slice(1).filter((l) => l.trim().length > 0).length;

  return { branch, ahead, behind, changes };
}
