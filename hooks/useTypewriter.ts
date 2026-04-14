"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { COMMANDS } from "@/lib/commands";

type Phase =
  | "typing"
  | "typed-pause"
  | "preview-mount"
  | "preview-visible"
  | "preview-hold"
  | "preview-fade"
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
const FADE_MS = 300;
const PAINT_TICK_MS = 32;

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
          timerRef.current = setTimeout(() => setPhase("typed-pause"), TYPED_PAUSE_MS);
        }
        break;
      }

      case "typed-pause": {
        timerRef.current = setTimeout(() => {
          setShowPreview(true);
          setPhase("preview-mount");
        }, 0);
        break;
      }

      case "preview-mount": {
        timerRef.current = setTimeout(() => {
          setPreviewVisible(true);
          setPhase("preview-visible");
        }, PAINT_TICK_MS);
        break;
      }

      case "preview-visible": {
        timerRef.current = setTimeout(() => {
          setPhase("preview-hold");
        }, FADE_MS);
        break;
      }

      case "preview-hold": {
        timerRef.current = setTimeout(() => {
          setPreviewVisible(false);
          setPhase("preview-fade");
        }, PREVIEW_HOLD_MS);
        break;
      }

      case "preview-fade": {
        timerRef.current = setTimeout(() => {
          setShowPreview(false);
          setPhase("deleting");
        }, FADE_MS);
        break;
      }

      case "deleting": {
        if (charIndex > 0) {
          timerRef.current = setTimeout(() => {
            setDisplayText((t) => t.slice(0, -1));
            setCharIndex((i) => i - 1);
          }, DELETING_SPEED_MS);
        } else {
          timerRef.current = setTimeout(() => setPhase("delete-pause"), 0);
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
