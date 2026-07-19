"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

// Browser support never changes over a page's lifetime, so there's nothing
// to actually subscribe to — this only exists to give useSyncExternalStore a
// server snapshot (false) distinct from the real client one, which is how
// it avoids a hydration mismatch on the mic button's disabled state.
function subscribe() {
  return () => {};
}
function getServerSnapshot() {
  return false;
}

/**
 * Chrome/Edge (Google's cloud STT) and Safari (on-device dictation) both
 * expose SpeechRecognition, under different global names. Firefox exposes
 * neither — callers must check `isSupported` and degrade the mic control
 * accordingly rather than assume every browser can listen.
 */
export function useSpeechRecognition(
  onResult: (transcript: string, isFinal: boolean) => void
) {
  const isSupported = useSyncExternalStore(
    subscribe,
    () => getSpeechRecognitionConstructor() !== null,
    getServerSnapshot
  );
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const onResultRef = useRef(onResult);

  useEffect(() => {
    onResultRef.current = onResult;
  });

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
    };
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const SpeechRecognitionCtor = getSpeechRecognitionConstructor();
    if (!SpeechRecognitionCtor || recognitionRef.current) return;

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    recognition.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      if (final) onResultRef.current(final, true);
      if (interim) onResultRef.current(interim, false);
    };

    recognition.onerror = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    setIsListening(true);
    recognition.start();
  }, []);

  return { isSupported, isListening, start, stop };
}
