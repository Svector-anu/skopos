"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { COMMANDS } from "@/lib/commands";

type Phase =
  | "typing"
  | "typed-pause"
  | "show-preview"
  | "preview-in"
  | "preview-hold"
  | "preview-out"
  | "deleting"
  | "delete-pause";

export interface TypewriterState {
  displayText: string;
  showPreview: boolean;
  previewText: string;
  previewVisible: boolean;
}

const TYPING_SPEED_MS = 40;
const DELETING_SPEED_MS = 18;
const TYPED_PAUSE_MS = 1200;
const PREVIEW_HOLD_MS = 1800;
const DELETE_PAUSE_MS = 400;
const FADE_DURATION_MS = 300;
const TRANSITION_TICK_MS = 20;

export function useTypewriter(): TypewriterState {
  const [displayText, setDisplayText] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("typing");
  const [charIndex, setCharIndex] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentCommand = COMMANDS[commandIndex];

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    clearTimer();

    switch (phase) {
      case "typing": {
        const full = currentCommand.cmd;
        if (charIndex < full.length) {
          timerRef.current = setTimeout(() => {
            setDisplayText(full.slice(0, charIndex + 1));
            setCharIndex((i) => i + 1);
          }, TYPING_SPEED_MS);
        } else {
          setPhase("typed-pause");
        }
        break;
      }

      case "typed-pause": {
        timerRef.current = setTimeout(() => {
          setPhase("show-preview");
        }, TYPED_PAUSE_MS);
        break;
      }

      case "show-preview": {
        setShowPreview(true);
        timerRef.current = setTimeout(() => {
          setPreviewVisible(true);
          setPhase("preview-in");
        }, TRANSITION_TICK_MS);
        break;
      }

      case "preview-in": {
        timerRef.current = setTimeout(() => {
          setPhase("preview-hold");
        }, FADE_DURATION_MS);
        break;
      }

      case "preview-hold": {
        timerRef.current = setTimeout(() => {
          setPreviewVisible(false);
          setPhase("preview-out");
        }, PREVIEW_HOLD_MS);
        break;
      }

      case "preview-out": {
        timerRef.current = setTimeout(() => {
          setShowPreview(false);
          setPhase("deleting");
        }, FADE_DURATION_MS);
        break;
      }

      case "deleting": {
        if (charIndex > 0) {
          timerRef.current = setTimeout(() => {
            setDisplayText((t) => t.slice(0, -1));
            setCharIndex((i) => i - 1);
          }, DELETING_SPEED_MS);
        } else {
          setPhase("delete-pause");
        }
        break;
      }

      case "delete-pause": {
        timerRef.current = setTimeout(() => {
          setCommandIndex((i) => (i + 1) % COMMANDS.length);
          setCharIndex(0);
          setPhase("typing");
        }, DELETE_PAUSE_MS);
        break;
      }
    }

    return clearTimer;
  }, [phase, charIndex, commandIndex, currentCommand.cmd, clearTimer]);

  return {
    displayText,
    showPreview,
    previewText: currentCommand.preview,
    previewVisible,
  };
}
