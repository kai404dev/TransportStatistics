'use client';

import { usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import { ThemeSwitcher } from '@/components/ThemeSwitcher';

type LayoutShellProps = {
  children: React.ReactNode;
};

export default function LayoutShell({ children }: LayoutShellProps) {
  const pathname = usePathname();
  const isAdmin = pathname.startsWith('/admin');

  if (isAdmin) {
    return (
      <div className="min-h-screen bg-ts-bg">
        {children}
        {/* Admin pages have no sidebar, so offer a floating theme switcher */}
        <div className="fixed bottom-4 right-4 z-40 rounded-xl border border-ts-border bg-ts-surface p-2 shadow-lg">
          <div className="px-2 pb-1 text-[9.5px] font-bold tracking-[0.09em] text-ts-text-3">
            Theme
          </div>
          <div className="w-36">
            <ThemeSwitcher />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <aside>
        <Sidebar />
      </aside>
      <main className="flex-1 overflow-y-auto bg-ts-bg">
        {children}
      </main>
    </div>
  );
}
