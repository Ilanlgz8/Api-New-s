import type { Metadata } from 'next';
import './globals.css';
import { RootLayoutClient } from './LayoutClient';

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'Dashboard temps réel — Météo, Crypto, Énergie, Football, Actus',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-screen bg-bg antialiased transition-colors duration-300">
        <RootLayoutClient>
          {children}
        </RootLayoutClient>
      </body>
    </html>
  );
}
