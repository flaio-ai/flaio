import { useState, useEffect, useRef, useCallback } from 'react';

type Phase = 'type-portal' | 'connecting' | 'mirrored' | 'input-forward' | 'hold';

const PHASES: { phase: Phase; duration: number }[] = [
  { phase: 'type-portal', duration: 2000 },
  { phase: 'connecting', duration: 1000 },
  { phase: 'mirrored', duration: 2000 },
  { phase: 'input-forward', duration: 2000 },
  { phase: 'hold', duration: 2000 },
];

const MAIN_CONTENT = [
  { color: '#D97757', text: 'Claude' },
  { color: '#8b949e', text: ' Working on authentication...' },
  { color: '#06B6D4', text: 'Tool: ' },
  { color: '#8b949e', text: 'Write src/auth.ts' },
];

const PORTAL_CMD = 'flaio portal';

export default function PortalsDiagram() {
  const [phaseIdx, setPhaseIdx] = useState(0);
  const [portalTyped, setPortalTyped] = useState('');
  const [userInput, setUserInput] = useState('');
  const timeoutRef = useRef<number>(0);

  const phase = PHASES[phaseIdx].phase;

  const typeText = useCallback((text: string, setter: (v: string) => void, onDone: () => void) => {
    let i = 0;
    const next = () => {
      if (i < text.length) {
        setter(text.slice(0, i + 1));
        i++;
        timeoutRef.current = window.setTimeout(next, 60 + (Math.random() - 0.5) * 30);
      } else {
        onDone();
      }
    };
    next();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const runCycle = () => {
      // Reset
      setPhaseIdx(0);
      setPortalTyped('');
      setUserInput('');

      // Phase 0: type portal command
      typeText(PORTAL_CMD, setPortalTyped, () => {
        if (cancelled) return;
        timeoutRef.current = window.setTimeout(() => {
          if (cancelled) return;
          setPhaseIdx(1); // connecting

          timeoutRef.current = window.setTimeout(() => {
            if (cancelled) return;
            setPhaseIdx(2); // mirrored

            timeoutRef.current = window.setTimeout(() => {
              if (cancelled) return;
              setPhaseIdx(3); // input-forward
              typeText('allow', setUserInput, () => {
                if (cancelled) return;
                timeoutRef.current = window.setTimeout(() => {
                  if (cancelled) return;
                  setPhaseIdx(4); // hold

                  timeoutRef.current = window.setTimeout(() => {
                    if (!cancelled) runCycle();
                  }, PHASES[4].duration);
                }, 500);
              });
            }, PHASES[2].duration);
          }, PHASES[1].duration);
        }, 500);
      });
    };

    runCycle();
    return () => {
      cancelled = true;
      clearTimeout(timeoutRef.current);
    };
  }, [typeText]);

  const connected = phaseIdx >= 2;

  return (
    <div className="flex flex-col md:flex-row items-center gap-4 md:gap-0 max-w-4xl mx-auto relative">
      {/* Main terminal */}
      <div className="w-full md:w-[45%] terminal-chrome">
        <div className="terminal-titlebar">
          <span className="terminal-dot terminal-dot-red" />
          <span className="terminal-dot terminal-dot-yellow" />
          <span className="terminal-dot terminal-dot-green" />
          <span className="ml-3 text-[10px] text-[#8b949e] font-mono">
            flaio
            {connected && <span className="text-[#06B6D4] ml-2">&#8644;</span>}
          </span>
        </div>
        <div className="p-4 font-mono text-xs min-h-[160px] space-y-1.5">
          {MAIN_CONTENT.map((line, i) => (
            <span key={i} style={{ color: line.color }}>{line.text}</span>
          ))}
          {(phase === 'input-forward' || phase === 'hold') && userInput && (
            <div className="mt-2">
              <span className="text-[#22C55E]">&gt; {userInput}</span>
            </div>
          )}
        </div>
      </div>

      {/* Connection line */}
      <div className="md:w-[10%] flex items-center justify-center py-2 md:py-0">
        <svg className="hidden md:block w-full h-8" viewBox="0 0 80 32">
          <line
            x1="0" y1="16" x2="80" y2="16"
            stroke={connected ? '#06B6D4' : '#30363d'}
            strokeWidth={connected ? 2 : 1}
            strokeDasharray={connected ? undefined : '6 4'}
            className="transition-all duration-500"
          >
            {connected && (
              <animate
                attributeName="stroke-opacity"
                values="1;0.4;1"
                dur="2s"
                repeatCount="indefinite"
              />
            )}
          </line>
          {connected && (
            <circle r="3" fill="#06B6D4">
              <animateMotion dur="1.5s" repeatCount="indefinite" path="M0,16 L80,16" />
            </circle>
          )}
        </svg>
        {/* Mobile vertical line */}
        <svg className="md:hidden w-8 h-12" viewBox="0 0 32 48">
          <line
            x1="16" y1="0" x2="16" y2="48"
            stroke={connected ? '#06B6D4' : '#30363d'}
            strokeWidth={connected ? 2 : 1}
            strokeDasharray={connected ? undefined : '6 4'}
            className="transition-all duration-500"
          >
            {connected && (
              <animate
                attributeName="stroke-opacity"
                values="1;0.4;1"
                dur="2s"
                repeatCount="indefinite"
              />
            )}
          </line>
        </svg>
      </div>

      {/* Portal terminal */}
      <div className="w-full md:w-[45%] terminal-chrome">
        <div className="terminal-titlebar">
          <span className="terminal-dot terminal-dot-red" />
          <span className="terminal-dot terminal-dot-yellow" />
          <span className="terminal-dot terminal-dot-green" />
          <span className="ml-3 text-[10px] text-[#8b949e] font-mono">portal</span>
        </div>
        <div className="p-4 font-mono text-xs min-h-[160px]">
          {phaseIdx === 0 && (
            <div>
              <span className="text-[#8b949e]">$ </span>
              <span className="text-[#22C55E]">{portalTyped}</span>
              <span className="animate-pulse text-[#e6edf3]">|</span>
            </div>
          )}
          {phaseIdx === 1 && (
            <div className="text-[#06B6D4]">
              Connecting to session...
              <span className="animate-pulse">|</span>
            </div>
          )}
          {phaseIdx >= 2 && (
            <div className="space-y-1.5 animate-[fadeIn_0.3s_ease]">
              <div className="text-[10px] text-[#06B6D4] mb-2">
                Connected to Claude Code session
              </div>
              {MAIN_CONTENT.map((line, i) => (
                <span key={i} style={{ color: line.color }}>{line.text}</span>
              ))}
              {(phase === 'input-forward' || phase === 'hold') && (
                <div className="mt-2">
                  <span className="text-[#8b949e]">&gt; </span>
                  <span className="text-[#22C55E]">{userInput}</span>
                  {phase === 'input-forward' && <span className="animate-pulse text-[#e6edf3]">|</span>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
