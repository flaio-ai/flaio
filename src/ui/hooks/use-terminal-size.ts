import { useState, useEffect } from "react";
import { useStdout } from "ink";

export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout?.columns ?? 120,
    rows: stdout?.rows ?? 40,
  });

  useEffect(() => {
    if (!stdout) return;

    const onResize = () => {
      setSize({ columns: stdout.columns, rows: stdout.rows });
    };

    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
