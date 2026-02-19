import { useState, useEffect, useCallback, useRef } from 'react';

type Phase = 'install-type' | 'install-output' | 'launch-type' | 'tui' | 'hold';

const INSTALL_CMD = 'npm install -g agent-manager';
const LAUNCH_CMD = 'agent-manager';
const CHAR_DELAY = 50;
const JITTER = 30;

const INSTALL_OUTPUT = [
  'added 1 package in 2.4s',
  '',
  '1 package is looking for funding',
  '  run `npm fund` for details',
];

export default function TerminalAnimation() {
  const [phase, setPhase] = useState<Phase>('install-type');
  const [typed, setTyped] = useState('');
  const [showOutput, setShowOutput] = useState(false);
  const [showTUI, setShowTUI] = useState(false);
  const timeoutRef = useRef<number>(0);

  const typeText = useCallback(
    (text: string, onDone: () => void) => {
      let i = 0;
      const next = () => {
        if (i < text.length) {
          setTyped(text.slice(0, i + 1));
          i++;
          timeoutRef.current = window.setTimeout(next, CHAR_DELAY + (Math.random() - 0.5) * JITTER);
        } else {
          onDone();
        }
      };
      next();
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    const run = () => {
      // Phase 1: Type install command
      setPhase('install-type');
      setTyped('');
      setShowOutput(false);
      setShowTUI(false);

      typeText(INSTALL_CMD, () => {
        if (cancelled) return;
        // Phase 2: Show output
        timeoutRef.current = window.setTimeout(() => {
          if (cancelled) return;
          setPhase('install-output');
          setShowOutput(true);

          // Phase 3: Type launch command
          timeoutRef.current = window.setTimeout(() => {
            if (cancelled) return;
            setPhase('launch-type');
            setTyped('');
            setShowOutput(false);

            typeText(LAUNCH_CMD, () => {
              if (cancelled) return;
              // Phase 4: Show TUI
              timeoutRef.current = window.setTimeout(() => {
                if (cancelled) return;
                setPhase('tui');
                setShowTUI(true);

                // Phase 5: Hold then loop
                timeoutRef.current = window.setTimeout(() => {
                  if (cancelled) return;
                  setPhase('hold');
                  timeoutRef.current = window.setTimeout(() => {
                    if (!cancelled) run();
                  }, 3000);
                }, 200);
              }, 500);
            });
          }, 1200);
        }, 600);
      });
    };

    run();
    return () => {
      cancelled = true;
      clearTimeout(timeoutRef.current);
    };
  }, [typeText]);

  if (showTUI) return <TUIMockup />;

  return (
    <div>
      {(phase === 'install-type' || phase === 'install-output') && (
        <div>
          <div>
            <span className="text-[#8b949e]">$ </span>
            <span className="text-[#22C55E]">{typed}</span>
            {phase === 'install-type' && <span className="animate-pulse text-text-primary">|</span>}
          </div>
          {showOutput && (
            <div className="mt-2">
              {INSTALL_OUTPUT.map((line, i) => (
                <div key={i} className="text-[#8b949e]">{line || '\u00A0'}</div>
              ))}
            </div>
          )}
        </div>
      )}
      {phase === 'launch-type' && (
        <div>
          <span className="text-[#8b949e]">$ </span>
          <span className="text-[#22C55E]">{typed}</span>
          <span className="animate-pulse text-text-primary">|</span>
        </div>
      )}
    </div>
  );
}

function TUIMockup() {
  const [activeTab, setActiveTab] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveTab((prev) => (prev === 0 ? 1 : 0));
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex h-[280px] text-xs animate-[fadeIn_0.3s_ease]">
      {/* Sidebar */}
      <div className="w-[180px] border-r border-[#30363d] pr-3 flex flex-col gap-1 shrink-0">
        <div className="text-[#8b949e] text-[10px] uppercase tracking-wider mb-2 font-semibold">Sessions</div>
        <div
          className={`px-2 py-1.5 rounded text-[11px] flex items-center gap-2 transition-colors ${
            activeTab === 0 ? 'bg-[#D97757]/15 text-[#D97757]' : 'text-[#8b949e] hover:text-[#e6edf3]'
          }`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E]" />
          Claude Code
        </div>
        <div
          className={`px-2 py-1.5 rounded text-[11px] flex items-center gap-2 transition-colors ${
            activeTab === 1 ? 'bg-[#06B6D4]/15 text-[#06B6D4]' : 'text-[#8b949e] hover:text-[#e6edf3]'
          }`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E]" />
          Gemini CLI
        </div>
        <div className="flex-1" />
        <div className="text-[10px] text-[#8b949e] border-t border-[#30363d] pt-2 mt-2">
          <span className="text-[#4A154B]">Slack</span>
          {' | '}
          <span className="text-[#22C55E]">running</span>
          {' | 2 sessions'}
        </div>
      </div>

      {/* Main pane */}
      <div className="flex-1 pl-3 flex flex-col min-w-0">
        <div className="flex items-center gap-2 mb-3 text-[10px]">
          <span className={activeTab === 0 ? 'text-[#D97757] font-bold' : 'text-[#06B6D4] font-bold'}>
            {activeTab === 0 ? 'Claude Code' : 'Gemini CLI'}
          </span>
          <span className="text-[#22C55E]">running</span>
          <span className="text-[#8b949e]">~/projects/my-app</span>
        </div>

        {activeTab === 0 ? (
          <div className="flex-1 text-[#8b949e] space-y-1.5">
            <div>
              <span className="text-[#D97757]">Claude</span> I'll help you implement the authentication module.
            </div>
            <div className="mt-2">
              <span className="text-[#D97757] font-medium">Tool:</span>{' '}
              <span className="text-[#06B6D4]">Write</span>{' '}
              <span className="text-[#8b949e]">src/auth/middleware.ts</span>
            </div>
            <div className="mt-1 bg-[#0d1117] rounded px-2 py-1.5 text-[#e6edf3]">
              <span className="text-[#06B6D4]">export</span> <span className="text-[#06B6D4]">function</span>{' '}
              <span className="text-[#e6edf3]">authMiddleware</span>
              <span className="text-[#8b949e]">(</span>
              <span className="text-[#D97757]">req</span>
              <span className="text-[#8b949e]">) {'{'}</span>
            </div>
            <div className="text-[#FFA500]">
              Allow this tool? <span className="text-[#22C55E]">[y]</span>/n
            </div>
          </div>
        ) : (
          <div className="flex-1 text-[#8b949e] space-y-1.5">
            <div>
              <span className="text-[#06B6D4]">Gemini</span> Analyzing your project structure...
            </div>
            <div className="mt-2">
              <span className="text-[#06B6D4] font-medium">Tool:</span>{' '}
              <span className="text-[#22C55E]">ReadFile</span>{' '}
              <span className="text-[#8b949e]">package.json</span>
            </div>
            <div className="mt-1 bg-[#0d1117] rounded px-2 py-1.5 text-[#e6edf3]">
              <span className="text-[#8b949e]">{'{'}</span>{' '}
              <span className="text-[#06B6D4]">"name"</span>
              <span className="text-[#8b949e]">:</span>{' '}
              <span className="text-[#22C55E]">"my-app"</span>
              <span className="text-[#8b949e]">,</span> ...{' '}
              <span className="text-[#8b949e]">{'}'}</span>
            </div>
            <div>
              <span className="text-[#06B6D4]">Gemini</span> Found a React project with TypeScript.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
