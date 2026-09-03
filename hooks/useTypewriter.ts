"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { Command } from "@/lib/commands";

export type ChatPhase =
  | "start-pause"
  | "show-user"
  | "user-pause"
  | "ai-thinking"
  | "ai-typing"
  | "hold"
  | "clearing";

export interface ChatState {
  userText: string;
  aiText: string;
  phase: ChatPhase;
}

const AI_TYPE_MS      = 40;
const START_PAUSE_MS  = 600;
const USER_PAUSE_MS   = 900;
const THINKING_MS     = 1100;
const HOLD_MS         = 2200;
const CLEAR_MS        = 350;

export function useTypewriter(commands: Command[]): ChatState {
  const [phase, setPhase]         = useState<ChatPhase>("start-pause");
  const [cmdIdx, setCmdIdx]       = useState(0);
  const [aiCharIdx, setAiCharIdx]     = useState(0);
  const [userText, setUserText]   = useState("");
  const [aiText, setAiText]       = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reduceMotion, setReduceMotion] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  const cmd = commands[cmdIdx];

  const clear = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(media.matches);
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    clear();

    if (reduceMotion) {
      return clear;
    }

    switch (phase) {
      case "start-pause":
        timer.current = setTimeout(() => {
          setUserText(cmd.cmd);
          setPhase("show-user");
        }, START_PAUSE_MS);
        break;

      case "show-user":
        timer.current = setTimeout(() => setPhase("user-pause"), 0);
        break;

      case "user-pause":
        timer.current = setTimeout(() => setPhase("ai-thinking"), USER_PAUSE_MS);
        break;

      case "ai-thinking":
        timer.current = setTimeout(() => {
          setAiText("");
          setAiCharIdx(0);
          setPhase("ai-typing");
        }, THINKING_MS);
        break;

      case "ai-typing": {
        const full = cmd.response;
        if (aiCharIdx < full.length) {
          timer.current = setTimeout(() => {
            setAiText(full.slice(0, aiCharIdx + 1));
            setAiCharIdx(i => i + 1);
          }, AI_TYPE_MS);
        } else {
          timer.current = setTimeout(() => setPhase("hold"), 0);
        }
        break;
      }

      case "hold":
        timer.current = setTimeout(() => setPhase("clearing"), HOLD_MS);
        break;

      case "clearing":
        timer.current = setTimeout(() => {
          setUserText("");
          setAiText("");
          setAiCharIdx(0);
          setCmdIdx(i => (i + 1) % commands.length);
          setPhase("start-pause");
        }, CLEAR_MS);
        break;
    }

    return clear;
  }, [phase, cmdIdx, aiCharIdx, cmd, clear, commands, reduceMotion]);

  if (reduceMotion) {
    return { userText: commands[0]?.cmd ?? "", aiText: commands[0]?.response ?? "", phase: "hold" };
  }

  return { userText, aiText, phase };
}
