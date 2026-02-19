import { useState, useEffect } from "react";

const FRAMES = ["◐", "◓", "◑", "◒"];

export function useSpinner(intervalMs = 150): string {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % FRAMES.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return FRAMES[index]!;
}
