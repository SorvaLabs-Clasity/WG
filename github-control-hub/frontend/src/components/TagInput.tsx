import React, { useState, useRef, useEffect } from "react";

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder: string;
  onPendingTextChange?: (hasPendingText: boolean) => void;
  icon?: string;
  colorClass?: "blue" | "gray";
}

export function TagInput({ tags, onChange, placeholder, onPendingTextChange, icon, colorClass = "blue" }: TagInputProps) {
  const [input, setInput] = useState("");
  const pendingCbRef = useRef(onPendingTextChange);
  pendingCbRef.current = onPendingTextChange;

  useEffect(() => {
    pendingCbRef.current?.(input.trim().length > 0);
  }, [input]);

  const addTag = () => {
    const val = input.trim();
    if (val && !tags.includes(val)) {
      onChange([...tags, val]);
    }
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    } else if (e.key === "Backspace" && input === "" && tags.length > 0) {
      e.preventDefault();
      onChange(tags.slice(0, -1));
    }
  };

  const isBlue = colorClass === "blue";

  const spanClass = isBlue
    ? "inline-flex items-center gap-1 text-xs bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-300 px-2 py-1 rounded-md font-mono"
    : "inline-flex items-center gap-1 text-xs bg-gray-100 dark:bg-slate-700 border border-gray-200 dark:border-slate-700 text-gray-800 dark:text-slate-200 px-2 py-1 rounded-md font-mono";

  const btnClass = isBlue
    ? "text-blue-300 dark:text-blue-500 hover:text-red-500 dark:hover:text-red-400 ml-0.5"
    : "text-gray-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 ml-0.5";

  const iconClass = isBlue
    ? `ph-bold ${icon} text-[10px] text-blue-400 dark:text-blue-300`
    : `ph-bold ${icon} text-[10px] text-gray-400 dark:text-slate-500`;

  return (
    <div
      className="border border-gray-300 dark:border-slate-600 rounded-md p-2 focus-within:ring-2 focus-within:ring-gh-blue focus-within:border-transparent bg-white dark:bg-slate-800 min-h-[40px] cursor-text"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const inputEl = e.currentTarget.querySelector("input");
          if (inputEl) inputEl.focus();
        }
      }}
    >
      <div className="flex flex-wrap gap-1.5 items-center">
        {tags.map(tag => (
          <span key={tag} className={spanClass}>
            {icon && <i className={iconClass}></i>}
            {tag}
            <button type="button" onClick={() => onChange(tags.filter(t => t !== tag))} className={btnClass}>
              <i className="ph-bold ph-x text-[10px]"></i>
            </button>
          </span>
        ))}
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={tags.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[120px] px-1 py-0.5 text-sm outline-none bg-transparent dark:text-slate-200 dark:placeholder:text-slate-500"
        />
      </div>
    </div>
  );
}
