import React, { useMemo } from 'react';
import * as diff from 'diff';

interface DiffViewerProps {
  oldValue: any;
  newValue: any;
}

export default function DiffViewer({ oldValue, newValue }: DiffViewerProps) {
  const diffLines = useMemo(() => {
    // We stringify the values manually to ensure consistent spacing if diffJson formatting isn't enough,
    // but diffJson already formats it.
    const changes = diff.diffJson(oldValue || {}, newValue || {});
    
    const lines: { type: 'added' | 'removed' | 'unchanged'; content: string; oldLineNum?: number; newLineNum?: number }[] = [];
    
    let oldLineNum = 1;
    let newLineNum = 1;

    changes.forEach((change) => {
      const parts = change.value.split('\n');
      // remove trailing empty newline from split if present
      if (parts[parts.length - 1] === '') {
        parts.pop();
      }

      parts.forEach((line) => {
        if (change.added) {
          lines.push({ type: 'added', content: line, newLineNum: newLineNum++ });
        } else if (change.removed) {
          lines.push({ type: 'removed', content: line, oldLineNum: oldLineNum++ });
        } else {
          lines.push({ type: 'unchanged', content: line, oldLineNum: oldLineNum++, newLineNum: newLineNum++ });
        }
      });
    });

    return lines;
  }, [oldValue, newValue]);

  return (
    <div className="w-full text-sm font-mono bg-white border border-gh-border rounded-md overflow-hidden overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <tbody>
          {diffLines.map((line, i) => {
            let bgColor = "bg-white";
            let textColor = "text-gh-textBase";
            let symbol = " ";
            
            if (line.type === "added") {
              bgColor = "bg-[#e6ffed]";
              textColor = "text-[#24292e]";
              symbol = "+";
            } else if (line.type === "removed") {
              bgColor = "bg-[#ffeef0]";
              textColor = "text-[#24292e]";
              symbol = "-";
            }

            return (
              <tr key={i} className={`group ${bgColor}`}>
                <td className="w-12 py-0.5 px-2 text-right select-none border-r border-gh-border text-gray-400 opacity-70 group-hover:opacity-100 text-xs font-mono">
                  {line.oldLineNum || ""}
                </td>
                <td className="w-12 py-0.5 px-2 text-right select-none border-r border-gh-border text-gray-400 opacity-70 group-hover:opacity-100 text-xs font-mono">
                  {line.newLineNum || ""}
                </td>
                <td className="w-6 py-0.5 px-2 select-none text-gray-500 font-mono text-center">
                  {symbol}
                </td>
                <td className={`py-0.5 px-2 whitespace-pre pr-8 ${textColor}`}>
                  {line.content}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
