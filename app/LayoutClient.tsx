'use client';

import { ThemeProvider } from '@/lib/ThemeContext';

export function RootLayoutClient({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      {children}
    </ThemeProvider>
  );
}
