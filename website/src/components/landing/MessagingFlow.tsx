import { useState, useEffect } from 'react';

const NODES = [
  { id: 'claude', label: 'Claude Code', x: 60, color: '#D97757' },
  { id: 'hook', label: 'Hook', x: 200, color: '#8b949e' },
  { id: 'ipc', label: 'IPC Socket', x: 340, color: '#8b949e' },
  { id: 'manager', label: 'Agent Manager', x: 480, color: '#06B6D4' },
  { id: 'slack', label: 'Slack', x: 620, color: '#4A154B' },
  { id: 'user', label: 'User', x: 760, color: '#22C55E' },
];

const MOBILE_NODES = [
  { id: 'claude', label: 'Claude Code', y: 40, color: '#D97757' },
  { id: 'hook', label: 'Hook', y: 110, color: '#8b949e' },
  { id: 'ipc', label: 'IPC Socket', y: 180, color: '#8b949e' },
  { id: 'manager', label: 'Agent Manager', y: 250, color: '#06B6D4' },
  { id: 'slack', label: 'Slack', y: 320, color: '#4A154B' },
  { id: 'user', label: 'User', y: 390, color: '#22C55E' },
];

const LABELS = [
  'PermissionRequest',
  'HookMessage',
  'IPC → Manager',
  'Write to file? allow/deny',
  'allow',
  'PermissionReply',
  'Allowed',
];

const STEP_DURATION = 1000;
const HOLD_DURATION = 1500;
const TOTAL_STEPS = 8;

export default function MessagingFlow() {
  const [step, setStep] = useState(0);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setStep((s) => (s + 1) % TOTAL_STEPS);
    }, step === TOTAL_STEPS - 1 ? HOLD_DURATION : STEP_DURATION);
    return () => clearInterval(interval);
  }, [step]);

  if (isMobile) return <MobileFlow step={step} />;
  return <DesktopFlow step={step} />;
}

function DesktopFlow({ step }: { step: number }) {
  const w = 840;
  const h = 140;
  const cy = 60;
  const nodeW = 100;
  const nodeH = 36;

  // Arrow segments (forward path: steps 0-3, return path: steps 4-6)
  const forwardArrows = [
    { from: 0, to: 1, activeStep: 0 },
    { from: 1, to: 2, activeStep: 1 },
    { from: 2, to: 3, activeStep: 2 },
    { from: 3, to: 4, activeStep: 2 },
    { from: 4, to: 5, activeStep: 3 },
  ];

  const returnArrows = [
    { from: 5, to: 4, activeStep: 4 },
    { from: 4, to: 3, activeStep: 4 },
    { from: 3, to: 2, activeStep: 5 },
    { from: 2, to: 1, activeStep: 5 },
    { from: 1, to: 0, activeStep: 5 },
  ];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full max-w-4xl mx-auto" role="img" aria-label="Messaging flow diagram">
      {/* Nodes */}
      {NODES.map((node, i) => {
        const isActive =
          (step <= 3 && i <= step + 1) ||
          (step >= 4 && step <= 6 && i >= 5 - (step - 4)) ||
          step === 6;
        const glowGreen = step === 6 && i === 0;

        return (
          <g key={node.id}>
            <rect
              x={node.x - nodeW / 2}
              y={cy - nodeH / 2}
              width={nodeW}
              height={nodeH}
              rx={6}
              fill={isActive ? node.color + '22' : '#161b22'}
              stroke={glowGreen ? '#22C55E' : isActive ? node.color : '#30363d'}
              strokeWidth={isActive ? 2 : 1}
              className="transition-all duration-500"
            />
            <text
              x={node.x}
              y={cy + 1}
              textAnchor="middle"
              dominantBaseline="central"
              fill={isActive ? '#e6edf3' : '#8b949e'}
              fontSize={10}
              fontFamily="Inter, sans-serif"
              className="transition-all duration-500"
            >
              {node.label}
            </text>
          </g>
        );
      })}

      {/* Forward arrows */}
      {forwardArrows.map((arrow, i) => {
        const fromX = NODES[arrow.from].x + nodeW / 2;
        const toX = NODES[arrow.to].x - nodeW / 2;
        const isActive = step >= arrow.activeStep && step <= 3;

        return (
          <line
            key={`fwd-${i}`}
            x1={fromX + 4}
            y1={cy}
            x2={toX - 4}
            y2={cy}
            stroke={isActive ? '#D97757' : '#30363d'}
            strokeWidth={isActive ? 2 : 1}
            strokeDasharray={isActive ? undefined : '4 4'}
            className="transition-all duration-500"
          />
        );
      })}

      {/* Return arrows */}
      {returnArrows.map((arrow, i) => {
        const fromX = NODES[arrow.from].x - nodeW / 2;
        const toX = NODES[arrow.to].x + nodeW / 2;
        const isActive = step >= arrow.activeStep && step <= 6;

        return (
          <line
            key={`ret-${i}`}
            x1={fromX - 4}
            y1={cy + 16}
            x2={toX + 4}
            y2={cy + 16}
            stroke={isActive ? '#22C55E' : 'transparent'}
            strokeWidth={2}
            className="transition-all duration-500"
          />
        );
      })}

      {/* Floating label */}
      {step < 7 && (
        <text
          x={w / 2}
          y={h - 10}
          textAnchor="middle"
          fill={step >= 4 ? '#22C55E' : '#D97757'}
          fontSize={11}
          fontFamily="JetBrains Mono, monospace"
          className="transition-all duration-300"
        >
          {LABELS[step]}
        </text>
      )}

      {/* Data packet */}
      {step <= 3 && (
        <circle r={4} fill="#D97757" className="transition-all duration-700">
          <animate
            attributeName="cx"
            values={`${NODES[Math.min(step, 4)].x};${NODES[Math.min(step + 1, 5)].x}`}
            dur="0.8s"
            repeatCount="1"
            fill="freeze"
          />
          <animate attributeName="cy" values={`${cy};${cy}`} dur="0.8s" fill="freeze" />
        </circle>
      )}
      {step >= 4 && step <= 6 && (
        <circle r={4} fill="#22C55E" className="transition-all duration-700">
          <animate
            attributeName="cx"
            values={`${NODES[5 - (step - 4)].x};${NODES[Math.max(5 - (step - 3), 0)].x}`}
            dur="0.8s"
            repeatCount="1"
            fill="freeze"
          />
          <animate attributeName="cy" values={`${cy + 16};${cy + 16}`} dur="0.8s" fill="freeze" />
        </circle>
      )}
    </svg>
  );
}

function MobileFlow({ step }: { step: number }) {
  const w = 200;
  const h = 440;
  const cx = 100;
  const nodeW = 140;
  const nodeH = 32;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full max-w-xs mx-auto" role="img" aria-label="Messaging flow diagram">
      {MOBILE_NODES.map((node, i) => {
        const isActive =
          (step <= 3 && i <= step + 1) ||
          (step >= 4 && step <= 6 && i >= 5 - (step - 4)) ||
          step === 6;

        return (
          <g key={node.id}>
            <rect
              x={cx - nodeW / 2}
              y={node.y - nodeH / 2}
              width={nodeW}
              height={nodeH}
              rx={6}
              fill={isActive ? node.color + '22' : '#161b22'}
              stroke={isActive ? node.color : '#30363d'}
              strokeWidth={isActive ? 2 : 1}
              className="transition-all duration-500"
            />
            <text
              x={cx}
              y={node.y + 1}
              textAnchor="middle"
              dominantBaseline="central"
              fill={isActive ? '#e6edf3' : '#8b949e'}
              fontSize={10}
              fontFamily="Inter, sans-serif"
            >
              {node.label}
            </text>
          </g>
        );
      })}

      {/* Vertical connecting lines */}
      {MOBILE_NODES.slice(0, -1).map((node, i) => {
        const nextNode = MOBILE_NODES[i + 1];
        const isActive = step <= 3 ? i <= step : step <= 6 ? i >= 5 - (step - 3) : true;

        return (
          <line
            key={`line-${i}`}
            x1={cx}
            y1={node.y + nodeH / 2 + 2}
            x2={cx}
            y2={nextNode.y - nodeH / 2 - 2}
            stroke={isActive ? (step >= 4 ? '#22C55E' : '#D97757') : '#30363d'}
            strokeWidth={isActive ? 2 : 1}
            strokeDasharray={isActive ? undefined : '4 4'}
            className="transition-all duration-500"
          />
        );
      })}

      {step < 7 && (
        <text
          x={cx}
          y={h - 10}
          textAnchor="middle"
          fill={step >= 4 ? '#22C55E' : '#D97757'}
          fontSize={9}
          fontFamily="JetBrains Mono, monospace"
        >
          {LABELS[step]}
        </text>
      )}
    </svg>
  );
}
