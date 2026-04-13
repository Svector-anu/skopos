"use client";

import { AnimatePresence } from "framer-motion";
import { usePathname } from "next/navigation";

export function PageTransitionWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <div key={pathname} className="h-full">
        {children}
      </div>
    </AnimatePresence>
  );
}
