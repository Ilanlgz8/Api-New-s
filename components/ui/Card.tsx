import { clsx } from 'clsx';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  accent?: 'blue' | 'green' | 'gold' | 'red' | 'purple' | 'cyan';
}

const accentStyles = {
  blue: {
    border: 'border-l-2 border-l-blue-500/50',
    hover: 'hover:border-l-blue-400 hover:shadow-blue-500/20',
    bg: 'from-blue-950/10 to-transparent',
    icon: 'text-blue-400',
  },
  green: {
    border: 'border-l-2 border-l-green-500/50',
    hover: 'hover:border-l-green-400 hover:shadow-green-500/20',
    bg: 'from-green-950/10 to-transparent',
    icon: 'text-green-400',
  },
  gold: {
    border: 'border-l-2 border-l-yellow-500/50',
    hover: 'hover:border-l-yellow-400 hover:shadow-yellow-500/20',
    bg: 'from-yellow-950/10 to-transparent',
    icon: 'text-yellow-400',
  },
  red: {
    border: 'border-l-2 border-l-red-500/50',
    hover: 'hover:border-l-red-400 hover:shadow-red-500/20',
    bg: 'from-red-950/10 to-transparent',
    icon: 'text-red-400',
  },
  purple: {
    border: 'border-l-2 border-l-purple-500/50',
    hover: 'hover:border-l-purple-400 hover:shadow-purple-500/20',
    bg: 'from-purple-950/10 to-transparent',
    icon: 'text-purple-400',
  },
  cyan: {
    border: 'border-l-2 border-l-cyan-500/50',
    hover: 'hover:border-l-cyan-400 hover:shadow-cyan-500/20',
    bg: 'from-cyan-950/10 to-transparent',
    icon: 'text-cyan-400',
  },
};

export function Card({ children, className, accent }: CardProps) {
  const accentStyle = accent ? accentStyles[accent] : null;

  return (
    <div
      className={clsx(
        'relative rounded-2xl animate-slide-up overflow-hidden group',
        'bg-gradient-to-br from-bg-card/80 to-bg-hover/40',
        'backdrop-blur-md border border-border/50',
        'shadow-lg shadow-black/20',
        'hover:shadow-2xl hover:shadow-black/30 hover:border-border',
        'transition-all duration-500 ease-out',
        accentStyle?.border,
        accentStyle?.hover,
        className
      )}
    >
      {/* Gradient background accent */}
      {accentStyle && (
        <div className={clsx(
          'absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-5',
          'transition-opacity duration-500 pointer-events-none',
          accentStyle.bg
        )} />
      )}

      {/* Top glow effect */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

      {/* Content */}
      <div className="relative z-10 p-6">
        {children}
      </div>

      {/* Bottom fade effect */}
      <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-bg-card/50 to-transparent pointer-events-none" />
    </div>
  );
}

export function CardHeader({ title, icon, children }: { title: string; icon?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-5 pb-3 border-b border-border/30">
      <div className="flex items-center gap-2.5">
        {icon && (
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-bg-hover to-bg-accent/50 border border-border/50 group-hover:border-border transition-colors duration-300">
            {icon}
          </div>
        )}
        <h2 className="font-display text-xs font-bold text-text-primary uppercase tracking-widest opacity-90 group-hover:opacity-100 transition-opacity duration-300">
          {title}
        </h2>
      </div>
      {children}
    </div>
  );
}
