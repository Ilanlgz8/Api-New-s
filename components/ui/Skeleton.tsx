import { clsx } from 'clsx';

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        'rounded bg-bg-hover animate-pulse',
        className
      )}
    />
  );
}

export function WidgetSkeleton() {
  return (
    <div className="rounded-xl bg-bg-card border border-border p-5 space-y-3">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

export function ErrorCard({ message }: { message: string }) {
  return (
    <div className="rounded-xl bg-bg-card border border-accent-red/30 p-5 text-accent-red text-sm">
      ⚠️ {message}
    </div>
  );
}
