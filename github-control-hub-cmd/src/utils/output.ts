import chalk from "chalk";
import Table from "cli-table3";
import ora from "ora";

export { chalk, ora };

export function heading(text: string): void {
  console.log(`\n${chalk.bold.white(text)}`);
  console.log(chalk.gray("─".repeat(Math.min(text.length + 4, 60))));
}

export function success(msg: string): void {
  console.log(chalk.green("✓") + " " + msg);
}

export function warn(msg: string): void {
  console.log(chalk.yellow("⚠") + " " + chalk.yellow(msg));
}

export function error(msg: string): void {
  console.log(chalk.red("✗") + " " + chalk.red(msg));
}

export function info(msg: string): void {
  console.log(chalk.blue("ℹ") + " " + msg);
}

export function dim(msg: string): void {
  console.log(chalk.gray(msg));
}

export function table(headers: string[], rows: string[][]): void {
  const t = new Table({
    head: headers.map((h) => chalk.bold.cyan(h)),
    style: { head: [], border: ["gray"] },
    wordWrap: true,
  });
  rows.forEach((r) => t.push(r));
  console.log(t.toString());
}

export function kvTable(pairs: [string, string][]): void {
  const t = new Table({
    style: { head: [], border: ["gray"] },
    colWidths: [25, 55],
    wordWrap: true,
  });
  pairs.forEach(([k, v]) => t.push([chalk.bold(k), v]));
  console.log(t.toString());
}

export function badge(text: string, color: "green" | "red" | "yellow" | "blue" | "gray"): string {
  const fn = chalk[color] || chalk.white;
  return fn(`[${text}]`);
}

export function riskBadge(level: string): string {
  switch (level) {
    case "CRITICAL": return chalk.bgRed.white.bold(` ${level} `);
    case "HIGH": return chalk.bgYellow.black.bold(` ${level} `);
    case "MEDIUM": return chalk.bgHex("#FFA500").black(` ${level} `);
    default: return chalk.bgGreen.black(` LOW `);
  }
}

export function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

export function spinner(text: string) {
  return ora({ text, spinner: "dots" });
}
