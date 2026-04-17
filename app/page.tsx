import { CornerBrackets } from "@/components/landing/CornerBrackets";
import { HeaderIcons } from "@/components/landing/HeaderIcons";
import { ThemeToggle } from "@/components/landing/ThemeToggle";
import { HeroTitle } from "@/components/landing/HeroTitle";
import { TerminalCard } from "@/components/landing/TerminalCard";
import { ActionButtons } from "@/components/landing/ActionButtons";

export default function LandingPage() {
  return (
    <main
      className="relative min-h-screen flex flex-col items-center justify-center px-4"
      style={{ background: "var(--landing-bg)", color: "var(--landing-text)", transition: "background 0.25s, color 0.25s" }}
    >
      <CornerBrackets />

      {/* Header */}
      <div className="absolute top-6 left-1/2 -translate-x-1/2">
        <HeaderIcons />
      </div>

      <ThemeToggle />

      {/* Center content */}
      <div className="flex flex-col items-center gap-8 w-full max-w-xl">
        <HeroTitle />
        <TerminalCard />
        <ActionButtons />
      </div>
    </main>
  );
}
