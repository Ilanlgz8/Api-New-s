'use client';

import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/lib/ThemeContext';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      className="relative w-12 h-12 rounded-lg bg-bg-hover hover:bg-bg-card transition-all duration-300 flex items-center justify-center group border border-border hover:border-accent-blue"
      aria-label="Toggle theme"
    >
      <div className="relative w-6 h-6">
        {theme === 'dark' ? (
          <Moon
            size={20}
            className="absolute inset-0 text-accent-gold rotate-0 group-hover:rotate-12 transition-transform duration-300"
          />
        ) : (
          <Sun
            size={20}
            className="absolute inset-0 text-accent-gold rotate-180 group-hover:-rotate-12 transition-transform duration-300"
          />
        )}
      </div>
    </button>
  );
}

