import { CornerBrackets } from "@/components/landing/CornerBrackets";
import { HeaderIcons } from "@/components/landing/HeaderIcons";
import { HeroTitle } from "@/components/landing/HeroTitle";
import { TerminalCard } from "@/components/landing/TerminalCard";
import { ActionButtons } from "@/components/landing/ActionButtons";
import { OracleChip } from "@/components/landing/OracleChip";

export default function LandingPage() {
  return (
    <main className="relative min-h-screen flex flex-col items-center justify-center px-4"
      style={{ background: "#000000", color: "#ffffff" }}>
      <CornerBrackets />

      <div className="absolute top-6 left-1/2 -translate-x-1/2">
        <HeaderIcons />
      </div>

      <div className="flex flex-col items-center gap-8 w-full">
        <HeroTitle />
        <div className="flex flex-col items-center gap-8 w-full max-w-xl">
          <TerminalCard />
          <ActionButtons />
          <OracleChip />
        </div>
      </div>
    </main>
  );
}
