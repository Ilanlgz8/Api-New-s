'use client';

import { Suspense } from 'react';
import { ThemeToggle } from './ThemeToggle';

function ThemeToggleSuspense() {
  return (
    <Suspense fallback={<div className="w-12 h-12 rounded-lg bg-bg-hover animate-pulse" />}>
      <ThemeToggle />
    </Suspense>
  );
}

export function ThemeToggleWrapper() {
  return <ThemeToggleSuspense />;
}
