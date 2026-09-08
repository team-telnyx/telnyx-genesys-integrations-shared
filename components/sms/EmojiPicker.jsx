"use client";

import { useEffect, useRef } from "react";
import data from "@emoji-mart/data";

export default function EmojiPicker({ onEmojiSelect, theme = "light" }) {
  const containerRef = useRef(null);
  const pickerRef = useRef(null);
  const onEmojiSelectRef = useRef(onEmojiSelect);
  const themeRef = useRef(theme);

  useEffect(() => {
    onEmojiSelectRef.current = onEmojiSelect;
  }, [onEmojiSelect]);

  useEffect(() => {
    themeRef.current = theme;
    pickerRef.current?.update({ theme });
  }, [theme]);

  useEffect(() => {
    let active = true;
    const container = containerRef.current;

    import("emoji-mart").then(({ Picker }) => {
      if (!active || !container) return;
      const picker = new Picker({
        data,
        onEmojiSelect: (emoji) => onEmojiSelectRef.current?.(emoji),
        previewPosition: "none",
        skinTonePosition: "none",
        navPosition: "top",
        perLine: 7,
        theme: themeRef.current,
      });
      picker.style.width = "300px";
      picker.style.height = "400px";
      picker.style.maxWidth = "600px";
      container.replaceChildren(picker);
      pickerRef.current = picker;
    });

    return () => {
      active = false;
      pickerRef.current = null;
      container?.replaceChildren();
    };
  }, []);

  return <div ref={containerRef} />;
}
